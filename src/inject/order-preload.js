'use strict';

/**
 * 订单页注入：运行在官方卖家订单页
 *
 * 职责：
 *   1. 常驻扫描订单列表，把每一单（不只是待发货）上报给主进程入库
 *   2. 标记「待发货」的订单，交给主进程决定是否自动发卡密
 *   3. 接受主进程指令，在页面上执行动作：
 *        发货（点发货 → 填单号 → 确认）
 *        评价买家
 *        收下小红花
 *
 * 说明：官方订单页结构会变，这里用「文本特征 + 通用选择器」双重兜底，
 *       抽不到的字段留空，由主进程用本地数据补。
 */

const { ipcRenderer } = require('electron');

const ORDER_NO_RE = /\b(\d{15,25})\b/;            // 闲鱼订单号通常是长数字
const ITEM_ID_RE = /\bid[=:]\s*(\d{9,15})\b/i;
const MONEY_RE = /[¥￥]\s*(\d+(?:\.\d+)?)/;
const BUY_NUM_RE = /(?:x|×)\s*(\d{1,3})\b/;
const FLOWER_PATTERNS = [/^(?:收下|领取|接受).*花$/];

const SEL = {
  orderRow: [
    '[class*="order-item"]',
    '[class*="orderItem"]',
    '[class*="order-card"]',
    '[class*="order-row"]',
    '[data-order-id]',
    '[data-order-no]',
    'tbody tr',
  ],
  status: ['[class*="order-status"]', '[class*="status"]'],
  title: ['[class*="item-title"]', '[class*="goods-name"]', '[class*="title"]'],
  buyer: ['[class*="buyer"]', '[class*="nick"]', '[class*="user-name"]'],
  price: ['[class*="price"]', '[class*="amount"]'],
};

/** 已上报过的订单 → 内容签名，内容变了才重报，避免每 3 秒刷一遍 */
const reported = new Map();
const pendingSeen = new Set();
const flowerSeen = new Set();

function pickAll(selectors) {
  for (const s of selectors) {
    try {
      const list = document.querySelectorAll(s);
      if (list.length) return { list: Array.from(list), selector: s };
    } catch (_) { /* ignore */ }
  }
  return null;
}

function pickIn(root, selectors) {
  for (const s of selectors) {
    try {
      const el = root.querySelector(s);
      if (el) return el;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function textOf(el) {
  return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
}

function firstMoney(text) {
  const m = String(text || '').match(MONEY_RE);
  return m ? Number(m[1]) : null;
}

/** 从一行订单 DOM 里尽力抽字段 */
function extractOrder(row) {
  const raw = textOf(row);

  const orderMatch = raw.match(ORDER_NO_RE);
  const order_no = row.getAttribute('data-order-no')
    || row.getAttribute('data-order-id')
    || (orderMatch ? orderMatch[1] : null);
  if (!order_no) return null;

  // 商品ID：优先 data 属性，其次链接里的 id
  let item_id = row.getAttribute('data-item-id') || row.getAttribute('data-itemid') || '';
  if (!item_id) {
    const link = row.querySelector('a[href*="item"], a[href*="id="]');
    if (link) {
      const m = (link.getAttribute('href') || '').match(/[?&]id=(\d+)/);
      if (m) item_id = m[1];
    }
  }
  if (!item_id) {
    const m = raw.match(ITEM_ID_RE);
    if (m) item_id = m[1];
  }

  const statusEl = pickIn(row, SEL.status);
  const order_status = textOf(statusEl);

  // 金额优先取「实付款」字样附近的数字
  const amountMatch = raw.match(/(?:实付款|实付|成交价|付款金额)[^\d]{0,6}(\d+(?:\.\d+)?)/);
  const amount = amountMatch ? Number(amountMatch[1]) : firstMoney(textOf(pickIn(row, SEL.price)));

  const buyMatch = raw.match(/(?:数量|x|×)\s*[:：]?\s*(\d{1,3})\b/);

  // 规格：闲鱼订单行里常见「规格：颜色/尺寸」或冒号后的第二段
  const specMatch = raw.match(/规格\s*[:：]\s*([^\s|，,]{1,40}(?:\s*[/、]\s*[^\s|，,]{1,40})?)/);
  const buyer = pickIn(row, SEL.buyer);
  const buyerLink = buyer && buyer.querySelector('a[href]') || row.querySelector('a[href*="userId="],a[href*="user_id="]');
  const buyerIdMatch = buyerLink && String(buyerLink.getAttribute('href') || '').match(/[?&](?:userId|user_id|uid)=(\d+)/);
  const buyerUid = row.getAttribute('data-buyer-id') || (buyer && buyer.getAttribute('data-user-id'))
    || (buyerIdMatch && buyerIdMatch[1]) || null;
  const creditText = textOf(pickIn(row, ['[data-buyer-credit]', '[class*="buyer-credit"]', '[class*="credit"]']));
  const creditMatch = creditText.match(/(?:评价数|评价)\s*[:：]?\s*(\d+)|(?:(\d+)\s*(?:条|个)?评价)/);
  const creditAttribute = row.getAttribute('data-buyer-credit');
  const credit = creditAttribute != null && /^\d+$/.test(creditAttribute) ? Number(creditAttribute)
    : creditMatch ? Number(creditMatch[1] || creditMatch[2] || 0) : null;

  return {
    order_no: String(order_no),
    item_id: item_id ? String(item_id) : null,
    item_title: textOf(pickIn(row, SEL.title)) || '',
    buyer_nick: textOf(pickIn(row, SEL.buyer)) || '',
    buyer_uid: buyerUid,
    buyer_credit: credit,
    order_status,
    amount: amount != null && Number.isFinite(amount) ? amount : null,
    buy_num: buyMatch ? Math.max(1, Number(buyMatch[1]) || 1) : 1,
    spec_name: specMatch ? String(specMatch[1]).split(/[/、]/)[0].trim() : '',
    spec_value: specMatch ? String(specMatch[1]).trim() : '',
    raw: raw.slice(0, 400),
  };
}

function isPendingShip(order) {
  if (!order) return false;
  const st = order.order_status || '';
  if (/待发货/.test(st) && !/已发货|待收货|交易成功/.test(st)) return true;
  if (!st) return /待发货/.test(order.raw || '');
  return false;
}

function scanOrders() {
  const found = pickAll(SEL.orderRow);
  if (!found) return;

  const batch = [];
  const flowers = [];
  for (const row of found.list) {
    const order = extractOrder(row);
    if (!order || !order.order_no) continue;

    // 待发货的单独标记：主进程据此触发自动发货（幂等在主进程）
    if (isPendingShip(order) && !pendingSeen.has(order.order_no)) {
      pendingSeen.add(order.order_no);
      ipcRenderer.send('order:pending', order);
    }
    if (!flowerSeen.has(order.order_no) && clickButtonIn(row, FLOWER_PATTERNS)) {
      flowerSeen.add(order.order_no);
      flowers.push(order.order_no);
    }
    const signature = [order.order_status, order.amount, order.buy_num, order.spec_value,
      order.item_title, order.buyer_nick, order.buyer_uid, order.buyer_credit].join('|');
    if (reported.get(order.order_no) !== signature) {
      reported.set(order.order_no, signature);
      batch.push(order);
    }
  }

  if (batch.length) ipcRenderer.send('order:scan', { orders: batch, selector: found.selector });
  for (const orderNo of flowers) ipcRenderer.send('order:flower', { orderNo });
}

/* ------------------------------ 发货操作 ------------------------------ */

const SHIP_SEL = {
  shipBtn: [
    'button[class*="ship"]',
    '[class*="ship-btn"]',
    'button[class*="deliver"]',
    '[class*="consign"]',
  ],
  waybillInput: [
    'input[placeholder*="单号"]',
    'input[class*="waybill"]',
    'input[name*="waybill"]',
    'input[placeholder*="物流"]',
  ],
  expressSelect: [
    'input[placeholder*="快递"]',
    'input[placeholder*="物流公司"]',
    'select[class*="express"]',
  ],
  confirmBtn: ['button[class*="confirm"]', 'button[class*="submit"]', 'button[class*="primary"]'],
};

function pickS(selectors) {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && visibleS(el)) return el;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function visibleS(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}

/** 找到指定订单号所在的行（取文本最短的匹配，避免命中整个列表容器） */
function findOrderRow(orderNo) {
  const rows = Array.from(document.querySelectorAll(
    '[data-order-no],[data-order-id],[class*="order-item"],[class*="orderItem"],[class*="order-card"],[class*="order-row"],tbody tr',
  ));
  return rows.filter((row) => {
    if (row.getAttribute('data-order-no') === String(orderNo)) return true;
    if (row.getAttribute('data-order-id') === String(orderNo)) return true;
    const numbers = new Set(String(row.textContent || '').match(/\b\d{15,25}\b/g) || []);
    return numbers.has(String(orderNo));
  }).sort((a, b) => String(a.textContent).length - String(b.textContent).length)[0] || null;
}

function clickButtonIn(row, patterns) {
  const buttons = Array.from(row.querySelectorAll('button,a,[role="button"]'))
    .filter((node) => visibleS(node) && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true');
  return buttons.find((node) => patterns.some((re) => re.test(textOf(node)))) || null;
}

async function shipOrder({ orderNo, waybillNo, expressCode }) {
  const row = findOrderRow(orderNo);
  if (!row) return { ok: false, error: `页面上找不到订单 ${orderNo}` };
  if (!isPendingShip(extractOrder(row))) return { ok: false, uncertain: false, error: '目标订单未确认处于待发货状态，请人工核对' };

  // 虚拟商品：优先「无需物流 / 虚拟发货」，找不到再走填单号
  let btn = clickButtonIn(row, [/^发货$/, /立即发货/, /去发货/, /确认发货/])
    || pickIn(row, SHIP_SEL.shipBtn);
  if (!btn) return { ok: false, error: '该订单没有「发货」按钮（可能已发货或状态不对）', needManual: true };

  btn.click();
  await new Promise((r) => setTimeout(r, 1500));

  // 弹窗里可能先要选发货方式
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"],.ant-modal,[class*="modal"],[class*="dialog"]'))
    .filter(visibleS);
  const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;

  const noLogistics = Array.from(scope.querySelectorAll('button,label,[role="radio"],[class*="radio"]'))
    .filter(visibleS)
    .find((node) => /无需物流|虚拟发货|无需邮寄|不需要物流/.test(textOf(node)));
  if (noLogistics) {
    noLogistics.click();
    await new Promise((r) => setTimeout(r, 600));
  }

  if (waybillNo) {
    const input = pickS(SHIP_SEL.waybillInput) || scope.querySelector('input[type="text"]');
    if (input) {
      input.focus();
      input.value = waybillNo;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (expressCode) {
      const exp = pickS(SHIP_SEL.expressSelect);
      if (exp) {
        exp.value = expressCode;
        exp.dispatchEvent(new Event('input', { bubbles: true }));
        exp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    await new Promise((r) => setTimeout(r, 600));
  }

  const confirm = Array.from(scope.querySelectorAll('button'))
    .filter((node) => visibleS(node) && /^(确认发货|确定发货|确认|确定|提交)$/.test(textOf(node)))
    .pop();
  if (!confirm) return { ok: false, error: '找不到确认发货按钮', needManual: true };
  confirm.click();

  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise((r) => setTimeout(r, 400));
    const updated = findOrderRow(orderNo);
    const status = updated ? textOf(pickIn(updated, SEL.status)) : '';
    if (/^(?:已发货|待收货|交易成功|交易完成|已完成|已收货)$/.test(status)) {
      return { ok: true, reason: '已核对平台订单发货状态', status };
    }
  }
  return { ok: false, uncertain: true, error: '已点击发货，但平台状态未确认，请先人工核对' };
}

/* ------------------------------ 评价 ------------------------------ */

async function rateOrder({ orderNo, text, score }) {
  const row = findOrderRow(orderNo);
  if (!row) return { ok: false, error: `页面上找不到订单 ${orderNo}` };
  const ratePatterns = [/^(?:评价|去评价|立即评价|评价买家)$/];
  const rateBtn = clickButtonIn(row, ratePatterns);
  if (!rateBtn) return { ok: false, error: '该订单没有「评价」按钮（可能已评价或未到评价时机）', needManual: true };
  rateBtn.click();
  await new Promise((r) => setTimeout(r, 1200));

  const dialogs = Array.from(document.querySelectorAll('[role="dialog"],.ant-modal,[class*="modal"]'))
    .filter(visibleS);
  const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;

  // 评分：默认 5 星（很多页面默认就是好评，点一下更稳）
  const stars = Array.from(scope.querySelectorAll('[class*="star"],[class*="rate-icon"],[role="radio"]'))
    .filter(visibleS);
  if (stars.length && score) {
    const target = stars[Math.min(score, stars.length) - 1];
    if (target) { target.click(); await new Promise((r) => setTimeout(r, 300)); }
  }

  const area = scope.querySelector('textarea')
    || scope.querySelector('[contenteditable="true"]');
  if (area && text) {
    if (area.tagName === 'TEXTAREA') {
      area.value = text;
      area.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      area.textContent = text;
      area.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  const submit = Array.from(scope.querySelectorAll('button'))
    .filter((node) => visibleS(node) && /^(提交|发布|确认评价|确定)$/.test(textOf(node)))
    .pop();
  if (!submit) return { ok: false, error: '找不到评价提交按钮', needManual: true };
  submit.click();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const updated = findOrderRow(orderNo);
    if (updated && /评价成功|已评价|评价完成/.test(textOf(updated)) && !clickButtonIn(updated, ratePatterns)) {
      return { ok: true, reason: '已核对平台评价结果' };
    }
  }
  return { ok: false, uncertain: true, error: '已点击提交，平台评价结果未确认，请先人工核对，未自动重试' };
}

/* ------------------------------ 收小红花 ------------------------------ */

async function receiveFlower({ orderNo }) {
  const row = orderNo ? findOrderRow(orderNo) : document.body;
  if (!row) return { ok: false, error: `页面上找不到订单 ${orderNo}` };
  const btn = clickButtonIn(row, FLOWER_PATTERNS);
  if (!btn) return { ok: false, error: '找不到「收下小红花」按钮', needManual: true };
  btn.click();
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const updated = orderNo && findOrderRow(orderNo);
    if (updated && /已收下|已领取|已接受|已收花/.test(textOf(updated))
        && !clickButtonIn(updated, FLOWER_PATTERNS)) {
      return { ok: true, reason: '已核对收花结果' };
    }
  }
  return { ok: false, uncertain: true, error: '已点击收花，平台结果未确认，请先人工核对' };
}

/* ------------------------------ 消息通道 ------------------------------ */

ipcRenderer.on('order:ship', async (_e, payload) => {
  let res;
  try { res = await shipOrder(payload || {}); }
  catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
  ipcRenderer.send('order:ship-result', { ...res, requestId: payload && payload.requestId });
});

ipcRenderer.on('order:rate', async (_e, payload) => {
  let res;
  try { res = await rateOrder(payload || {}); }
  catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
  ipcRenderer.send('order:action-result', { action: 'rate', ...res, requestId: payload && payload.requestId });
});

/* 主进程要求立刻同步：清掉去重缓存，强制重新上报全部可见订单 */
ipcRenderer.on('order:scan-now', () => {
  reported.clear();
  pendingSeen.clear();
  flowerSeen.clear();
  scanOrders();
});

/* 自动任务：评价在订单页执行（主进程按 task.page='order' 把指令发到这里） */
ipcRenderer.on('task:run', async (_e, { taskId, payload, requestId }) => {
  let result;
  try {
    if (taskId === 'rate') {
      result = await rateOrder(payload || {});
    } else {
      result = { ok: false, reason: `订单页不支持任务 ${taskId}` };
    }
  } catch (e) {
    result = { ok: false, reason: String(e && e.message || e) };
  }
  ipcRenderer.send('task:result', { taskId, requestId, ...result });
});

ipcRenderer.on('order:receive-flower', async (_e, payload) => {
  let res;
  try { res = await receiveFlower(payload || {}); }
  catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
  ipcRenderer.send('order:action-result', { action: 'receive-flower', ...res, requestId: payload && payload.requestId });
});

function boot() {
  // 订单页常有虚拟列表，轮询比 MutationObserver 稳
  const timer = setInterval(scanOrders, 3000);
  scanOrders();
  window.addEventListener('beforeunload', () => clearInterval(timer));

  // 每 5 分钟清一次「待发货」已见集合，允许同一订单被重新检查（幂等靠主进程）
  setInterval(() => { pendingSeen.clear(); flowerSeen.clear(); }, 5 * 60_000);

  console.log('[xy-order] ready | rowSelector =',
    (pickAll(SEL.orderRow) || {}).selector || 'not-found');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

window.__xyShip = shipOrder;
window.__xyRate = rateOrder;
window.__xyReceiveFlower = receiveFlower;

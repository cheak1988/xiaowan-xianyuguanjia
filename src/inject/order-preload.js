'use strict';

/**
 * 订单页注入：运行在官方卖家订单页
 *
 * 目标：识别「待发货」的虚拟商品订单，上报给主进程，
 *       由主进程决定是否自动发卡密。
 *
 * ⚠️ 这个脚本默认不启用，需要在 main 里为「订单页 view」单独加载。
 *    订单页 URL 可能变化，先用 webview 打开 https://www.goofish.com/im 的
 *    「订单」入口，或直接在外部浏览器打开官方卖家中心。
 *
 * 由于订单页结构未知（本次未抓到真实登录态），
 * 这里实现「通用表格扫描」：找出包含订单号、商品、买家、状态的表格行，
 * 尽最大努力抽出结构化数据。抽不到的字段留空，由主进程再补。
 */

const { ipcRenderer } = require('electron');

const SEL = {
  // 订单列表可能的选择器
  orderTable: [
    '[class*="order-list"]',
    '[class*="orderTable"]',
    '[class*="order-table"]',
    'table',
  ],
  orderRow: [
    '[class*="order-item"]',
    '[class*="orderItem"]',
    '[class*="order-row"]',
    'tbody tr',
  ],
};

const ORDER_NO_RE = /\b(\d{15,25})\b/;            // 闲鱼订单号通常是长数字
const ITEM_ID_RE = /\bid[=:]?\s*(\d{9,15})\b/i;

const seen = new Set();

function pickAll(selectors) {
  for (const s of selectors) {
    const list = document.querySelectorAll(s);
    if (list.length) return { list, selector: s };
  }
  return null;
}

function textOf(el) {
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}

/**
 * 从一行订单 DOM 里尽力抽字段
 */
function extractOrder(row) {
  const raw = textOf(row);

  const orderMatch = raw.match(ORDER_NO_RE);
  const order_no = orderMatch ? orderMatch[1] : null;
  if (!order_no) return null;

  // 商品ID：优先 data 属性，其次链接里的 id
  let item_id = row.getAttribute('data-item-id') || row.getAttribute('data-itemid');
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

  // 商品标题：通常是商品图旁边的标题元素
  const titleEl = row.querySelector('[class*="title"], [class*="goods-name"], [class*="item-title"]');
  const item_title = textOf(titleEl) || '';

  // 买家昵称
  const buyerEl = row.querySelector('[class*="buyer"], [class*="nick"], [class*="user-name"]');
  const buyer_nick = textOf(buyerEl) || '';

  // 订单状态：找包含「发货/待发货」字样的元素
  const statusEl = row.querySelector('[class*="status"], [class*="order-status"]');
  const order_status = textOf(statusEl) || '';

  // 会话ID：有些订单行会带「联系买家」按钮，点了才知道；这里先留空
  const session_id = row.getAttribute('data-session-id') || null;

  return {
    order_no,
    item_id: item_id ? String(item_id) : null,
    item_title,
    buyer_nick,
    order_status,
    session_id,
    raw: raw.slice(0, 300),
  };
}

function isPendingShip(order) {
  if (!order) return false;
  const st = order.order_status || '';
  // 命中「待发货」且没有「已发货」
  if (/待发货/.test(st) && !/已发货/.test(st)) return true;
  // 有的页面状态列可能为空，此时靠文本兜底
  if (!st) return /待发货/.test(order.raw || '');
  return false;
}

function scanOrders() {
  const found = pickAll(SEL.orderRow);
  if (!found) return;

  for (const row of found.list) {
    const order = extractOrder(row);
    if (!order || !order.order_no) continue;
    if (!isPendingShip(order)) continue;

    if (seen.has(order.order_no)) continue;
    seen.add(order.order_no);

    ipcRenderer.send('order:pending', order);
  }
}

function boot() {
  // 页面可能懒加载，轮询比 MutationObserver 更稳（订单页常有虚拟列表）
  const timer = setInterval(scanOrders, 3000);
  scanOrders();

  window.addEventListener('beforeunload', () => clearInterval(timer));

  console.log('[xy-order] ready | rowSelector =',
    (pickAll(SEL.orderRow) || {}).selector || 'not-found');

  // 每 5 分钟清一次已见集合，允许同一订单被重新检查（幂等靠主进程）
  setInterval(() => seen.clear(), 5 * 60_000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

/* ------------------------------ 发货操作 ------------------------------ */

const SHIP_SEL = {
  // 订单行里的「发货」按钮
  shipBtn: [
    'button[class*="ship"]',
    '[class*="ship-btn"]',
    'button[class*="deliver"]',
    '[title*="发货"]',
    'a[class*="发货"]',
  ],
  // 发货弹窗里的快递单号输入
  waybillInput: [
    'input[placeholder*="单号"]',
    'input[class*="waybill"]',
    'input[name*="waybill"]',
    'input[placeholder*="物流"]',
  ],
  // 快递公司选择
  expressSelect: [
    'input[placeholder*="快递"]',
    'input[placeholder*="物流公司"]',
    'select[class*="express"]',
  ],
  // 确认按钮
  confirmBtn: [
    'button[class*="confirm"]',
    'button[class*="submit"]',
    'button[class*="primary"]',
  ],
};

function pickS(selectors) {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function visibleS(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}

/** 找到指定订单号所在的行 */
function findOrderRow(orderNo) {
  const rows = Array.from(document.querySelectorAll('[data-order-no],[class*="order-item"],[class*="orderItem"],[class*="order-row"],tbody tr'));
  return rows.filter((row) => {
    const numbers = new Set((row.textContent || '').match(/\b\d{15,25}\b/g) || []);
    return row.getAttribute('data-order-no') === String(orderNo) || numbers.size === 1 && numbers.has(String(orderNo));
  }).sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;
}

async function shipOrder({ orderNo, waybillNo, expressCode }) {
  const row = findOrderRow(orderNo);
  if (!row) return { ok: false, error: `页面上找不到订单 ${orderNo}` };

  // 1. 点这个订单行里的「发货」按钮
  let btn = null;
  for (const sel of SHIP_SEL.shipBtn) {
    try {
      const found = row.querySelector(sel);
      if (found && visibleS(found)) { btn = found; break; }
    } catch (_) { /* ignore */ }
  }
  if (!btn) return { ok: false, error: '该订单没有「发货」按钮（可能已发货或状态不对）', needManual: true };

  btn.click();
  await new Promise((r) => setTimeout(r, 1500));

  // 2. 填快递单号
  const input = pickS(SHIP_SEL.waybillInput);
  if (!input) return { ok: false, error: '找不到快递单号输入框', needManual: true };

  input.focus();
  input.value = waybillNo || '';
  input.dispatchEvent(new Event('input', { bubbles: true }));

  // 3. 快递公司（如果可以选）
  if (expressCode) {
    const exp = pickS(SHIP_SEL.expressSelect);
    if (exp) {
      exp.value = expressCode;
      exp.dispatchEvent(new Event('input', { bubbles: true }));
      exp.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  await new Promise((r) => setTimeout(r, 600));

  // 4. 点确认
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"],.ant-modal')).filter(visibleS);
  const buttons = dialogs.length === 1 ? Array.from(dialogs[0].querySelectorAll('button')).filter((node) => visibleS(node) && /^(确认发货|确定发货|确认|确定)$/.test(textOf(node))) : [];
  const confirm = buttons.length === 1 ? buttons[0] : null;
  if (!confirm || !visibleS(confirm)) {
    return { ok: false, error: '找不到确认发货按钮', needManual: true };
  }
  confirm.click();
  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const updated = findOrderRow(orderNo);
    const status = updated?.querySelector('[class*="order-status"],[class*="status"]');
    if (status && /^(已发货|待收货|交易成功|交易完成)$/.test(textOf(status))) return { ok: true, reason: '已核对平台订单发货状态' };
  }
  return { ok: false, uncertain: true, error: '已点击发货，但平台状态未确认，请先人工核对' };
}

ipcRenderer.on('order:ship', async (_e, payload) => {
  let res;
  try {
    res = await shipOrder(payload || {});
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e) };
  }
  ipcRenderer.send('order:ship-result', { ...res, requestId: payload && payload.requestId });
});

window.__xyShip = shipOrder;

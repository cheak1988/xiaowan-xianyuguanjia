'use strict';

/**
 * 虚拟商品自动发货
 *
 * 背景（来自逆向）：
 *   原厂把「卡密自动发货」作为付费权益，实现在订单页里：
 *     - way=1 仅更新订单状态
 *     - way=2 发卡密 + 更新订单状态
 *   发货接口是 /v1/trade/logistics/batch/ship（私有，带签名，不能直接用）。
 *
 * 本项目的做法：
 *   不碰私有接口，改走「官方订单页 UI 自动化 + 聊天窗口发货」：
 *     1. 在官方订单页监听「待发货」订单
 *     2. 匹配到本地商品配置（商品ID → 卡密池）
 *     3. 取一条未使用的卡密
 *     4. 通过 IM 把卡密发给买家
 *     5. 在官方订单页点「发货」→ 选择虚拟发货/无需物流
 *
 *   订单页与 IM 是两个不同的 webview，互不干扰。
 *
 * ⚠️ 平台风险：
 *   自动发货涉及「代替卖家执行交易操作」，属于平台敏感行为。
 *   本模块默认「半自动」：只自动发卡密给买家 + 在本地标记已发，
 *   订单状态更新需要你在官方页面确认一次（或开启 fullAuto）。
 *   请自行评估账号风险。
 */

const store = require('./store');
const crypto = require('crypto');

/* ------------------------------ 卡密池 ------------------------------ */

/**
 * 卡密池结构（存在 store 的 cards 表）：
 *   { id, account_id, item_id, content, status: 'unused'|'used'|'reserved', used_order_no, used_at }
 */

/** 导入卡密：一行一条，自动去重；可按分组导入 */
function importCards({ accountId, itemId, text, groupId }) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const s = store.ready();
  if (!s.cards) s.cards = [];

  const existing = new Set(
    s.cards.filter((c) => c.account_id === Number(accountId) && c.item_id === String(itemId))
      .map((c) => c.content),
  );

  let added = 0;
  let skipped = 0;
  for (const line of lines) {
    if (existing.has(line)) { skipped += 1; continue; }
    s.cards.push({
      id: s.cards.reduce((m, c) => Math.max(m, c.id), 0) + 1,
      account_id: Number(accountId),
      item_id: String(itemId),
      group_id: groupId ? Number(groupId) : null,
      content: line,
      status: 'unused',
      used_order_no: null,
      used_at: null,
      created_at: Date.now(),
    });
    existing.add(line);
    added += 1;
  }
  store.scheduleSave();
  return { added, skipped, total: lines.length };
}

function listCards(accountId, itemId) {
  const s = store.ready();
  const acc = accountId == null || accountId === '' ? null : Number(accountId);
  return (s.cards || [])
    .filter((c) => (!acc || c.account_id === acc) && (!itemId || c.item_id === String(itemId)))
    .sort((a, b) => a.id - b.id);
}

function cardStats(accountId, itemId) {
  const cards = listCards(accountId, itemId);
  const unused = cards.filter((c) => c.status === 'unused').length;
  const used = cards.filter((c) => c.status === 'used').length;
  const reserved = cards.filter((c) => c.status === 'reserved').length;
  return { total: cards.length, unused, used, reserved };
}

function removeCard(id) {
  const s = store.ready();
  if ((s.cards || []).some((card) => card.id === Number(id) && card.status === 'reserved')) {
    throw new Error('该卡密的发送结果待确认，不能删除');
  }
  s.cards = (s.cards || []).filter((c) => c.id !== Number(id));
  store.scheduleSave();
}

function clearCards(accountId, itemId) {
  const s = store.ready();
  if (listCards(accountId, itemId).some((card) => card.status === 'reserved')) {
    throw new Error('存在占用或待核对卡密，请先核对发货结果');
  }
  s.cards = (s.cards || []).filter(
    (c) => !(c.account_id === Number(accountId) && c.item_id === String(itemId)),
  );
  store.scheduleSave();
}

/* ------------------------------ 商品配置 ------------------------------ */

/**
 * 自动发货配置，三级作用域：
 *   scope = 'global'  全局默认：所有店铺所有商品都能用（不含 item_id）
 *   scope = 'account' 指定店铺默认：该店铺下未单独配置的商品
 *   scope = 'item'    指定商品：优先级最高
 *
 * 同时支持按 SKU 绑定：skus = [{ spec_name, spec_value, content|api_url|card_type }]
 * 买家拍多个数量时按 buy_num 依次取多份。
 *
 * template 支持占位符：
 *   {卡密}  {订单号}  {买家昵称}  {商品标题}  {时间}  {卡密序号}  {购买数量}
 */

function normalizeScope(rule) {
  const scope = ['global', 'account', 'item'].includes(rule.scope) ? rule.scope : 'item';
  if (scope === 'global') return 'global';
  if (scope === 'account') return 'account';
  return 'item';
}

function listDeliverRules(accountId) {
  const s = store.ready();
  const acc = accountId == null || accountId === '' ? null : Number(accountId);
  return (s.deliverRules || [])
    .filter((r) => r.scope === 'global' || (acc ? r.account_id === acc : true))
    .sort((a, b) => {
      const rank = { item: 0, account: 1, global: 2 };
      return (rank[a.scope || 'item'] - rank[b.scope || 'item']) || a.id - b.id;
    });
}

/**
 * 给一个订单挑规则：商品级 > 账号级 > 全局。
 * 商品级还要求 item_id 匹配；同级别取 id 最小（最早创建）。
 */
function resolveDeliverRule(accountId, itemId) {
  const rules = listDeliverRules(accountId).filter((r) => r.enabled);
  const item = String(itemId || '');
  return rules.find((r) => (r.scope || 'item') === 'item' && r.item_id === item)
    || rules.find((r) => r.scope === 'account')
    || rules.find((r) => r.scope === 'global')
    || null;
}

/** 订单的 SKU 是否命中规则里的绑定 */
function matchSkuBinding(rule, order) {
  const bindings = Array.isArray(rule.skus) ? rule.skus.filter((row) => row && row.content || row && row.api_url) : [];
  if (!bindings.length) return null;
  const specName = String(order.spec_name || '').trim();
  const specValue = String(order.spec_value || '').trim();
  if (!specValue) return null;
  return bindings.find((row) => (!row.spec_name || row.spec_name === specName)
    && String(row.spec_value || '') === specValue) || null;
}

function saveDeliverRule(rule) {
  const s = store.ready();
  if (!s.deliverRules) s.deliverRules = [];

  const scope = normalizeScope(rule);
  const data = {
    account_id: scope === 'global' ? null : Number(rule.accountId),
    scope,
    item_id: scope === 'item' ? String(rule.item_id || '').trim() : '',
    item_title: rule.item_title || '',
    enabled: rule.enabled === false ? false : true,
    // 允许显式传空模板（发货时会校验并报错），不再静默回退默认文案
    template: rule.template !== undefined && rule.template !== null
      ? String(rule.template)
      : '您好，您的卡密是：{卡密}\n订单号：{订单号}\n请尽快使用，有问题随时联系~',
    delay_seconds: Math.max(0, Number(rule.delay_seconds) || 0),
    msg_gap_ms: Math.max(0, Number(rule.msg_gap_ms) || 800),
    full_auto: !!rule.full_auto,
    card_type: ['text', 'image', 'api'].includes(rule.card_type) ? rule.card_type : 'text',
    api_url: rule.api_url || '',
    group_id: rule.group_id ? Number(rule.group_id) : null,
    skus: Array.isArray(rule.skus) ? rule.skus.map((row) => ({
      spec_name: String(row.spec_name || ''),
      spec_value: String(row.spec_value || ''),
      card_type: ['text', 'image', 'api'].includes(row.card_type) ? row.card_type : null,
      api_url: String(row.api_url || ''),
      content: String(row.content || ''),
    })) : [],
  };

  if (scope === 'item' && !data.item_id) throw new Error('商品级规则必须填写商品ID');
  if (scope !== 'global' && !data.account_id) throw new Error('请选择店铺');

  if (rule.id) {
    const idx = s.deliverRules.findIndex((r) => r.id === Number(rule.id));
    if (idx >= 0) {
      s.deliverRules[idx] = { ...s.deliverRules[idx], ...data };
      store.scheduleSave();
      return s.deliverRules[idx].id;
    }
  }

  // 同作用域同目标视为同一规则，避免重复条目
  const dup = s.deliverRules.find((r) => (r.scope || 'item') === data.scope
    && (data.scope === 'global' ? true : r.account_id === data.account_id)
    && (data.scope === 'item' ? r.item_id === data.item_id : true));
  if (dup) {
    Object.assign(dup, data);
    store.scheduleSave();
    return dup.id;
  }

  const id = s.deliverRules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  s.deliverRules.push({ id, ...data, created_at: Date.now() });
  store.scheduleSave();
  return id;
}

function removeDeliverRule(id) {
  const s = store.ready();
  s.deliverRules = (s.deliverRules || []).filter((r) => r.id !== Number(id));
  store.scheduleSave();
}

/* ------------------------------ 发货前风控 ------------------------------ */

/** 未完成订单的状态判定：只有这些状态才算「交易还在进行」 */
const OPEN_ORDER_RE = /待付款|待发货|已发货|待收货|待评价/;
const CLOSED_ORDER_RE = /交易成功|交易完成|已完成|已收货|关闭|取消|退款成功|已退款/;

function isOpenOrder(order) {
  const status = String((order && order.status) || '');
  if (CLOSED_ORDER_RE.test(status)) return false;
  return OPEN_ORDER_RE.test(status) || status === '';
}

/**
 * 发货前风控：命中任何一条就拦截，返回 { hit, rule, reason }。
 * 这里只读本地数据，不额外请求平台，所以判定是保守的（宁可放过也不误拦）。
 *
 * @param {object} p
 * @param {number} p.accountId
 * @param {object} p.order  当前订单
 * @param {Array}  [p.otherOrders]  用于「买家已有订单」判定的订单集合（默认取本店铺）
 */
function evaluateDeliveryRisk({ accountId, order, otherOrders }) {
  order = store.resolveOrderBuyer(accountId, order || {});
  const settings = store.getDeliveryRiskSettings();
  const orderNo = String((order && order.order_no) || '');
  const buyerUid = String((order && order.buyer_uid) || '');
  const itemId = String((order && order.item_id) || '');
  const block = (rule, reason) => ({ hit: true, rule, reason });
  const pass = { hit: false, rule: '', reason: '' };

  if (!orderNo) return pass;
  if (order.buyer_identity_conflict) return block('buyerIdentityConflict', '买家身份与关联会话冲突，请人工核对');
  const needsUid = ['buyerBlacklist', 'buyerHasOpenOrder', 'buyerHasOpenOrderGlobal']
    .some((key) => settings[key] && settings[key].enabled);
  if (needsUid && (!buyerUid || buyerUid.startsWith('nick:'))) {
    return block('buyerIdentityUnknown', '无法核验买家身份，未执行依赖买家身份的风控，请先关联正确会话');
  }

  // 1. 买家黑名单：按买家 UID 命中当前店铺的客户档案
  if (settings.buyerBlacklist && settings.buyerBlacklist.enabled && buyerUid) {
    const customer = (store.ready().customers || []).find((row) =>
      row.account_id === Number(accountId) && String(row.buyer_uid) === buyerUid);
    if (customer && customer.blacklisted) {
      return block('buyerBlacklist', `买家「${customer.nick || buyerUid}」在本店黑名单中`);
    }
  }

  // 2. 买家在本店还有别的未完成订单
  if (settings.buyerHasOpenOrder && settings.buyerHasOpenOrder.enabled && buyerUid) {
    const sameOnly = !!settings.buyerHasOpenOrder.sameItemOnly;
    const rows = (otherOrders || store.listOrders(accountId)).filter((row) =>
      row.order_no !== orderNo && String(row.buyer_uid || '') === buyerUid
      && isOpenOrder(row) && (!sameOnly || String(row.item_id || '') === itemId));
    if (rows.length) {
      return block('buyerHasOpenOrder',
        `买家在本店还有 ${rows.length} 笔未完成订单（${rows[0].order_no}）`);
    }
  }

  // 3. 买家在本机任一店铺还有未完成订单（跨账号防薅）
  if (settings.buyerHasOpenOrderGlobal && settings.buyerHasOpenOrderGlobal.enabled && buyerUid) {
    const sameOnly = !!settings.buyerHasOpenOrderGlobal.sameItemOnly;
    const rows = store.listOrders(null).filter((row) =>
      !(row.account_id === Number(accountId) && row.order_no === orderNo)
      && String(row.buyer_uid || '') === buyerUid
      && isOpenOrder(row) && (!sameOnly || String(row.item_id || '') === itemId));
    if (rows.length) {
      return block('buyerHasOpenOrderGlobal',
        `买家在其他店铺还有 ${rows.length} 笔未完成订单（店铺 ${rows[0].account_id} / ${rows[0].order_no}）`);
    }
  }

  // 4. 买家信用度（订单页能抓到的评价数）
  if (settings.buyerLowCredit && settings.buyerLowCredit.enabled) {
    const threshold = Math.max(0, Number(settings.buyerLowCredit.threshold) || 0);
    const credit = order && order.buyer_credit != null ? Number(order.buyer_credit) : null;
    if (credit == null || !Number.isFinite(credit)) return block('buyerCreditUnknown', '未读取到买家信用数据，请人工核对');
    if (credit != null && Number.isFinite(credit) && credit <= threshold) {
      return block('buyerLowCredit', `买家评价数为 ${credit}，不高于阈值 ${threshold}`);
    }
  }

  return pass;
}

/* ------------------------------ 发货记录 ------------------------------ */

function listDeliverLog(accountId, limit) {
  const s = store.ready();
  const acc = accountId == null || accountId === '' ? null : Number(accountId);
  return (s.deliverLog || [])
    .filter((x) => !acc || x.account_id === acc)
    .slice(-(limit || 100))
    .reverse();
}

function pushDeliverLog(entry) {
  const s = store.ready();
  if (!s.deliverLog) s.deliverLog = [];
  s.deliverLog.push({ ts: Date.now(), ...entry });
  if (s.deliverLog.length > 500) s.deliverLog = s.deliverLog.slice(-500);
  store.scheduleSave();
}

/* ------------------------------ 核心：处理一个待发货订单 ------------------------------ */

const inFlight = new Map(); // account + order，任务取消与并发保护

function cancelAccount(accountId) {
  for (const job of inFlight.values()) {
    if (job.accountId === Number(accountId)) job.cancelled = true;
  }
}

function importImageCards({ accountId, itemId, images }) {
  if (!store.getAccount(Number(accountId)) || !String(itemId || '').trim()) throw new Error('请先选择店铺和商品');
  if (!Array.isArray(images) || !images.length) throw new Error('请选择图片卡密');
  for (const image of images) {
    if (!/^[a-f0-9-]{36}$/i.test(image.assetId || '') || !/^[a-f0-9]{64}$/i.test(image.sha256 || '')) throw new Error('图片卡密文件无效');
    if (!['jpg', 'png'].includes(image.extension) || image.size > 3 * 1024 * 1024) throw new Error('闲鱼聊天图片卡密仅支持3MB以内的JPG或PNG');
  }
  const cards = store.ready().cards;
  let added = 0, skipped = 0;
  for (const image of images) {
    if (cards.some((row) => row.account_id === Number(accountId) && row.item_id === String(itemId) && row.image_hash === image.sha256)) { skipped++; continue; }
    cards.push({ id: cards.reduce((max, row) => Math.max(max, row.id), 0) + 1, account_id: Number(accountId), item_id: String(itemId),
      type: 'image', asset_id: image.assetId, image_hash: image.sha256, content: image.name || '图片卡密', status: 'unused', created_at: Date.now() }); added++;
  }
  store.persist(); return { added, skipped, total: images.length };
}

function getDeliveryState(accountId, orderNo) {
  const entries = (store.ready().deliveries || []).filter((entry) => entry.account_id === Number(accountId)
    && entry.order_no === String(orderNo));
  return entries.find((entry) => ['reserved', 'sending', 'uncertain'].includes(entry.status))
    || entries.find((entry) => entry.status === 'sent');
}

function resolveDelivery(accountId, orderNo, received) {
  accountId = Number(accountId);
  if (inFlight.has(`${accountId}:${orderNo}`)) return { ok: false, error: '订单仍在处理中，请稍后核对' };
  const entries = store.ready().deliveries.filter((entry) => entry.account_id === accountId
    && entry.order_no === String(orderNo) && entry.status === 'uncertain');
  if (!entries.length) return { ok: false, error: '没有待核对的投递记录' };
  const previousEntries = entries.map((entry) => ({ ...entry }));
  const previousCards = [];
  for (const entry of entries) {
    entry.status = received ? 'sent' : 'failed';
    entry.reason = received ? '人工核对：买家已收到' : '人工核对：买家未收到，原卡密保留占用';
    entry.updated_at = Date.now();
    // 未收到也不重新出售曾经尝试发送的卡密，防止它被迟到的消息泄露。
    const cardIds = Array.isArray(entry.card_ids) && entry.card_ids.length
      ? entry.card_ids : (entry.card_id ? [entry.card_id] : []);
    for (const cardId of cardIds) {
      const card = store.ready().cards.find((item) => item.account_id === accountId && item.id === cardId);
      if (card) previousCards.push({ card, value: { ...card } });
      if (card && received) Object.assign(card, { status: 'used', used_order_no: String(orderNo), used_at: Date.now() });
    }
  }
  try { store.persist(); }
  catch (error) {
    entries.forEach((entry, index) => Object.assign(entry, previousEntries[index]));
    for (const previous of previousCards) Object.assign(previous.card, previous.value);
    return { ok: false, error: `核对结果未保存，仍保持冻结：${error.message}` };
  }
  pushDeliverLog({ account_id: accountId, order_no: String(orderNo), ok: !!received,
    reason: received ? '人工核对已收到' : '人工核对未收到，可使用新卡密补发' });
  return { ok: true, reason: received ? '已确认收到' : '可补发新卡密，原卡密继续保留' };
}

function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\S+?)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

/** 取一份可用的卡密（跳过已占用/已用的） */
function pickUnusedCard(accountId, itemId, cardType, groupId) {
  return listCards(accountId, itemId).find((candidate) => candidate.status === 'unused'
    && (!groupId || candidate.group_id === Number(groupId))
    && (cardType === 'image'
      ? candidate.type === 'image' && candidate.asset_id
      : candidate.type !== 'image'));
}

/**
 * @param {object} p
 * @param {number} p.accountId
 * @param {object} p.order   { order_no, item_id, item_title, buyer_nick, buyer_uid, session_id, order_status, buy_num, spec_name, spec_value }
 * @param {Function} p.sendFn  发送卡密到 IM 的函数 (sessionId, text) => Promise
 * @param {Function} [p.markShippedFn]  在官方订单页执行发货的函数
 * @param {boolean} [p.skipRisk]  人工补发时跳过风控（默认 false）
 * @returns {Promise<{ok:boolean, reason:string, card?:string}>}
 */
async function handleOrder({ accountId, order, sendFn, markShippedFn, resend = false, cardContent, skipRisk = false }) {
  accountId = Number(accountId);
  order = store.resolveOrderBuyer(accountId, order);
  const orderNo = String(order.order_no || '');
  if (!orderNo) return { ok: false, reason: '缺少订单号' };
  const account = store.getAccount(accountId);
  if (!account || account.disabled) return { ok: false, reason: '店铺不存在或已停用' };
  if (!order.session_id || String(order.session_id).startsWith('nick:')) {
    return { ok: false, reason: '缺少可核验的买家会话ID，请先关联正确会话' };
  }
  const done = getDeliveryState(accountId, orderNo);
  if (done && (!resend || done.status !== 'sent')) {
    return { ok: false, skipped: true, reason: done.status === 'sent'
      ? '该订单已经发货，自动重发已拦截' : '该订单发送结果待人工核对，自动重发已暂停' };
  }
  const key = `${accountId}:${orderNo}`;
  if (inFlight.has(key)) return { ok: false, skipped: true, reason: '该订单正在处理中，请稍后' };
  const job = { accountId, cancelled: false };
  inFlight.set(key, job);
  let cards = [];
  let entry;
  let dispatched = false;
  let sentSegments = 0;
  let selectedRule;
  const allowed = () => !job.cancelled && !!store.getAccount(accountId)
    && !store.getAccount(accountId).disabled && (!selectedRule || listDeliverRules(accountId).some((rule) => rule.id === selectedRule.id && rule.enabled));
  const releaseCards = () => {
    for (const card of cards) {
      if (card && card.id && card.status === 'reserved') card.status = 'unused';
    }
  };
  const fail = (reason, uncertain = false) => {
    if (entry && store.getAccount(accountId)) {
      entry.status = uncertain ? 'uncertain' : 'failed';
      entry.reason = reason;
      entry.sent_segments = sentSegments;
      entry.updated_at = Date.now();
      if (!uncertain) releaseCards();
      store.persist();
      pushDeliverLog({ account_id: accountId, order_no: orderNo, item_id: order.item_id,
        ok: false, uncertain, reason });
    }
    return { ok: false, uncertain, reason };
  };
  try {
    // 风控只在「首次自动发货」时评估；人工补发由操作者自己判断
    if (!resend && !skipRisk) {
      const risk = evaluateDeliveryRisk({ accountId, order });
      if (risk.hit) {
        store.pushDeliveryBlockLog({
          account_id: accountId, order_no: orderNo, item_id: order.item_id,
          buyer_uid: order.buyer_uid || null, buyer_nick: order.buyer_nick || '',
          rule: risk.rule, reason: risk.reason,
        });
        pushDeliverLog({ account_id: accountId, order_no: orderNo, item_id: order.item_id,
          ok: false, blocked: true, rule: risk.rule, reason: `风控拦截：${risk.reason}` });
        return { ok: false, blocked: true, riskRule: risk.rule, reason: `风控拦截：${risk.reason}` };
      }
    }

    const rule = resolveDeliverRule(accountId, order.item_id);
    selectedRule = rule;
    if (!rule) return { ok: false, reason: `商品 ${order.item_id} 未配置自动发货` };
    if (!rule.template || !String(rule.template).trim()) {
      return { ok: false, reason: '该商品的发货模板为空，请先配置模板' };
    }

    // SKU 绑定优先：命中就覆盖默认卡密类型与接口
    const skuBind = matchSkuBinding(rule, order);
    const cardType = skuBind && skuBind.card_type ? skuBind.card_type : rule.card_type;
    const apiUrl = skuBind && skuBind.api_url ? skuBind.api_url : rule.api_url;
    const skuContent = skuBind && skuBind.content ? skuBind.content : '';

    // 购买数量：至少 1，封顶避免异常值把卡池抽干
    const quantity = Math.max(1, Math.min(50, Number(order.buy_num) || 1));

    if (cardContent) {
      cards = [{ content: String(cardContent) }];
    } else if (cardType === 'api') {
      if (!apiUrl) return { ok: false, reason: '请配置取卡API地址' };
      cards = Array.from({ length: quantity }, () => ({ content: '', api: true }));
    } else if (skuContent) {
      // SKU 固定内容（一码一单）：多数量时也只有这一份，重复发送会泄露同一码
      cards = [{ content: skuContent, fixed: true }];
    } else {
      const groupId = rule.group_id || null;
      const pool = listCards(accountId, order.item_id).filter((candidate) => candidate.status === 'unused'
        && (!groupId || candidate.group_id === Number(groupId))
        && (cardType === 'image'
          ? candidate.type === 'image' && candidate.asset_id
          : candidate.type !== 'image'));
      if (!pool.length) return { ok: false, reason: `商品 ${order.item_id} 卡密不足` };
      if (pool.length < quantity) {
        return { ok: false, reason: `卡密不足：需要 ${quantity} 条，库存仅 ${pool.length} 条` };
      }
      cards = pool.slice(0, quantity);
    }

    // 在任何 await 之前占用并落盘，两个订单不能领取同一张卡。
    for (const card of cards) if (card.id) card.status = 'reserved';
    entry = { account_id: accountId, order_no: orderNo,
      card_id: cards[0] && cards[0].id || null,
      card_ids: cards.map((card) => card.id).filter(Boolean),
      quantity,
      attempt_id: crypto.randomUUID(), status: 'reserved', sent_segments: 0, updated_at: Date.now() };
    store.ready().deliveries.push(entry);
    store.persist();
    if (rule.delay_seconds > 0) await new Promise((resolve) => setTimeout(resolve, rule.delay_seconds * 1000));
    if (!allowed() || !listDeliverRules(accountId).some((current) => current.id === rule.id && current.enabled)) {
      return fail('店铺或发货规则已停用，已取消发送');
    }

    // API 取卡：逐份取，任何一份失败都整体判为不确定（已发的部分不能当没发生）
    const payloads = [];
    if (cardType === 'api' && !cardContent) {
      for (let i = 0; i < cards.length; i++) {
        try {
          const got = await fetchCardFromApi(apiUrl, { orderNo, itemId: order.item_id });
          if (!got) throw new Error('接口未返回卡密');
          payloads.push(got);
        } catch (e) {
          return fail(`第 ${i + 1}/${cards.length} 份取卡失败：${e.message}`, true);
        }
      }
      entry.api_payload = payloads.length === 1 ? payloads[0] : payloads;
      store.persist();
    } else {
      for (const card of cards) payloads.push(card.content);
    }

    const baseVars = {
      订单号: orderNo,
      买家昵称: order.buyer_nick || '',
      商品标题: order.item_title || rule.item_title || '',
      时间: new Date().toLocaleString('zh-CN', { hour12: false }),
      购买数量: String(quantity),
    };

    const sentTexts = [];
    // 每一份卡密 = 一组消息；数量 > 1 时逐份发
    for (let index = 0; index < payloads.length; index++) {
      const cardPayload = payloads[index];
      const vars = {
        ...baseVars,
        卡密: cardType === 'image' ? '（见图片）' : cardPayload,
        卡密序号: String(index + 1),
      };
      const segments = splitTemplate(rule.template)
        .map((seg) => renderTemplate(seg, vars))
        .map((seg) => seg.trim())
        .filter(Boolean);
      if (cardType === 'image' && cards[index] && cards[index].asset_id) {
        segments.unshift({ type: 'image', assetId: cards[index].asset_id, content: cards[index].content });
      }
      if (!segments.length) return fail('模板渲染后为空');

      for (let i = 0; i < segments.length; i++) {
        if (!allowed()) return fail('店铺已停用，剩余消息已取消', sentSegments > 0);
        entry.status = 'sending';
        store.persist();
        dispatched = true;
        const segment = segments[i], image = typeof segment === 'object';
        const sent = await sendFn(order.session_id, image ? segment.content : segment,
          { kind: image ? 'image' : 'text', assetId: segment && segment.assetId, guard: allowed });
        if (!sent || sent.ok !== true) {
          return fail(`第 ${index + 1}/${payloads.length} 份第 ${i + 1}/${segments.length} 条发送未确认：${sent && (sent.error || sent.reason) || '页面无确认'}`,
            sentSegments > 0 || !sent || sent.uncertain !== false);
        }
        sentSegments += 1;
        entry.sent_segments = sentSegments;
        store.persist();
        if (i < segments.length - 1 && rule.msg_gap_ms > 0) {
          await new Promise((r) => setTimeout(r, rule.msg_gap_ms));
        }
      }
      sentTexts.push(segments.map((segment) => typeof segment === 'string' ? segment : '[图片卡密]').join('\n---\n'));
      // 多份之间也留间隔
      if (index < payloads.length - 1 && rule.msg_gap_ms > 0) {
        await new Promise((r) => setTimeout(r, rule.msg_gap_ms));
      }
    }

    // 标记已用
    if (!allowed()) return fail('店铺已停用，请核对发送结果', true);
    for (const card of cards) {
      if (!card.id) continue;
      card.status = 'used';
      card.used_order_no = orderNo;
      card.used_at = Date.now();
    }
    entry.status = 'sent';
    entry.updated_at = Date.now();
    store.persist();
    store.markAiActivity(accountId, order.session_id, Date.now());

    // 可选：自动在官方订单页点发货
    let shipped = false;
    if (rule.full_auto && typeof markShippedFn === 'function') {
      try {
        shipped = await markShippedFn(order);
      } catch (_) {
        shipped = false;
      }
    }

    pushDeliverLog({
      account_id: accountId, order_no: orderNo, item_id: order.item_id,
      buyer_nick: order.buyer_nick || '',
      card_id: cards[0] && cards[0].id, quantity,
      ok: true, shipped,
      reason: shipped ? `已发 ${quantity} 份卡密并更新订单` : `已发 ${quantity} 份卡密（订单待手动确认）`,
    });

    return {
      ok: true,
      card: payloads[0],
      text: sentTexts.join('\n========\n'),
      quantity,
      shipped,
      reason: shipped ? '已自动发货' : '已发卡密，请在订单页确认发货',
    };
  } catch (e) {
    // 写盘或发送抛异常时保留占用，禁止将可能已发出的卡密放回库存。
    if (entry) entry.status = 'uncertain';
    for (const card of cards) if (card && card.id) card.status = 'reserved';
    try { if (store.getAccount(accountId)) store.persist(); } catch (error) { console.error('[delivery] 状态保存失败', error.message); }
    return { ok: false, uncertain: !!entry || dispatched, reason: String(e && e.message || e) };
  } finally {
    inFlight.delete(key);
  }
}

/** 手工发一条指定卡密（测试用） */
function previewText(rule, order, cardContent) {
  return renderTemplate(rule.template, {
    卡密: cardContent,
    订单号: order.order_no,
    买家昵称: order.buyer_nick || '',
    商品标题: order.item_title || rule.item_title || '',
    时间: new Date().toLocaleString('zh-CN', { hour12: false }),
  });
}


/** 把模板按 --- 拆成多段（--- 单独一行） */
function splitTemplate(template) {
  const tpl = String(template || '');
  // 支持 ---、--- 前后带空格、以及三个以上的横线
  return tpl.split(/^\s*-{3,}\s*$/m);
}

/** 从外部 API 取卡密：GET 返回纯文本或 JSON */
function fetchCardFromApi(url, { orderNo, itemId }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url
        .replace(/\{订单号\}/g, encodeURIComponent(orderNo || ''))
        .replace(/\{商品ID\}/g, encodeURIComponent(itemId || '')));
    } catch (_) { reject(new Error('接口地址不合法')); return; }

    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const req = lib.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        // 尝试按 JSON 解析，取常见字段
        try {
          const j = JSON.parse(text);
          const v = j.card || j.card_key || j.key || (typeof j.data === 'string' ? j.data : j.data?.card || j.data?.card_key || j.data?.key);
          if (typeof v !== 'string' && typeof v !== 'number') { reject(new Error('接口未返回文本卡密')); return; }
          resolve(String(v));
        } catch (_) {
          resolve(text);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('接口超时')));
    req.on('error', (e) => reject(new Error(String(e && e.message || e))));
    req.end();
  });
}

module.exports = {
  importCards, importImageCards, listCards, cardStats, removeCard, clearCards,
  listDeliverRules, resolveDeliverRule, matchSkuBinding, saveDeliverRule, removeDeliverRule,
  evaluateDeliveryRisk, isOpenOrder,
  handleOrder, listDeliverLog, pushDeliverLog, previewText, renderTemplate, getDeliveryState,
  cancelAccount, resolveDelivery,
};

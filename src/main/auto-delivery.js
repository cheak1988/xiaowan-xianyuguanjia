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

/** 导入卡密：一行一条，自动去重 */
function importCards({ accountId, itemId, text }) {
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
  return (s.cards || [])
    .filter((c) => c.account_id === Number(accountId) && (!itemId || c.item_id === String(itemId)))
    .sort((a, b) => a.id - b.id);
}

function cardStats(accountId, itemId) {
  const cards = listCards(accountId, itemId);
  const unused = cards.filter((c) => c.status === 'unused').length;
  const used = cards.filter((c) => c.status === 'used').length;
  return { total: cards.length, unused, used };
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
 * 自动发货配置（每个商品一条）：
 *   { id, account_id, item_id, item_title, enabled, template, delay_seconds, full_auto }
 *
 * template 支持占位符：
 *   {卡密}  {订单号}  {买家昵称}  {商品标题}  {时间}
 */

function listDeliverRules(accountId) {
  const s = store.ready();
  return (s.deliverRules || [])
    .filter((r) => r.account_id === Number(accountId))
    .sort((a, b) => a.id - b.id);
}

function saveDeliverRule(rule) {
  const s = store.ready();
  if (!s.deliverRules) s.deliverRules = [];

  const data = {
    account_id: Number(rule.accountId),
    item_id: String(rule.item_id || '').trim(),
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
  };

  if (!data.item_id) throw new Error('商品ID不能为空');

  if (rule.id) {
    const idx = s.deliverRules.findIndex((r) => r.id === Number(rule.id));
    if (idx >= 0) {
      s.deliverRules[idx] = { ...s.deliverRules[idx], ...data };
      store.scheduleSave();
      return s.deliverRules[idx].id;
    }
  }

  const dup = s.deliverRules.find(
    (r) => r.account_id === data.account_id && r.item_id === data.item_id,
  );
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

/* ------------------------------ 发货记录 ------------------------------ */

function listDeliverLog(accountId, limit) {
  const s = store.ready();
  return (s.deliverLog || [])
    .filter((x) => x.account_id === Number(accountId))
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
    const card = store.ready().cards.find((item) => item.account_id === accountId && item.id === entry.card_id);
    if (card) previousCards.push({ card, value: { ...card } });
    if (card && received) Object.assign(card, { status: 'used', used_order_no: String(orderNo), used_at: Date.now() });
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

/**
 * @param {object} p
 * @param {number} p.accountId
 * @param {object} p.order   { order_no, item_id, item_title, buyer_nick, buyer_uid, session_id, order_status }
 * @param {Function} p.sendFn  发送卡密到 IM 的函数 (sessionId, text) => Promise
 * @param {Function} [p.markShippedFn]  在官方订单页执行发货的函数
 * @returns {Promise<{ok:boolean, reason:string, card?:string}>}
 */
async function handleOrder({ accountId, order, sendFn, markShippedFn, resend = false, cardContent }) {
  accountId = Number(accountId);
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
  let card;
  let entry;
  let dispatched = false;
  let sentSegments = 0;
  let selectedRule;
  const allowed = () => !job.cancelled && !!store.getAccount(accountId)
    && !store.getAccount(accountId).disabled && (!selectedRule || listDeliverRules(accountId).some((rule) => rule.id === selectedRule.id && rule.enabled));
  const fail = (reason, uncertain = false) => {
    if (entry && store.getAccount(accountId)) {
      entry.status = uncertain ? 'uncertain' : 'failed';
      entry.reason = reason;
      entry.sent_segments = sentSegments;
      entry.updated_at = Date.now();
      if (card && card.id && !uncertain) card.status = 'unused';
      store.persist();
      pushDeliverLog({ account_id: accountId, order_no: orderNo, item_id: order.item_id,
        ok: false, uncertain, reason });
    }
    return { ok: false, uncertain, reason };
  };
  try {
    const rules = listDeliverRules(accountId);
    const rule = rules.find((r) => r.enabled && r.item_id === String(order.item_id));
    selectedRule = rule;
    if (!rule) return { ok: false, reason: `商品 ${order.item_id} 未配置自动发货` };
    if (!rule.template || !String(rule.template).trim()) {
      return { ok: false, reason: '该商品的发货模板为空，请先配置模板' };
    }
    card = cardContent ? { content: String(cardContent) }
      : rule.card_type === 'api' ? { content: '' }
        : listCards(accountId, order.item_id).find((candidate) => candidate.status === 'unused'
          && (rule.card_type === 'image' ? candidate.type === 'image' && candidate.asset_id : candidate.type !== 'image'));
    if (!card) return { ok: false, reason: `商品 ${order.item_id} 卡密不足` };
    // 在任何 await 之前占用并落盘，两个订单不能领取同一张卡。
    if (card.id) card.status = 'reserved';
    entry = { account_id: accountId, order_no: orderNo, card_id: card.id || null,
      attempt_id: crypto.randomUUID(), status: 'reserved', sent_segments: 0, updated_at: Date.now() };
    store.ready().deliveries.push(entry);
    store.persist();
    if (rule.delay_seconds > 0) await new Promise((resolve) => setTimeout(resolve, rule.delay_seconds * 1000));
    if (!allowed() || !listDeliverRules(accountId).some((current) => current.id === rule.id && current.enabled)) {
      return fail('店铺或发货规则已停用，已取消发送');
    }
    let cardPayload = card.content;
    if (rule.card_type === 'api' && !rule.api_url) return fail('请配置取卡API地址');
    if (rule.card_type === 'api' && rule.api_url) {
      try {
        const got = await fetchCardFromApi(rule.api_url, { orderNo, itemId: order.item_id });
        if (!got) throw new Error('接口未返回卡密');
        cardPayload = got;
        entry.api_payload = cardPayload; store.persist();
      } catch (e) {
        return fail(`取卡接口失败：${e.message}`, true);
      }
    }

    const vars = {
      卡密: rule.card_type === 'image' ? '（见图片）' : cardPayload,
      订单号: orderNo,
      买家昵称: order.buyer_nick || '',
      商品标题: order.item_title || rule.item_title || '',
      时间: new Date().toLocaleString('zh-CN', { hour12: false }),
    };

    // 多段模板：用 --- 分隔，按顺序逐条发送
    const segments = splitTemplate(rule.template)
      .map((seg) => renderTemplate(seg, vars))
      .map((seg) => seg.trim())
      .filter(Boolean);
    if (rule.card_type === 'image') segments.unshift({ type: 'image', assetId: card.asset_id, content: card.content });

    if (!segments.length) {
      return fail('模板渲染后为空');
    }

    const text = segments.map((segment) => typeof segment === 'string' ? segment : '[图片卡密]').join('\n---\n');

    // 逐条发送
    for (let i = 0; i < segments.length; i++) {
      if (!allowed()) return fail('店铺已停用，剩余消息已取消', sentSegments > 0);
      entry.status = 'sending';
      store.persist();
      dispatched = true;
      const segment = segments[i], image = typeof segment === 'object';
      const sent = await sendFn(order.session_id, image ? segment.content : segment,
        { kind: image ? 'image' : 'text', assetId: image ? segment.assetId : undefined, guard: allowed });
      if (!sent || sent.ok !== true) {
        return fail(`第 ${i + 1}/${segments.length} 条发送未确认：${sent && (sent.error || sent.reason) || '页面无确认'}`,
          sentSegments > 0 || !sent || sent.uncertain !== false);
      }
      sentSegments += 1;
      entry.sent_segments = sentSegments;
      store.persist();
      // 多条之间留间隔，避免被判定刷屏
      if (i < segments.length - 1 && rule.msg_gap_ms > 0) {
        await new Promise((r) => setTimeout(r, rule.msg_gap_ms));
      }
    }

    // 标记已用
    if (!allowed()) return fail('店铺已停用，请核对发送结果', true);
    if (card.id) {
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
      card_id: card.id, ok: true, shipped,
      reason: shipped ? '已发卡密并更新订单' : '已发卡密（订单待手动确认）',
    });

    return {
      ok: true,
      card: card.content,
      text,
      shipped,
      reason: shipped ? '已自动发货' : '已发卡密，请在订单页确认发货',
    };
  } catch (e) {
    // 写盘或发送抛异常时保留占用，禁止将可能已发出的卡密放回库存。
    if (entry) entry.status = 'uncertain';
    if (card && card.id) card.status = 'reserved';
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
  listDeliverRules, saveDeliverRule, removeDeliverRule,
  handleOrder, listDeliverLog, pushDeliverLog, previewText, renderTemplate, getDeliveryState, cancelAccount, resolveDelivery,
};

'use strict';

const store = require('./store');

// 仅接受完成状态，不能把「待买家确认收货」当作已收货。
const CLOSED_STATUS_RE = /^(?:交易成功|交易完成|已收货|已完成|(?:买家)?已确认收货)$/;
const ACTIONS = ['thanks', 'flower', 'rate'];
let sendFn, orderAction;
let notify = () => {};
let now = () => Date.now();
let canExecute = () => true;
let timer = null, draining = null, stopped = true;

function isClosedDeal(order) { return CLOSED_STATUS_RE.test(String(order && order.status || '').trim()); }
function shouldTrigger(prev, next) { return !isClosedDeal({ status: prev }) && isClosedDeal({ status: next }); }
function records() { return store.ready().interactionActions; }
function existing(accountId, orderNo, action) {
  return records().find((row) => row.account_id === Number(accountId)
    && row.order_no === String(orderNo) && row.action === action);
}

function init({ send, order, onNotify, clock, ready }) {
  stop();
  sendFn = send; orderAction = order;
  notify = onNotify || (() => {});
  now = clock || (() => Date.now());
  canExecute = ready || (() => true);
  stopped = false;
  armTimer();
}

function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

function armTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (stopped) return;
  const due = records().filter((row) => row.status === 'scheduled').map((row) => row.due_at);
  if (!due.length) return;
  timer = setTimeout(() => {
    timer = null;
    processDue().catch((error) => console.error('[interaction]', error.message));
  }, Math.max(1, Math.min(60000, Math.min(...due) - now())));
  timer.unref?.();
}

function cancelAccount(accountId) {
  let changed = false;
  for (const entry of records()) {
    if (entry.account_id === Number(accountId) && entry.status === 'scheduled') {
      entry.status = 'cancelled'; entry.reason = '店铺已停用或页面已停止'; changed = true;
    }
  }
  if (changed) store.persist();
  armTimer();
}

function reserve(accountId, order, action, dueAt, manual, payload) {
  if (existing(accountId, order.order_no, action)) return null;
  const entry = { account_id: Number(accountId), order_no: String(order.order_no), action,
    status: 'scheduled', due_at: dueAt, manual: !!manual, payload,
    order: { order_no: String(order.order_no), status: order.status,
      session_id: order.session_id, buyer_nick: order.buyer_nick }, updated_at: now() };
  records().push(entry);
  try { store.persist(); }
  catch (error) { entry.status = 'uncertain'; entry.reason = '动作占位未保存：' + error.message; throw error; }
  return entry;
}

async function execute(entry) {
  const accountId = entry.account_id;
  const account = store.getAccount(accountId);
  const cfg = store.getBuyerInteraction(accountId);
  const config = cfg[entry.action] || {};
  const order = store.listOrders(accountId).find((row) => row.order_no === entry.order_no) || entry.order;
  if (stopped || !account || account.disabled || (!entry.manual && !config.enabled)
      || (entry.action !== 'receiveFlower' && !isClosedDeal(order))) {
    entry.status = 'cancelled'; entry.reason = '店铺、开关或订单状态已变化，已取消';
    store.persist(); return;
  }
  if (['thanks', 'flower'].includes(entry.action) && (!order.session_id || String(order.session_id).startsWith('nick:'))) {
    entry.status = 'cancelled'; entry.reason = '订单未关联可核验的买家会话';
    store.persist(); return;
  }
  // 重启后等待页面和登录就绪，尚未尝试的动作不应被误记为发送失败。
  if (!canExecute(accountId, entry.action)) {
    entry.due_at = now() + 3000;
    store.persist(); return;
  }

  // 在任何外部动作前持久占位；崩溃后的 running 会迁移为 uncertain。
  entry.status = 'running'; entry.updated_at = now();
  try { store.persist(); }
  catch (error) { entry.status = 'uncertain'; entry.reason = error.message; return; }
  let result;
  const guard = () => !stopped && !!store.getAccount(accountId) && !store.getAccount(accountId).disabled
    && (entry.manual || !!store.getBuyerInteraction(accountId)[entry.action].enabled);
  try {
    if (['thanks', 'flower'].includes(entry.action)) {
      const text = String(config.template || '').replace(/\{买家昵称\}/g, order.buyer_nick || '');
      result = text && sendFn ? await sendFn(accountId, order.session_id, text, guard)
        : { ok: false, uncertain: false, error: '互动文案或发送器不可用' };
    } else {
      result = orderAction ? await orderAction(accountId,
        entry.action === 'rate' ? 'rate' : 'receive-flower', {
          text: config.template, score: Number(config.score) || 5,
          ...entry.payload, orderNo: entry.order_no,
        }, guard) : { ok: false, uncertain: false, error: '订单页操作未就绪' };
    }
  } catch (error) { result = { ok: false, uncertain: true, error: error.message }; }
  entry.status = result && result.ok === true ? 'done'
    : result && result.uncertain === false ? 'failed' : 'uncertain';
  entry.reason = result && (result.error || result.reason) || '';
  entry.updated_at = now();
  store.persist();
  store.pushInteractionLog({ account_id: accountId, order_no: entry.order_no,
    action: entry.action, ok: entry.status === 'done', uncertain: entry.status === 'uncertain', reason: entry.reason });
  try {
    notify(entry.status === 'done' ? '买家互动完成' : '买家互动需核对',
      '店铺「' + account.label + '」订单 ' + entry.order_no + '：' + entry.action + ' ' + entry.reason, 'interaction');
  } catch (_) { /* 通知失败不重做交易动作 */ }
}

async function processDue() {
  if (draining) return draining;
  draining = (async () => {
    for (const entry of records()) {
      if (stopped) break;
      if (entry.status === 'scheduled' && entry.due_at <= now()) await execute(entry);
    }
  })();
  try { await draining; }
  finally { draining = null; armTimer(); }
}

function resultOf(entry) {
  return { action: entry.action, ok: entry.status === 'done', scheduled: entry.status === 'scheduled',
    uncertain: entry.status === 'uncertain', reason: entry.reason || (entry.status === 'scheduled' ? '已安排延迟执行' : entry.status) };
}

async function runForOrder({ accountId, order }) {
  const account = store.getAccount(accountId);
  if (stopped || !account || account.disabled) return { ok: false, reason: '店铺已停用或互动服务未就绪' };
  if (!order || !order.order_no || !isClosedDeal(order)) return { ok: false, reason: '订单尚未交易成功' };
  const cfg = store.getBuyerInteraction(accountId), entries = [], skipped = [];
  for (const action of ACTIONS) {
    if (!cfg[action].enabled || !cfg[action].template) continue;
    const old = existing(accountId, order.order_no, action);
    if (old) { skipped.push({ ...resultOf(old), skipped: true }); continue; }
    if (action !== 'rate' && (!order.session_id || String(order.session_id).startsWith('nick:'))) {
      skipped.push({ action, ok: false, reason: '订单未关联买家会话' }); continue;
    }
    entries.push(reserve(accountId, order, action, now() + Math.max(0, Number(cfg.delayMinutes) || 0) * 60000));
  }
  await processDue();
  return { ok: true, results: [...entries.map(resultOf), ...skipped] };
}

/** 手动动作与自动动作共用永久占位，不能绕过不确定结果。 */
async function performAction({ accountId, order, action, payload, manual = false }) {
  const account = store.getAccount(accountId);
  if (stopped || !account || account.disabled || !order || !order.order_no) return { ok: false, error: '店铺或订单不可用' };
  if (!['rate', 'receiveFlower'].includes(action)) return { ok: false, error: '不支持的互动动作' };
  if (!manual && !store.getBuyerInteraction(accountId)[action].enabled) return { ok: false, reason: '该店铺未开启此互动' };
  const old = existing(accountId, order.order_no, action);
  if (old) return { ...resultOf(old), skipped: true, reason: '已有动作记录，未重复执行；' + resultOf(old).reason };
  const entry = reserve(accountId, order, action, now(), manual, payload);
  await processDue();
  return resultOf(entry);
}

async function receiveFlower({ accountId, orderNo }) {
  const order = store.listOrders(accountId).find((row) => row.order_no === String(orderNo));
  return performAction({ accountId, order, action: 'receiveFlower' });
}

module.exports = { init, stop, cancelAccount, runForOrder, receiveFlower, performAction, processDue, shouldTrigger, isClosedDeal };


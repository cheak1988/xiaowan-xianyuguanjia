'use strict';

/**
 * 订单同步
 *
 * 来源是官方订单页的注入扫描（inject/order-preload.js），不是私有接口。
 * 这里负责三件事：
 *   1. 把扫描到的订单写进本地订单库，并触发状态变化事件
 *   2. 订单从「交易成功」时触发买家互动
 *   3. 维护订单页是否常驻打开
 *
 * 订单页扫描是「全量」的：页面能看到的每一单都会入库，
 * 不只是待发货，所以历史订单（页面可见范围内）能看到。
 */

const store = require('./store');
const interaction = require('./buyer-interaction');

let ensurePage = null;      // (accountId) => BrowserView|null
let onOrderChanged = null;  // (payload) => void
let deliver = null;         // 延迟注入，避免循环依赖

function init({ ensureOrderPage, onChanged, delivery }) {
  ensurePage = ensureOrderPage;
  onOrderChanged = onChanged;
  deliver = delivery;
}

/**
 * 把扫描批次写库。
 * @param {number} accountId
 * @param {Array} orders  注入脚本上报的订单数组
 * @returns {{added:number, updated:number, closed:Array}}
 */
function ingestBatch(accountId, orders) {
  const added = [];
  const updated = [];
  const closed = [];
  if (!Array.isArray(orders)) return { added: 0, updated: 0, closed: [] };

  const existingMap = new Map(
    store.listOrders(accountId).map((row) => [row.order_no, row]),
  );

  for (const raw of orders.slice(0, 500)) {
    if (!raw || !raw.order_no) continue;
    const prev = existingMap.get(String(raw.order_no));
    const prevStatus = prev ? prev.status : '';
    const nextStatus = String(raw.order_status || (prev && prev.status) || '');
    const row = store.upsertOrder(accountId, {
      order_no: raw.order_no,
      item_id: raw.item_id,
      item_title: raw.item_title,
      buyer_nick: raw.buyer_nick,
      buyer_uid: raw.buyer_uid,
      buyer_credit: raw.buyer_credit,
      amount: raw.amount,
      status: nextStatus,
      buy_num: raw.buy_num,
      spec_name: raw.spec_name,
      spec_value: raw.spec_value,
      source: 'order_page',
    });
    if (!row) continue;

    if (!prev) added.push(row);
    else updated.push(row);

    // 买家档案：订单里带买家昵称时补一份，方便黑名单/风控使用
    if (raw.buyer_nick) {
      store.upsertCustomer(accountId, {
        buyer_uid: row.buyer_uid || `nick:${raw.buyer_nick}`,
        nick: raw.buyer_nick,
      });
    }

    if (interaction.shouldTrigger(prevStatus, nextStatus)) closed.push(row);
  }

  if (added.length || updated.length) {
    store.pushOrderSyncLog({
      account_id: accountId, added: added.length, updated: updated.length,
      total: orders.length, ok: true,
    });
    if (onOrderChanged) onOrderChanged({ accountId, added: added.length, updated: updated.length });
  }
  return { added: added.length, updated: updated.length, closed };
}

/** 处理某一单变成「交易成功」之后的动作：先补会话，再跑买家互动 */
async function afterClosed(accountId, order) {
  const account = store.getAccount(accountId);
  if (!account || account.disabled) return;
  // 评价通过订单页执行，不依赖 IM 会话；消息动作自行检查会话。
  await interaction.runForOrder({ accountId, order });
}

/** 打开订单页（幂等），供常驻扫描与手动发货复用 */
function openOrderPage(accountId) {
  if (!ensurePage) return null;
  return ensurePage(Number(accountId));
}

/**
 * 常驻订单页：为所有启用店铺打开订单页，让注入脚本持续扫描。
 * 这是「订单真实同步」的前提；默认关闭，避免多占内存。
 */
function startResidentScan(accountIds) {
  const cfg = (store.getSettings().tasks && store.getSettings().tasks.orderSync) || {};
  if (!cfg.enabled) return { started: 0 };
  let started = 0;
  for (const id of accountIds || []) {
    const account = store.getAccount(id);
    if (!account || account.disabled) continue;
    if (ensurePage && ensurePage(Number(id))) started += 1;
  }
  return { started };
}

/** 手动触发一次同步：打开订单页并等待注入脚本上报 */
async function syncNow(accountId) {
  const view = openOrderPage(accountId);
  if (!view) return { ok: false, error: '订单页未能打开（店铺可能已停用）' };

  // 等页面加载完成后，主动要求注入脚本立刻扫一次
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({
      ok: true, uncertain: true,
      reason: '已打开订单页，但未在 15 秒内收到订单数据；请确认已登录并停留在订单列表',
    }), 15000);
    const wc = view.webContents;
    const done = (payload) => {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', send);
      resolve(payload);
    };
    const send = () => {
      try { wc.send('order:scan-now'); } catch (_) { /* ignore */ }
    };
    // 第一次上报由主进程在 order:scan 处理时回填
    pendingSyncs.set(Number(accountId), done);
    if (wc.isLoading()) wc.once('did-finish-load', send);
    else send();
  });
}

const pendingSyncs = new Map(); // accountId -> resolve

/** 注入脚本上报扫描结果时调用，回填等待中的 syncNow */
function notifySync(accountId, summary) {
  const resolve = pendingSyncs.get(Number(accountId));
  if (!resolve) return;
  pendingSyncs.delete(Number(accountId));
  resolve({ ok: true, ...summary });
}

/** 应用退出/店铺停用时清理等待 */
function cancelPending(accountId) {
  const resolve = pendingSyncs.get(Number(accountId));
  if (resolve) {
    pendingSyncs.delete(Number(accountId));
    resolve({ ok: false, error: '订单同步已取消' });
  }
}

module.exports = {
  init, ingestBatch, afterClosed, openOrderPage, startResidentScan, syncNow, notifySync, cancelPending,
};

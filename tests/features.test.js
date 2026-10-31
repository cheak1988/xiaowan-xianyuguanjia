'use strict';

/**
 * 二期功能回归测试：卖家侧能力对齐（卡券分组、三级发货、SKU、多数量、
 * 发货风控、默认回复、商品回复、消息过滤、买家互动、订单同步、备份）
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fixture, root } = require('./helpers');

function shop(t) {
  const f = fixture(t);
  f.account = f.store.addAccount('测试店铺');
  f.delivery = f.load('src/main/auto-delivery.js');
  f.order = (number = 'ORDER-1', extra = {}) => ({
    order_no: number, item_id: 'ITEM', session_id: 'BUYER-' + number, buyer_uid: 'UID-' + number, ...extra,
  });
  return f;
}

/* ------------------------------ 卡券分组 ------------------------------ */

test('卡券分组可增删，删除时清空卡密与规则上的引用', (t) => {
  const f = shop(t);
  const group = f.store.saveCardGroup({ accountId: f.account.id, name: '月卡' });
  f.delivery.importCards({ accountId: f.account.id, itemId: 'ITEM', text: 'C1', groupId: group.id });
  f.delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', group_id: group.id });

  assert.equal(f.store.listCardGroups(f.account.id).length, 1);
  assert.equal(f.delivery.listCards(f.account.id, 'ITEM')[0].group_id, group.id);

  f.store.removeCardGroup(group.id);
  assert.equal(f.store.listCardGroups(f.account.id).length, 0);
  assert.equal(f.delivery.listCards(f.account.id, 'ITEM')[0].group_id, null);
  assert.equal(f.delivery.listDeliverRules(f.account.id)[0].group_id, null);
});

test('同分组内取卡，缺卡时明确报不足', async (t) => {
  const f = shop(t);
  const group = f.store.saveCardGroup({ accountId: f.account.id, name: '年卡' });
  f.delivery.importCards({ accountId: f.account.id, itemId: 'ITEM', text: 'GROUP-CARD', groupId: group.id });
  f.delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', template: '{卡密}', group_id: group.id });

  const sent = [];
  const r = await f.delivery.handleOrder({
    accountId: f.account.id, order: f.order('G1'),
    sendFn: async (_sid, text) => { sent.push(text); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, ['GROUP-CARD']);
  // 没有剩余卡密：同分组再发一单必须失败，不能借别的分组
  const second = await f.delivery.handleOrder({
    accountId: f.account.id, order: f.order('G2'),
    sendFn: async () => ({ ok: true }),
  });
  assert.equal(second.ok, false);
  assert.match(second.reason, /卡密不足/);
});

/* ------------------------------ 三级发货规则 ------------------------------ */

test('三级规则优先级：商品级 > 本店默认 > 全局默认', (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({ scope: 'global', accountId: f.account.id, template: 'GLOBAL' });
  let rule = f.delivery.resolveDeliverRule(f.account.id, 'ITEM');
  assert.equal(rule.template, 'GLOBAL');

  f.delivery.saveDeliverRule({ scope: 'account', accountId: f.account.id, template: 'ACCOUNT' });
  rule = f.delivery.resolveDeliverRule(f.account.id, 'ITEM');
  assert.equal(rule.template, 'ACCOUNT');

  f.delivery.saveDeliverRule({ scope: 'item', accountId: f.account.id, item_id: 'ITEM', template: 'ITEM' });
  rule = f.delivery.resolveDeliverRule(f.account.id, 'ITEM');
  assert.equal(rule.template, 'ITEM');

  // 另一个商品只吃到本店默认，不会串到 ITEM 的规则
  assert.equal(f.delivery.resolveDeliverRule(f.account.id, 'OTHER').template, 'ACCOUNT');
});

test('本店默认规则可以给所有未单独配置的商品发货', async (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({ scope: 'account', accountId: f.account.id, template: '默认发货 {卡密}' });
  f.delivery.importCards({ accountId: f.account.id, itemId: 'ANY-ITEM', text: 'DEFAULT-CARD' });
  const sent = [];
  const r = await f.delivery.handleOrder({
    accountId: f.account.id,
    order: { order_no: 'A1', item_id: 'ANY-ITEM', session_id: 'SID-A1', buyer_uid: 'UID-A1' },
    sendFn: async (_sid, text) => { sent.push(text); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, ['默认发货 DEFAULT-CARD']);
});

test('商品级规则必填商品ID，全局规则不能带店铺', (t) => {
  const f = shop(t);
  assert.throws(() => f.delivery.saveDeliverRule({ scope: 'item', accountId: f.account.id }), /商品ID/);
  const id = f.delivery.saveDeliverRule({ scope: 'global', accountId: f.account.id, template: '{卡密}' });
  const rule = f.store.ready().deliverRules.find((row) => row.id === id);
  assert.equal(rule.account_id, null);
  assert.equal(rule.scope, 'global');
});

/* ------------------------------ SKU 绑定 + 多数量 ------------------------------ */

test('SKU 绑定优先使用规格自己的卡密内容', (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({
    accountId: f.account.id, item_id: 'ITEM', template: '{卡密}',
    skus: [{ spec_name: '套餐', spec_value: '月卡', content: 'MONTH-KEY' }],
  });
  const rule = f.delivery.resolveDeliverRule(f.account.id, 'ITEM');
  const hit = f.delivery.matchSkuBinding(rule, { spec_name: '套餐', spec_value: '月卡' });
  assert.equal(hit.content, 'MONTH-KEY');
  assert.equal(f.delivery.matchSkuBinding(rule, { spec_name: '套餐', spec_value: '年卡' }), null);
});

test('买家拍 N 件发 N 份卡密，并逐份占位', async (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', template: '{卡密}' });
  f.delivery.importCards({ accountId: f.account.id, itemId: 'ITEM', text: 'C1\nC2\nC3' });
  const sent = [];
  const r = await f.delivery.handleOrder({
    accountId: f.account.id, order: f.order('M1', { buy_num: 3 }),
    sendFn: async (_sid, text) => { sent.push(text); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.quantity, 3);
  assert.deepEqual(sent, ['C1', 'C2', 'C3']);
  assert.equal(f.delivery.cardStats(f.account.id, 'ITEM').used, 3);
  assert.equal(f.delivery.cardStats(f.account.id, 'ITEM').unused, 0);
});

test('多数量时库存不足整体拒绝，不会只发一部分', async (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', template: '{卡密}' });
  f.delivery.importCards({ accountId: f.account.id, itemId: 'ITEM', text: 'ONLY-ONE' });
  let sent = 0;
  const r = await f.delivery.handleOrder({
    accountId: f.account.id, order: f.order('M2', { buy_num: 2 }),
    sendFn: async () => { sent++; return { ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /卡密不足/);
  assert.equal(sent, 0);
  assert.equal(f.delivery.cardStats(f.account.id, 'ITEM').unused, 1);
});

test('规格专属的固定内容多件时只发一次，避免同一码泄露', async (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({
    accountId: f.account.id, item_id: 'ITEM', template: '{卡密}',
    skus: [{ spec_value: '年卡', content: 'FIXED-YEAR' }],
  });
  const sent = [];
  const r = await f.delivery.handleOrder({
    accountId: f.account.id,
    order: f.order('M3', { buy_num: 5, spec_name: '套餐', spec_value: '年卡' }),
    sendFn: async (_sid, text) => { sent.push(text); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, ['FIXED-YEAR']);
});

/* ------------------------------ 发货风控 ------------------------------ */

test('买家在黑名单时拦截发货，不消耗卡密', async (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', template: '{卡密}' });
  f.delivery.importCards({ accountId: f.account.id, itemId: 'ITEM', text: 'CARD' });
  const customer = f.store.upsertCustomer(f.account.id, { buyer_uid: 'BAD-BUYER', nick: '捣乱的' });
  f.store.updateCustomer(customer.id, { blacklisted: true });

  const r = await f.delivery.handleOrder({
    accountId: f.account.id,
    order: f.order('R1', { buyer_uid: 'BAD-BUYER' }),
    sendFn: async () => ({ ok: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, true);
  assert.equal(r.riskRule, 'buyerBlacklist');
  assert.equal(f.delivery.cardStats(f.account.id, 'ITEM').unused, 1);
  assert.equal(f.store.listDeliveryBlockLog(f.account.id).length, 1);
});

test('买家已有未完成订单时拦截（可设仅同商品）', (t) => {
  const f = shop(t);
  f.store.updateSettings({ deliveryRisk: { buyerHasOpenOrder: { enabled: true, sameItemOnly: false } } });
  f.store.upsertOrder(f.account.id, {
    order_no: 'OLD-1', item_id: 'ITEM', buyer_uid: 'B1', status: '待发货',
  });
  const risky = f.delivery.evaluateDeliveryRisk({
    accountId: f.account.id,
    order: { order_no: 'NEW-1', item_id: 'ITEM', buyer_uid: 'B1' },
  });
  assert.equal(risky.hit, true);
  assert.equal(risky.rule, 'buyerHasOpenOrder');

  // 同一买家、不同商品：开了「仅同商品」就放过
  f.store.updateSettings({ deliveryRisk: { buyerHasOpenOrder: { enabled: true, sameItemOnly: true } } });
  const differentItem = f.delivery.evaluateDeliveryRisk({
    accountId: f.account.id,
    order: { order_no: 'NEW-2', item_id: 'OTHER', buyer_uid: 'B1' },
  });
  assert.equal(differentItem.hit, false);
});

test('已完成订单不算未完成，不会误拦', (t) => {
  const f = shop(t);
  f.store.updateSettings({ deliveryRisk: { buyerHasOpenOrder: { enabled: true } } });
  f.store.upsertOrder(f.account.id, {
    order_no: 'DONE-1', item_id: 'ITEM', buyer_uid: 'B2', status: '交易成功',
  });
  const risk = f.delivery.evaluateDeliveryRisk({
    accountId: f.account.id,
    order: { order_no: 'NEW-3', item_id: 'ITEM', buyer_uid: 'B2' },
  });
  assert.equal(risk.hit, false);
});

test('跨店铺未完成订单可以拦截，且能定位到其他店铺', (t) => {
  const f = shop(t);
  const other = f.store.addAccount('另一个店铺');
  f.store.updateSettings({ deliveryRisk: { buyerHasOpenOrderGlobal: { enabled: true } } });
  f.store.upsertOrder(other.id, {
    order_no: 'CROSS-1', item_id: 'X', buyer_uid: 'GLOBAL-BUYER', status: '待收货',
  });
  const risk = f.delivery.evaluateDeliveryRisk({
    accountId: f.account.id,
    order: { order_no: 'NEW-4', item_id: 'ITEM', buyer_uid: 'GLOBAL-BUYER' },
  });
  assert.equal(risk.hit, true);
  assert.equal(risk.rule, 'buyerHasOpenOrderGlobal');
  assert.match(risk.reason, new RegExp(String(other.id)));
});

test('人工补发跳过风控，仍能发卡', async (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', template: '{卡密}' });
  f.delivery.importCards({ accountId: f.account.id, itemId: 'ITEM', text: 'RESEND-CARD' });
  const customer = f.store.upsertCustomer(f.account.id, { buyer_uid: 'BLACK', nick: '黑名单' });
  f.store.updateCustomer(customer.id, { blacklisted: true });
  const sent = [];
  const r = await f.delivery.handleOrder({
    accountId: f.account.id,
    order: f.order('R2', { buyer_uid: 'BLACK' }),
    sendFn: async (_sid, text) => { sent.push(text); return { ok: true }; },
    skipRisk: true,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, ['RESEND-CARD']);
});

/* ------------------------------ 默认回复 / 商品回复 / 过滤 ------------------------------ */

test('默认回复排序在规则和 AI 之后，可设置只回一次', (t) => {
  const f = shop(t);
  const engine = f.load('src/main/reply-engine.js');
  f.store.saveDefaultReply(f.account.id, { enabled: true, content: '稍后回复您~' });

  const session = { id: 'S-DEFAULT', peer_user_id: 'U1' };
  const message = { direction: 'in', content: { text: '在吗在吗' } };
  const decision = engine.decide({
    accountId: f.account.id, account: f.store.getAccount(f.account.id), session, message,
    settings: f.store.getSettings(),
  });
  assert.equal(decision.action, 'reply');
  assert.equal(decision.reason, '规则未命中，使用默认回复');
  assert.equal(decision.markDefault, true);
  assert.equal(decision.replies[0].content, '稍后回复您~');

  // 记录发过之后，同一会话不该再回
  f.store.markDefaultReply(f.account.id, 'S-DEFAULT');
  const again = engine.decide({
    accountId: f.account.id, account: f.store.getAccount(f.account.id), session, message,
    settings: f.store.getSettings(),
  });
  assert.equal(again.action, 'skip');
  assert.match(again.reason, /只回一次|已发过/);
});

test('关键词规则命中时不会用默认回复顶替', (t) => {
  const f = shop(t);
  const engine = f.load('src/main/reply-engine.js');
  f.store.saveDefaultReply(f.account.id, { enabled: true, content: '默认' });
  f.store.saveRule({ accountId: f.account.id, name: '发货', keywords: ['发货'], content: '今天发' });
  const decision = engine.decide({
    accountId: f.account.id, account: f.store.getAccount(f.account.id),
    session: { id: 'S-RULE', peer_user_id: 'U2' }, message: { direction: 'in', content: { text: '什么时候发货' } },
    settings: f.store.getSettings(),
  });
  assert.equal(decision.action, 'reply');
  assert.match(decision.reason, /命中规则/);
  assert.equal(decision.replies[0].content, '今天发');
});

test('商品专属回复优先于关键词规则', (t) => {
  const f = shop(t);
  const engine = f.load('src/main/reply-engine.js');
  f.store.saveRule({ accountId: f.account.id, name: '通用', keywords: ['在吗'], content: '通用回复' });
  f.store.saveItemReply({ accountId: f.account.id, item_id: 'ITEM-X', content: '这个链接拍下自动发货' });
  const decision = engine.decide({
    accountId: f.account.id, account: f.store.getAccount(f.account.id),
    session: { id: 'S-ITEM', peer_user_id: 'U3', itemId: 'ITEM-X' },
    message: { direction: 'in', content: { text: '在吗' } },
    settings: f.store.getSettings(),
  });
  assert.match(decision.reason, /商品专属回复/);
  assert.equal(decision.replies[0].content, '这个链接拍下自动发货');
});

test('拉黑买家不自动回复，会说明原因', (t) => {
  const f = shop(t);
  const engine = f.load('src/main/reply-engine.js');
  const customer = f.store.upsertCustomer(f.account.id, { buyer_uid: 'BLACK-U', nick: '黑户' });
  f.store.updateCustomer(customer.id, { blacklisted: true });
  const decision = engine.decide({
    accountId: f.account.id, account: f.store.getAccount(f.account.id),
    session: { id: 'S-BLACK', peerUserId: 'BLACK-U' },
    message: { direction: 'in', content: { text: '你好' } },
    settings: f.store.getSettings(),
  });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /黑名单/);
});

test('消息过滤词命中时直接忽略', (t) => {
  const f = shop(t);
  const engine = f.load('src/main/reply-engine.js');
  f.store.saveMessageFilter({ accountId: f.account.id, keyword: '自动回复', filter_type: 'contains' });
  const decision = engine.decide({
    accountId: f.account.id, account: f.store.getAccount(f.account.id),
    session: { id: 'S-FILTER', peer_user_id: 'U4' },
    message: { direction: 'in', content: { text: '你是自动回复吧' } },
    settings: f.store.getSettings(),
  });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /消息过滤/);
});

test('回复决策日志按店铺可查，且保留最近记录', (t) => {
  const f = shop(t);
  for (let i = 0; i < 1100; i++) {
    f.store.pushReplyLog({ account_id: f.account.id, action: 'skip', reason: 'r' + i });
  }
  const log = f.store.listReplyLog(f.account.id, 5);
  assert.equal(log.length, 5);
  assert.equal(log[0].reason, 'r1099');
  assert.equal(f.store.ready().replyLog.length, 1000);
});

/* ------------------------------ 买家互动 ------------------------------ */

test('买家互动全部默认关闭', (t) => {
  const f = shop(t);
  const cfg = f.store.getBuyerInteraction(f.account.id);
  assert.equal(cfg.thanks.enabled, false);
  assert.equal(cfg.flower.enabled, false);
  assert.equal(cfg.rate.enabled, false);
  assert.equal(cfg.receiveFlower.enabled, false);
});

test('开启致谢后，交易成功订单只发一次致谢', async (t) => {
  const f = shop(t);
  f.store.saveBuyerInteraction(f.account.id, { delayMinutes: 0, thanks: { enabled: true, template: '感谢 {买家昵称}' } });
  const interaction = f.load('src/main/buyer-interaction.js');
  const sent = [];
  interaction.init({
    send: async (_a, _s, text) => { sent.push(text); return { ok: true }; },
    order: async () => ({ ok: true }),
    onNotify: () => {},
  });
  const order = { order_no: 'I1', session_id: 'SID-I1', status: '交易成功', buyer_nick: '买家甲' };
  await interaction.runForOrder({ accountId: f.account.id, order });
  await interaction.runForOrder({ accountId: f.account.id, order });
  assert.deepEqual(sent, ['感谢 买家甲']);
  assert.equal(f.store.listInteractionLog(f.account.id).filter((r) => r.action === 'thanks' && r.ok).length, 1);
});

test('未交易成功的订单不触发买家互动', async (t) => {
  const f = shop(t);
  f.store.saveBuyerInteraction(f.account.id, { thanks: { enabled: true, template: '感谢' } });
  const interaction = f.load('src/main/buyer-interaction.js');
  let sent = 0;
  interaction.init({ send: async () => { sent++; return { ok: true }; }, order: async () => ({ ok: true }), onNotify: () => {} });
  const r = await interaction.runForOrder({
    accountId: f.account.id,
    order: { order_no: 'I2', session_id: 'S', status: '待发货' },
  });
  assert.equal(r.ok, false);
  assert.equal(sent, 0);
});

test('状态从非成功变为交易成功时才判定为触发点', (t) => {
  const f = shop(t);
  const interaction = f.load('src/main/buyer-interaction.js');
  assert.equal(interaction.shouldTrigger('待发货', '交易成功'), true);
  assert.equal(interaction.shouldTrigger('交易成功', '交易成功'), false);
  assert.equal(interaction.shouldTrigger('', '待收货'), false);
});

/* ------------------------------ 订单同步 ------------------------------ */

test('订单扫描批次入库：新增、更新分别计数', (t) => {
  const f = shop(t);
  const sync = f.load('src/main/order-sync.js');
  sync.init({ ensureOrderPage: () => null, onChanged: () => {}, delivery: f.delivery });

  const first = sync.ingestBatch(f.account.id, [{
    order_no: 'SYNC-1', item_id: 'ITEM', item_title: '测试商品', buyer_nick: '买家A',
    order_status: '待发货', amount: 19.9, buy_num: 2, spec_value: '月卡',
  }]);
  assert.equal(first.added, 1);
  assert.equal(first.updated, 0);

  const second = sync.ingestBatch(f.account.id, [{
    order_no: 'SYNC-1', item_id: 'ITEM', item_title: '测试商品', buyer_nick: '买家A',
    order_status: '已发货', amount: 19.9,
  }]);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);

  const row = f.store.listOrders(f.account.id)[0];
  assert.equal(row.status, '已发货');
  assert.equal(row.buy_num, 2);
  assert.equal(row.spec_value, '月卡');
  assert.equal(row.source, 'order_page');
  assert.equal(row.amount, 19.9);
});

test('订单从待发货变为交易成功时进入 closed 队列', (t) => {
  const f = shop(t);
  const sync = f.load('src/main/order-sync.js');
  sync.init({ ensureOrderPage: () => null, onChanged: () => {}, delivery: f.delivery });
  sync.ingestBatch(f.account.id, [{ order_no: 'CLOSE-1', item_id: 'ITEM', order_status: '待发货' }]);
  const result = sync.ingestBatch(f.account.id, [{ order_no: 'CLOSE-1', item_id: 'ITEM', order_status: '交易成功' }]);
  assert.equal(result.closed.length, 1);
  assert.equal(result.closed[0].order_no, 'CLOSE-1');
});

test('订单备注与删除', (t) => {
  const f = shop(t);
  f.store.upsertOrder(f.account.id, { order_no: 'NOTE-1', item_id: 'ITEM', status: '待发货' });
  const row = f.store.updateOrderField(f.account.id, 'NOTE-1', { note: '买家要求延迟' });
  assert.equal(row.note, '买家要求延迟');
  assert.equal(f.store.removeOrder(f.account.id, 'NOTE-1'), true);
  assert.equal(f.store.listOrders(f.account.id).length, 0);
});

test('看板营收排除关闭/退款，并单列退款额', (t) => {
  const f = shop(t);
  f.store.upsertOrder(f.account.id, { order_no: 'S1', item_id: 'I', amount: 100, status: '交易成功' });
  f.store.upsertOrder(f.account.id, { order_no: 'S2', item_id: 'I', amount: 50, status: '已关闭' });
  f.store.upsertOrder(f.account.id, { order_no: 'S3', item_id: 'I', amount: 30, status: '退款成功', refund_amount: 30 });
  const stats = f.store.getStats(f.account.id);
  assert.equal(stats.revenue, 100);
  assert.equal(stats.refunded, 30);
  assert.equal(stats.orders, 3);
});

/* ------------------------------ 备份 ------------------------------ */

test('备份导出后可完整导入，导入前先保护现有数据', (t) => {
  const f = shop(t);
  f.store.upsertOrder(f.account.id, { order_no: 'BK-1', item_id: 'ITEM', amount: 9.9, status: '待发货' });
  f.store.flush();
  const backup = f.load('src/main/backup.js');
  const target = fs.mkdtempSync(path.join(require('os').tmpdir(), 'backup-out-'));

  const exported = backup.exportBackup(f.directory, target);
  assert.equal(exported.ok, true);
  assert.ok(fs.existsSync(path.join(exported.path, 'state.json')));
  assert.ok(fs.existsSync(path.join(exported.path, 'README.txt')));

  // 破坏当前数据，再导入
  f.store.upsertOrder(f.account.id, { order_no: 'BK-2', item_id: 'ITEM', amount: 1, status: '待发货' });
  f.store.flush();
  const imported = backup.importBackup(f.directory, exported.path);
  assert.equal(imported.ok, true);
  assert.ok(fs.existsSync(imported.backup), '导入前必须留一份保护性备份');

  const restored = JSON.parse(fs.readFileSync(path.join(f.directory, 'state.json'), 'utf8'));
  assert.ok(restored.orders.some((row) => row.order_no === 'BK-1'));
  assert.ok(!restored.orders.some((row) => row.order_no === 'BK-2'));

  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(imported.backup, { recursive: true, force: true });
});

test('导入缺少 state.json 的目录会被拒绝，不破坏现有数据', (t) => {
  const f = shop(t);
  f.store.upsertOrder(f.account.id, { order_no: 'KEEP', item_id: 'ITEM', status: '待发货' });
  f.store.flush();
  const backup = f.load('src/main/backup.js');
  const empty = fs.mkdtempSync(path.join(require('os').tmpdir(), 'backup-empty-'));
  const r = backup.importBackup(f.directory, empty);
  assert.equal(r.ok, false);
  assert.match(r.error, /state\.json/);
  const still = JSON.parse(fs.readFileSync(path.join(f.directory, 'state.json'), 'utf8'));
  assert.ok(still.orders.some((row) => row.order_no === 'KEEP'));
  fs.rmSync(empty, { recursive: true, force: true });
});

/* ------------------------------ 任务页面归属 ------------------------------ */

test('擦亮绑定商品页、评价绑定订单页', (t) => {
  const f = shop(t);
  const tasks = f.load('src/main/tasks.js');
  assert.equal(tasks.RISK_LEVELS.polish.page, 'product');
  assert.equal(tasks.RISK_LEVELS.rate.page, 'order');
  const list = tasks.listTasks();
  assert.equal(list.find((row) => row.id === 'polish').page, 'product');
  assert.equal(list.find((row) => row.id === 'rate').page, 'order');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixture, fakeElectron, root } = require('./helpers');

function mainFixture(t) {
  const fake = fakeElectron();
  const f = fixture(t, { electron: fake.electron, './notify': { notify: async () => ({ ok: true }) } });
  fake.electron.app.getPath = () => f.directory;
  f.load('src/main/index.js'); fake.electron.api.createWindow();
  const contents = fake.windows[0].webContents;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const call = (name, input) => fake.handles.get(name)(event, input);
  const account = call('accounts:add', { label: 'CURRENT' });
  return { ...f, ...fake, call, account };
}

function interactionFixture(t, patch = {}) {
  const f = fixture(t), account = f.store.addAccount('互动店铺');
  const interaction = f.load('src/main/buyer-interaction.js');
  const order = f.store.upsertOrder(account.id, { order_no: 'ORDER', status: '交易完成', session_id: 'SESSION' });
  f.store.saveBuyerInteraction(account.id, { delayMinutes: 0, thanks: { enabled: true, template: '谢谢' }, ...patch });
  return { ...f, account, order, interaction };
}

test('真实备份导入 IPC 暂停旧任务，退出和迟到写盘都不能覆盖恢复的数据', async (t) => {
  const f = mainFixture(t);
  f.store.saveMessage(f.account.id, { id: 'S' }, { messageId: 'OLD', content: { text: '旧消息' } });
  f.store.flush();
  const source = path.join(f.directory, 'incoming'); fs.mkdirSync(source);
  const incoming = JSON.parse(fs.readFileSync(path.join(f.directory, 'state.json')));
  incoming.accounts[0].label = 'RESTORED';
  fs.writeFileSync(path.join(source, 'state.json'), JSON.stringify(incoming));
  fs.mkdirSync(path.join(source, 'messages', '1'), { recursive: true });
  fs.writeFileSync(path.join(source, 'messages', '1', '2026-10.json'), '[]');
  f.electron.dialog = { showOpenDialog: async () => ({ filePaths: [source] }) };
  const cleared = [];
  f.electron.session.fromPartition = (partition) => ({
    clearStorageData: async () => cleared.push(partition), clearCache: async () => {},
  });
  // 同一 Electron 对象在加载后补上 dialog，真实 IPC 使用同一个对象。
  const result = await f.call('backup:import');
  assert.equal(result.ok, true); assert.equal(result.needsRestart, true);
  const restored = fs.readFileSync(path.join(f.directory, 'state.json'), 'utf8');
  f.store.updateAccount(f.account.id, { label: 'LATE-OLD-WRITER' });
  f.store.saveMessage(f.account.id, { id: 'S' }, { messageId: 'LATE', content: { text: '迟到消息' } });
  f.store.persist(); f.store.flush();
  assert.equal(fs.readFileSync(path.join(f.directory, 'state.json'), 'utf8'), restored);
  assert.equal(JSON.parse(restored).accounts[0].label, 'RESTORED');
  assert.equal(JSON.parse(restored).accounts[0].disabled, true);
  assert.deepEqual(cleared, ['persist:xy-' + f.account.id]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup, 'state.json'))).accounts[0].label, 'CURRENT');
  assert.equal(fs.readFileSync(path.join(f.directory, 'messages', '1', '2026-10.json'), 'utf8'), '[]');
  assert.ok(f.views.every((view) => view.webContents.destroyed));
  assert.throws(() => f.call('accounts:add', { label: '禁止新操作' }), /重启/);
});

test('无效备份导入失败后原档案仍能使用，不会进入等待重启锁定状态', async (t) => {
  const f = mainFixture(t), source = path.join(f.directory, 'invalid'); fs.mkdirSync(source);
  f.electron.dialog = { showOpenDialog: async () => ({ filePaths: [source] }) };
  const result = await f.call('backup:import');
  assert.equal(result.ok, false);
  assert.equal(f.call('accounts:list')[0].label, 'CURRENT');
  f.store.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'state.json'))).accounts[0].label, 'CURRENT');
});

test('备份包含真实图片目录，恢复替换图片且移除备份中不存在的旧消息目录', (t) => {
  const f = fixture(t), backup = f.load('src/main/backup.js');
  f.store.addAccount('图片店铺'); f.store.flush();
  const images = path.join(f.directory, 'product-images'); fs.mkdirSync(images);
  fs.writeFileSync(path.join(images, 'card.png'), 'IMAGE-BYTES');
  fs.writeFileSync(path.join(images, 'card.json'), '{"id":"card"}');
  const target = path.join(f.directory, 'exports');
  const exported = backup.exportBackup(f.directory, target);
  assert.equal(exported.ok, true);
  assert.equal(fs.readFileSync(path.join(exported.path, 'product-images', 'card.png'), 'utf8'), 'IMAGE-BYTES');
  const sameSecond = backup.exportBackup(f.directory, target);
  assert.notEqual(sameSecond.path, exported.path);
  assert.equal(backup.exportBackup(f.directory, images).ok, false);
  fs.writeFileSync(path.join(images, 'obsolete.png'), 'OLD');
  const restored = backup.importBackup(f.directory, exported.path);
  assert.equal(restored.ok, true);
  assert.equal(fs.existsSync(path.join(images, 'obsolete.png')), false);
  assert.equal(fs.readFileSync(path.join(images, 'card.png'), 'utf8'), 'IMAGE-BYTES');
  assert.equal(fs.existsSync(path.join(restored.backup, 'product-images', 'obsolete.png')), true);
});

test('备份安装中途失败会回滚 state、其备份和图片，损坏结构在覆盖前拒绝', (t) => {
  let rejectImageInstall = true;
  const mockFs = { ...fs, renameSync(from, to) {
    if (rejectImageInstall && from.includes(path.join('.incoming', 'product-images'))) {
      rejectImageInstall = false; throw new Error('模拟图片目录移动失败');
    }
    return fs.renameSync(from, to);
  } };
  const f = fixture(t, { fs: mockFs }), backup = f.load('src/main/backup.js');
  f.store.addAccount('CURRENT'); f.store.flush();
  const current = fs.readFileSync(path.join(f.directory, 'state.json'), 'utf8');
  const imageDir = path.join(f.directory, 'product-images'); fs.mkdirSync(imageDir);
  fs.writeFileSync(path.join(imageDir, 'old.png'), 'OLD');
  const source = path.join(f.directory, 'source'); fs.mkdirSync(path.join(source, 'product-images'), { recursive: true });
  fs.writeFileSync(path.join(source, 'state.json'), '{"accounts":[],"orders":{}}');
  assert.equal(backup.importBackup(f.directory, source).ok, false);
  fs.writeFileSync(path.join(source, 'state.json'), '{"accounts":[]}');
  fs.writeFileSync(path.join(source, 'product-images', 'new.png'), 'NEW');
  assert.equal(backup.importBackup(f.directory, source).ok, false);
  assert.equal(fs.readFileSync(path.join(f.directory, 'state.json'), 'utf8'), current);
  assert.equal(fs.readFileSync(path.join(imageDir, 'old.png'), 'utf8'), 'OLD');
  assert.equal(fs.existsSync(path.join(imageDir, 'new.png')), false);
});

test('自动发货真实入口保留已知 UID，并从已关联本店会话补全；黑名单仍被拦截', async (t) => {
  const f = mainFixture(t), delivery = f.load('src/main/auto-delivery.js');
  f.store.saveMessage(f.account.id, { id: 'SESSION', peerUserId: 'UID-BLOCKED' }, { messageId: 'M' });
  const customer = f.store.upsertCustomer(f.account.id, { buyer_uid: 'UID-BLOCKED' });
  f.store.updateCustomer(customer.id, { blacklisted: true });
  f.store.upsertOrder(f.account.id, { order_no: 'RISK', session_id: 'SESSION', item_id: 'ITEM' });
  delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', template: '{卡密}' });
  delivery.importCards({ accountId: f.account.id, itemId: 'ITEM', text: 'NEVER-SEND' });
  const orderView = f.electron.api.ensureOrderView(f.account.id).webContents;
  await f.ipcMain.listeners('order:pending')[0]({ sender: orderView, senderFrame: orderView.mainFrame },
    { order_no: 'RISK', item_id: 'ITEM', order_status: '待发货' });
  assert.equal(delivery.cardStats(f.account.id, 'ITEM').unused, 1);
  assert.equal(f.store.listDeliveryBlockLog(f.account.id)[0].rule, 'buyerBlacklist');
  assert.equal(f.views[0].webContents.sent.some((row) => row.channel === 'inject:send'), false);
});

test('缺少身份或信用数据时明确拦截，身份冲突不发送', (t) => {
  const f = fixture(t), account = f.store.addAccount('风控'), delivery = f.load('src/main/auto-delivery.js');
  const input = { accountId: account.id, order: { order_no: 'O' } };
  assert.equal(delivery.evaluateDeliveryRisk(input).rule, 'buyerIdentityUnknown');
  f.store.saveDeliveryRiskSettings({ buyerLowCredit: { enabled: true, threshold: 1 } });
  input.order.buyer_uid = 'UID';
  assert.equal(delivery.evaluateDeliveryRisk(input).rule, 'buyerCreditUnknown');
  input.order.buyer_credit = 0;
  assert.equal(delivery.evaluateDeliveryRisk(input).rule, 'buyerLowCredit');
  f.store.saveMessage(account.id, { id: 'S', peerUserId: 'OTHER' }, { messageId: 'M' });
  input.order.session_id = 'S';
  assert.equal(delivery.evaluateDeliveryRisk(input).rule, 'buyerIdentityConflict');
});

test('同订单并发互动仅发送一次，日志轮换和重启后仍不重发', async (t) => {
  const f = interactionFixture(t);
  let sent = 0, release;
  const wait = new Promise((resolve) => { release = resolve; });
  f.interaction.init({ send: async () => { sent++; await wait; return { ok: true }; } });
  const one = f.interaction.runForOrder({ accountId: f.account.id, order: f.order });
  const two = f.interaction.runForOrder({ accountId: f.account.id, order: f.order });
  assert.equal(sent, 1); release(); await Promise.all([one, two]);
  for (let i = 0; i < 850; i++) f.store.pushInteractionLog({ action: 'skip', order_no: 'OTHER-' + i });
  f.store.flush(); f.interaction.stop(); f.store.init(f.directory);
  f.interaction.init({ send: async () => { sent++; return { ok: true }; } });
  await f.interaction.runForOrder({ accountId: f.account.id, order: f.order });
  assert.equal(sent, 1);
});

test('评价超时后手动和自动入口都不重试，中断占位重启后保持待核对', async (t) => {
  const f = interactionFixture(t, { thanks: { enabled: false }, rate: { enabled: true, template: '感谢惠顾' } });
  let calls = 0;
  f.interaction.init({ order: async () => { calls++; return { ok: false, uncertain: true, error: '超时' }; } });
  await f.interaction.runForOrder({ accountId: f.account.id, order: f.order });
  await f.interaction.runForOrder({ accountId: f.account.id, order: f.order });
  await f.interaction.performAction({ accountId: f.account.id, order: f.order, action: 'rate', manual: true });
  assert.equal(calls, 1);
  f.store.ready().interactionActions[0].status = 'running';
  f.store.flush(); f.interaction.stop(); f.store.init(f.directory);
  assert.equal(f.store.ready().interactionActions[0].status, 'uncertain');
  f.interaction.init({ order: async () => { calls++; return { ok: true }; } });
  await f.interaction.runForOrder({ accountId: f.account.id, order: f.order });
  assert.equal(calls, 1);
});

test('互动占位写盘失败时不执行外部动作', async (t) => {
  const f = interactionFixture(t);
  let calls = 0;
  f.interaction.init({ send: async () => { calls++; return { ok: true }; } });
  f.store.persist = () => { throw new Error('磁盘已满'); };
  await assert.rejects(f.interaction.runForOrder({ accountId: f.account.id, order: f.order }), /磁盘已满/);
  assert.equal(calls, 0);
});

test('互动按延迟执行，重启保留到期时间；到期前关闭开关则取消', async (t) => {
  const f = interactionFixture(t, { delayMinutes: 60 });
  let time = Date.now(), sent = 0;
  const services = { clock: () => time, send: async () => { sent++; return { ok: true }; } };
  f.interaction.init(services);
  await f.interaction.runForOrder({ accountId: f.account.id, order: f.order });
  assert.equal(sent, 0);
  f.interaction.stop(); f.store.flush(); f.store.init(f.directory);
  f.interaction.init(services); time += 59 * 60000;
  await f.interaction.processDue(); assert.equal(sent, 0);
  time += 60000; await f.interaction.processDue(); assert.equal(sent, 1);
  const other = f.store.upsertOrder(f.account.id, { order_no: 'SECOND', status: '交易成功', session_id: 'S' });
  await f.interaction.runForOrder({ accountId: f.account.id, order: other });
  f.store.saveBuyerInteraction(f.account.id, { thanks: { enabled: false } });
  time += 60 * 60000; await f.interaction.processDue();
  assert.equal(sent, 1);
  assert.equal(f.store.ready().interactionActions.find((row) => row.order_no === 'SECOND').status, 'cancelled');
});

test('评价不依赖聊天会话，已完成状态触发，待确认收货不触发', async (t) => {
  const f = interactionFixture(t, { thanks: { enabled: false }, rate: { enabled: true, template: '谢谢' } });
  assert.equal(f.interaction.shouldTrigger('已发货', '交易完成'), true);
  for (const status of ['待确认收货', '待买家确认收货', '未确认收货', '确认收货']) {
    assert.equal(f.interaction.isClosedDeal({ status }), false);
  }
  let calls = 0;
  f.interaction.init({ order: async () => { calls++; return { ok: true }; } });
  const sync = f.load('src/main/order-sync.js');
  const order = f.store.upsertOrder(f.account.id, { order_no: 'NO-SESSION', status: '交易完成' });
  await sync.afterClosed(f.account.id, order);
  assert.equal(calls, 1);
});

test('重启后页面未就绪时保留互动任务，登录就绪后才执行', async (t) => {
  const f = interactionFixture(t);
  let ready = false, time = Date.now(), calls = 0;
  f.interaction.init({ clock: () => time, ready: () => ready,
    send: async () => { calls++; return { ok: true }; } });
  await f.interaction.runForOrder({ accountId: f.account.id, order: f.order });
  assert.equal(calls, 0);
  assert.equal(f.store.ready().interactionActions[0].status, 'scheduled');
  ready = true; time += 3000;
  await f.interaction.processDue();
  assert.equal(calls, 1);
});

test('同店铺订单页动作串行，失败结果不会将本地订单误标成已发货', async (t) => {
  const f = mainFixture(t);
  for (const order_no of ['SHIP-1', 'SHIP-2']) f.store.upsertOrder(f.account.id, { order_no, status: '待发货' });
  const one = f.call('order:operate', { accountId: f.account.id, orderNo: 'SHIP-1', action: 'ship' });
  const two = f.call('order:operate', { accountId: f.account.id, orderNo: 'SHIP-2', action: 'ship' });
  await new Promise((resolve) => setImmediate(resolve));
  const contents = f.electron.api.ensureOrderView(f.account.id).webContents;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(contents.sent.length, 1);
  f.ipcMain.emit('order:ship-result', event, { requestId: contents.sent[0].payload.requestId, ok: true, status: '已发货' });
  await one; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(contents.sent.length, 2);
  f.ipcMain.emit('order:ship-result', event, { requestId: contents.sent[1].payload.requestId, ok: false, uncertain: true });
  assert.equal((await two).ok, false);
  assert.equal(f.store.listOrders(f.account.id).find((row) => row.order_no === 'SHIP-1').status, '已发货');
  assert.equal(f.store.listOrders(f.account.id).find((row) => row.order_no === 'SHIP-2').status, '待发货');
});

test('订单动作等待页面加载时停用店铺，会移除监听，迟到加载事件不能再执行', async (t) => {
  const f = mainFixture(t);
  f.store.upsertOrder(f.account.id, { order_no: 'SHIP', status: '待发货' });
  const contents = f.electron.api.ensureOrderView(f.account.id).webContents;
  contents.isLoading = () => true;
  const pending = f.call('order:operate', { accountId: f.account.id, orderNo: 'SHIP', action: 'ship' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(contents.listenerCount('did-finish-load'), 1);
  f.call('accounts:update', { id: f.account.id, patch: { disabled: true } });
  assert.equal((await pending).ok, false);
  assert.equal(contents.listenerCount('did-finish-load'), 0);
  contents.emit('did-finish-load');
  assert.equal(contents.sent.length, 0);
});

test('官方赠花事件接通自动收花，重复事件仅操作一次，关闭开关或其它窗口不能触发', async (t) => {
  const f = mainFixture(t), interaction = f.load('src/main/buyer-interaction.js');
  let calls = 0;
  interaction.init({ order: async (_id, action) => { assert.equal(action, 'receive-flower'); calls++; return { ok: true }; } });
  f.store.upsertOrder(f.account.id, { order_no: 'FLOWER', status: '交易完成' });
  const contents = f.electron.api.ensureOrderView(f.account.id).webContents;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const handle = f.ipcMain.listeners('order:flower')[0];
  await handle(event, { orderNo: 'FLOWER' }); assert.equal(calls, 0);
  f.store.saveBuyerInteraction(f.account.id, { receiveFlower: { enabled: true } });
  await handle({ sender: f.views[0].webContents }, { orderNo: 'FLOWER' }); assert.equal(calls, 0);
  await Promise.all([handle(event, { orderNo: 'FLOWER' }), handle(event, { orderNo: 'FLOWER' })]);
  assert.equal(calls, 1);
});

function orderPage({ shipped = false, flower = false } = {}) {
  let dialogOpen = false, statusText = '待发货';
  const sent = [], handlers = new Map(), intervals = new Map();
  const visible = { getBoundingClientRect: () => ({ width: 50, height: 20 }) };
  const ship = { ...visible, textContent: '发货', click() { dialogOpen = true; } };
  const gift = { ...visible, textContent: '收下小红花', click() {} };
  const confirm = { ...visible, textContent: '确认发货', click() { dialogOpen = false; if (shipped) statusText = '已发货'; } };
  const status = { get textContent() { return statusText; } };
  const buyer = { textContent: '买家', getAttribute: () => null, querySelector: () => null };
  const row = { get textContent() { return '订单 1234567890123456 ' + statusText + ' 实付款 20 x 1'; },
    getAttribute(name) { return ({ 'data-order-no': '1234567890123456', 'data-item-id': '123456789',
      'data-buyer-id': '99887766', 'data-buyer-credit': '8' })[name] || null; },
    querySelector(selector) { return selector.includes('status') ? status : selector.includes('buyer') || selector.includes('nick') ? buyer : null; },
    querySelectorAll() { return flower ? [ship, gift] : [ship]; } };
  const dialog = { ...visible, querySelectorAll: (selector) => selector === 'button' ? [confirm] : [] };
  const context = vm.createContext({ console, require: () => ({ ipcRenderer: {
    on: (name, fn) => handlers.set(name, fn), send: (channel, payload) => sent.push({ channel, payload }) } }),
    document: { readyState: 'loading', addEventListener() {}, querySelectorAll(selector) {
      return selector.includes('dialog') || selector.includes('modal') ? dialogOpen ? [dialog] : [] : [row];
    } }, window: { addEventListener() {} },
    setTimeout: (fn) => queueMicrotask(fn), clearTimeout() {},
    setInterval: (fn, ms) => { intervals.set(ms, fn); return ms; }, clearInterval() {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'src/inject/order-preload.js'), 'utf8'), context);
  return { context, sent, handlers, intervals };
}

test('发货弹窗关闭但状态未变时返回待核对，只有目标订单状态确认才成功', async () => {
  const failed = orderPage(), success = orderPage({ shipped: true });
  const uncertain = await failed.context.window.__xyShip({ orderNo: '1234567890123456' });
  assert.equal(uncertain.ok, false); assert.equal(uncertain.uncertain, true);
  assert.equal((await success.context.window.__xyShip({ orderNo: '1234567890123456' })).ok, true);
});

test('未变化的订单仍按五分钟重检，扫描传递身份和信用，并上报赠花', () => {
  const page = orderPage({ flower: true });
  vm.runInContext('boot()', page.context);
  const scans = page.sent.filter((row) => row.channel === 'order:scan');
  assert.equal(scans[0].payload.orders[0].buyer_uid, '99887766');
  assert.equal(scans[0].payload.orders[0].buyer_credit, 8);
  page.intervals.get(300000)(); vm.runInContext('scanOrders()', page.context);
  assert.equal(page.sent.filter((row) => row.channel === 'order:pending').length, 2);
  assert.equal(page.sent.filter((row) => row.channel === 'order:scan').length, 1);
  assert.equal(page.sent.filter((row) => row.channel === 'order:flower').length, 2);
});

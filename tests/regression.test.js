'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fixture, fakeElectron, root } = require('./helpers');

function shop(t, imports) {
  const f = fixture(t, imports);
  f.account = f.store.addAccount('测试店铺');
  f.delivery = f.load('src/main/auto-delivery.js');
  f.delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', template: '{卡密}' });
  f.delivery.importCards({ accountId: f.account.id, itemId: 'ITEM', text: 'CARD-A\nCARD-B' });
  f.order = (number = 'ORDER-1') => ({ order_no: number, item_id: 'ITEM', session_id: 'BUYER-' + number });
  f.send = (order, sendFn = async () => ({ ok: true })) => f.delivery.handleOrder({ accountId: f.account.id, order, sendFn });
  return f;
}

test('并发延迟订单领取不同卡密', async (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', template: '{卡密}', delay_seconds: 0.02 });
  const sent = [];
  const results = await Promise.all(['1', '2'].map((number) => f.send(f.order(number), async (_sid, text) => { sent.push(text); return { ok: true }; })));
  assert.ok(results.every((r) => r.ok));
  assert.equal(new Set(sent).size, 2);
});

test('同一订单并发只发送一次', async (t) => {
  const f = shop(t);
  let count = 0;
  await Promise.all([1, 2].map(() => f.send(f.order(), async () => { count++; await new Promise((r) => setTimeout(r, 5)); return { ok: true }; })));
  assert.equal(count, 1);
});

test('日志轮换和重启后仍然拦截已发订单', async (t) => {
  const f = shop(t);
  assert.equal((await f.send(f.order())).ok, true);
  for (let i = 0; i < 550; i++) f.delivery.pushDeliverLog({ account_id: 99, order_no: 'OTHER-' + i, ok: true });
  f.store.flush();
  f.store.init(f.directory);
  let sent = false;
  assert.equal((await f.send(f.order(), async () => { sent = true; return { ok: true }; })).ok, false);
  assert.equal(sent, false);
});

test('部分消息成功后失败，已泄露卡密不回库存', async (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', template: '{卡密}\n---\n售后说明', msg_gap_ms: 1 });
  let count = 0;
  const first = await f.send(f.order(), async () => ++count === 1 ? { ok: true } : { ok: false, uncertain: false, error: '失败' });
  assert.equal(first.uncertain, true);
  assert.equal(f.delivery.listCards(f.account.id)[0].status, 'reserved');
  const second = await f.send(f.order('SECOND'));
  assert.equal(second.card, 'CARD-B');
});

test('明确未发送可以回滚，超时不确定则冻结卡密', async (t) => {
  const f = shop(t);
  assert.equal((await f.send(f.order(), async () => ({ ok: false, uncertain: false, error: '找不到会话' }))).uncertain, false);
  assert.equal(f.delivery.listCards(f.account.id)[0].status, 'unused');
  assert.equal((await f.send(f.order('TIMEOUT'), async () => ({ ok: false, uncertain: true, error: '超时' }))).uncertain, true);
  assert.equal(f.delivery.listCards(f.account.id)[0].status, 'reserved');
  assert.equal((await f.send(f.order('TIMEOUT'))).ok, false);
});

test('保留中断的投递状态，重启后不自动重发', (t) => {
  const f = shop(t);
  f.store.ready().deliveries.push({ account_id: f.account.id, order_no: 'CRASH', status: 'sending' });
  f.store.persist(); f.store.init(f.directory);
  assert.equal(f.delivery.getDeliveryState(f.account.id, 'CRASH').status, 'uncertain');
});

test('旧已用卡密可以迁移为永久幂等记录', (t) => {
  const f = shop(t);
  Object.assign(f.delivery.listCards(f.account.id)[0], { status: 'used', used_order_no: 'LEGACY' });
  f.store.persist(); f.store.init(f.directory);
  assert.equal(f.delivery.getDeliveryState(f.account.id, 'LEGACY').status, 'uncertain');
});

test('卡密占用未落盘时禁止发送', async (t) => {
  const f = shop(t);
  f.store.persist = () => { throw new Error('磁盘已满'); };
  let count = 0;
  const result = await f.send(f.order(), async () => { count++; return { ok: true }; });
  assert.equal(result.ok, false); assert.equal(count, 0);
  assert.equal(f.delivery.listCards(f.account.id)[0].status, 'reserved');
});

test('缺少会话ID和昵称标识不消耗库存', async (t) => {
  const f = shop(t);
  for (const session_id of ['', 'nick:同名买家']) {
    assert.equal((await f.send({ ...f.order(), session_id })).ok, false);
  }
  assert.equal(f.delivery.cardStats(f.account.id, 'ITEM').unused, 2);
});

test('延迟期间停用店铺后取消发送并释放未发送卡密', async (t) => {
  const f = shop(t);
  f.delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM', template: '{卡密}', delay_seconds: 0.02 });
  let count = 0;
  const pending = f.send(f.order(), async () => { count++; return { ok: true }; });
  f.store.updateAccount(f.account.id, { disabled: true });
  await pending;
  assert.equal(count, 0); assert.equal(f.delivery.cardStats(f.account.id, 'ITEM').unused, 2);
});

test('删除店铺清理业务数据，重启后也不复用ID', (t) => {
  const f = shop(t);
  f.store.upsertOrder(f.account.id, f.order());
  f.store.removeAccount(f.account.id); f.store.flush(); f.store.init(f.directory);
  const next = f.store.addAccount('新店铺');
  assert.ok(next.id > f.account.id);
  assert.equal(f.delivery.listCards(f.account.id).length, 0);
  assert.equal(f.delivery.listDeliverRules(f.account.id).length, 0);
  assert.equal(f.store.listOrders(f.account.id).length, 0);
});

test('历史登录分区的ID不会被重新分配', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.directory, 'Partitions', 'xy-19'), { recursive: true });
  f.store.init(f.directory);
  assert.equal(f.store.addAccount('新店铺').id, 20);
});

test('订单保存并保留买家会话ID', (t) => {
  const f = shop(t);
  f.store.upsertOrder(f.account.id, f.order());
  f.store.upsertOrder(f.account.id, { order_no: 'ORDER-1', status: '待发货' });
  assert.equal(f.store.listOrders(f.account.id)[0].session_id, 'BUYER-ORDER-1');
});

test('任务开关保留执行时间及其他配置', (t) => {
  const f = fixture(t), tasks = f.load('src/main/tasks.js');
  tasks.setTaskEnabled('polish', true, { acceptRisk: true });
  assert.equal(f.store.getSettings().tasks.polish.hour, 9);
  assert.equal(f.store.getSettings().tasks.polish.minute, 0);
  assert.equal(f.store.getSettings().tasks.tokenRenew.checkMinutes, 30);
});

test('损坏主文件从备份恢复，备份也损坏则保留原文件并报错', (t) => {
  const f = fixture(t);
  f.store.addAccount('保留'); f.store.flush(); f.store.flush();
  const file = path.join(f.directory, 'state.json');
  fs.writeFileSync(file, '{truncated');
  f.store.init(f.directory);
  assert.equal(f.store.listAccounts()[0].label, '保留');
  fs.writeFileSync(file, '{bad'); fs.writeFileSync(file + '.bak', '{also bad');
  assert.throws(() => f.store.init(f.directory), /停止写入/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});

test('原子替换失败时主文件保持完整', (t) => {
  let failRename = false;
  const f = fixture(t, { fs: { ...fs, renameSync(from, to) {
    if (failRename && to.endsWith('example.json')) throw new Error('模拟原子替换失败');
    return fs.renameSync(from, to);
  } } }), atomic = f.load('src/main/atomic-json.js');
  const file = path.join(f.directory, 'example.json');
  atomic.writeJson(file, { keep: true });
  failRename = true;
  assert.throws(() => atomic.writeJson(file, { keep: false }), /模拟原子替换失败/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { keep: true });
  assert.equal(fs.readdirSync(f.directory).some((name) => name.endsWith('.tmp')), false);
});

test('人工核对未收到后可使用新卡密补发，原卡不再出售', async (t) => {
  const f = shop(t);
  await f.send(f.order(), async () => ({ ok: false, uncertain: true }));
  assert.equal(f.delivery.resolveDelivery(f.account.id, 'ORDER-1', false).ok, true);
  assert.equal(f.delivery.listCards(f.account.id)[0].status, 'reserved');
  assert.equal((await f.delivery.handleOrder({ accountId: f.account.id, order: f.order(), resend: true,
    sendFn: async () => ({ ok: true }) })).card, 'CARD-B');
});

test('人工核对结果保存失败时继续冻结订单', async (t) => {
  const f = shop(t);
  await f.send(f.order(), async () => ({ ok: false, uncertain: true }));
  f.store.persist = () => { throw new Error('磁盘已满'); };
  assert.equal(f.delivery.resolveDelivery(f.account.id, 'ORDER-1', false).ok, false);
  assert.equal(f.delivery.getDeliveryState(f.account.id, 'ORDER-1').status, 'uncertain');
});

test('未落盘的新消息立即可查询', (t) => {
  const f = fixture(t);
  f.store.saveMessage(1, { id: 'S' }, { messageId: 'M', content: { text: '最新消息' } });
  assert.equal(f.store.listMessages(1, 'S', 1)[0].text, '最新消息');
});

test('消息分片按月份及数字序号排序，跨分片去重', (t) => {
  const f = fixture(t), messages = f.load('src/main/message-store.js');
  const dir = path.join(f.directory, 'messages', '1'); fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of [['2026-10.json', 'BASE'], ['2026-10-2.json', 'PART2'], ['2026-10-10.json', 'LATEST']]) {
    fs.writeFileSync(path.join(dir, file), JSON.stringify([{ session_id: 'S', message_id: text, text, ts: 1 }]));
  }
  assert.equal(messages.query(1, 'S', 1)[0].text, 'LATEST');
  assert.equal(messages.append(1, { session_id: 'S', message_id: 'PART2', ts: new Date(2026, 9, 20).getTime() }), false);
});

test('停用店铺不再自动回复', (t) => {
  const f = shop(t), engine = f.load('src/main/reply-engine.js');
  f.store.saveRule({ accountId: f.account.id, keywords: ['你好'], content: '您好' });
  f.store.updateAccount(f.account.id, { disabled: true });
  assert.equal(engine.decide({ accountId: f.account.id, session: { id: 'S' }, message: { content: { text: '你好' } } }).action, 'skip');
});

for (const change of ['人工接管', '关闭再打开', '停用再启用']) {
  test(`AI等待期间${change}，旧回复不能发出`, async (t) => {
    let finish;
    const f = shop(t, { './ai': { chat: () => new Promise((resolve) => { finish = resolve; }) } });
    f.store.updateSettings({ ai: { enabled: true } });
    const engine = f.load('src/main/reply-engine.js'); let sent = 0;
    const pending = engine.handle({ accountId: f.account.id, account: f.account, session: { id: 'S' },
      message: { content: { text: '在吗' } }, sendFn: async () => { sent++; return { ok: true }; } });
    await new Promise((resolve) => setImmediate(resolve));
    if (change === '人工接管') f.store.markHumamActivity(f.account.id, 'S');
    if (change === '关闭再打开') { f.store.updateSettings({ autoReply: { enabled: false } }); f.store.updateSettings({ autoReply: { enabled: true } }); }
    if (change === '停用再启用') { f.store.updateAccount(f.account.id, { disabled: true }); f.store.updateAccount(f.account.id, { disabled: false }); }
    finish({ ok: true, reply: 'AI回复' }); await pending;
    assert.equal(sent, 0);
  });
}

test('回复发送失败不记录为成功，下一次同内容可重试', async (t) => {
  const f = shop(t), engine = f.load('src/main/reply-engine.js');
  f.store.saveRule({ accountId: f.account.id, keywords: ['你好'], content: '您好' });
  const args = { accountId: f.account.id, account: f.account, session: { id: 'S' }, message: { content: { text: '你好' } } };
  assert.equal((await engine.handle({ ...args, sendFn: async () => ({ ok: false, error: '失败' }) })).action, 'error');
  assert.equal((await engine.handle({ ...args, sendFn: async () => ({ ok: true }) })).action, 'reply');
});

function mainFixture(t) {
  const fake = fakeElectron();
  const f = fixture(t, { electron: fake.electron, './notify': { notify: async () => ({ ok: true }) } });
  f.load('src/main/index.js'); fake.electron.api.createWindow();
  const event = { sender: fake.windows[0].webContents, senderFrame: fake.windows[0].webContents.mainFrame };
  const call = (name, value) => fake.handles.get(name)(event, value);
  const account = call('accounts:add', { label: '测试店铺' });
  return { ...f, ...fake, call, account };
}

test('远程页面启用沙箱且不能调用店铺管理IPC', (t) => {
  const f = mainFixture(t), im = f.views[0];
  assert.equal(im.options.webPreferences.nodeIntegration, false);
  assert.equal(im.options.webPreferences.contextIsolation, true);
  assert.equal(im.options.webPreferences.webSecurity, true);
  assert.equal(im.options.webPreferences.sandbox, true);
  assert.throws(() => f.handles.get('accounts:list')({ sender: im.webContents }), /未授权/);
});

test('发送必须等待正确页面、请求ID、会话ID的确认', async (t) => {
  const f = mainFixture(t), im = f.views[0].webContents;
  let settled = false;
  const pending = f.electron.api.sendToSession(f.account.id, 'BUYER', { kind: 'delivery', content: 'CARD' }).then((r) => { settled = true; return r; });
  const request = im.sent.at(-1).payload;
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  const remote = { sender: im, senderFrame: im.mainFrame };
  assert.equal(f.handles.get('im:can-send')(remote, request), true);
  f.ipcMain.emit('im:send-result', remote, { ...request, sessionId: 'WRONG', ok: true });
  assert.equal(settled, false);
  f.ipcMain.emit('im:send-result', remote, { ...request, ok: false, uncertain: false, error: '找不到会话' });
  assert.equal((await pending).ok, false);
});

test('机器人自己的消息不触发人工静默', async (t) => {
  const f = mainFixture(t), im = f.views[0].webContents;
  f.ipcMain.emit('im:message', { sender: im }, { session: { id: 'S' },
    message: { messageId: 'BOT', direction: 'out', source: 'ai', content: { text: '自动回复' } } });
  assert.equal(f.store.findSession(f.account.id, 'S').last_human_ts, 0);
  f.ipcMain.emit('im:message', { sender: im }, { session: { id: 'S' },
    message: { messageId: 'HUMAN', direction: 'out', source: 'human', content: { text: '人工回复' } } });
  assert.ok(f.store.findSession(f.account.id, 'S').last_human_ts > 0);
});

test('删除账号销毁三个页面并清理登录分区', async (t) => {
  const f = mainFixture(t), im = f.views[0].webContents;
  f.electron.api.ensureOrderView(f.account.id); f.electron.api.ensureProductView(f.account.id);
  await f.call('accounts:remove', f.account.id);
  assert.ok(f.views.every((view) => view.webContents.destroyed));
  assert.equal(im.storageCleared, true); assert.equal(im.cacheCleared, true);
  assert.ok(f.call('accounts:add', { label: '新店铺' }).id > f.account.id);
});

test('补发缺失会话时明确拒绝，不消耗卡密', async (t) => {
  const f = mainFixture(t), delivery = f.load('src/main/auto-delivery.js');
  delivery.saveDeliverRule({ accountId: f.account.id, item_id: 'ITEM' });
  delivery.importCards({ accountId: f.account.id, itemId: 'ITEM', text: 'CARD' });
  f.store.upsertOrder(f.account.id, { order_no: 'O', item_id: 'ITEM' });
  const result = await f.call('order:operate', { accountId: f.account.id, orderNo: 'O', action: 'resend' });
  assert.equal(result.ok, false); assert.equal(delivery.cardStats(f.account.id, 'ITEM').unused, 1);
});

test('主进程存储调用及界面IPC均有实现', (t) => {
  const f = fixture(t), main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
  for (const match of main.matchAll(/\bstore\.(\w+)\s*\(/g)) assert.equal(typeof f.store[match[1]], 'function', match[1]);
  const preload = fs.readFileSync(path.join(root, 'src/shell/shell-preload.js'), 'utf8');
  for (const match of preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)) {
    assert.ok(main.includes(`handleShell('${match[1]}'`) || main.includes(`handleProduct('${match[1]}'`), match[1]);
  }
});

test('订单只允许关联本店会话，并拒绝已知买家身份冲突', async (t) => {
  const f = mainFixture(t);
  f.store.saveMessage(f.account.id, { id: 'S', peerUserId: 'BUYER-A' }, { messageId: 'M', content: { text: '咨询' } });
  f.store.upsertOrder(f.account.id, { order_no: 'O', item_id: 'ITEM', buyer_uid: 'BUYER-B' });
  const payload = { accountId: f.account.id, orderNo: 'O', action: 'link-session', payload: { sessionId: 'S' } };
  assert.equal((await f.call('order:operate', payload)).ok, false);
  f.store.upsertOrder(f.account.id, { order_no: 'O', buyer_uid: 'BUYER-A' });
  assert.equal((await f.call('order:operate', payload)).ok, true);
  assert.equal(f.store.listOrders(f.account.id)[0].session_id, 'S');
});

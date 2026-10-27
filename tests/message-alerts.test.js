'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMessageAlerts, normalizeConfig } = require('../src/main/message-alerts');
const { fixture, fakeElectron } = require('./helpers');

const initial = 1793074000000;
function setup(config = {}) {
  let time = initial;
  const settings = { messageAlerts: config }, sound = [], desktop = [], flashed = [], errors = [];
  const alerts = createMessageAlerts({ getSettings: () => settings, now: () => time,
    playSound: (x) => sound.push(x), showNotification: (x) => desktop.push(x), flash: (x) => flashed.push(x), onError: (x) => errors.push(x) });
  const account = { id: 1, label: '店铺甲' };
  const message = (id = 'M1', patch = {}, shop = account, sessionId = 'BUYER') => alerts.message(shop,
    { id: sessionId, withWhoNick: '买家甲' }, { messageId: id, ts: time, direction: 'in', content: { text: '还在吗' }, ...patch });
  const row = (patch = {}) => ({ id: 'BUYER', nickname: '买家甲', last_ts: time, last_text: '还在吗', unread: 1, ...patch });
  return { alerts, settings, sound, desktop, flashed, errors, account, message, row, advance: (ms) => { time += ms; } };
}

test('新消息默认响铃并通知，自己发送、系统、历史和停用店铺不提醒', () => {
  const f = setup();
  assert.equal(f.message(), true);
  assert.equal(f.sound.length, 1); assert.equal(f.desktop.length, 1); assert.equal(f.flashed.length, 1);
  assert.equal(f.desktop[0].accountLabel, '店铺甲'); assert.equal(f.desktop[0].sessionId, 'BUYER');
  for (const patch of [{ direction: 'out' }, { source: 'system' }, { history: true }, { ts: initial - 180000 }, { ts: initial + 90000 }]) {
    f.advance(4000); assert.equal(f.message('IGNORED-' + JSON.stringify(patch), patch), false);
  }
  assert.equal(f.message('DISABLED', {}, { ...f.account, disabled: true }), false);
  assert.equal(f.sound.length, 1);
});

test('重复消息幂等，两个店铺的相同会话与消息ID互不串扰', () => {
  const f = setup();
  f.message(); f.advance(4000); assert.equal(f.message('M1'), false);
  assert.equal(f.message('M1', {}, { id: 2, label: '店铺乙' }), true);
  assert.equal(f.desktop.length, 2); assert.equal(f.desktop[1].accountId, 2);
});

test('首次会话列表不响铃，后台会话新的未读消息独立提醒', () => {
  const f = setup();
  f.alerts.conversations(f.account, [f.row()]); assert.equal(f.sound.length, 0);
  f.advance(4000);
  f.alerts.conversations(f.account, [f.row({ last_message_id: 'NEW', unread: 2 })]);
  assert.equal(f.sound.length, 1); assert.equal(f.desktop[0].peerNick, '买家甲');
  f.advance(4000); f.alerts.conversations(f.account, [f.row({ last_message_id: 'NEW', last_ts: initial + 4000, unread: 2 })]);
  assert.equal(f.sound.length, 1);
  f.alerts.resetAccount(1); f.alerts.conversations(f.account, [f.row({ unread: 5 })]);
  assert.equal(f.sound.length, 1, '页面重新连接时只建立新基线');
});

test('分页旧会话、无未读、自发摘要和系统摘要不提醒，新客户可提醒', () => {
  const f = setup();
  f.alerts.conversations(f.account, [f.row()]); f.advance(4000);
  for (const patch of [{ id: 'OLD', last_ts: initial - 180000 }, { id: 'READ', unread: 0 },
    { id: 'SELF', last_direction: 'out' }, { id: 'SYSTEM', system: true }]) f.alerts.conversations(f.account, [f.row(patch)]);
  assert.equal(f.sound.length, 0);
  f.alerts.conversations(f.account, [f.row({ id: 'NEW-CUSTOMER' })]); assert.equal(f.sound.length, 1);
});

test('会话摘要与聊天内容交叉到达只提醒一次', () => {
  for (const first of ['summary', 'message']) {
    const f = setup(); f.alerts.conversations(f.account, [f.row()]); f.advance(4000);
    const summary = () => f.alerts.conversations(f.account, [f.row({ last_message_id: 'NEW', unread: 2 })]);
    if (first === 'summary') { summary(); f.message('NEW'); } else { f.message('NEW'); summary(); }
    assert.equal(f.desktop.length, 1, first); assert.equal(f.sound.length, 1, first);
  }
});

test('同会话连续消息合并，跨会话桌面提示独立，声音防连响', () => {
  const f = setup(); f.message('M1'); f.advance(100);
  f.message('M2'); f.message('M3', {}, f.account, 'OTHER');
  assert.equal(f.desktop.length, 2); assert.equal(f.sound.length, 1);
  f.advance(4000); f.message('M4'); assert.equal(f.sound.length, 2);
});

test('总开关、声音开关、桌面开关和零音量互相独立', () => {
  for (const [cfg, sound, desktop, flash] of [[{ enabled: false }, 0, 0, 0], [{ soundEnabled: false }, 0, 1, 1],
    [{ desktopEnabled: false }, 1, 0, 1], [{ volume: 0 }, 0, 1, 1]]) {
    const f = setup(cfg); f.message();
    assert.equal(f.sound.length, sound); assert.equal(f.desktop.length, desktop); assert.equal(f.flashed.length, flash);
  }
  assert.equal(normalizeConfig({ volume: -10 }).volume, 0);
  assert.equal(normalizeConfig({ volume: 150 }).volume, 100);
  assert.equal(normalizeConfig({ volume: 'invalid' }).volume, 60);
  assert.equal(normalizeConfig(null).volume, 60);
});

test('新增设置可迁移旧数据，保存后重启保持提醒偏好', (t) => {
  const f = fixture(t); delete f.store.ready().settings.messageAlerts; f.store.persist(); f.store.init(f.directory);
  assert.equal(f.store.getSettings().messageAlerts.volume, 60);
  f.store.updateSettings({ messageAlerts: { soundEnabled: false, volume: 23 } }); f.store.persist(); f.store.init(f.directory);
  assert.equal(f.store.getSettings().messageAlerts.soundEnabled, false);
  assert.equal(f.store.getSettings().messageAlerts.enabled, true);
  assert.equal(f.store.getSettings().messageAlerts.volume, 23);
});

test('提醒失败不会阻断其余提醒通道', () => {
  let sounds = 0, errors = 0;
  const a = createMessageAlerts({ getSettings: () => ({}), now: () => initial, flash() {},
    showNotification() { throw new Error('系统拒绝通知'); }, playSound() { sounds++; }, onError() { errors++; } });
  a.message({ id: 1 }, { id: 'S' }, { messageId: 'M', ts: initial, direction: 'in', content: { imgUrl: 'https://example.invalid/image' } });
  assert.equal(sounds, 1); assert.equal(errors, 1);
});

test('实际主进程接入后台提醒，通知静音防双响，点击定位指定店铺且远程不能调用', async (t) => {
  const fake = fakeElectron(), notifications = [];
  fake.electron.Notification = class extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notifications.push(this); }
    show() { this.shown = true; } close() { this.emit('close'); }
  };
  const f = fixture(t, { electron: fake.electron });
  f.load('src/main/index.js'); fake.electron.api.createWindow();
  const main = fake.windows[0], sender = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const call = (name, arg) => fake.handles.get(name)(sender, arg);
  const account = call('accounts:add', { label: '后台店铺' }), view = fake.views[0].webContents;
  f.store.updateSettings({ autoReply: { enabled: false } });
  const remote = { sender: view, senderFrame: view.mainFrame }, time = Date.now();
  const row = { id: 'BUYER', nickname: '后台买家', last_ts: time - 5000, last_text: '旧消息', unread: 1 };
  fake.ipcMain.emit('im:sessions', remote, [row]); assert.equal(notifications.length, 0);
  fake.ipcMain.emit('im:sessions', remote, [{ ...row, last_ts: time, last_text: '新咨询', unread: 2 }]);
  assert.equal(notifications.length, 1); assert.equal(notifications[0].options.silent, true);
  assert.match(notifications[0].options.title, /后台店铺/);
  assert.ok(main.webContents.sent.some((x) => x.channel === 'ui:message-sound'));
  notifications[0].emit('click');
  const open = main.webContents.sent.find((x) => x.channel === 'ui:open-message');
  assert.equal(open.payload.accountId, account.id); assert.equal(open.payload.sessionId, 'BUYER');
  assert.equal(call('messages:focus', open.payload).ok, true);
  assert.ok(view.sent.some((x) => x.channel === 'inject:focus-session' && x.payload.sessionId === 'BUYER'));
  assert.throws(() => fake.handles.get('messages:focus')(remote, open.payload), /未授权/);
  assert.equal(main.options.webPreferences.autoplayPolicy, 'no-user-gesture-required');
  assert.equal(main.options.webPreferences.backgroundThrottling, false);
});

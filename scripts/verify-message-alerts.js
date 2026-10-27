'use strict';

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true, timeout: 90000 });
  process.exit(result.status === 0 ? 0 : 1);
}

const { app, BrowserWindow, session } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const root = path.join(__dirname, '..');
const source = process.argv.includes('--packed') ? path.join(root, require('../package.json').build.directories.output, 'win-unpacked/resources/app.asar') : root;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-message-check-'));
app.setPath('appData', temporary); app.setPath('userData', path.join(temporary, 'OpenFish'));
app.commandLine.appendSwitch('disable-gpu');
BrowserWindow.prototype.show = function () {}; BrowserWindow.prototype.focus = function () {};
const notifications = [], errors = [], checks = [];
// Desktop notifications are recorded; local audio and rendered-page IPC remain real.
class TestNotification extends require('events').EventEmitter {
  static isSupported() { return true; }
  constructor(options) { super(); Object.assign(this, options); }
  show() { notifications.push(this); }
  close() { this.emit('close'); }
}
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (name) => { checks.push(name); console.log('PASS ' + name); };
async function until(check, message) {
  for (let i = 0; i < 80; i++) { if (await check()) return; await pause(); }
  throw new Error(message);
}
const page = `<!doctype html><meta charset="utf-8"><div class="page-im"><div class="im-main--fixture">
  <div class="sidebar-container--fixture"><button class="conversation-item--fixture" id="A"><span class="title--fixture">演示买家甲</span><span class="unread-badge">0</span></button><button class="conversation-item--fixture" id="B"><span class="title--fixture">演示买家乙</span><span class="unread-badge">0</span></button></div>
  <div class="chat-main--fixture"><div class="conv-header--fixture"><span class="nick">演示买家甲</span></div><div class="message-list"></div><textarea></textarea></div>
  </div></div><script>
  const chat = document.querySelector('.chat-main--fixture');
  const chatProps = { store: { activeCid: 'A' } }; chat.__reactFiber$fixture = { memoizedProps: chatProps };
  for(const id of ['A','B']) {
    const node=document.getElementById(id);
    node.__reactFiber$fixture={memoizedProps:{sessionInfo:{sessionId:id,unreadCount:0,summary:{summaryContent:'历史消息',timeStamp:Date.now()-3600000,isMyMsg:false}}}};
    node.onclick=()=>{chatProps.store.activeCid=id;node.__reactFiber$fixture.memoizedProps.sessionInfo.unreadCount=0;node.querySelector('.unread-badge').textContent='0';document.querySelector('.conv-header--fixture .nick').textContent=node.querySelector('.title--fixture').textContent;document.querySelector('.message-list').replaceChildren()};
  }
  window.fixtureIncoming=(id,text)=>{const node=document.getElementById(id),info=node.__reactFiber$fixture.memoizedProps.sessionInfo;info.unreadCount++;info.summary={summaryContent:text,timeStamp:Date.now(),messageId:'incoming-'+Math.random(),isMyMsg:false};node.querySelector('.unread-badge').textContent=String(info.unreadCount)};
  window.fixtureOutgoing=(id)=>{const node=document.getElementById(id),info=node.__reactFiber$fixture.memoizedProps.sessionInfo;info.summary={summaryContent:'人工回复',timeStamp:Date.now(),isMyMsg:true};node.querySelector('.title--fixture').textContent+=' '};
  </script>`;

let started = false;
const timeout = setTimeout(() => { console.error('Message alert verification timed out'); app.exit(1); }, 80000);
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_e, file, error) => errors.push(path.basename(file) + ': ' + error.message));
  contents.on('console-message', (_e, level, message) => { if (level >= 3 && contents.getURL().includes('/shell/')) errors.push(message); });
  contents.on('did-finish-load', async () => {
    if (started || !contents.getURL().endsWith('/shell/index.html')) return;
    started = true;
    try {
      const main = BrowserWindow.fromWebContents(contents), evaluate = (code) => contents.executeJavaScript(code);
      await pause(250);
      for (const current of [session.defaultSession, session.fromPartition('persist:xy-1'), session.fromPartition('persist:xy-2')]) {
        await current.protocol.interceptBufferProtocol('https', (request, callback) => callback({ statusCode: request.url.startsWith('https://www.goofish.com/im') ? 200 : 403, mimeType: 'text/html', data: Buffer.from(page) }));
        current.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (_details, callback) => callback({ cancel: true }));
      }
      const store = require(path.join(source, 'src/main/store'));
      store.updateSettings({ autoReply: { enabled: false } });
      await evaluate(`(async()=>{await window.api.accounts.add('演示 · 前台店铺');await window.api.accounts.add('演示 · 后台店铺');await selectAccount(1);await switchView('settings');switchSettingsTab('notify')})()`);
      await until(() => evaluate(`!!document.querySelector('#stab-notify #msg-alert-save')`), '通知设置没有渲染');
      assert.equal(await evaluate(`document.querySelector('#stab-notify #msg-alert-sound').checked`), true);
      await evaluate(`document.querySelector('.breadcrumb').insertAdjacentHTML('beforeend','<span style="margin-left:12px;font-size:11px;color:#6b7075">离线演示 · 新消息提醒验收</span>')`);
      pass('通知设置提供新消息提醒，声音和桌面通知默认启用');
      await evaluate(`document.querySelector('#stab-notify #msg-alert-volume').value=35;document.querySelector('#stab-notify #msg-alert-volume').dispatchEvent(new Event('input'));document.querySelector('#stab-notify #msg-alert-save').click()`);
      await until(() => store.getSettings().messageAlerts.volume === 35, '音量没有保存');
      store.persist();
      assert.equal(store.getSettings().messageAlerts.desktopEnabled, true);
      pass('设置界面可保存音量并立即用于所有店铺');

      await evaluate('window.MessageSound.play(35)');
      assert.ok(await evaluate('window.MessageSound.status().playedAt > 0'));
      assert.equal(await evaluate('window.MessageSound.status().volume'), 0.35);
      const pcm = fs.readFileSync(path.join(source, 'src/shell/message-alert.wav'));
      assert.equal(pcm.toString('ascii', 0, 4), 'RIFF'); assert.ok(pcm.length > 20000);
      pass('真实 WAV 在本地渲染器中成功开始播放，音量为 35%');

      await pause(1600); assert.equal(notifications.length, 0, '加载历史会话不能弹通知');
      const views = main.getBrowserViews();
      // Settings unmounts the foreground view, so use the partition identity, not screen order.
      const all = require('electron').webContents.getAllWebContents();
      const second = all.find((x) => x.getURL().startsWith('https://www.goofish.com/im') && x.session === session.fromPartition('persist:xy-2'));
      assert.ok(second, '后台店铺浏览器必须运行');
      assert.ok(store.findSession(2, 'B'), '后台会话列表必须通过真实 preload 到达主进程');
      assert.ok(!views.some((x) => x.webContents === second));
      const previousSound = await evaluate('window.MessageSound.status().playedAt');
      main.hide();
      await second.executeJavaScript(`fixtureIncoming('B','请问还有现货吗')`);
      await until(() => notifications.length === 1, '后台未打开的会话没有弹通知');
      await until(() => evaluate(`window.MessageSound.status().playedAt > ${previousSound}`), '隐藏到后台没有自动播放提示音');
      assert.match(notifications[0].title, /后台店铺/); assert.match(notifications[0].body, /演示买家乙/);
      pass('隐藏主窗口、后台店铺未打开的买家会话均触发通知与自动播放');
      await pause(1300); assert.equal(notifications.length, 1, '重复扫描不能重复通知');
      notifications[0].emit('click');
      await until(() => evaluate(`currentAccountId===2 && currentView==='chat'`), '点击通知没有切换对应店铺');
      await until(() => second.executeJavaScript(`document.querySelector('.chat-main--fixture').getAttribute('data-xy-session-id')==='B'`), '通知未定位对应买家');
      pass('点击通知切换对应店铺并实际定位买家会话');

      await second.executeJavaScript(`document.querySelector('textarea').value='请保留这个未发送的草稿';fixtureIncoming('A','另一位买家的新消息')`);
      await until(() => notifications.length === 2, '第二个买家未收到提醒'); notifications[1].emit('click');
      await until(() => evaluate(`document.querySelector('#toasts').innerText.includes('未发送草稿')`), '草稿保护没有提示');
      assert.equal(await second.executeJavaScript(`document.querySelector('textarea').value`), '请保留这个未发送的草稿');
      assert.equal(await second.executeJavaScript(`document.querySelector('.chat-main--fixture').getAttribute('data-xy-session-id')`), 'B');
      pass('点击其他买家的通知时保留未发送草稿并明确提示');

      await evaluate(`(async()=>{await switchView('settings');switchSettingsTab('notify')})()`);
      await until(() => evaluate(`!!document.querySelector('#stab-notify #msg-alert-enabled')`), '设置未加载');
      await evaluate(`document.querySelector('#stab-notify #msg-alert-enabled').checked=false;document.querySelector('#stab-notify #msg-alert-save').click()`);
      await until(() => store.getSettings().messageAlerts.enabled === false, '总开关没有保存');
      const lastPlayed = await evaluate('window.MessageSound.status().playedAt');
      await second.executeJavaScript(`fixtureIncoming('B','关闭提醒后的消息')`); await pause(1400);
      assert.equal(notifications.length, 2); assert.equal(await evaluate('window.MessageSound.status().playedAt'), lastPlayed);
      pass('关闭总开关后后台新消息不弹通知也不播放声音');
      await evaluate(`document.querySelector('#stab-notify #msg-alert-enabled').checked=true;document.querySelector('#stab-notify #msg-alert-save').click()`);
      await until(() => store.getSettings().messageAlerts.enabled, '总开关没有恢复');
      await second.executeJavaScript(`fixtureOutgoing('B')`); await pause(1400); assert.equal(notifications.length, 2);
      pass('人工发送造成的会话摘要更新不触发新消息提醒');
      const output = path.join(root, '_bench', 'message-alerts'); fs.mkdirSync(output, { recursive: true });
      await evaluate(`document.querySelector('#stab-notify #msg-alert-result').textContent='已保存，所有店铺立即生效'`);
      fs.writeFileSync(path.join(output, 'settings.png'), (await main.capturePage()).toPNG());
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ status: 'PASS', checks: checks.length, scope: 'temporary profile; offline simulated IM; real local audio playback; no real shops or transactions' }));
      clearTimeout(timeout); app.isQuitting = true; app.quit();
    } catch (error) { console.error(error.stack); console.error(JSON.stringify({ checks, errors })); app.exit(1); }
  });
});
const Module = require('module'), originalLoad = Module._load;
const entry = path.join(source, 'src/main/index.js');
Module._load = function (name, parent, ...args) {
  const value = originalLoad.call(this, name, parent, ...args);
  return name === 'electron' && parent?.filename === entry
    ? new Proxy(value, { get: (target, key) => key === 'Notification' ? TestNotification : target[key] }) : value;
};
require(entry); Module._load = originalLoad;

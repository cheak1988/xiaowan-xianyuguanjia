'use strict';

// 使用临时数据目录和本地模拟页面，不访问真实店铺或已有登录分区。
if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.resolve(__filename), ...process.argv.slice(2)], {
    env, encoding: 'utf8', timeout: 45000, windowsHide: true,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status === 0 ? 0 : 1);
}

const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert').strict;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-electron-smoke-'));
app.setPath('userData', temporary);
app.commandLine.appendSwitch('disable-gpu');
const root = process.argv.includes('--packed') ? path.join(__dirname, '..', require('../package.json').build.directories.output, 'win-unpacked/resources/app.asar')
  : path.join(__dirname, '..');
const windows = [];
const messages = [];
let checks = 0;
const html = `<!doctype html><html><body><div class="page-im"><div class="im-main--test">
<div class="conv-header--test" data-session-id="CURRENT"><span class="nick">买家</span></div>
<div class="conv-item" data-session-id="TARGET">目标（模拟点击失败）</div>
<div class="chat-main--test"><div id="messages"></div><div class="chat-input"><textarea></textarea></div>
<button class="send-btn">发送</button></div></div></div><script>
window.sentCount=0;window.confirmed=true;
document.querySelector('button').onclick=()=>{const input=document.querySelector('textarea');
const node=document.createElement('div');node.className='message-item right--test';node.setAttribute('data-message-id','OUT-'+(++window.sentCount));
if(window.confirmed)node.setAttribute('data-status','sent');
const text=document.createElement('span');text.className='message-content';text.textContent=input.value;node.appendChild(text);
document.querySelector('#messages').appendChild(node);input.value='';};
</script></body></html>`;
const timeout = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1); }, 40000);

ipcMain.handle('im:can-send', () => true);
ipcMain.on('im:message', (event, payload) => messages.push({ sender: event.sender.id, payload }));
ipcMain.on('im:login-status', () => {});

async function makeWindow(preload, partition = 'audit-A') {
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'src/inject', preload), partition,
    contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false,
  } });
  windows.push(win);
  const errors = [];
  win.webContents.on('preload-error', (_event, file, error) => errors.push(file + ': ' + error.message));
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  assert.equal(errors.length, 0, errors.join('\n'));
  checks++;
  return win;
}

function send(win, sessionId, content) {
  const requestId = String(Date.now()) + Math.random();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ipcMain.removeListener('im:send-result', listener); reject(new Error('No send result')); }, 16000);
    const listener = (event, result) => {
      if (event.sender !== win.webContents || result.requestId !== requestId) return;
      clearTimeout(timer); ipcMain.removeListener('im:send-result', listener); resolve(result);
    };
    ipcMain.on('im:send-result', listener);
    win.webContents.send('inject:send', { requestId, sessionId, reply: { kind: 'rule', content } });
  });
}

app.whenReady().then(async () => {
  const first = await makeWindow('im-bundle.js');
  const globals = await first.webContents.executeJavaScript('JSON.stringify([typeof require,typeof process,typeof globalThis.__xyAutomation])');
  assert.equal(globals, '["undefined","undefined","undefined"]'); checks++;
  const result = await send(first, 'CURRENT', '自动回复验证');
  assert.equal(result.ok, true); checks++;
  assert.ok(messages.some((message) => message.payload.message.source === 'rule')); checks++;
  await first.webContents.executeJavaScript('document.querySelector("textarea").value="人工草稿"');
  const draft = await send(first, 'CURRENT', '不可覆盖');
  assert.equal(draft.ok, false);
  assert.equal(await first.webContents.executeJavaScript('document.querySelector("textarea").value'), '人工草稿'); checks++;
  await first.webContents.executeJavaScript('document.querySelector("textarea").value=""');
  const wrong = await send(first, 'TARGET', '不可错发');
  assert.equal(wrong.ok, false);
  assert.equal(await first.webContents.executeJavaScript('window.sentCount'), 1); checks++;
  await first.webContents.executeJavaScript('window.confirmed=false');
  const optimistic = await send(first, 'CURRENT', '仅出现气泡不能算成功');
  assert.equal(optimistic.ok, false); assert.equal(optimistic.uncertain, true); checks++;

  const second = await makeWindow('im-bundle.js', 'audit-B');
  for (const [partition, value] of [['audit-A', 'A'], ['audit-B', 'B']]) {
    await session.fromPartition(partition).cookies.set({ url: 'https://www.goofish.com', name: 'audit-shop', value });
  }
  assert.equal((await session.fromPartition('audit-A').cookies.get({ name: 'audit-shop' }))[0].value, 'A');
  assert.equal((await session.fromPartition('audit-B').cookies.get({ name: 'audit-shop' }))[0].value, 'B'); checks++;
  for (const win of [first, second]) {
    await win.webContents.executeJavaScript(`(()=>{const node=document.createElement('div');node.className='message-item';
      node.setAttribute('data-message-id','INCOMING');node.innerHTML='<span class="message-content">买家新消息</span>';
      document.querySelector('#messages').appendChild(node);})()`);
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok([first, second].every((win) => messages.some((message) => message.sender === win.webContents.id
    && message.payload.message.messageId === 'INCOMING'))); checks++;
  await makeWindow('order-preload.js', 'audit-A');
  await makeWindow('product-scan.js', 'audit-A');
  console.log(JSON.stringify({ status: 'PASS', checks, electron: process.versions.electron,
    scope: 'local fixtures, sandbox, session isolation, send confirmation, two background views' }));
  clearTimeout(timeout);
  for (const win of windows) win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error.stack); clearTimeout(timeout);
  for (const win of windows) win.destroy();
  app.exit(1);
});

app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  // Electron 退出后文件句柄释放，临时目录由系统 Temp 清理；不接触用户数据。
});

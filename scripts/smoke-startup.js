'use strict';

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status === 0 ? 0 : 1);
}

const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert').strict;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-startup-smoke-'));
app.setPath('appData', temporary);
app.setPath('userData', path.join(temporary, 'OpenFish'));
// 验证真实入口及本地界面，隐藏窗口，不接入已有店铺数据。
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
dialog.showErrorBox = (title, message) => { console.error(title + ': ' + message); app.exit(1); };
let checked = false;
const timeout = setTimeout(() => { console.error('Application startup timed out'); app.exit(1); }, 15000);
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_e, file, error) => { console.error(file, error.message); app.exit(1); });
  contents.on('did-finish-load', async () => {
    if (checked || !contents.getURL().endsWith('/shell/index.html')) return;
    checked = true;
    try {
      const result = await contents.executeJavaScript(`(async()=>({
        accounts: (await window.api.accounts.list()).length,
        autoReply: (await window.api.settings.get()).autoReply.enabled,
        orders: (await window.api.orders.list()).length,
        tasks: (await window.api.tasks.list()).length,
        dialogReady: typeof window.dlg.form === 'function'
      }))()`);
      assert.equal(result.accounts, 0); assert.equal(result.orders, 0);
      assert.equal(result.autoReply, true); assert.equal(result.tasks, 4); assert.equal(result.dialogReady, true);
      console.log(JSON.stringify({ status: 'PASS', scope: 'real main entry, local shell, protected IPC, empty temporary profile' }));
      clearTimeout(timeout); app.isQuitting = true; app.quit();
    } catch (error) { console.error(error.stack); app.exit(1); }
  });
});
require(process.argv.includes('--packed')
  ? path.join(__dirname, '..', require('../package.json').build.directories.output, 'win-unpacked/resources/app.asar/src/main/index.js') : '../src/main/index.js');

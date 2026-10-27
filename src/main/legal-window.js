'use strict';

/**
 * 首次启动的免责与风险确认窗口。
 *
 * 设计约束（与产品风险等级匹配）：
 *   - 独立 BrowserWindow，不受主窗口 BrowserView 遮挡
 *   - 无关闭按钮、不可 ESC、不可点遮罩，只能「同意」或「退出程序」
 *   - 未确认前主窗口不显示，避免用户在没读说明的情况下直接使用高风险功能
 *   - 确认结果持久化，之后不再弹出（设置里可回看）
 */

const { BrowserWindow, ipcMain, app } = require('electron');
const path = require('path');

/** 声明版本：内容有实质修改时递增，会重新要求用户确认 */
const DISCLAIMER_VERSION = '2026-10-27.1';

let gate = null;

function alreadyAccepted(store) {
  const legal = store.getSettings().legal || {};
  return !!legal.disclaimerAccepted && legal.acceptedVersion === DISCLAIMER_VERSION;
}

/**
 * 打开确认窗口。
 * @returns {Promise<{accepted: boolean, quit?: boolean}>}
 */
function requireDisclaimer(store, parent) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 760, height: 760, minWidth: 640, minHeight: 560,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: false, alwaysOnTop: true, resizable: true,
      minimizable: false, maximizable: false, closable: false,
      show: false, frame: false, backgroundColor: '#ffffff', title: '使用前请阅读',
      webPreferences: {
        preload: path.join(__dirname, '..', 'shell', 'legal-preload.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    gate = win;
    win.loadFile(path.join(__dirname, '..', 'shell', 'legal.html'));
    win.once('ready-to-show', () => { win.show(); win.focus(); });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('legal:result', onResult);
      gate = null;
      try { if (!win.isDestroyed()) { win.setClosable(true); win.destroy(); } } catch (_) {}
      resolve(result);
    };

    const onResult = (event, payload) => {
      if (event.sender !== win.webContents) return;
      if (payload && payload.action === 'accept') {
        store.updateSettings({ legal: {
          disclaimerAccepted: true, acceptedAt: Date.now(), acceptedVersion: DISCLAIMER_VERSION,
        } });
        store.persist();
        finish({ accepted: true });
      } else if (payload && payload.action === 'quit') {
        finish({ accepted: false, quit: true });
      }
    };
    ipcMain.on('legal:result', onResult);

    // 用户从任务栏/系统强制关闭窗口时，视为未同意并退出，不留下半启动状态
    win.on('closed', () => { if (!settled) { settled = true; ipcMain.removeListener('legal:result', onResult); gate = null; resolve({ accepted: false, quit: true }); } });
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('legal:init', { version: DISCLAIMER_VERSION, appVersion: app.getVersion() });
    });
  });
}

function isOpen() { return !!(gate && !gate.isDestroyed()); }
function forceClose() { if (gate && !gate.isDestroyed()) { try { gate.setClosable(true); gate.destroy(); } catch (_) {} } gate = null; }

module.exports = { requireDisclaimer, alreadyAccepted, isOpen, forceClose, DISCLAIMER_VERSION };

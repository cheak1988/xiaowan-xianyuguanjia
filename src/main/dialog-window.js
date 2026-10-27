'use strict';

/**
 * 独立窗口对话框
 *
 * 解决的架构问题：
 *   BrowserView 是原生视图，永远绘制在渲染进程的网页层之上。
 *   所以网页里画的任何弹窗（HTML/CSS）只要落在 BrowserView 区域，一定被盖住。
 *
 *   解决方式：用独立的 BrowserWindow 承载对话框，它是系统级窗口，
 *   永远在最上层，不受 BrowserView 影响。
 *
 *   这也是闲管家自己的做法（逆向确认：它们用 `new BrowserWindow` 弹窗）。
 *
 * 用法（渲染进程）：
 *   const r = await window.api.dlg.open({
 *     title: '新增账号',
 *     fields: [{ key:'label', label:'名称', value:'店铺1' }],
 *     okText: '创建',
 *   });
 *   // r = { label: '店铺1' } 或 null（取消）
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

/** 同时只允许一个对话框 */
let activeDlg = null;
let activeResolve = null;

function createDialogWindow(parent, opt) {
  const isForm = Array.isArray(opt.fields) && opt.fields.length;

  // 根据内容估算高度（标题栏 64 + 底部按钮 72 + 上下留白 32）
  const fieldCount = opt.fields ? opt.fields.length : 0;
  const hasTextarea = (opt.fields || []).some((f) => f.type === 'textarea');
  const checklist = (opt.fields || []).find((f) => f.type === 'checklist');
  const bodyLines = opt.body ? String(opt.body).split('\n').length : 0;

  let height = 64 + 72 + 32;           // 与 Semi 对话框标题栏、底栏及留白保持一致
  height += bodyLines * 22;            // 说明文字
  height += fieldCount * 84;           // 每个字段
  if (hasTextarea) height += 90;       // textarea 额外高度
  if (checklist) height += 46 + Math.min((checklist.options || []).length, 6) * 58 + 20; // 清单头部 + 可见行
  if (!fieldCount) height += 8;        // 纯提示框留一点空

  height = Math.min(Math.max(height, 190), 720);

  const win = new BrowserWindow({
    width: 520,
    height,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    modal: false,          // 不用 modal（会遮住父窗口的 BrowserView 交互）
    alwaysOnTop: true,     // 关键：永远在最上层
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#ffffff',
    title: opt.title || '对话框',
    webPreferences: {
      preload: path.join(__dirname, '..', 'shell', 'dlg-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'shell', 'dlg.html'));

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('dlg:init', {
      title: opt.title || '',
      body: opt.body || '',
      fields: opt.fields || [],
      okText: opt.okText || '确定',
      cancelText: opt.cancelText || '取消',
      danger: !!opt.danger,
      onlyOk: !!opt.onlyOk,
      width: 520,
    });
    win.show();
    win.focus();
  });

  win.once('ready-to-show', () => win.show());
  return win;
}

/**
 * 由主进程发起的对话框（UI 渲染进程调用）
 * @returns {Promise<object|null>}
 */
function openDialog(parentWindow, opt) {
  return new Promise((resolve) => {
    // 已有对话框 → 先关掉
    if (activeDlg && !activeDlg.isDestroyed()) {
      try { activeDlg.destroy(); } catch (_) {}
      if (activeResolve) { activeResolve(null); activeResolve = null; }
    }

    const win = createDialogWindow(parentWindow, opt);
    activeDlg = win;
    activeResolve = resolve;

    const done = (result) => {
      if (activeResolve === resolve) activeResolve = null;
      activeDlg = null;
      try { if (!win.isDestroyed()) win.destroy(); } catch (_) {}
      resolve(result);
    };

    const onResult = (event, payload) => {
      if (event.sender !== win.webContents) return;
      ipcMain.removeListener('dlg:result', onResult);
      done(payload && payload.ok ? payload.values : null);
    };
    ipcMain.on('dlg:result', onResult);

    win.once('closed', () => {
      ipcMain.removeListener('dlg:result', onResult);
      if (activeResolve === resolve) {
        activeResolve = null;
        activeDlg = null;
        resolve(null);
      }
    });
  });
}

/**
 * 从页面（BrowserView 注入脚本）发起对话框
 * 这类调用不能阻塞，用回调方式
 */
function openDialogFromPage(parentWindow, accountId, opt, callback) {
  openDialog(parentWindow, opt).then((r) => {
    if (typeof callback === 'function') callback(r);
  });
}

function closeActiveDialog() {
  if (activeDlg && !activeDlg.isDestroyed()) {
    try { activeDlg.destroy(); } catch (_) {}
  }
  activeDlg = null;
  if (activeResolve) {
    const r = activeResolve;
    activeResolve = null;
    r(null);
  }
}

module.exports = { openDialog, openDialogFromPage, closeActiveDialog };

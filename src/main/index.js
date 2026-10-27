'use strict';

/**
 * 主进程入口
 *
 * 多店铺模型：
 *   - 每个闲鱼账号一个常驻 BrowserView（partition 独立，cookie 隔离）
 *   - 同一时刻只有一个 view 被「挂载」到窗口上可见
 *   - 未挂载的 view 仍在后台运行，注入脚本照常收消息、照常自动回复
 *     → 这是「多店铺消息回复」的前提：后台店铺也要在线
 */

const { app, BrowserWindow, BrowserView, ipcMain, Tray, Menu, nativeImage, shell, safeStorage, Notification } = require('electron');
const path = require('path');
const store = require('./store');
const replyEngine = require('./reply-engine');
const ai = require('./ai');
const delivery = require('./auto-delivery');
const reminder = require('./reminder');
const notify = require('./notify');
const tasks = require('./tasks');
const dialogWindow = require('./dialog-window');
const legalWindow = require('./legal-window');
const { secureRemoteView } = require('./remote-security');
const { createMessageAlerts } = require('./message-alerts');
const crypto = require('crypto');
const { createDraftManager } = require('./product-drafts');
const { createProductService } = require('./product-service');
const productAI = require('./product-ai');
const uploadChatImage = require('./im-media').createImageUploader();
let productDrafts;

const OFFICIAL_IM_URL = 'https://www.goofish.com/im';
const TITLEBAR_HEIGHT = 48;
const CHAT_TOOLBAR_HEIGHT = 64;

// 左侧账号栏 / 右侧设置面板的宽度，必须与 CSS 保持一致
const SIDEBAR_WIDTH = 216;
const PANEL_WIDTH = 434;
/** 右侧面板当前是否展开（影响 BrowserView 可用宽度） */
let panelOpen = false;
const APP_ICON = path.join(__dirname, '..', 'shell', 'icon.png');

// 固定应用名，保证开发态与打包态用同一个 userData 目录
// （否则开发时落到 Roaming/Electron，打包后落到 Roaming/<appName>，数据不互通）
// 注意：'OpenFish' 是数据目录名，改名会导致已有账号/卡密数据"丢失"（其实是找不到旧目录），
// 所以这里保持 OpenFish，只改界面显示名叫「小丸闲鱼管家」。
app.setName('OpenFish');
if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
  app.setAppUserModelId('com.xiaowan.xianyuguanjia');
}
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'OpenFish'));
}

/** accountId -> BrowserView（全部常驻） */
const views = new Map();
/** 当前挂载到窗口的 accountId */
let mountedAccountId = null;

let win = null;
let tray = null;
const messageNotifications = new Set();
const messageAlerts = createMessageAlerts({
  getSettings: () => store.getSettings(),
  playSound: (detail) => { if (win && !win.isDestroyed()) win.webContents.send('ui:message-sound', { volume: detail.volume }); },
  flash: () => { if (win && !win.isDestroyed() && !win.isFocused?.()) win.flashFrame?.(true); },
  showNotification: (detail) => {
    if (!Notification?.isSupported()) return;
    const notification = new Notification({
      title: `新消息 · ${detail.accountLabel}`, body: `${detail.peerNick}：${detail.text}`,
      icon: APP_ICON, silent: true, // The local WAV supplies one configurable sound, without double chimes.
    });
    messageNotifications.add(notification);
    if (messageNotifications.size > 50) {
      const oldest = messageNotifications.values().next().value;
      oldest.close(); messageNotifications.delete(oldest);
    }
    notification.on('close', () => messageNotifications.delete(notification));
    notification.on('failed', (_event, error) => {
      messageNotifications.delete(notification);
      console.error('[message-notification]', error);
      if (win && !win.isDestroyed()) win.webContents.send('ui:message-alert-error', '桌面通知未能显示，请检查 Windows 通知设置。提示音不受此项影响。');
    });
    notification.on('click', () => {
      const account = store.getAccount(detail.accountId);
      if (!win || win.isDestroyed() || !account || account.disabled) return;
      if (win.isMinimized?.()) win.restore();
      win.show(); win.focus();
      win.webContents.send('ui:open-message', { accountId: detail.accountId, sessionId: detail.sessionId });
    });
    notification.show();
  },
  onError: (error) => console.error('[message-alert]', error.message),
});

/* ------------------------------ 窗口 ------------------------------ */

function createWindow({ showWhenReady = true } = {}) {
  win = new BrowserWindow({
    width: 1500,
    height: 900,
    // 官方闲鱼页面自身是「会话列表 + 对话区」两栏，
    // 太窄会把官方布局挤变形，所以最小宽度给足
    minWidth: 1280,
    minHeight: 720,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: TITLEBAR_HEIGHT, color: '#ffffff', symbolColor: '#1c1f23' },
    backgroundColor: '#f6f7f9',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, '..', 'shell', 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.loadFile(path.join(__dirname, '..', 'shell', 'index.html'));
  if (showWhenReady) win.once('ready-to-show', () => win.show());
  win.on('resize', layoutView);
  win.on('maximize', layoutView);
  win.on('unmaximize', layoutView);
  win.on('focus', () => win.flashFrame?.(false));

  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.webContents.on('did-finish-load', () => syncAccounts());
}

function layoutView() {
  if (!win || !mountedAccountId) return;
  const view = views.get(mountedAccountId);
  if (!view) return;

  const [w, h] = win.getContentSize();
  const right = panelOpen ? PANEL_WIDTH : 0;
  const width = Math.max(0, w - SIDEBAR_WIDTH - right);

  // 官方闲鱼页面自身是两栏布局，太窄会挤变形。
  // 只有极端情况（< 760px）才提示；1500 宽的窗口开面板后 ≈880px 属于正常范围。
  if (panelOpen && width < 760) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('ui:space-tight', { width });
    }
  }

  // BrowserView 是原生视图，永远盖在网页层之上，
  // 所以只能给它「中间舞台」这块区域，两侧留给本地 UI。
  view.setBounds({
    x: SIDEBAR_WIDTH,
    y: TITLEBAR_HEIGHT + CHAT_TOOLBAR_HEIGHT,
    width,
    height: Math.max(0, h - TITLEBAR_HEIGHT - CHAT_TOOLBAR_HEIGHT),
  });
}

/* ------------------------------ 账号 ↔ view ------------------------------ */

function createView(account) {
  messageAlerts.resetAccount(account.id);
  const view = new BrowserView({
    webPreferences: {
      // 每个闲鱼号独立 session，否则会串号
      partition: `persist:xy-${account.id}`,
      preload: path.join(__dirname, '..', 'inject', 'im-bundle.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false, // 后台店铺也要保持 JS 活跃
    },
  });

  secureRemoteView(view, shell);
  view.webContents.loadURL(OFFICIAL_IM_URL).catch(() => {});

  // 页面标题变化时，判断是否已登录，回传给 UI
  const emitStatus = () => {
    if (!win) return;
    let loggedIn = false;
    try {
      // 未登录时官方页面有 login-iframe-wrap 容器
      view.webContents.executeJavaScript(
        `!!document.querySelector('[class*="page-im"]') && !!document.querySelector('[class*="im-main--"]') && !document.querySelector('[class*="login-iframe-wrap"]')`,
      ).then((v) => {
        if (win) win.webContents.send('accounts:status', { accountId: account.id, loggedIn: !!v });
      }).catch(() => {});
    } catch (_) { /* ignore */ }
  };

  view.webContents.on('did-finish-load', () => { emitStatus(); });
  view.webContents.on('page-title-updated', () => { emitStatus(); });

  return view;
}

/** 确保该账号的 view 已创建并在运行（后台也算在线） */
function ensureView(accountId) {
  accountId = Number(accountId);
  if (views.has(accountId)) return views.get(accountId);
  const account = store.getAccount(accountId);
  if (!account || account.disabled) return null;
  const view = createView(account);
  views.set(accountId, view);
  return view;
}

/** 全部账号都拉起（应用启动时调用，实现「多店铺同时在线」） */
function ensureAllViews() {
  for (const acc of store.listAccounts()) if (!acc.disabled) ensureView(acc.id);
}

function mount(accountId) {
  accountId = Number(accountId);
  const view = ensureView(accountId);
  if (!view || !win) return false;

  if (mountedAccountId && views.has(mountedAccountId)) {
    const prev = views.get(mountedAccountId);
    try { win.removeBrowserView(prev); } catch (_) { /* 未挂载 */ }
  }

  win.addBrowserView(view);
  mountedAccountId = accountId;
  layoutView();
  store.setActiveAccount(accountId);

  // 关键：BrowserView 是原生视图，会把键盘焦点吸走，
  // 导致本地 UI 的第一次点击被吞掉。这里主动把焦点还给窗口本体。
  try { win.focus(); } catch (_) {}
  return true;
}

function unmount() {
  if (mountedAccountId && views.has(mountedAccountId) && win) {
    try { win.removeBrowserView(views.get(mountedAccountId)); } catch (_) {}
  }
  mountedAccountId = null;
}

function destroyView(accountId) {
  const view = views.get(Number(accountId));
  if (!view) return;
  if (mountedAccountId === Number(accountId)) unmount();
  try { view.webContents.destroy(); } catch (_) {}
  views.delete(Number(accountId));
}

function stopAccountViews(accountId) {
  accountId = Number(accountId);
  delivery.cancelAccount(accountId);
  for (const [requestId, pending] of pendingSends) {
    if (pending.accountId === accountId) {
      clearTimeout(pending.timer);
      pendingSends.delete(requestId);
      pending.resolve({ ok: false, uncertain: pending.authorized, error: '店铺已停用或删除' });
    }
  }
  destroyView(accountId);
  productService.stop(accountId);
  for (const collection of [orderViews, productViews]) {
    const view = collection.get(accountId);
    if (view) { try { view.webContents.destroy(); } catch (_) {} collection.delete(accountId); }
  }
}

// 远程页面只能调用下面单独注册的发送许可，不能调用本地管理 API。
function handleShell(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!win || event.sender !== win.webContents
        || (event.senderFrame && event.senderFrame !== win.webContents.mainFrame)) {
      throw new Error('未授权的 IPC 调用');
    }
    return handler(event, ...args);
  });
}

/** 只允许打开本项目自己的说明页面，避免被当成任意链接跳板 */
const EXTERNAL_ALLOWLIST = new Set([
  'https://xianyuguanjia.com/legal.html',
  'https://xianyuguanjia.com/',
]);
handleShell('shell:open-external', async (_event, url) => {
  if (!EXTERNAL_ALLOWLIST.has(String(url))) throw new Error('该地址不在允许打开的范围内');
  await shell.openExternal(String(url));
  return { ok: true };
});

const pendingSends = new Map();
const historyRequests = new Map();
function readRemoteHistory(accountId, sessionId) {
  const view = views.get(accountId); if (!view) return Promise.reject(new Error('该店铺聊天页未就绪'));
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID(), timer = setTimeout(() => { historyRequests.delete(requestId); reject(new Error('会话读取超时，请在主机检查登录')); }, 15000);
    historyRequests.set(requestId, { contents: view.webContents, sessionId, accountId, timer, resolve, reject });
    view.webContents.send('inject:history', { requestId, sessionId });
  });
}
ipcMain.on('im:history-result', (event, result) => {
  const pending = result && historyRequests.get(result.requestId);
  if (!pending || pending.contents !== event.sender || pending.sessionId !== result.sessionId || event.senderFrame && event.senderFrame !== event.sender.mainFrame) return;
  clearTimeout(pending.timer); historyRequests.delete(result.requestId);
  const account = store.getAccount(pending.accountId);
  if (!account || account.disabled || !result.ok) pending.reject(new Error(result.error || '店铺已停用')); else pending.resolve(result.messages);
});
ipcMain.on('im:sessions', (event, rows) => {
  const accountId = accountIdOfWebContents(event.sender), account = accountId && store.getAccount(accountId);
  if (!account || account.disabled || event.senderFrame && event.senderFrame !== event.sender.mainFrame || !Array.isArray(rows) || rows.length > 5000) return;
  messageAlerts.conversations(account, rows);
  for (const value of rows) {
    if (!value.id || String(value.id).length > 200 || String(value.id).startsWith('nick:')) continue;
    const row = store.ensureSession(accountId, String(value.id));
    row.peer_nick = String(value.nickname || row.peer_nick || '').slice(0, 100);
    if (Number(value.last_ts) >= row.last_ts) { row.last_ts = Number(value.last_ts); row.last_text = String(value.last_text || '').slice(0, 500); }
    if (value.item_id) row.item_id = String(value.item_id).slice(0, 50);
  }
  store.scheduleSave();
});

function sendToSession(accountId, sessionId, reply, guard = () => true) {
  accountId = Number(accountId);
  const account = store.getAccount(accountId);
  const view = views.get(accountId);
  if (!account || account.disabled || !view || !guard()) {
    return Promise.resolve({ ok: false, uncertain: false, error: '店铺已停用或发送已取消' });
  }
  if (!sessionId || String(sessionId).startsWith('nick:') || !reply.content) {
    return Promise.resolve({ ok: false, uncertain: false, error: '缺少可核验的会话ID或发送内容' });
  }
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const pending = { accountId, sessionId: String(sessionId), contents: view.webContents,
      reply, guard, resolve, authorized: false };
    pending.timer = setTimeout(() => {
      pendingSends.delete(requestId);
      resolve({ ok: false, uncertain: pending.authorized, error: '发送确认超时，请核对聊天记录' });
    }, 40000);
    pendingSends.set(requestId, pending);
    try { view.webContents.send('inject:send', { requestId, sessionId: String(sessionId), reply }); }
    catch (error) {
      clearTimeout(pending.timer);
      pendingSends.delete(requestId);
      resolve({ ok: false, uncertain: false, error: error.message });
    }
  });
}

ipcMain.handle('im:can-send', (event, { requestId, sessionId } = {}) => {
  const pending = pendingSends.get(requestId);
  if (!pending || event.sender !== pending.contents || String(sessionId) !== pending.sessionId
      || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) return false;
  const account = store.getAccount(pending.accountId);
  if (!account || account.disabled || !pending.guard()) return false;
  pending.authorized = true;
  return true;
});

ipcMain.handle('im:upload-image', async (event, { requestId, sessionId, assetId } = {}) => {
  const pending = pendingSends.get(requestId);
  if (!pending || event.sender !== pending.contents || String(sessionId) !== pending.sessionId
      || (event.senderFrame && event.senderFrame !== event.sender.mainFrame) || pending.reply.type !== 'image'
      || pending.reply.assetId !== assetId || !pending.guard()) return { ok: false, uncertain: false, error: '图片发送未授权' };
  const card = store.ready().cards.find((row) => row.account_id === pending.accountId && row.asset_id === assetId);
  if (!card) return { ok: false, uncertain: false, error: '图片卡密不属于该店铺' };
  const asset = productDrafts.asset(assetId);
  const hash = crypto.createHash('sha256').update(require('fs').readFileSync(asset.file)).digest('hex');
  if (hash !== card.image_hash) return { ok: false, uncertain: false, error: '图片卡密文件已变化，未发送' };
  pending.authorized = true;
  return uploadChatImage(event.sender, asset.file, () => !!store.getAccount(pending.accountId)
    && !store.getAccount(pending.accountId).disabled && pendingSends.has(requestId) && pending.guard());
});

/** 从 IPC 事件反查账号 */
function accountIdOfWebContents(wc) {
  for (const [accountId, view] of views.entries()) {
    if (view.webContents.id === wc.id) return accountId;
  }
  return null;
}

function syncAccounts() {
  if (!win) return;
  win.webContents.send('accounts:sync', store.listAccounts());
}

/* ------------------------------ 托盘 ------------------------------ */

function createTray() {
  const icon = nativeImage.createFromPath(APP_ICON);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('小丸闲鱼管家');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => (win ? win.show() : createWindow()) },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => (win ? win.show() : createWindow()));
}

/* ------------------------------ IPC: 账号 ------------------------------ */

/**
 * 切换一级视图时，决定官方页面是否挂载。
 * 非客服视图（商品/订单/任务/数据）要把 BrowserView 摘掉，
 * 否则原生视图会盖住本地页面。
 */
handleShell('ui:set-chat-view', (_e, isChatView) => {
  if (!win) return false;
  if (isChatView) {
    if (mountedAccountId && views.has(mountedAccountId)) win.addBrowserView(views.get(mountedAccountId));
    layoutView();
  } else if (mountedAccountId && views.has(mountedAccountId)) {
    try { win.removeBrowserView(views.get(mountedAccountId)); } catch (_) {}
  }
  return !!isChatView;
});

/** 面板展开/收起时，通知主进程重排 BrowserView（否则会盖住面板） */
handleShell('ui:set-panel-open', (_e, open) => {
  panelOpen = !!open;
  layoutView();
  return panelOpen;
});

handleShell('ui:set-theme', (_e, theme) => {
  if (win && process.platform === 'win32') {
    const dark = theme === 'dark';
    win.setTitleBarOverlay({ color: dark ? '#232429' : '#ffffff', symbolColor: dark ? '#f9f9f9' : '#1c1f23' });
  }
});

handleShell('accounts:list', () => store.listAccounts());

handleShell('accounts:add', (_e, { label }) => {
  const account = store.addAccount(label || '新账号');
  store.persist();
  // 新增后立刻拉起（后台在线）
  ensureView(account.id);
  syncAccounts();
  return account;
});

handleShell('accounts:update', (_e, { id, patch }) => {
  const acc = store.updateAccount(id, patch || {});
  if (acc) {
    if (acc.disabled) stopAccountViews(id);
    else ensureView(id);
    store.persist();
  }
  syncAccounts();
  return acc;
});

handleShell('accounts:activate', (_e, accountId) => {
  const ok = mount(accountId);
  return ok;
});

handleShell('accounts:remove', async (_e, accountId) => {
  const account = store.getAccount(accountId);
  if (!account) return false;
  const view = views.get(Number(accountId)) || orderViews.get(Number(accountId)) || productViews.get(Number(accountId));
  const accountSession = view ? view.webContents.session
    : require('electron').session.fromPartition(`persist:xy-${Number(accountId)}`);
  stopAccountViews(accountId);
  // 先停用，清理失败时也不允许旧账号继续自动化。
  store.updateAccount(accountId, { disabled: true });
  store.persist();
  await accountSession.clearStorageData();
  await accountSession.clearCache();
  store.removeAccount(accountId);
  store.persist();
  syncAccounts();
  return true;
});

/* ------------------------------ IPC: 消息 ------------------------------ */

ipcMain.on('im:message', async (event, payload) => {
  const { session, message } = payload || {};
  const accountId = accountIdOfWebContents(event.sender);
  if (!accountId || !message) return;

  const accountNow = store.getAccount(accountId);
  if (!accountNow || accountNow.disabled) return;
  const isHumanOut = message.direction === 'out' && !['ai', 'rule', 'delivery'].includes(message.source);
  try { if (store.saveMessage(accountId, session, message) === false) return; }
  catch (error) { console.error('[messages] 已停止处理，消息保存失败', error.message); return; }
  messageAlerts.message(accountNow, session, message);

  // 自动建档：买家发来消息时更新客户档案
  if (session && (session.withWhoNick || session.peerUserId) && message.direction !== 'out') {
    try {
      store.upsertCustomer(accountId, {
        buyer_uid: session.peerUserId || session.id,
        nick: session.withWhoNick || '',
        avatar: session.peerAvatar || '',
      });
    } catch (_) { /* 建档失败不影响主流程 */ }
  }

  if (win) win.webContents.send('ui:message', { accountId, session, message });

  // 自己（或人工）发出的消息 → 记为人工活动，触发静默期
  if (isHumanOut) {
    const sid = String((session && session.id) || message.sessionId || '');
    if (sid) store.markHumamActivity(accountId, sid, Number(message.ts) || Date.now());
    return;
  }

  const account = store.getAccount(accountId);
  const view = views.get(accountId);
  if (!view) return;

  try {
    const result = await replyEngine.handle({
      accountId,
      account,
      session,
      message,
      sendFn: (reply, guard) => sendToSession(accountId, String((session && session.id) || ''), reply, guard),
    });

    if (win) {
      win.webContents.send('ui:reply-decision', {
        accountId,
        sessionId: String((session && session.id) || ''),
        ...result,
      });
    }
  } catch (e) {
    console.error('[reply-engine] failed', e);
    if (win) {
      win.webContents.send('ui:reply-decision', {
        accountId,
        sessionId: String((session && session.id) || ''),
        action: 'error',
        reason: String(e && e.message || e),
        replies: [],
      });
    }
  }
});

// 注入层回报发送结果
handleShell('messages:focus', (_event, { accountId, sessionId } = {}) => {
  const account = store.getAccount(accountId);
  if (!account || account.disabled || !sessionId || String(sessionId).length > 200) return { ok: false, error: '店铺或会话不可用' };
  const view = views.get(Number(accountId));
  if (!view || !mount(accountId)) return { ok: false, error: '店铺聊天页未就绪' };
  view.webContents.send('inject:focus-session', { sessionId: String(sessionId) });
  return { ok: true };
});

ipcMain.on('im:focus-session-result', (event, result) => {
  const accountId = accountIdOfWebContents(event.sender);
  if (!accountId || event.senderFrame && event.senderFrame !== event.sender.mainFrame) return;
  if (result?.ok === false && win && !win.isDestroyed()) {
    win.webContents.send('ui:message-alert-error', String(result.error || '无法定位会话').slice(0, 250));
  }
});

ipcMain.on('im:send-result', (event, result) => {
  const accountId = accountIdOfWebContents(event.sender);
  if (!accountId) return;
  const pending = result && pendingSends.get(result.requestId);
  if (!pending || pending.contents !== event.sender || pending.sessionId !== String(result.sessionId)) return;
  clearTimeout(pending.timer);
  pendingSends.delete(result.requestId);
  pending.resolve({ ...result, ok: result.ok === true && pending.authorized });
  if (win) win.webContents.send('ui:send-result', { accountId, ...result });
});

// 注入层主动上报登录态
const lastLoginState = new Map(); // accountId -> boolean
ipcMain.on('im:login-status', (event, { loggedIn }) => {
  const accountId = accountIdOfWebContents(event.sender);
  if (!accountId) return;

  const prev = lastLoginState.get(accountId);
  lastLoginState.set(accountId, !!loggedIn);

  // 从「已登录」掉到「未登录」→ 告警
  if (prev === true && !loggedIn) {
    const label = (store.getAccount(accountId) || {}).label || accountId;
    notify.notify({
      title: '账号登录态失效',
      body: `店铺「${label}」已掉线，自动回复和自动发货将停止工作。
请打开该账号重新扫码登录。`,
      event: 'offline',
      force: true,
    }).catch(() => {});
  }

  if (win) win.webContents.send('accounts:status', { accountId, loggedIn: !!loggedIn });
});

/* ------------------------------ IPC: 对话框窗口 ------------------------------ */

/**
 * 所有对话框走独立窗口，避免被 BrowserView 遮挡
 * body/fields/okText 等参数与前端 dialog.js 一致
 */
handleShell('dlg:open', async (_e, opt) => {
  return dialogWindow.openDialog(win, opt || {});
});

/* ------------------------------ IPC: 通知 ------------------------------ */

handleShell('notify:channels', () => notify.listChannels());

handleShell('notify:test', (_e, { channel, config }) =>
  notify.testChannel(channel, config));

handleShell('notify:log', (_e, limit) => store.listNotifyLog(limit));

handleShell('notify:send-test', async () => {
  const r = await notify.notify({
    title: '【测试】小丸闲鱼管家',
    body: '如果你收到这条消息，说明通知渠道配置成功。',
    force: true,
  });
  return r;
});

/* ------------------------------ 自动任务 ------------------------------ */

/** 让指定账号的注入脚本执行任务 */
function executeTaskInPage(accountId, taskId, payload) {
  return new Promise((resolve) => {
    const view = views.get(Number(accountId)) || ensureView(accountId);
    if (!view) { resolve({ ok: false, error: '该账号没有运行中的页面' }); return; }

    const requestId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const timer = setTimeout(() => {
      pendingTaskRuns.delete(requestId);
      resolve({ ok: false, error: '任务执行超时' });
    }, 30000);

    pendingTaskRuns.set(requestId, { resolve, timer, accountId, taskId });
    const send = () => view.webContents.send('task:run', { taskId, payload, requestId });
    if (view.webContents.isLoading()) view.webContents.once('did-finish-load', send);
    else send();
  });
}

const pendingTaskRuns = new Map();

ipcMain.on('task:result', (event, res) => {
  // 找到对应的 pending（用 sender 匹配账号）
  const accountId = accountIdOfWebContents(event.sender);
  if (!accountId) return;
  const entry = res && pendingTaskRuns.get(res.requestId);
  if (!entry || entry.accountId !== accountId || entry.taskId !== res.taskId) return;
  clearTimeout(entry.timer);
  pendingTaskRuns.delete(res.requestId);
  entry.resolve(res);
});

// 初始化任务模块
tasks.init({
  execute: executeTaskInPage,
  notify: (title, body, event) => notify.notify({ title, body, event }).catch(() => {}),
});

handleShell('tasks:list', () => tasks.listTasks());
handleShell('tasks:risk-notice', (_e, taskId) => tasks.riskNotice(taskId));
handleShell('tasks:set-enabled', (_e, { taskId, enabled, acceptRisk }) =>
  tasks.setTaskEnabled(taskId, enabled, { acceptRisk }));

handleShell('tasks:run-now', async (_e, { taskId, accountId }) => {
  if (taskId === 'polish') return tasks.runPolish(accountId, { force: true });
  if (taskId === 'rate') return tasks.runRate(accountId);
  return { ok: false, error: '未知任务' };
});

handleShell('tasks:log', (_e, limit) => tasks.listRunLog(limit));

/* ------------------------------ 待发货兜底扫描 ------------------------------ */

let catchupTimer = null;

function startCatchupScan() {
  if (catchupTimer) clearInterval(catchupTimer);
  catchupTimer = setInterval(async () => {
    const cfg = store.getSettings().tasks.catchupScan || {};
    if (!cfg.enabled) return;

    // 找「待发货」且有卡密可发的订单
    for (const acc of store.listAccounts().filter((account) => !account.disabled)) {
      const orders = store.listOrders(acc.id).filter((o) => /待发货/.test(o.status || ''));
      for (const o of orders) {
        const rules = delivery.listDeliverRules(acc.id);
        const rule = rules.find((r) => r.enabled && r.item_id === String(o.item_id));
        if (!rule) continue;

        // 已经发过的跳过（handleOrder 内部有幂等，但这里省一次调用）
        if (delivery.getDeliveryState(acc.id, o.order_no)) continue;

        const stats = delivery.cardStats(acc.id, o.item_id);
        if (stats.unused <= 0) continue;

        const imView = views.get(acc.id);
        if (!imView) continue;

        // 补发
        await delivery.handleOrder({
          accountId: acc.id,
          order: o,
          sendFn: (sessionId, text, options) => sendToSession(acc.id, sessionId, { kind: 'delivery', type: options.kind, assetId: options.assetId, content: text }, options.guard),
        });
      }
    }
  }, Math.max(5, Number(store.getSettings().tasks.catchupScan.intervalMinutes) || 30) * 60_000);
}

/* ------------------------------ 凭证续期 ------------------------------ */

let tokenTimer = null;
const tokenStatus = new Map(); // accountId -> { ok, checkedAt, error }

function startTokenRenew() {
  if (tokenTimer) clearInterval(tokenTimer);
  tokenTimer = setInterval(async () => {
    const cfg = store.getSettings().tasks.tokenRenew || {};
    if (!cfg.enabled) return;

    for (const acc of store.listAccounts()) {
      const view = views.get(acc.id);
      if (!view) {
        tokenStatus.set(acc.id, { ok: false, checkedAt: Date.now(), error: '页面未运行' });
        continue;
      }
      try {
        const alive = await view.webContents.executeJavaScript(
          `!!document.querySelector('[class*="page-im"]') && !!document.querySelector('[class*="im-main--"]') && !document.querySelector('[class*="login-iframe-wrap"]')`,
        );
        const prev = tokenStatus.get(acc.id);
        tokenStatus.set(acc.id, { ok: !!alive, checkedAt: Date.now(), error: alive ? null : '未登录' });

        // 从正常掉到异常 → 通知
        if (prev && prev.ok && !alive) {
          notify.notify({
            title: '登录态失效',
            body: `店铺「${acc.label}」掉线了，需要重新登录。`,
            event: 'offline',
            force: true,
          }).catch(() => {});
        }
      } catch (e) {
        tokenStatus.set(acc.id, { ok: false, checkedAt: Date.now(), error: String(e && e.message || e) });
      }
    }
  }, Math.max(5, Number(store.getSettings().tasks.tokenRenew.checkMinutes) || 30) * 60_000);
}

handleShell('tasks:token-status', () => {
  return store.listAccounts().map((a) => ({
    accountId: a.id,
    label: a.label,
    ...(tokenStatus.get(a.id) || { ok: null, checkedAt: null, error: null }),
  }));
});

/* ------------------------------ 商品管理 ------------------------------ */

/** 商品页与客服使用同一店铺分区，但在独立窗口中展示。 */
const productViews = new Map();
const productService = createProductService({
  store, views: productViews, parent: () => win,
  onUpdated: (payload) => { if (win && !win.isDestroyed()) win.webContents.send('ui:products-updated', payload); },
});
function ensureProductView(accountId) { return productService.ensureView(accountId); }
let autoRelist, remoteServer;
function handleProduct(channel, action) {
  handleShell(channel, async (_event, payload) => {
    try { return await action(payload); }
    catch (error) { return { ok: false, error: error.message }; }
  });
}
handleProduct('products:open-page', (id) => productService.open(id));
handleProduct('products:sync', (id) => productService.sync(id));
handleProduct('products:scan-preview', (id) => productService.scanPreview(id));
handleProduct('products:sync-import', ({ accountId, scanId, itemIds }) => productService.importSelected(accountId, scanId, itemIds));
handleProduct('products:ai-config', () => ({ ok: true, config: productAI.config() }));
handleProduct('products:ai-save-config', (input) => productAI.save(input));
handleProduct('products:ai-generate', (input) => productAI.generate(input));
handleProduct('products:ai-test', () => productAI.test());
handleProduct('products:drafts-list', (accountId) => ({ ok: true, drafts: productDrafts.list(accountId) }));
handleProduct('products:draft-save', (input) => ({ ok: true, draft: productDrafts.save(input) }));
handleProduct('products:draft-remove', (id) => ({ ok: productDrafts.remove(id) }));
handleProduct('products:draft-edit-item', ({ accountId, itemId }) => productService.readItem(accountId, itemId));
handleProduct('products:draft-prepare', (id) => productService.prepare(id));
handleProduct('products:draft-verify', (id) => productService.verify(id));
handleProduct('products:draft-options', (id) => productService.options(id));
handleProduct('products:draft-submit', (id) => productService.submit(id));
handleProduct('products:draft-resolve', ({ id, ...result }) => productService.resolve(id, result));
handleProduct('products:show-window', (id) => productService.show(id));
handleProduct('products:choose-images', async () => {
  const selected = await require('electron').dialog.showOpenDialog(win, {
    title: '选择商品图片', properties: ['openFile', 'multiSelections'],
    filters: [{ name: '商品图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  return { ok: true, canceled: selected.canceled, images: selected.canceled ? [] : productDrafts.importFiles(selected.filePaths) };
});

/* ------------------------------ 自动发货 ------------------------------ */

/**
 * 订单页 view 与 IM view 分开管理。
 * 订单页默认不自动打开（会多占一个页面/内存），需要时通过 UI 手动开启。
 */
const orderViews = new Map(); // accountId -> BrowserView

const ORDER_PAGE_URL = 'https://www.goofish.com/im?tab=order';

function ensureOrderView(accountId) {
  accountId = Number(accountId);
  if (orderViews.has(accountId)) return orderViews.get(accountId);

  const account = store.getAccount(accountId);
  if (!account || account.disabled) return null;

  const view = new BrowserView({
    webPreferences: {
      partition: `persist:xy-${accountId}`, // 与 IM 共用 session，登录态共享
      preload: path.join(__dirname, '..', 'inject', 'order-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  secureRemoteView(view, shell);
  view.webContents.loadURL(ORDER_PAGE_URL).catch(() => {});
  orderViews.set(accountId, view);
  return view;
}

function accountIdOfOrderWebContents(wc) {
  for (const [accountId, view] of orderViews.entries()) {
    if (view.webContents.id === wc.id) return accountId;
  }
  return null;
}

/** 收到「待发货」订单 → 走自动发货 */
ipcMain.on('order:pending', async (event, order) => {
  const accountId = accountIdOfOrderWebContents(event.sender);
  if (!accountId || event.senderFrame && event.senderFrame !== event.sender.mainFrame) return;

  // 记录到订单库（订单管理页展示）
  const savedOrder = store.upsertOrder(accountId, {
    order_no: order.order_no,
    item_id: order.item_id,
    item_title: order.item_title,
    buyer_nick: order.buyer_nick,
    amount: order.amount,
    status: order.order_status || '待发货',
    session_id: order.session_id,
    buyer_uid: order.buyer_uid,
  });
  if (!savedOrder) return;
  order = { ...order, session_id: savedOrder.session_id };

  const account = store.getAccount(accountId);
  const imView = views.get(accountId);
  if (!imView) {
    delivery.pushDeliverLog({
      account_id: accountId, order_no: order.order_no,
      ok: false, reason: 'IM 窗口未就绪',
    });
    return;
  }

  const result = await delivery.handleOrder({
    accountId,
    order,
    sendFn: (sessionId, text, options) => sendToSession(accountId, sessionId, { kind: 'delivery', type: options.kind, assetId: options.assetId, content: text }, options.guard),
    markShippedFn: async () => {
      // 目前只做「发卡密」，订单状态更新交给人工在官方页面点一次，
      // 或后续在这里对 orderView 执行 UI 自动化。
      return false;
    },
  });

  // 推送发货结果
  if (!store.getAccount(accountId) || result.skipped) return;
  const accName = (store.getAccount(accountId) || {}).label || accountId;
  notify.notify({
    title: result.ok ? '自动发货成功' : '自动发货失败',
    body: `店铺：${accName}
商品：${order.item_title || order.item_id || '-'}
订单：${order.order_no}
${result.reason || ''}`,
    event: 'delivery',
  }).catch(() => {});

  if (win) win.webContents.send('ui:delivery-result', { accountId, order, ...result });
});

/* ------------------------------ IPC: 自动发货 ------------------------------ */

handleShell('delivery:open-order-page', (_e, accountId) => {
  const view = ensureOrderView(accountId);
  return !!view;
});

handleShell('delivery:rules', (_e, accountId) => delivery.listDeliverRules(accountId));
handleShell('delivery:save-rule', (_e, rule) => {
  delivery.saveDeliverRule(rule);
  return delivery.listDeliverRules(rule.accountId);
});
handleShell('delivery:remove-rule', (_e, id) => { delivery.removeDeliverRule(id); return true; });

handleShell('delivery:cards', (_e, { accountId, itemId }) => delivery.listCards(accountId, itemId));
handleShell('delivery:card-stats', (_e, { accountId }) => {
  const rules = delivery.listDeliverRules(accountId);
  const out = {};
  for (const r of rules) out[r.item_id] = delivery.cardStats(accountId, r.item_id);
  return out;
});
handleShell('delivery:import-cards', (_e, { accountId, itemId, text }) =>
  delivery.importCards({ accountId, itemId, text }));
handleProduct('delivery:import-image-cards', async ({ accountId, itemId }) => {
  if (!store.getAccount(Number(accountId))) throw new Error('店铺不存在');
  const selected = await require('electron').dialog.showOpenDialog(win, { title: '导入图片卡密（每张一份，JPG/PNG，最大3MB）',
    properties: ['openFile', 'multiSelections'], filters: [{ name: '图片卡密', extensions: ['jpg', 'jpeg', 'png'] }] });
  if (selected.canceled) return { ok: true, canceled: true };
  const images = productDrafts.importFiles(selected.filePaths, { maximum: 100 });
  return { ok: true, ...delivery.importImageCards({ accountId, itemId, images }) };
});
handleProduct('relist:list', () => ({ ok: true, ...autoRelist.list() }));
handleProduct('relist:save', async (input) => ({ ok: true, ...await autoRelist.save(input) }));
handleProduct('relist:toggle', async ({ id, enabled }) => ({ ok: true, ...await autoRelist.toggle(id, enabled) }));
handleProduct('relist:resolve', async ({ id, itemId }) => ({ ok: true, ...await autoRelist.resolve(id, itemId) }));
handleProduct('remote:status', () => ({ ok: true, config: remoteServer.config(), status: remoteServer.status(), users: remoteServer.listUsers() }));
handleProduct('remote:configure', async (input) => ({ ok: true, status: await remoteServer.configure(input) }));
handleProduct('remote:save-user', async (input) => ({ ok: true, user: await remoteServer.saveUser(input) }));
handleProduct('remote:remove-user', (id) => ({ ok: remoteServer.removeUser(id) }));
handleShell('delivery:clear-cards', (_e, { accountId, itemId }) => {
  delivery.clearCards(accountId, itemId);
  return true;
});
handleShell('delivery:log', (_e, { accountId, limit }) => delivery.listDeliverLog(accountId, limit));
handleShell('delivery:preview', (_e, { accountId, itemId }) => {
  const rules = delivery.listDeliverRules(accountId);
  const rule = rules.find((r) => r.item_id === String(itemId));
  if (!rule) return '';
  const cards = delivery.listCards(accountId, itemId);
  const sample = cards.find((c) => c.status === 'unused');
  return delivery.previewText(rule, {
    order_no: '1234567890123456',
    buyer_nick: '买家示例',
    item_title: rule.item_title,
  }, sample ? sample.content : 'SAMPLE-CARD-KEY');
});

/* ------------------------------ IPC: 规则 ------------------------------ */

handleShell('rules:list', (_e, accountId) => store.listRules(accountId));
handleShell('rules:save', (_e, rule) => { store.saveRule(rule); return store.listRules(rule.accountId); });
handleShell('rules:remove', (_e, id) => { store.removeRule(id); return true; });

handleShell('rules:export', async (_e, accountId) => {
  const csv = store.exportRulesCsv(accountId);
  const { dialog } = require('electron');
  const r = await dialog.showSaveDialog(win, {
    title: '导出快捷回复',
    defaultPath: `快捷回复-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  require('fs').writeFileSync(r.filePath, '\ufeff' + csv, 'utf8'); // BOM 让 Excel 正确识别 UTF-8
  return { ok: true, path: r.filePath };
});

handleShell('rules:import', async (_e, accountId) => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(win, {
    title: '导入快捷回复（CSV：分组,关键词,内容）',
    filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  const text = require('fs').readFileSync(r.filePaths[0], 'utf8').replace(/^\ufeff/, '');
  const res = store.importRulesCsv(accountId, text);
  return { ok: true, ...res };
});

/* ------------------------------ IPC: 消息查询 ------------------------------ */

handleShell('messages:list', (_e, { accountId, sessionId, limit }) =>
  store.listMessages(accountId, sessionId, limit || 100));

handleShell('sessions:list', (_e, accountId) => {
  const s = store.ready();
  return s.sessions
    .filter((x) => x.account_id === Number(accountId))
    .sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));
});

/* ------------------------------ IPC: 设置 / AI ------------------------------ */

function publicSettings(s) {
  return { ...s, ai: { ...s.ai, apiKeyEnc: undefined, apiKeySet: !!store.getAiKey() },
    productAI: { ...s.productAI, apiKeyEnc: undefined, apiKeySet: !!store.getProductAiKey() } };
}
handleShell('settings:get', () => {
  const s = store.getSettings();
  // 不回传密钥本身，只告知是否已配置
  return publicSettings(s);
});

handleShell('settings:update', (_e, patch) => {
  const next = store.updateSettings(patch || {});
  if (patch && patch.tasks) { startCatchupScan(); startTokenRenew(); tasks.startScheduler(); }
  return publicSettings(next);
});

handleShell('ai:set-key', (_e, key) => store.setAiKey(key));

handleShell('ai:test', async (_event, config) => {
  const r = await ai.test(config);
  return r;
});

handleShell('ai:log', (_e, { accountId, limit }) => store.listAiLog(accountId, limit));

/* ------------------------------ 订单操作 ------------------------------ */

/**
 * 三种操作：
 *   ship      在官方订单页点「发货」，填物流单号
 *   resend    补发卡密（复用自动发货逻辑，可指定卡密）
 *   confirm   仅更新本地状态为已发货（不动平台）
 */
handleShell('order:operate', async (_e, { accountId, orderNo, action, payload }) => {
  accountId = Number(accountId);
  const order = store.listOrders(accountId).find((o) => o.order_no === orderNo);
  if (!order) return { ok: false, error: '找不到订单' };
  if (action === 'link-session') {
    const sessionId = String(payload && payload.sessionId || '');
    const session = store.findSession(accountId, sessionId);
    if (!session || sessionId.startsWith('nick:')) return { ok: false, error: '请选择该店铺中可核验的会话' };
    if (order.buyer_uid && session.peer_user_id && String(order.buyer_uid) !== String(session.peer_user_id)) {
      return { ok: false, error: '买家身份与会话不一致，已拒绝关联' };
    }
    store.upsertOrder(accountId, { ...order, session_id: sessionId });
    store.persist();
    return { ok: true, reason: '已关联买家会话' };
  }
  if (action === 'resolve') {
    if (!payload || !['received', 'not-received'].includes(payload.result)) return { ok: false, error: '请选择人工核对结果' };
    return delivery.resolveDelivery(accountId, orderNo, payload.result === 'received');
  }

  if (action === 'resend') {
    const result = await delivery.handleOrder({
      accountId, order, resend: true, cardContent: payload && payload.card,
      sendFn: (sessionId, text, options) => sendToSession(accountId, sessionId, { kind: 'delivery', type: options.kind, assetId: options.assetId, content: text }, options.guard),
    });
    return { ...result, error: result.ok ? undefined : result.reason };
  }

  if (action === 'confirm') {
    store.upsertOrder(accountId, { ...order, status: '已发货' });
    return { ok: true, reason: '已标记为已发货（仅本地）' };
  }

  if (action === 'ship') {
    const view = ensureOrderView(accountId);
    if (!view) return { ok: false, error: '订单页未就绪' };

    // 在订单页执行发货：点发货 → 填单号 → 确认
    const r = await new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { shipWaiters.delete(requestId); resolve({ ok: false, uncertain: true, error: '发货操作超时，请先核对平台订单' }); }, 25000);
      shipWaiters.set(requestId, { resolve, timer, contents: view.webContents, accountId });
      view.webContents.send('order:ship', {
        orderNo,
        waybillNo: (payload && payload.waybillNo) || '',
        expressCode: (payload && payload.expressCode) || '',
        requestId,
      });
    });

    if (r.ok) store.upsertOrder(accountId, { ...order, status: '已发货' });
    return r;
  }

  return { ok: false, error: `未知操作 ${action}` };
});

const shipWaiters = new Map();
ipcMain.on('order:ship-result', (event, res) => {
  const entry = res && res.requestId ? shipWaiters.get(res.requestId) : null;
  if (entry && entry.contents === event.sender && (!event.senderFrame || event.senderFrame === event.sender.mainFrame)) {
    clearTimeout(entry.timer);
    shipWaiters.delete(res.requestId);
    const account = store.getAccount(entry.accountId);
    entry.resolve(account && !account.disabled ? res : { ok: false, uncertain: true, error: '店铺已停用，请核对发货结果' });
  }
});

/* ------------------------------ IPC: 店铺分组 ------------------------------ */

handleShell('shopgroups:list', () => store.listShopGroups());
handleShell('shopgroups:save', (_e, g) => store.saveShopGroup(g));
handleShell('shopgroups:remove', (_e, id) => { store.removeShopGroup(id); return true; });

/* ------------------------------ IPC: 客户 ------------------------------ */

handleShell('customers:list', (_e, args) => store.listCustomers(args && args.accountId, args || {}));
handleShell('customers:update', (_e, { id, patch }) => store.updateCustomer(id, patch || {}));
handleShell('customers:remove', (_e, id) => { store.removeCustomer(id); return true; });
handleShell('customers:tags', (_e, accountId) => store.listCustomerTags(accountId));

/** 从会话记录同步客户档案 */
handleShell('customers:upsert-session', (_e, { accountId, session }) => {
  if (!session) return null;
  return store.upsertCustomer(accountId, {
    buyer_uid: session.peer_user_id || session.id,
    nick: session.peer_nick || '',
    avatar: session.peer_avatar || '',
  });
});

/* ------------------------------ IPC: 快捷话术 ------------------------------ */

handleShell('quickreplies:list', (_e, accountId) => store.listQuickReplies(accountId));
handleShell('quickreplies:save', (_e, r) => store.saveQuickReply(r));
handleShell('quickreplies:remove', (_e, id) => { store.removeQuickReply(id); return true; });

/* ------------------------------ IPC: 商品/订单/看板 ------------------------------ */

handleShell('products:list', (_e, { accountId, search, status }) =>
  store.listProducts(accountId, { search, status }));

handleShell('products:save', (_e, product) => store.upsertProduct(product.accountId, product));

handleShell('products:remove', (_e, { accountId, itemId }) => {
  store.removeProduct(accountId, itemId);
  return true;
});

handleShell('products:import', (_e, { accountId, text }) =>
  store.importProductsCsv(accountId, text));

// 旧接口曾把「填写文字」误报为发布成功；统一转到可核验的草稿流程。
handleProduct('products:publish', () => ({ ok: false, error: '请在商品编辑器中添加图片、预览并确认发布' }));

handleShell('orders:list', (_e, accountId) => store.listOrders(accountId).map((order) => ({
  ...order, delivery_status: (delivery.getDeliveryState(order.account_id, order.order_no) || {}).status || '',
})));

handleShell('stats:get', (_e, accountId) => store.getStats(accountId));

/* ------------------------------ IPC: 多客服 ------------------------------ */

handleShell('staff:list', () => store.listStaff());
handleShell('staff:add', (_e, { name }) => { const s = store.addStaff(name); syncStaff(); return s; });
handleShell('staff:update', (_e, { id, patch }) => { const s = store.updateStaff(id, patch || {}); syncStaff(); return s; });
handleShell('staff:remove', (_e, id) => { store.removeStaff(id); syncStaff(); return true; });
handleShell('staff:current', () => store.getCurrentStaffId());
handleShell('staff:set-current', (_e, id) => { store.setCurrentStaffId(id); syncStaff(); return true; });

handleShell('sessions:assign', (_e, { accountId, sessionId, assigneeId }) => {
  const r = store.assignSession(accountId, sessionId, assigneeId);
  if (win) win.webContents.send('sessions:updated', { accountId });
  return r;
});

handleShell('sessions:list-assignable', (_e, accountId) => {
  const s = store.ready();
  return s.sessions
    .filter((x) => x.account_id === Number(accountId))
    .sort((a, b) => (b.last_ts || 0) - (a.last_ts || 0));
});

function syncStaff() {
  if (!win) return;
  win.webContents.send('staff:sync', {
    staff: store.listStaff(),
    currentId: store.getCurrentStaffId(),
  });
}

/* ------------------------------ 超时提醒 ------------------------------ */

function notifyTimeout(title, body, meta) {
  // 推送到已配置的渠道（钉钉/飞书/Bark…）
  notify.notify({ title, body, event: 'timeout' }).catch(() => {});

  // 系统通知（点一下跳到对应账号）
  if (Notification.isSupported()) {
    const n = new Notification({
      title,
      body,
      icon: APP_ICON,
      silent: false,
    });
    n.on('click', () => {
      if (!win) return;
      win.show();
      mount(meta.accountId);
      win.webContents.send('ui:focus-session', meta);
    });
    n.show();
  }
  // 同时推给 UI 显示在顶部
  if (win) win.webContents.send('ui:timeout-alert', meta);
}

function startReminder() {
  reminder.start({ notify: notifyTimeout });
}

handleShell('reminder:pending', () => {
  const s = store.getSettings();
  return reminder.pendingSessions({
    accountId: null,
    timeoutMinutes: Number(s.reminder.timeoutMinutes) || 5,
  });
});

handleShell('reminder:scan', () => reminder.scan());

/* ------------------------------ 页面级操作（发送商品 / 拉黑） ------------------------------ */

/**
 * 这些动作要在官方页面执行，结果异步回来。
 * 用 pending 表按 requestId 对应请求与响应。
 */
const pendingActions = new Map(); // requestId -> { resolve, timer }

function callPageAction(accountId, channel, payload, timeoutMs = 20000) {
  return new Promise((resolve) => {
    // 懒创建：即使 view 还没建（例如刚启动），这里也能兜住
    const view = views.get(Number(accountId)) || ensureView(accountId);
    if (!view) { resolve({ ok: false, error: '该账号不存在或 IM 窗口未就绪' }); return; }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      pendingActions.delete(requestId);
      resolve({ ok: false, error: '页面无响应（超时）。可能未登录，或页面结构已变。' });
    }, timeoutMs);

    pendingActions.set(requestId, { resolve, timer });

    const send = () => {
      try {
        view.webContents.send(channel, { ...payload, requestId });
      } catch (e) {
        clearTimeout(timer);
        pendingActions.delete(requestId);
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    };

    // 页面还在加载时先等一等
    if (view.webContents.isLoading()) {
      view.webContents.once('did-finish-load', send);
    } else {
      send();
    }
  });
}

ipcMain.on('action:result', (event, payload) => {
  const accountId = accountIdOfWebContents(event.sender);
  const requestId = payload && payload.requestId;
  const entry = requestId ? pendingActions.get(requestId) : null;
  if (entry) {
    clearTimeout(entry.timer);
    pendingActions.delete(requestId);
    entry.resolve({ ...payload, accountId });
  }
  if (win) win.webContents.send('ui:action-result', { ...payload, accountId });
});

handleShell('action:send-product', (_e, { accountId, sessionId, itemId, keyword }) =>
  callPageAction(accountId, 'action:send-product', { sessionId, itemId, keyword }));

handleShell('action:set-blocked', (_e, { accountId, sessionId, unblock }) =>
  callPageAction(accountId, 'action:set-blocked', { sessionId, unblock }));

/** 诊断：探测当前官方页面有哪些可用元素 */
const diagnoseWaiters = new Map();
handleShell('action:diagnose', (e, accountId) => {
  const view = views.get(Number(accountId)) || ensureView(accountId);
  if (!view) return { ok: false, error: '该账号不存在或 IM 窗口未就绪' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      diagnoseWaiters.delete(view.webContents.id);
      resolve({ ok: false, error: '诊断超时（页面可能未加载完）' });
    }, 15000);
    diagnoseWaiters.set(view.webContents.id, { resolve, timer });
    const send = () => view.webContents.send('action:diagnose');
    if (view.webContents.isLoading()) view.webContents.once('did-finish-load', send);
    else send();
  });
});

ipcMain.on('action:diagnose-result', (event, data) => {
  const wcId = event.sender.id;
  const entry = diagnoseWaiters.get(wcId);
  if (entry) {
    clearTimeout(entry.timer);
    diagnoseWaiters.delete(wcId);
    entry.resolve({ ok: true, ...data });
  }
});

/* ------------------------------ 商品快捷发送配置 ------------------------------ */

handleShell('quick-products:list', (_e, accountId) => {
  const s = store.ready();
  return (s.quickProducts || []).filter((p) => p.account_id === Number(accountId));
});

handleShell('quick-products:save', (_e, product) => {
  const s = store.ready();
  if (!s.quickProducts) s.quickProducts = [];
  const data = {
    account_id: Number(product.accountId),
    item_id: String(product.item_id || '').trim(),
    title: product.title || '',
  };
  if (!data.item_id) throw new Error('商品ID不能为空');

  const exist = s.quickProducts.find(
    (p) => p.account_id === data.account_id && p.item_id === data.item_id,
  );
  if (exist) {
    exist.title = data.title || exist.title;
  } else {
    s.quickProducts.push({
      id: s.quickProducts.reduce((m, p) => Math.max(m, p.id), 0) + 1,
      ...data,
    });
  }
  store.scheduleSave();
  return (s.quickProducts || []).filter((p) => p.account_id === data.account_id);
});

handleShell('quick-products:remove', (_e, { accountId, itemId }) => {
  const s = store.ready();
  s.quickProducts = (s.quickProducts || []).filter(
    (p) => !(p.account_id === Number(accountId) && p.item_id === String(itemId)),
  );
  store.scheduleSave();
  return (s.quickProducts || []).filter((p) => p.account_id === Number(accountId));
});

/* ------------------------------ 生命周期 ------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { win && win.show(); });

  app.whenReady().then(() => {
    store.init(app.getPath('userData'));
    productDrafts = createDraftManager({ store, directory: app.getPath('userData'), nativeImage });
    productService.setDraftManager(productDrafts);
    autoRelist = require('./auto-relist').createAutoRelist({ store, drafts: productDrafts, products: productService });
    remoteServer = require('./remote-server').createRemoteServer({ store,
      dispatch: require('./remote-actions').createRemoteActions({ store, drafts: productDrafts, products: productService, send: sendToSession, history: readRemoteHistory, directory: app.getPath('userData') }),
    });
    remoteServer.start().catch((error) => console.error('[remote] 启动失败', error.message));
    store.setSafeStorage(safeStorage);

    const needsDisclaimer = !legalWindow.alreadyAccepted(store);
    createWindow({ showWhenReady: !needsDisclaimer });
    createTray();

    // 所有已存在的店铺全部拉起，保证后台也在线
    win.webContents.once('did-finish-load', () => {
      ensureAllViews();
      syncAccounts();
      startReminder();
      tasks.startScheduler();
      startCatchupScan();
      startTokenRenew();
      autoRelist.start();
    });

    // 首次启动（或声明版本变更）必须先阅读并确认风险与免责声明，确认前不显示主窗口、
    // 不启动任何自动化。用户选择退出时直接结束进程，不留下半启动状态。
    if (needsDisclaimer) {
      legalWindow.requireDisclaimer(store, win).then((result) => {
        if (result.accepted) { if (win && !win.isDestroyed()) win.show(); return; }
        app.isQuitting = true;
        legalWindow.forceClose();
        app.quit();
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else win && win.show();
    });
  }).catch((error) => {
    require('electron').dialog.showErrorBox('启动失败：数据已保留', error.message);
    app.isQuitting = true;
    app.quit();
  });

  app.on('before-quit', (event) => {
    autoRelist?.stop(); remoteServer?.stop().catch(() => {});
    try { store.flush(); app.isQuitting = true; }
    catch (error) {
      event.preventDefault();
      app.isQuitting = false;
      require('electron').dialog.showErrorBox('数据保存失败', error.message);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') { /* 托盘常驻 */ }
  });
}

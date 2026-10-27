'use strict';

/**
 * 官方页面 UI 自动化（发送商品卡片 / 拉黑）
 *
 * ⚠️ 重要前提
 *   这两个动作都必须在「已登录 + 已打开某个会话」的官方页面上执行。
 *   未登录时聊天区是空的，任何选择器都探不到。
 *
 * 设计原则：
 *   1. 选择器集中在 PAGE_UI 里，官方改版只改这里
 *   2. 每一步都有「找不到就明确报错」，绝不静默发错内容
 *   3. 操作前先确认当前会话正确，避免发到错误买家
 *
 * 未登录时本模块的所有方法都会返回 { ok:false, error:'未登录' }。
 */

const { ipcRenderer } = require('electron');

/* ------------------------- 官方页面选择器（改版改这里） ------------------------- */
const PAGE_UI = {
  // 已登录判断
  loginWrap: '[class*="login-iframe-wrap"]',

  // 会话区
  chatMain: '[class*="chat-main--"]',
  convHeader: '[class*="conv-header--"]',
  convItem: [
    '[class*="conv-item"]',
    '[class*="conversation-item"]',
    '[class*="session-item"]',
    '[class*="sidebar-item-wrap"]',
  ],

  // 输入区
  input: [
    '[class*="chat-input"] [contenteditable="true"]',
    '[class*="editor"] [contenteditable="true"]',
    '[contenteditable="true"]',
    'textarea',
  ],
  sendBtn: [
    '[class*="send-btn"]',
    '[class*="sendBtn"]',
    '[class*="send-button"]',
    'button[class*="send"]',
  ],

  // 工具栏（发送商品入口常见形态）
  toolbar: [
    '[class*="toolbar"]',
    '[class*="chat-tool"]',
    '[class*="action-bar"]',
    '[class*="editor-tool"]',
  ],
  // 工具栏里的「商品」按钮：文字或图标名含商品/宝贝
  productBtn: [
    '[class*="product"]',
    '[class*="goods"]',
    '[title*="商品"]',
    '[title*="宝贝"]',
    '[aria-label*="商品"]',
  ],

  // 商品选择弹层
  productDlg: [
    '[class*="product-dialog"]',
    '[class*="goods-dialog"]',
    '[class*="product-select"]',
    '[class*="ant-modal"]',
    '[role="dialog"]',
  ],
  productItem: [
    '[class*="product-item"]',
    '[class*="goods-item"]',
    '[class*="product-card"]',
    '[class*="item-card"]',
  ],
  dlgConfirm: [
    '[class*="confirm"]',
    'button[class*="primary"]',
    '[class*="ok-btn"]',
  ],

  // 更多菜单（拉黑入口）
  moreBtn: [
    '[class*="more"]',
    '[title*="更多"]',
    '[aria-label*="更多"]',
    '[class*="setting"]',
  ],
  // 拉黑菜单项
  blockItem: [
    '[class*="block"]',
    '[class*="black"]',
  ],
  // 确认弹窗
  confirmBtn: [
    '[class*="confirm"]',
    'button[class*="primary"]',
    '[class*="ok-btn"]',
    '[class*="sure"]',
  ],
};

/* ------------------------- 工具函数 ------------------------- */

function pick(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const s of list) {
    try {
      const el = document.querySelector(s);
      if (el) return { el, selector: s };
    } catch (_) { /* 非法选择器忽略 */ }
  }
  return null;
}

function pickAll(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const s of list) {
    try {
      const found = document.querySelectorAll(s);
      if (found.length) return { list: Array.from(found), selector: s };
    } catch (_) { /* ignore */ }
  }
  return null;
}

/** 元素是否可见可点 */
function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待某个条件成立 */
async function waitFor(fn, timeoutMs = 5000, stepMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const v = fn(); if (v) return v; } catch (_) { /* ignore */ }
    await sleep(stepMs);
  }
  return null;
}

/**
 * 判断页面处于三种状态之一：
 *   loading     —— 页面还没真正加载（连 page-im 都没有）
 *   logged-out  —— 有登录框
 *   logged-in   —— 有 page-im 且无登录框
 *
 * 区分 loading 很关键：否则页面空白时会被误判成「已登录」。
 */
function pageState() {
  const hasApp = !!document.querySelector('[class*="page-im"]')
    || document.body.innerText.trim().length > 100;
  if (!hasApp) return 'loading';
  return document.querySelector(PAGE_UI.loginWrap) ? 'logged-out' : 'logged-in';
}

function isLoggedIn() {
  return pageState() === 'logged-in';
}

/** 统一的可操作性检查；返回 null 表示可以继续 */
function guardReady() {
  const st = pageState();
  if (st === 'loading') return { ok: false, error: '页面还在加载，请稍后再试', retryable: true };
  if (st === 'logged-out') return { ok: false, error: '未登录，请先在页面上扫码登录闲鱼' };
  return null;
}

function readPeerNick() {
  const el = pick([
    '[class*="conv-header--"] [class*="nick"]',
    '[class*="conv-header--"] [class*="name"]',
    '[class*="chat-header"] [class*="nick"]',
  ]);
  return el ? el.el.textContent.trim() : '';
}

/* ------------------------- 切会话 ------------------------- */

function convKeyOf(node) {
  for (const a of ['data-session-id', 'data-sessionid', 'data-cid', 'data-id']) {
    const v = node.getAttribute(a);
    if (v) return v;
  }
  const nameEl = node.querySelector('[class*="nick"], [class*="name"]');
  const name = nameEl ? nameEl.textContent.trim() : node.textContent.trim().slice(0, 20);
  return name ? 'nick:' + name : null;
}

async function switchToSession(sessionId) {
  return !!globalThis.__xyAutomation && globalThis.__xyAutomation.switchToSession(sessionId);
}

function currentSessionMatches(sessionId) {
  return sessionId && !String(sessionId).startsWith('nick:') && globalThis.__xyAutomation
    && String(globalThis.__xyAutomation.readSessionId()) === String(sessionId);
}

/* ------------------------- 发送商品卡片 ------------------------- */

/**
 * 在官方页面打开「发送商品」入口，选一个商品发出。
 *
 * @param {object} opts
 * @param {string} opts.sessionId   目标会话（空=当前会话）
 * @param {string} opts.itemId      商品ID
 * @param {string} [opts.keyword]   商品标题关键词（用于在选择弹层里定位）
 */
async function sendProduct({ sessionId, itemId, keyword }) {
  const notReady = guardReady();
  if (notReady) return notReady;
  if (!itemId) return { ok: false, error: '缺少商品ID' };
  sessionId = sessionId || globalThis.__xyAutomation.readSessionId();
  if (!sessionId || String(sessionId).startsWith('nick:')) return { ok: false, error: '无法核验目标会话，请人工操作' };

  const origin = readPeerNick();

  // 1. 切会话
  if (sessionId) {
    const ok = await switchToSession(sessionId);
    if (!ok) return { ok: false, error: `找不到会话 ${sessionId}` };
    await sleep(500);
  }

  // 2. 找工具栏的「商品」按钮
  let productBtn = null;

  // 2a. 先在工具栏范围内找
  const toolbar = pick(PAGE_UI.toolbar);
  if (toolbar) {
    productBtn = pick(PAGE_UI.productBtn.filter((s) => {
      try { return !!toolbar.el.querySelector(s); } catch (_) { return false; }
    }).map((s) => `:scope ${s}`));
  }

  // 2b. 全局兜底找
  if (!productBtn) productBtn = pick(PAGE_UI.productBtn);

  if (!productBtn || !visible(productBtn.el)) {
    return {
      ok: false,
      error: '找不到「发送商品」按钮（官方页面结构可能变了，或当前会话不支持）',
      needManual: true,
    };
  }

  productBtn.el.click();
  await sleep(800);

  // 3. 等商品选择弹层出现
  const dlg = await waitFor(() => pick(PAGE_UI.productDlg), 4000);
  if (!dlg) {
    return { ok: false, error: '商品选择弹层没出现', needManual: true };
  }

  // 4. 在弹层里找目标商品
  const items = pickAll(PAGE_UI.productItem);
  if (!items) {
    return { ok: false, error: '商品列表为空或结构不识别', needManual: true };
  }

  let target = null;
  for (const node of items.list) {
    const txt = node.textContent || '';
    const attr = node.getAttribute('data-item-id') || node.getAttribute('data-id') || '';
    if (attr && String(attr).includes(String(itemId))) { target = node; break; }
    if (keyword && txt.includes(keyword)) { target = node; break; }
    if (txt.includes(String(itemId))) { target = node; break; }
  }

  if (!target) {
    // 关掉弹层（按 Esc）
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    return {
      ok: false,
      error: `商品列表里找不到 ${itemId}${keyword ? ' / ' + keyword : ''}（可能需要先滚动加载）`,
      needManual: true,
    };
  }

  // 5. 选中并确认发送
  if (!currentSessionMatches(sessionId)) return { ok: false, error: '会话已变化，已取消发送商品' };
  target.click();
  await sleep(500);

  // 有些页面选完直接发送，有些要再点确认
  const confirm = pick(PAGE_UI.dlgConfirm);
  if (confirm && visible(confirm.el)) {
    if (!currentSessionMatches(sessionId)) return { ok: false, error: '会话已变化，已取消确认' };
    confirm.el.click();
    await sleep(600);
  }

  return {
    ok: true,
    itemId,
    peerNick: readPeerNick() || origin,
    note: '已触发发送，请确认买家是否收到商品卡片',
  };
}

/* ------------------------- 拉黑 / 解除拉黑 ------------------------- */

/**
 * 拉黑当前会话的买家。
 *
 * 路径：会话头部「更多」→「拉黑」→ 确认
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {boolean} [opts.unblock]  true = 解除拉黑
 */
async function setBlocked({ sessionId, unblock = false }) {
  const notReady = guardReady();
  if (notReady) return notReady;
  sessionId = sessionId || globalThis.__xyAutomation.readSessionId();
  if (!sessionId || String(sessionId).startsWith('nick:')) return { ok: false, error: '无法核验目标会话，请人工操作' };

  if (sessionId) {
    const ok = await switchToSession(sessionId);
    if (!ok) return { ok: false, error: `找不到会话 ${sessionId}` };
    await sleep(500);
  }

  const peerNick = readPeerNick();

  // 1. 点「更多」菜单
  const moreBtn = pick(PAGE_UI.moreBtn);
  if (!moreBtn || !visible(moreBtn.el)) {
    return {
      ok: false,
      error: '找不到会话头部的「更多」按钮（官方页面结构可能变了）',
      needManual: true,
    };
  }
  moreBtn.el.click();
  await sleep(700);

  // 2. 在菜单里找「拉黑 / 解除拉黑」
  const menuItems = Array.from(document.querySelectorAll(
    '[class*="menu"] li, [class*="dropdown"] li, [role="menuitem"], [class*="menu-item"]',
  )).filter(visible);

  const wantText = unblock ? /解除|取消拉黑|移出/ : /拉黑|加入黑名单|屏蔽/;
  let blockEntry = null;
  for (const el of menuItems) {
    if (wantText.test(el.textContent || '')) { blockEntry = el; break; }
  }

  // 兜底：用 class 找
  if (!blockEntry) {
    const byClass = pick(PAGE_UI.blockItem);
    if (byClass && visible(byClass.el)) blockEntry = byClass.el;
  }

  if (!blockEntry) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    return {
      ok: false,
      error: `菜单里找不到「${unblock ? '解除拉黑' : '拉黑'}」选项`,
      needManual: true,
    };
  }

  if (!currentSessionMatches(sessionId)) return { ok: false, error: '会话已变化，已取消操作' };
  blockEntry.click();
  await sleep(700);

  // 3. 确认弹窗
  const confirm = pick(PAGE_UI.confirmBtn);
  if (confirm && visible(confirm.el)) {
    if (!currentSessionMatches(sessionId)) return { ok: false, error: '会话已变化，已取消确认' };
    confirm.el.click();
    await sleep(600);
  }

  return {
    ok: true,
    peerNick,
    action: unblock ? 'unblock' : 'block',
    note: '已执行，请在页面上确认买家状态',
  };
}

/* ------------------------- 诊断：探测页面结构 ------------------------- */

/**
 * 探测当前页面有哪些可用元素。
 * 未登录时会返回 loggedIn:false，这是正常现象。
 */
function diagnose() {
  const state = pageState();
  const out = {
    state,
    loggedIn: state === 'logged-in',
    url: location.href,
    bodyLen: document.body.innerText.trim().length,
    peerNick: readPeerNick(),
    found: {},
  };

  if (state === 'loading') {
    out.hint = '页面还在加载（还没出现 page-im 容器），请稍等再诊断。';
    return out;
  }
  if (state === 'logged-out') {
    out.hint = '未登录：聊天区为空，选择器无法探测。请先扫码登录。';
    return out;
  }

  const checks = {
    chatMain: PAGE_UI.chatMain,
    convHeader: PAGE_UI.convHeader,
    input: PAGE_UI.input,
    sendBtn: PAGE_UI.sendBtn,
    toolbar: PAGE_UI.toolbar,
    productBtn: PAGE_UI.productBtn,
    moreBtn: PAGE_UI.moreBtn,
  };
  for (const [k, sel] of Object.entries(checks)) {
    const r = pick(sel);
    out.found[k] = r ? { selector: r.selector, text: (r.el.textContent || '').trim().slice(0, 20) } : null;
  }

  // 列出所有可见按钮，帮助人工判断
  out.visibleButtons = Array.from(document.querySelectorAll('button, [role="button"], [class*="iconfont"]'))
    .filter(visible)
    .slice(0, 30)
    .map((e) => ({
      tag: e.tagName,
      cls: String(e.className).slice(0, 50),
      title: e.getAttribute('title') || '',
      txt: (e.textContent || '').trim().slice(0, 12),
    }));

  out.convCount = (pickAll(PAGE_UI.convItem) || { list: [] }).list.length;
  return out;
}

/* ------------------------- IPC ------------------------- */

ipcRenderer.on('action:send-product', async (_e, payload) => {
  const requestId = payload && payload.requestId;
  let res;
  try {
    res = await globalThis.__xyAutomation.enqueue(() => sendProduct(payload || {}));
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e) };
  }
  ipcRenderer.send('action:result', { action: 'sendProduct', requestId, ...res });
});

ipcRenderer.on('action:set-blocked', async (_e, payload) => {
  const requestId = payload && payload.requestId;
  let res;
  try {
    res = await globalThis.__xyAutomation.enqueue(() => setBlocked(payload || {}));
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e) };
  }
  ipcRenderer.send('action:result', { action: 'setBlocked', requestId, ...res });
});

ipcRenderer.on('action:diagnose', () => {
  ipcRenderer.send('action:diagnose-result', diagnose());
});

// 暴露给 devtools 调试用
window.__xyAction = { sendProduct, setBlocked, diagnose };

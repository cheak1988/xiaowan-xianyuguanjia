'use strict';

/**
 * 注入脚本：运行在 https://www.goofish.com/im 页面内（每个店铺一份）
 *
 * 关键能力：
 *   1. 多店铺同时在线 —— 后台 view 不挂载也能收消息、发消息
 *   2. 收发都不依赖「当前打开的会话」—— 发送时先切到目标会话再发，发完切回
 *   3. 登录态上报
 *
 * ⚠️ 官方页面用 CSS Modules（class 带构建哈希），选择器一律用前缀匹配。
 *    实测结构（2026-10）：
 *      .page-im
 *        .content-container--xxx
 *          .im-main--xxx
 *            .sidebar-container--xxx   ← 会话列表
 *            .chat-main--xxx           ← 对话区
 *     未登录时聊天区为空，登录框在 .login-iframe-wrap--xxx 内 iframe。
 */

const { ipcRenderer, webFrame } = require('electron');
let lastConversations = '', automationBusy = false;
for (const event of ['click', 'keydown', 'paste', 'drop']) document.addEventListener(event, (event) => {
  if (automationBusy && event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
async function refreshRenderedIM() {
  if (!document.querySelector('[class*="conversation-item--"],[class*="message-row--"]')) return;
  const result = await webFrame.executeJavaScriptInIsolatedWorld(0, [{ code: '(' + readRenderedIM.toString() + ')()' }]);
  if (result?.conversations?.length && JSON.stringify(result.conversations) !== lastConversations) { lastConversations = JSON.stringify(result.conversations); ipcRenderer.send('im:sessions', result.conversations); }
}

// ------------------------- 选择器（改版只改这里） -------------------------
const SEL = {
  app:        '[class*="page-im"]',
  imMain:     '[class*="im-main--"]',
  sidebar:    '[class*="sidebar-container--"]',
  chatMain:   '[class*="chat-main--"]',
  convHeader: '[class*="conv-header--"]',

  convItem: [
    '[class*="conv-item"]',
    '[class*="conversation-item"]',
    '[class*="session-item"]',
    '[class*="sidebar-item-wrap"]',
  ],

  messageList: [
    '[class*="message-list"]',
    '[class*="msg-list"]',
    '[class*="chat-message"]',
    '[class*="chat-room"]',
  ],
  messageItem: [
    '[class*="message-row--"]',
    '[class*="message-item"]',
    '[class*="msg-item"]',
    '[data-message-id]',
  ],

  input: [
    '[class*="chat-input"] [contenteditable="true"]',
    '[class*="editor"] [contenteditable="true"]',
    '[class*="input-area"] [contenteditable="true"]',
    '[contenteditable="true"]',
    'textarea',
  ],
  sendBtn: [
    '[class*="send-btn"]',
    '[class*="sendBtn"]',
    '[class*="send-button"]',
    'button[class*="send"]',
  ],

  peerName: [
    '[class*="conv-header--"] [class*="nick"]',
    '[class*="conv-header--"] [class*="name"]',
    '[class*="chat-header"] [class*="nick"]',
  ],

  loginWrap: '[class*="login-iframe-wrap"]',
};

function pick(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const s of list) {
    const el = document.querySelector(s);
    if (el) return { el, selector: s };
  }
  return null;
}

function pickAll(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const s of list) {
    const found = document.querySelectorAll(s);
    if (found.length) return { list: found, selector: s };
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------- 登录态 -------------------------

function isLoggedIn() {
  return !!document.querySelector(SEL.app) && !!document.querySelector(SEL.imMain)
    && !document.querySelector(SEL.loginWrap);
}

function reportLoginStatus() {
  ipcRenderer.send('im:login-status', { loggedIn: isLoggedIn() });
}

// ------------------------- 会话 -------------------------

function readSessionId() {
  const rendered = document.querySelector('[class*="chat-main--"][data-xy-session-id]');
  if (rendered) return rendered.getAttribute('data-xy-session-id') || null;
  // 不读取列表中第一条会话的属性；只信任聊天区或明确选中的会话。
  for (const selector of [SEL.convHeader, SEL.chatMain,
    '[aria-selected="true"][data-session-id]', '[data-session-id][class*="active"]',
    '[data-session-id][class*="selected"]']) {
    const element = document.querySelector(selector);
    if (!element) continue;
    for (const key of ['data-session-id', 'data-sessionid', 'data-cid']) {
      const value = element.getAttribute(key);
      if (value) return value;
    }
  }
  try {
    const u = new URL(location.href);
    for (const k of ['sessionId', 'session_id', 'sid', 'cid']) {
      const v = u.searchParams.get(k);
      if (v) return v;
    }
  } catch (_) { /* ignore */ }

  const peer = pick(SEL.peerName);
  return peer ? 'nick:' + peer.el.textContent.trim() : null;
}

function readPeerNick() {
  const peer = pick(SEL.peerName);
  return peer ? peer.el.textContent.trim() : '';
}

/** 会话列表项上的稳定标识（优先 data 属性，其次昵称） */
function convKeyOf(node) {
  if (node.hasAttribute('data-xy-session-id')) return node.getAttribute('data-xy-session-id');
  const attrs = ['data-session-id', 'data-sessionid', 'data-cid', 'data-id'];
  for (const a of attrs) {
    const v = node.getAttribute(a);
    if (v) return v;
  }
  const nameEl = node.querySelector('[class*="nick"], [class*="name"]');
  const name = nameEl ? nameEl.textContent.trim() : node.textContent.trim().slice(0, 20);
  return name ? 'nick:' + name : null;
}

/**
 * 切换到目标会话。
 * sessionId 是我们记录的 key（可能是真 id，也可能是 'nick:xxx'）。
 * @returns {Promise<boolean>}
 */
async function switchToSession(sessionId) {
  await refreshRenderedIM();
  if (!sessionId || String(sessionId).startsWith('nick:')) return false;

  // 已经是当前会话，直接返回
  if (String(readSessionId()) === String(sessionId)) return true;

  const found = pickAll(SEL.convItem);
  if (!found) return false;

  for (const node of found.list) {
    if (String(convKeyOf(node)) !== String(sessionId)) continue;
    node.click();
    // 等会话消息区刷新
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      await refreshRenderedIM();
      if (String(readSessionId()) === String(sessionId)) return true;
    }
    return false; // 无法核验目标时停止，不能向当前买家发送。
  }
  return false;
}

// ------------------------- 消息抽取 -------------------------

const seen = new Set();
const nodeIds = new WeakMap();
const nodeSources = new WeakMap();
const expectedOutgoing = [];
let nodeSequence = 0;
const pageEpoch = Date.now().toString(36) + Math.random().toString(36).slice(2);
let observedSid = null;
let switching = false;
const normalizeText = (text) => String(text || '').trim().replace(/\s+/g, ' ');

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function extractOne(node, session) {
  const cls = String(node.className || '');

  const textEl = node.querySelector(
    '[class*="message-content"], [class*="msg-content"], [class*="text"]',
  );
  let text = node.hasAttribute('data-xy-text') ? node.getAttribute('data-xy-text') : (textEl || node).textContent.trim().replace(/\s+/g, ' ');

  const img = node.querySelector('img[class*="content"], img[class*="image"], img[src*="alicdn"]');
  if (img && !textEl) text = '';
  const imageSrc = node.getAttribute('data-xy-image') || img?.src;
  const isSelf = node.getAttribute('data-xy-direction') === 'out' || /(^|\s|--)(right|self|mine|out)(\s|$|--)/.test(cls);

  const idAttr = node.getAttribute('data-message-id') || node.getAttribute('data-id');
  const timestamp = node.getAttribute('data-ts');
  if (!nodeIds.has(node)) nodeIds.set(node, `${pageEpoch}-${++nodeSequence}`);
  const messageId = idAttr || (timestamp
    ? hash(`${session.id}|${timestamp}|${text}|${img ? img.src : ''}|${isSelf}`) : nodeIds.get(node));
  let source = nodeSources.get(node);
  if (isSelf && !source) {
    const pending = expectedOutgoing.find((entry) => !entry.claimed && entry.sessionId === String(session.id)
      && (entry.imageUrl ? sameImage(imageSrc, entry.imageUrl) : normalizeText(entry.text) === text) && Date.now() - entry.ts < 60000);
    if (pending) { pending.claimed = true; source = pending.kind; nodeSources.set(node, source); }
  }

  return {
    messageId,
    ts: Number(node.getAttribute('data-ts')) || Date.now(),
    type: imageSrc && !text ? 2 : 1,
    direction: isSelf ? 'out' : 'in',
    source: isSelf ? source || 'human' : null,
    content: imageSrc && !text ? { imgUrl: imageSrc } : { text },
    user: { id: null, nick: isSelf ? 'me' : readPeerNick() },
  };
}

function scanMessages() {
  if (!isLoggedIn() || switching) return;

  const found = pickAll(SEL.messageItem);
  if (!found) return;

  const session = { id: readSessionId(), withWhoNick: readPeerNick() };
  if (!session.id) return;
  if (session.id !== observedSid) { observedSid = session.id; primeSeen(); return; }

  for (const node of found.list) {
    const msg = extractOne(node, session);
    if (!msg || !msg.messageId) continue;
    if (!msg.content.imgUrl && !msg.content.text) continue;
    if (!msg.content.imgUrl && msg.content.text.length > 3000) continue;

    const key = `${session.id}:${msg.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    ipcRenderer.send('im:message', { session, message: msg });
  }
}

/** 首屏 / 切换会话时，把已有消息标记为已见，避免触发自动回复 */
function primeSeen() {
  const found = pickAll(SEL.messageItem);
  if (!found) return;
  const sid = readSessionId() || '';
  for (const node of found.list) {
    const msg = extractOne(node, { id: sid });
    if (msg && msg.messageId) seen.add(`${sid}:${msg.messageId}`);
  }
}

// ------------------------- 发送 -------------------------

function setInputValue(el, text) {
  el.focus();
  if (el.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  el.innerHTML = '';
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    if (i) el.appendChild(document.createElement('br'));
    el.appendChild(document.createTextNode(line));
  });
  el.dispatchEvent(new InputEvent('input', {
    bubbles: true, inputType: 'insertText', data: text,
  }));
}

function clickSend() {
  const btn = pick(SEL.sendBtn);
  if (btn) { btn.el.click(); return true; }

  const input = pick(SEL.input);
  if (!input) return false;
  const opts = {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
    bubbles: true, cancelable: true,
  };
  input.el.dispatchEvent(new KeyboardEvent('keydown', opts));
  input.el.dispatchEvent(new KeyboardEvent('keyup', opts));
  return true;
}

async function sendText(text, { sessionId, requestId, kind }) {
  await refreshRenderedIM();
  const reject = (error, uncertain = false) => ({ ok: false, error, uncertain });
  if (!isLoggedIn()) return reject('未登录');
  if (String(readSessionId()) !== String(sessionId)) return reject('会话已变化，已取消发送');

  const input = pick(SEL.input);
  if (!input) return reject('未找到输入框（选择器需更新）');
  const inputText = () => input.el.tagName === 'TEXTAREA' ? input.el.value : input.el.textContent;
  if (normalizeText(inputText())) return reject('当前有未发送草稿，请先人工处理');
  const before = new Set(Array.from((pickAll(SEL.messageItem) || { list: [] }).list)
    .map((node) => extractOne(node, { id: sessionId }).messageId));

  setInputValue(input.el, text);
  await sleep(150);
  if (String(readSessionId()) !== String(sessionId) || normalizeText(inputText()) !== normalizeText(text)) {
    return reject('会话或草稿已被人工修改，已取消发送');
  }
  if (!await ipcRenderer.invoke('im:can-send', { requestId, sessionId })) {
    if (String(readSessionId()) === String(sessionId) && normalizeText(inputText()) === normalizeText(text)) setInputValue(input.el, '');
    return reject('发送许可已撤销，已取消发送');
  }
  await refreshRenderedIM();
  if (String(readSessionId()) !== String(sessionId) || normalizeText(inputText()) !== normalizeText(text)) {
    return reject('发送前会话或草稿已变化');
  }
  while (expectedOutgoing.length && Date.now() - expectedOutgoing[0].ts > 60000) expectedOutgoing.shift();
  expectedOutgoing.push({ sessionId: String(sessionId), text, kind, ts: Date.now(), claimed: false });
  if (!clickSend()) return reject('未找到发送按钮');
  // 点击和乐观插入气泡不等于成功；必须看到新消息明确的已发送/已读状态。
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    await refreshRenderedIM();
    if (String(readSessionId()) !== String(sessionId)) return reject('发送后会话变化，请人工核对', true);
    for (const node of (pickAll(SEL.messageItem) || { list: [] }).list) {
      const message = extractOne(node, { id: sessionId });
      if (before.has(message.messageId) || message.direction !== 'out'
          || normalizeText(message.content.text) !== normalizeText(text)) continue;
      const statusNode = node.querySelector('[class*="status"], [class*="read-state"], [data-status]');
      const state = node.getAttribute('data-status') || (statusNode && statusNode.getAttribute('data-status')) || '';
      const label = statusNode ? statusNode.textContent.trim() : '';
      if (/failed|error/i.test(state) || /失败|重试/.test(label)) return reject('页面提示发送失败，请核对后处理', true);
      if (/^(sent|success|delivered|read)$/i.test(state) || /^(已发送|已送达|送达|已读|未读)$/.test(label)) {
        scanMessages();
        return { ok: true, messageId: message.messageId, uncertain: false };
      }
    }
  }
  return reject('已尝试发送，但未获得明确成功状态，请人工核对', true);
}

/**
 * 跨会话发送：先切到目标会话，再发，发完切回原会话。
 * 这样后台店铺也能回复任意买家，而不需要人工先点开那个会话。
 */
let sendQueue = Promise.resolve();

function sameImage(candidate, expected) {
  try {
    const a = new URL(candidate), b = new URL(expected);
    return a.hostname === b.hostname && (a.pathname === b.pathname || a.pathname.startsWith(b.pathname + '_'));
  } catch (_) { return false; }
}
function visible(node) { const rect = node?.getBoundingClientRect(); return !!rect && rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'; }

async function sendImage(reply, { sessionId, requestId, kind }) {
  await refreshRenderedIM();
  const reject = (error, uncertain = false) => ({ ok: false, error, uncertain });
  if (!isLoggedIn() || String(readSessionId()) !== String(sessionId)) return reject('登录或目标会话已变化');
  const input = pick(SEL.input)?.el;
  if (!input) return reject('聊天输入区尚未加载');
  if (normalizeText(input.tagName === 'TEXTAREA' ? input.value : input.textContent)
      || Array.from(document.querySelectorAll('[class*="upload-preview"],[class*="image-preview"],[data-chat-image-preview]')).some(visible)) return reject('聊天区有人工草稿或待发送图片，请先处理');
  const before = new Set(Array.from(pickAll(SEL.messageItem)?.list || []).map((node) => extractOne(node, { id: sessionId }).messageId));
  if (!await ipcRenderer.invoke('im:can-send', { requestId, sessionId })) return reject('图片发送许可已撤销');
  const uploaded = await ipcRenderer.invoke('im:upload-image', { requestId, sessionId, assetId: reply.assetId });
  if (!uploaded?.ok) return uploaded || reject('图片上传未确认', true);
  if (String(readSessionId()) !== String(sessionId)) return reject('图片上传后会话已变化，请核对', true);
  expectedOutgoing.push({ sessionId: String(sessionId), imageUrl: uploaded.imageUrl, kind, ts: Date.now(), claimed: false });
  await sleep(200);
  const candidates = () => Array.from(pickAll(SEL.messageItem)?.list || []).filter((node) => {
    const message = extractOne(node, { id: sessionId });
      return !before.has(message.messageId) && message.direction === 'out' && sameImage(node.getAttribute('data-xy-image') || node.querySelector('img')?.src, uploaded.imageUrl);
  });
  // 官方页面可能上传后立即发送；仅有明确的预览弹窗时才点击一次发送。
  const preview = Array.from(document.querySelectorAll('[class*="upload-preview"],[class*="image-preview"],[data-chat-image-preview]'))
    .find((node) => visible(node) && Array.from(node.querySelectorAll('img')).some((image) => sameImage(image.src, uploaded.imageUrl)));
  if (!candidates().length && preview) {
    const send = Array.from((preview.closest('[role="dialog"],.ant-modal') || preview).querySelectorAll('button'))
      .find((button) => visible(button) && /^(发送|确认发送)$/.test(button.textContent.trim()));
    if (!send || !await ipcRenderer.invoke('im:can-send', { requestId, sessionId })) return reject('图片预览尚不能确认发送，请人工核对', true);
    send.click();
  }
    for (let attempt = 0; attempt < 40; attempt++) {
      await refreshRenderedIM();
    if (String(readSessionId()) !== String(sessionId)) return reject('图片发送后会话变化，请核对', true);
    const nodes = candidates(); if (nodes.length > 1) return reject('存在多条同图消息，请核对本次图片投递', true);
    for (const node of nodes) {
      const status = node.querySelector('[class*="status"],[class*="read-state"],[data-status]');
      const state = node.getAttribute('data-status') || status?.getAttribute('data-status') || '', label = status?.textContent.trim() || '';
      if (/failed|error/i.test(state) || /失败|重试/.test(label)) return reject('页面提示图片发送失败，请核对', true);
      if (/^(sent|success|delivered|read)$/i.test(state) || /^(已发送|已送达|送达|已读|未读)$/.test(label)) {
        nodeSources.set(node, kind); scanMessages(); return { ok: true, uncertain: false, messageId: extractOne(node, { id: sessionId }).messageId };
      }
    }
    await sleep(250);
  }
  return reject('未确认图片已送达，请先核对，卡密保持占用', true);
}

function enqueueSend(task) {
  const result = sendQueue.then(task);
  sendQueue = result.catch((e) => {
    console.error('[xy-inject] send task failed', e);
  });
  return result;
}

ipcRenderer.on('inject:send', (_e, payload) => {
  const { sessionId, reply, requestId } = payload || {};
  const report = (result) => ipcRenderer.send('im:send-result', {
    requestId, sessionId, kind: reply && reply.kind, ...result,
  });
  if (!requestId || !sessionId || String(sessionId).startsWith('nick:') || !reply || !reply.content) {
    report({ ok: false, uncertain: false, error: '缺少可核验的发送请求' });
    return;
  }

  enqueueSend(async () => {
    await refreshRenderedIM();
    const origin = readSessionId();
    let switched = false;

    try {
      if (sessionId && String(sessionId) !== String(origin)) {
        switching = true;
        switched = await switchToSession(sessionId);
        if (!switched) {
          report({ ok: false, uncertain: false, error: `无法确认目标会话 ${sessionId}` });
          return;
        }
        await sleep(400); // 等消息区渲染完成
        observedSid = readSessionId();
        primeSeen();
        switching = false;
      }

      automationBusy = true;
      const res = reply.type === 'image' ? await sendImage(reply, { sessionId, requestId, kind: reply.kind })
        : await sendText(reply.content, { sessionId, requestId, kind: reply.kind });
      report(res);
    } catch (error) {
      report({ ok: false, uncertain: true, error: error.message });
    } finally {
      // 切回原会话，避免打扰正在看界面的人
      if (switched && origin && String(readSessionId()) === String(sessionId)) {
        switching = true;
        await sleep(300);
        await switchToSession(origin);
        observedSid = readSessionId();
        primeSeen();
      }
      switching = false;
      automationBusy = false;
    }
  });
});
ipcRenderer.on('inject:history', (_event, { requestId, sessionId }) => enqueueSend(async () => {
  let origin, switched = false;
  try {
    await refreshRenderedIM(); origin = readSessionId();
    const input = pick(SEL.input)?.el;
    if (origin !== sessionId && normalizeText(input?.value || input?.textContent)) throw new Error('主机聊天区有人工草稿，请稍后读取');
    automationBusy = true;
    if (origin !== sessionId) { switching = true; switched = await switchToSession(sessionId); if (!switched) throw new Error('无法打开目标会话，请在主机登录后重试'); await sleep(500); }
    await refreshRenderedIM();
    if (String(readSessionId()) !== String(sessionId)) throw new Error('目标会话已改变');
    const messages = Array.from(pickAll(SEL.messageItem)?.list || []).slice(-100).map((node) => extractOne(node, { id: sessionId })).map((message) => ({ id: message.messageId, text: message.content.text || '[图片]', direction: message.direction, type: message.type, ts: message.ts }));
    ipcRenderer.send('im:history-result', { requestId, sessionId, ok: true, messages });
  } catch (error) { ipcRenderer.send('im:history-result', { requestId, sessionId, ok: false, error: error.message }); }
  finally { if (switched && origin && String(readSessionId()) === String(sessionId)) await switchToSession(origin); switching = false; automationBusy = false; observedSid = null; }
}));

// ------------------------- 启动 -------------------------

let observer = null;
let watchTimer = null;

function boot() {
  reportLoginStatus();
  observedSid = readSessionId();
  primeSeen();

  const root = pick(SEL.chatMain) || pick(SEL.imMain) || { el: document.body };

  observer = new MutationObserver(() => {
    clearTimeout(boot._t);
    boot._t = setTimeout(scanMessages, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // 会话切换 → 重新 primeSeen
  let lastSid = readSessionId();
  let lastLogin = isLoggedIn();
  watchTimer = setInterval(async () => {
    try { await refreshRenderedIM(); } catch (_) {}
    const sid = readSessionId();
    if (sid && sid !== lastSid) {
      lastSid = sid;
      observedSid = null;
    }
    const nowLogin = isLoggedIn();
    if (nowLogin !== lastLogin) {
      lastLogin = nowLogin;
      reportLoginStatus();
      if (nowLogin) observedSid = null;
    }
  }, 1000);

  console.log('[xy-inject] ready | chatRoot =', root.selector || 'body',
    '| messageItem =', (pickAll(SEL.messageItem) || {}).selector || 'not-found',
    '| loggedIn =', isLoggedIn());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// 仅在隔离的 preload 世界共享；构建脚本随后合并页面操作和任务模块。
globalThis.__xyAutomation = { readSessionId, switchToSession, enqueue: enqueueSend };

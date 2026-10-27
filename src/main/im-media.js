'use strict';

const { remoteImage } = require('./product-drafts');

function uploadedImage(body) {
  let value = String(body).trim().replace(/^[\w.$]+\s*\(/, '').replace(/\)\s*;?$/, '');
  try { value = JSON.parse(value); } catch (_) { return ''; }
  const find = (node, depth = 0) => {
    if (depth > 6 || !node || typeof node !== 'object') return '';
    for (const [key, item] of Object.entries(node)) {
      if (/^(url|imageUrl|picUrl|imagePath|picPath|downloadUrl)$/i.test(key) && typeof item === 'string') {
        const url = remoteImage(item.replace(/^http:/, 'https:')); if (url) return url;
      }
    }
    for (const item of Object.values(node)) { const found = find(item, depth + 1); if (found) return found; }
    return '';
  };
  return find(value);
}

function createImageUploader() {
  const states = new WeakMap();
  return async function upload(contents, file, guard) {
    if (!guard()) return { ok: false, uncertain: false, error: '发送许可已撤销' };
    let state = states.get(contents);
    if (!state) {
      if (contents.debugger.isAttached()) return { ok: false, uncertain: false, error: '请关闭该聊天页开发者工具后再发送图片' };
      contents.debugger.attach('1.3'); state = { pending: null }; states.set(contents, state);
      contents.debugger.on('message', async (_event, method, params) => {
        const pending = state.pending; if (!pending) return;
        if (method === 'Network.responseReceived') {
          try {
            const url = new URL(params.response.url);
            if (url.protocol === 'https:' && /(^|\.)(taobao|goofish|alicdn)\.com$/.test(url.hostname)
                && /upload/i.test(url.pathname)) pending.responses.add(params.requestId);
          } catch (_) {}
        }
        if (method === 'Network.loadingFinished' && pending.responses.has(params.requestId)) {
          try {
            const result = await contents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
            const url = uploadedImage(result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body);
            if (url) pending.finish({ ok: true, imageUrl: url });
          } catch (_) {}
        }
      });
      contents.debugger.on('detach', () => { state.pending?.finish({ ok: false, uncertain: true, error: '图片上传监听中断，请核对聊天记录' }); states.delete(contents); });
      state.ready = contents.debugger.sendCommand('Network.enable');
    }
    await state.ready;
    if (state.pending) return { ok: false, uncertain: false, error: '上一张图片仍在上传' };
    const { root } = await contents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await contents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId,
      selector: 'input[type="file"][accept*="image"],input[type="file"][data-chat-image]' });
    if (!nodeId) return { ok: false, uncertain: false, error: '未找到官方聊天图片上传入口，请打开聊天后重试' };
    if (!guard()) return { ok: false, uncertain: false, error: '店铺或发送许可已变化' };
    return new Promise((resolve) => {
      const timer = setTimeout(() => state.pending?.finish({ ok: false, uncertain: true, error: '未能确认图片上传地址，请核对聊天后处理' }), 20000);
      const pending = { responses: new Set(), finish(result) {
        if (state.pending !== pending) return; clearTimeout(timer); state.pending = null; resolve(result);
      } };
      state.pending = pending;
      contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [file] }).catch((error) =>
        pending.finish({ ok: false, uncertain: true, error: '图片上传未确认：' + error.message }));
    });
  };
}

module.exports = { createImageUploader, uploadedImage };

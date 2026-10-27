'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
function createRemoteActions({ store, drafts, products, send, history, directory }) {
  const uploads = new Map();
  const safeDraft = (row) => { const { preparation, ...result } = row; return result; };
  return async function dispatch(action, input, context) {
    if (action === 'accounts') return { ok: true, accounts: store.listAccounts().filter((row) => context.accountIds.includes(row.id)).map((row) => ({ id: row.id, label: row.label })) };
    const accountId = context.requireAccount(input.account_id);
    if (action === 'sessions') return { ok: true, sessions: store.ready().sessions.filter((row) => row.account_id === accountId).map((row) => ({ id: row.id, nickname: row.peer_nick || row.id, last_msg: row.last_text || '', last_ts: row.last_ts, assignee_id: row.assignee_id })) };
    if (action === 'messages') {
      if (!store.findSession(accountId, String(input.session_id))) throw new Error('该店铺中不存在此会话');
      const cached = store.listMessages(accountId, String(input.session_id), 100).map((row) => ({ id: row.id, text: row.text || '', direction: row.direction, ts: row.ts, type: row.type }));
      const live = history ? await history(accountId, String(input.session_id)) : [];
      context.requireAccount(accountId);
      const messages = new Map(cached.map((row) => [row.id, row])); for (const row of live) messages.set(row.id, row);
      return { ok: true, messages: [...messages.values()].sort((a, b) => a.ts - b.ts).slice(-100) };
    }
    if (action === 'products') return { ok: true, products: store.listProducts(accountId), drafts: drafts.list(accountId).slice(0, 100).map(safeDraft) };
    if (action === 'orders') return { ok: true, orders: store.listOrders(accountId).slice(-500) };
    context.requireWrite();
    if (action === 'send') {
      const sessionId = String(input.session_id || ''), content = String(input.content || '').trim();
      if (!store.findSession(accountId, sessionId) || !content || content.length > 2000) throw new Error('会话或回复内容无效');
      store.markHumamActivity(accountId, sessionId, Date.now());
      return send(accountId, sessionId, { kind: 'manual', content }, () => context.guard(accountId));
    }
    if (action === 'sync') return products.sync(accountId, { background: true });
    if (action === 'edit-item') { const result = await products.readItem(accountId, String(input.item_id)); if (result.draft) result.draft = safeDraft(result.draft); return result; }
    if (action === 'upload') {
      const buffer = typeof input.base64 === 'string' && Buffer.from(input.base64, 'base64');
      if (!buffer || !buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error('图片需小于5MB');
      const temporary = path.join(directory, 'remote-image-' + crypto.randomUUID());
      try {
        fs.writeFileSync(temporary, buffer, { flag: 'wx' });
        const images = drafts.importFiles([temporary]);
        for (const image of images) uploads.set(image.assetId, { userId: context.user.id, accountId, expires: Date.now() + 3600000 });
        for (const [id, row] of uploads) if (row.expires < Date.now()) uploads.delete(id);
        return { ok: true, images };
      } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
    }
    const id = input.id || input.draft?.id;
    const existing = id ? drafts.get(id) : null;
    if (existing && existing.account_id !== accountId) throw new Error('草稿不属于该店铺');
    if (action === 'save-draft') {
      const value = input.draft || {};
      const known = new Set(drafts.list(accountId).flatMap((row) => row.images.map((image) => image.assetId).filter(Boolean)));
      for (const image of value.images || []) if (image.assetId && !known.has(image.assetId)) {
        const uploaded = uploads.get(image.assetId);
        if (!uploaded || uploaded.userId !== context.user.id || uploaded.accountId !== accountId || uploaded.expires < Date.now()) throw new Error('图片不属于当前店铺或上传已过期');
      }
      return { ok: true, draft: safeDraft(drafts.save({ ...value, account_id: accountId })) };
    }
    if (!existing) throw new Error('请选择该店铺草稿');
    if (action === 'remove-draft') return { ok: drafts.remove(id) };
    if (!context.guard(accountId)) throw new Error('当前账号授权已失效');
    let result;
    if (action === 'prepare') result = await products.prepare(id, { background: true });
    else if (action === 'verify') result = await products.verify(id);
    else if (action === 'options') result = await products.options(id);
    else if (action === 'submit') { if (input.confirm !== true) throw new Error('请先确认发布'); result = await products.submit(id, { guard: () => context.guard(accountId) }); }
    else throw new Error('不支持的远程操作');
    if (result.draft) result.draft = safeDraft(result.draft); return result;
  };
}
module.exports = { createRemoteActions };

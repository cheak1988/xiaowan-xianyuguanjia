'use strict';
// Read only the props backing rendered conversations/messages, without SDK calls.
function readRenderedIM() {
  function props(node, test) {
    let fiber = node?.[Object.keys(node).find((key) => key.startsWith('__reactFiber$'))];
    for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) if (test(fiber.memoizedProps || {})) return fiber.memoizedProps;
    return null;
  }
  const conversations = [], activeIds = new Set();
  for (const node of document.querySelectorAll('[class*="conversation-item--"]')) {
    const value = props(node, (value) => value.sessionInfo?.sessionId);
    if (!value) continue;
    const info = value.sessionInfo, id = String(info.sessionId);
    if (value.activeCid) activeIds.add(String(value.activeCid));
    node.setAttribute('data-xy-session-id', id);
    const summary = info.summary || {};
    const badge = node.querySelector('[class*="unread"], [class*="badge"], [class*="red-point"]');
    const unreadValue = info.unreadCount ?? info.unreadNum ?? info.unread ?? value.unreadCount;
    const badgeText = badge?.textContent.trim() || '';
    const unread = unreadValue == null
      ? (badge ? Number.parseInt(badgeText, 10) || (badge.getClientRects().length ? 1 : 0) : 0)
      : unreadValue === true ? 1 : Number.parseInt(unreadValue, 10) || 0;
    const direction = typeof summary.isMyMsg === 'boolean' ? (summary.isMyMsg ? 'out' : 'in')
      : ['in', 'out'].includes(summary.direction) ? summary.direction : '';
    conversations.push({ id, nickname: node.querySelector('[class*="title--"]')?.textContent.trim() || '',
      last_text: String(summary.summaryContent || '').slice(0, 500), last_ts: Number(summary.timeStamp) || 0,
      item_id: String(info.itemInfo?.itemId || ''), unread: Math.max(0, unread), last_direction: direction,
      last_message_id: String(summary.messageId || summary.msgId || ''), system: summary.type === 'system' });
  }
  const chat = document.querySelector('[class*="chat-main--"]');
  const value = props(chat, (value) => typeof value.store?.activeCid === 'string');
  const active = value?.store.activeCid || (activeIds.size === 1 ? [...activeIds][0] : '');
  if (chat) chat.setAttribute('data-xy-session-id', active);
  for (const node of document.querySelectorAll('[class*="message-row--"]')) {
    const value = props(node, (value) => value.message?.messageId && typeof value.isMyMsg === 'boolean');
    if (!value) continue;
    const message = value.message;
    node.setAttribute('data-message-id', String(message.messageId));
    node.setAttribute('data-xy-direction', value.isMyMsg ? 'out' : 'in');
    node.setAttribute('data-xy-text', String(message.content?.text?.text || ''));
    node.setAttribute('data-xy-image', String(message.content?.image?.pics?.[0]?.url || ''));
    const ts = Number(message.createAt || message.timestamp); if (ts) node.setAttribute('data-ts', String(ts));
  }
  return { conversations, active };
}
module.exports = readRenderedIM;

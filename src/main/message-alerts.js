'use strict';

const DEFAULTS = { enabled: true, soundEnabled: true, desktopEnabled: true, volume: 60 };
const textOf = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const timestamp = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : 0;
};

function normalizeConfig(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const volume = Number(value.volume ?? DEFAULTS.volume);
  return {
    enabled: value.enabled !== false,
    soundEnabled: value.soundEnabled !== false,
    desktopEnabled: value.desktopEnabled !== false,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : DEFAULTS.volume,
  };
}

/** Alerts only; conversation previews must never enter the reply/delivery pipeline. */
function createMessageAlerts({ getSettings, playSound, showNotification, flash, now = Date.now, onError = () => {} }) {
  const snapshots = new Map(), seen = new Map(), lastAlert = new Map(), outgoing = new Map();
  let lastSound = -Infinity;
  const trim = (map, limit = 2000) => { while (map.size > limit) map.delete(map.keys().next().value); };
  const keyOf = (accountId, sessionId) => `${Number(accountId)}:${sessionId}`;
  const signature = (ts, text) => `${timestamp(ts)}:${textOf(text)}`;

  function remember(accountId, sessionId, messageId, ts, text) {
    const base = keyOf(accountId, sessionId);
    const keys = [`${base}:summary:${signature(ts, text)}`];
    if (messageId) keys.push(`${base}:message:${messageId}`);
    const duplicate = keys.some((key) => seen.has(key));
    for (const key of keys) seen.set(key, now());
    trim(seen);
    return duplicate;
  }

  function alert(account, sessionId, peerNick, text, ts, messageId) {
    if (!account || account.disabled || !sessionId || String(sessionId).length > 200) return false;
    const time = now(), sentAt = timestamp(ts);
    // Old pages/history and malformed future timestamps cannot ring on startup/reconnect.
    if (!sentAt || sentAt < time - 120000 || sentAt > time + 30000) return false;
    if (remember(account.id, sessionId, messageId, sentAt, text)) return false;
    const cfg = normalizeConfig(getSettings().messageAlerts);
    if (!cfg.enabled) return false;
    const key = keyOf(account.id, sessionId);
    if (time - (lastAlert.get(key) ?? -Infinity) < 3000) return false;
    lastAlert.set(key, time); trim(lastAlert, 1000);
    const detail = {
      accountId: Number(account.id), sessionId: String(sessionId),
      accountLabel: textOf(account.label).slice(0, 80) || '店铺',
      peerNick: textOf(peerNick).slice(0, 80) || '买家',
      text: textOf(text).slice(0, 120) || '收到一条新消息', volume: cfg.volume,
    };
    for (const action of [
      () => flash(detail),
      () => { if (cfg.desktopEnabled) showNotification(detail); },
      () => {
        if (cfg.soundEnabled && cfg.volume > 0 && time - lastSound >= 800) {
          lastSound = time; playSound(detail);
        }
      },
    ]) { try { action(); } catch (error) { onError(error); } }
    return true;
  }

  function message(account, session, value) {
    const sessionId = String(session?.id || value?.sessionId || '');
    if (!account || account.disabled || !value || !sessionId) return false;
    const text = typeof value.content === 'string' ? value.content
      : value.content?.text || (value.content?.imgUrl ? '[图片]' : value.content?.audioUrl ? '[语音]' : '收到一条新消息');
    if (value.direction === 'out') {
      outgoing.set(keyOf(account.id, sessionId), { text: textOf(text), ts: timestamp(value.ts), observed: now() });
      trim(outgoing, 1000); return false;
    }
    if (value.direction !== 'in' || value.history || value.source === 'system') return false;
    return alert(account, sessionId, session?.withWhoNick || value.user?.nick, text, value.ts, value.messageId);
  }

  function conversations(account, rows) {
    if (!account || account.disabled || !Array.isArray(rows) || !rows.length) return;
    let state = snapshots.get(Number(account.id));
    const first = !state;
    if (!state) { state = new Map(); snapshots.set(Number(account.id), state); }
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const id = String(row.id || '');
      if (!id || id.startsWith('nick:') || id.length > 200) continue;
      const previous = state.get(id), ts = timestamp(row.last_ts), text = textOf(row.last_text);
      const unread = Math.max(0, Number(row.unread) || 0);
      state.set(id, { ts, unread, messageId: row.last_message_id });
      if (first) { remember(account.id, id, row.last_message_id, ts, text); continue; }
      const changed = !previous || ts > previous.ts || (ts === previous.ts && unread > previous.unread
        && row.last_message_id && previous.messageId && row.last_message_id !== previous.messageId);
      if (!changed || unread <= 0 || row.last_direction === 'out' || row.system) continue;
      const sent = outgoing.get(keyOf(account.id, id));
      if (sent && now() - sent.observed < 10000 && sent.text === text && Math.abs(ts - sent.ts) < 5000) continue;
      alert(account, id, row.nickname, text, ts, row.last_message_id);
    }
    trim(state, 5000);
  }

  return { message, conversations, resetAccount: (id) => snapshots.delete(Number(id)) };
}

module.exports = { createMessageAlerts, normalizeConfig, DEFAULTS };

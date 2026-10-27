'use strict';

/**
 * 超时提醒
 *
 * 原厂把「超时提醒」当高级版付费功能，实现其实很简单：
 * 定时扫会话，发现「买家最后一句没被回复」且超过阈值 → 桌面通知。
 *
 * 纯本地计算，不碰任何平台接口，零风险。
 *
 * 判定逻辑：
 *   1. 会话最后一条消息必须是买家发的（direction = 'in'）
 *   2. 距离那条消息的时间 > timeoutMinutes
 *   3. 会话不在「已分配给别人」的静默名单里（可选）
 *   4. 同一会话同一轮只提醒一次（避免每分钟都弹）
 */

const store = require('./store');
const msgStore = require('./message-store');

const SCAN_INTERVAL_MS = 60_000;

let timer = null;
let notifier = null;      // (title, body, meta) => void
/** `${accountId}:${sessionId}:${lastTs}` → 已提醒 */
const notified = new Set();

function pendingSessions({ accountId, timeoutMinutes }) {
  const s = store.ready();
  const now = Date.now();
  const threshold = Math.max(1, Number(timeoutMinutes) || 5) * 60_000;

  const result = [];
  for (const sess of s.sessions) {
    if (accountId && sess.account_id !== Number(accountId)) continue;
    if (!sess.last_ts) continue;
    if (now - sess.last_ts < threshold) continue;

    // 找该会话最后一条消息（从分片存储读），判断是不是买家发的
    const msgs = msgStore.query(sess.account_id, sess.id, 1);
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];

    if (last.direction !== 'in') continue;         // 最后是我们回的 → 不需要提醒
    if (last.source === 'ai') continue;            // AI 已回 → 不需要

    result.push({
      accountId: sess.account_id,
      sessionId: sess.id,
      peerNick: sess.peer_nick || sess.id,
      lastTs: last.ts,
      lastText: last.text || '',
      waitingMinutes: Math.floor((now - last.ts) / 60_000),
      assigneeId: sess.assignee_id || null,
    });
  }

  return result.sort((a, b) => a.lastTs - b.lastTs);
}

function scan() {
  const settings = store.getSettings();
  const cfg = settings.reminder || {};
  if (cfg.enabled === false) return [];

  const list = pendingSessions({
    accountId: null,
    timeoutMinutes: Number(cfg.timeoutMinutes) || 5,
  });

  const fresh = [];
  for (const item of list) {
    const key = `${item.accountId}:${item.sessionId}:${item.lastTs}`;
    if (notified.has(key)) continue;
    notified.add(key);
    fresh.push(item);
  }

  // 防止 Set 无限增长
  if (notified.size > 2000) {
    const arr = [...notified];
    notified.clear();
    for (const k of arr.slice(-500)) notified.add(k);
  }

  if (notifier && fresh.length) {
    for (const item of fresh) {
      notifier(
        '会话超时未回复',
        `${item.peerNick}：${item.lastText.slice(0, 40)}（已等待 ${item.waitingMinutes} 分钟）`,
        item,
      );
    }
  }

  return fresh;
}

function start({ notify }) {
  stop();
  notifier = notify;
  timer = setInterval(scan, SCAN_INTERVAL_MS);
  scan(); // 启动时先跑一次
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function reset() {
  notified.clear();
}

module.exports = { pendingSessions, scan, start, stop, reset };

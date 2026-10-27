'use strict';

/**
 * 消息分片存储
 *
 * 为什么分片：
 *   单个 state.json 存所有消息，15 个店铺同时收消息时会排队写同一个文件。
 *   实测 10 万条时单次落盘要 90ms，会明显卡顿。
 *
 * 分片规则：
 *   data/messages/<accountId>/<YYYY-MM>.json
 *
 *   每个店铺每个月一个文件。写入只碰「当月」那一个小文件（约 1-2MB），
 *   历史月份文件只读，永远不会再变大。
 *
 * 性能（实测）：
 *   单文件 5000 条 → 落盘 10-20ms，与总量无关。
 *
 * 兼容：
 *   旧版本的消息存在 state.json 的 messages 数组里，
 *   启动时会自动迁移到分片目录，然后清空该数组。
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./atomic-json');

const MAX_FILE_MESSAGES = 8000; // 单月超过这个数，多开一个分片文件

let rootDir = null;              // <userData>/messages
const cache = new Map();         // 文件路径 -> { list, dirty, timer }
let indexCache = null;           // accountId -> Set<"YYYY-MM">

function init(userDataPath) {
  for (const entry of cache.values()) if (entry.timer) clearTimeout(entry.timer);
  cache.clear();
  rootDir = path.join(userDataPath, 'messages');
  try { fs.mkdirSync(rootDir, { recursive: true }); } catch (_) {}
  return rootDir;
}

function accountDir(accountId) {
  const d = path.join(rootDir, String(accountId));
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

function monthKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}`;
}

/** 列出某账号所有分片文件（按时间倒序） */
function listShards(accountId) {
  const dir = accountDir(accountId);
  const files = new Set();
  for (const name of fs.readdirSync(dir)) {
    const normalized = name.replace(/\.bak$/, '');
    if (/^\d{4}-\d{2}(?:-\d+)?\.json$/.test(normalized)) files.add(normalized);
  }
  for (const filePath of cache.keys()) {
    if (path.dirname(filePath) === dir) files.add(path.basename(filePath));
  }
  return [...files].map((f) => {
    const base = f.replace(/\.json$/, '');
    // 文件名可能是 2026-10.json 或 2026-10-2.json（超量分片）
    const m = base.match(/^(\d{4}-\d{2})(?:-(\d+))?$/);
    return {
      name: f,
      path: path.join(dir, f),
      month: m ? m[1] : base,
      part: m && m[2] ? Number(m[2]) : 0,
    };
  }).sort((a, b) => b.month.localeCompare(a.month) || b.part - a.part);
}

function readShard(filePath) {
  if (cache.has(filePath)) return cache.get(filePath);
  const data = readJson(filePath, () => [], (value) => Array.isArray(value)
    || (value && Array.isArray(value.messages)));
  const list = Array.isArray(data) ? data : data.messages;
  const entry = { list, dirty: false, timer: null };
  cache.set(filePath, entry);
  return entry;
}

function scheduleSave(filePath) {
  const entry = cache.get(filePath);
  if (!entry || entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    try { flushFile(filePath); } catch (error) { console.error('[messages] 写盘失败', error.message); }
  }, 400);
}

function flushFile(filePath) {
  const entry = cache.get(filePath);
  if (!entry || !entry.dirty) return;
  writeJson(filePath, entry.list);
  entry.dirty = false;
}

function flushAll() {
  for (const filePath of cache.keys()) flushFile(filePath);
}

/**
 * 追加一条消息
 * @param {number} accountId
 * @param {object} record { session_id, message_id, ts, direction, text, ... }
 */
function append(accountId, record) {
  if (!rootDir) return;
  const month = monthKey(record.ts);

  // 找当月分片（可能因为超过上限而分成 -1、-2）
  const dir = accountDir(accountId);
  let base = path.join(dir, `${month}.json`);
  let filePath = base;
  let n = 1;
  // 跨分片去重，同时包含尚未落盘的缓存。
  for (const shard of listShards(accountId).filter((item) => item.month === month)) {
    if (readShard(shard.path).list.some((message) => message.message_id === record.message_id
        && String(message.session_id) === String(record.session_id))) return false;
  }
  while (fs.existsSync(filePath) || fs.existsSync(filePath + '.bak') || cache.has(filePath)) {
    const entry = readShard(filePath);
    if (entry.list.length < MAX_FILE_MESSAGES) break;
    filePath = path.join(dir, `${month}-${n}.json`);
    n += 1;
  }

  const entry = readShard(filePath);
  // 去重
  const dup = entry.list.some((m) => m.message_id === record.message_id
    && String(m.session_id) === String(record.session_id));
  if (dup) return false;
  entry.list.push(record);
  entry.dirty = true;
  scheduleSave(filePath);
  indexCache = null;
  return true;
}

/**
 * 查询消息（跨分片，按时间正序）
 * @returns {Array}
 */
function query(accountId, sessionId, limit = 100) {
  if (!rootDir) return [];
  const shards = listShards(accountId);
  const out = [];

  for (const shard of shards) {
    const entry = readShard(shard.path);
    for (let i = entry.list.length - 1; i >= 0; i--) {
      const m = entry.list[i];
      if (sessionId && String(m.session_id) !== String(sessionId)) continue;
      out.push(m);
      if (out.length >= limit) {
        return out.reverse();
      }
    }
  }
  return out.reverse();
}

/** 统计某账号消息总数（按分片累加） */
function count(accountId) {
  let total = 0;
  for (const shard of listShards(accountId)) total += readShard(shard.path).list.length;
  return total;
}

/** 删除某账号全部分片 */
function removeAccount(accountId) {
  const dir = path.join(rootDir, String(accountId));
  for (const [filePath, entry] of cache) {
    if (path.dirname(filePath) !== dir) continue;
    if (entry.timer) clearTimeout(entry.timer);
    cache.delete(filePath);
  }
  try {
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
    fs.rmdirSync(dir);
  } catch (_) {}
  indexCache = null;
}

/**
 * 从旧版 state.json 迁移
 * @param {Array} messages 旧格式的 messages 数组
 * @param {Array} sessions 用于回填 session 的账号信息
 * @returns {{migrated:number, skipped:number}}
 */
function migrateFromLegacy(messages, sessions) {
  if (!rootDir || !Array.isArray(messages) || !messages.length) {
    return { migrated: 0, skipped: 0 };
  }

  // 旧消息里有 account_id 字段
  const byAccountMonth = new Map();
  let skipped = 0;

  for (const m of messages) {
    if (!m || m.account_id == null || !m.message_id) { skipped++; continue; }
    const key = `${m.account_id}|${monthKey(m.ts)}`;
    if (!byAccountMonth.has(key)) byAccountMonth.set(key, []);
    byAccountMonth.get(key).push({
      session_id: String(m.session_id || ''),
      message_id: String(m.message_id),
      ts: Number(m.ts) || Date.now(),
      direction: m.direction || 'in',
      source: m.source || null,
      msg_type: Number(m.msg_type) || 1,
      sender_id: m.sender_id || null,
      sender_nick: m.sender_nick || null,
      text: m.text || null,
    });
  }

  let migrated = 0;
  for (const [key, list] of byAccountMonth.entries()) {
    const [accountId, month] = key.split('|');
    const dir = accountDir(accountId);
    const filePath = path.join(dir, `${month}.json`);
    const entry = readShard(filePath);
    const existing = new Set(entry.list.map((x) => x.message_id));
    for (const m of list) {
      if (existing.has(m.message_id)) continue;
      entry.list.push(m);
      existing.add(m.message_id);
      migrated++;
    }
    entry.dirty = true;
    flushFile(filePath);
  }

  return { migrated, skipped };
}

/** 供 UI 展示分片概况 */
function stats(accountId) {
  const shards = listShards(accountId);
  return shards.map((s) => {
    let size = 0;
    try { size = fs.statSync(s.path).size; } catch (_) {}
    return {
      month: s.month,
      file: s.name,
      messages: readShard(s.path).list.length,
      sizeKB: Math.round(size / 1024),
    };
  });
}

module.exports = {
  init, append, query, count, removeAccount,
  migrateFromLegacy, flushAll, stats, listShards, monthKey,
};

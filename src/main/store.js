'use strict';

/**
 * 本地存储层
 *
 * 原型阶段用 JSON 文件，零原生依赖，任何 Electron 版本都能跑。
 * 生产环境建议换 better-sqlite3（需 VS 编译）或 sql.js（WASM）。
 *
 * 数据模型对照逆向结果（_re/out/逆向分析报告.md 3.6 节）：
 *   account / session / message / rule / buyer_tag
 * 新增：settings（自动回复与 AI 配置）、ai_log（回复流水）
 */

const fs = require('fs');
const path = require('path');
const msgStore = require('./message-store');
const { readJson, writeJson } = require('./atomic-json');

const STATE_FILE = 'state.json';

const EMPTY = {
  accounts: [],
  sessions: [],
  messages: [],
  rules: [],
  tags: [],
  aiLog: [],
  cards: [],          // 卡密池：虚拟商品自动发货
  quickProducts: [],  // 常用商品（快捷发送）
  products: [],       // 商品库（多店铺商品管理）
  productDrafts: [],  // 商品编辑草稿与提交结果，独立于同步的商品列表
  remoteUsers: [],
  relistRules: [],
  relistLog: [],
  orders: [],         // 订单库
  shopGroups: [],     // 店铺分组
  customers: [],      // 客户库（买家档案）
  quickReplies: [],   // 快捷回复话术（独立于 rules）
  deliverRules: [],   // 自动发货配置
  deliverLog: [],     // 发货记录
  deliveries: [],     // 永久订单投递状态，不随展示日志轮换
  notifyLog: [],      // 通知发送记录
  staff: [],          // 多客服成员
  meta: {},
  settings: null,
};

const DEFAULT_SETTINGS = {
  autoReply: { enabled: true },
  reminder: {
    enabled: true,
    timeoutMinutes: 5,     // 买家最后一句超过多少分钟没回就提醒
  },
  notify: {
    // 每个渠道：{ enabled, events: [], ...渠道字段 }
    bark:     { enabled: false, key: '', server: 'https://api.day.app' },
    dingtalk: { enabled: false, webhook: '', secret: '' },
    feishu:   { enabled: false, webhook: '' },
    wecom:    { enabled: false, webhook: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    mail:     { enabled: false, host: '', port: 465, user: '', pass: '', to: '' },
    webhook:  { enabled: false, url: '', method: 'POST' },
  },
  /** 自动任务开关（高风险功能默认关） */
  tasks: {
    polish: { enabled: false, hour: 9, minute: 0, riskAccepted: false },
    rate:   { enabled: false, delayMinutes: 10, riskAccepted: false },
    catchupScan: { enabled: false, intervalMinutes: 30, riskAccepted: true },
    tokenRenew: { enabled: true, checkMinutes: 30 },
  },
  productAI: {
    baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyEnc: '', systemPrompt: '',
  },
  /** 法律声明：首次启动必须阅读并确认，之后可在设置里回看 */
  legal: { disclaimerAccepted: false, acceptedAt: 0, acceptedVersion: '' },
  ai: {
    enabled: false,
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnc: '',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 300,
    mode: 'fallback',        // fallback = 规则优先，AI 兜底；always = AI 优先
    systemPrompt:
      '你是一名闲鱼店铺的客服。请用简短、口语化、礼貌的中文回答买家问题，' +
      '控制在 80 字以内。不要编造商品参数、价格、库存和物流时效；' +
      '不确定的信息就回复“这个我确认一下，稍后回复您~”。不要使用 Markdown。',
    contextMessages: 10,
    quietMinutes: 10,        // 人工回复后静默多久不再自动回
    maxReplyChars: 300,
    // 议价控制
    bargain: {
      enabled: false,
      mode: 'full',              // full=全场景，bargain=仅砍价
      maxRounds: 3,              // 最多让价几轮
      maxDiscountPercent: 10,    // 最多让多少 %
      roundStepPercent: 3,       // 每轮让多少 %
      minPrice: 0,               // 底线价
    },
  },
};

let file = null;
let state = null;
let saveTimer = null;

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function init(userDataPath) {
  file = path.join(userDataPath, STATE_FILE);
  state = readJson(file, () => clone(EMPTY), (value) => value && !Array.isArray(value)
    && typeof value === 'object' && Array.isArray(value.accounts)
    && Object.keys(EMPTY).every((key) => !Array.isArray(EMPTY[key])
      || value[key] == null || Array.isArray(value[key])));
  for (const k of Object.keys(EMPTY)) {
    if (state[k] === undefined || state[k] === null) state[k] = clone(EMPTY[k]);
  }

  // 初始化消息分片存储
  msgStore.init(userDataPath);

  // 迁移旧版 state.json 里的消息（迁移后清空，避免重复占空间）
  if (Array.isArray(state.messages) && state.messages.length) {
    const r = msgStore.migrateFromLegacy(state.messages, state.sessions);
    if (r.migrated > 0) {
      console.log(`[store] 已迁移 ${r.migrated} 条消息到分片存储`);
      state.messages = [];
      try {
        writeJson(file, state);
      } catch (e) {
        console.error('[store] 迁移后保存失败', e.message);
      }
    }
  }
  if (!state.settings) state.settings = clone(DEFAULT_SETTINGS);
  state.settings = mergeSettings(clone(DEFAULT_SETTINGS), state.settings);
  // 迁移：补齐新增的配置项
  for (const section of Object.keys(DEFAULT_SETTINGS)) {
    if (!state.settings[section] || typeof state.settings[section] !== 'object') {
      state.settings[section] = clone(DEFAULT_SETTINGS[section]);
      continue;
    }
    for (const key of Object.keys(DEFAULT_SETTINGS[section])) {
      if (state.settings[section][key] === undefined) {
        state.settings[section][key] = clone(DEFAULT_SETTINGS[section][key]);
      }
    }
  }
  // 对曾经删除的账号也不复用 ID，避免复用其持久化 cookie 分区。
  let maximumId = Number(state.meta.account_seq) || 0;
  for (const value of Object.values(state)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) maximumId = Math.max(maximumId,
      Number(row.account_id || row.accountId || 0) || 0);
  }
  for (const account of state.accounts) maximumId = Math.max(maximumId, Number(account.id) || 0);
  try {
    for (const name of fs.readdirSync(path.join(userDataPath, 'Partitions'))) {
      const match = /^xy-(\d+)$/i.exec(name);
      if (match) maximumId = Math.max(maximumId, Number(match[1]));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  state.meta.account_seq = maximumId;
  // 迁移旧成功流水和已用卡密；幂等状态永久保留。
  for (const log of state.deliverLog.filter((entry) => entry.ok)) {
    if (!state.deliveries.some((entry) => entry.account_id === log.account_id && entry.order_no === log.order_no)) {
      state.deliveries.push({ account_id: log.account_id, order_no: log.order_no, status: 'uncertain',
        reason: '旧版成功记录缺少发送确认，请人工核对', updated_at: log.ts });
    }
  }
  for (const card of state.cards) {
    if (card.status === 'used' && card.used_order_no) {
      const orderNo = String(card.used_order_no).replace(/-resend$/, '');
      if (!state.deliveries.some((entry) => entry.account_id === card.account_id && entry.order_no === orderNo)) {
        state.deliveries.push({ account_id: card.account_id, order_no: orderNo,
          status: 'uncertain', reason: '旧版已用卡密缺少发送确认，请人工核对', card_id: card.id, updated_at: card.used_at });
      }
    }
  }
  for (const entry of state.deliveries) {
    if (entry.status === 'reserved' || entry.status === 'sending') {
      entry.status = 'uncertain';
      entry.reason = '上次运行中断，请人工核对，暂停自动重发';
    }
  }
  persist();
  return state;
}

function ready() {
  if (!state) throw new Error('store 尚未初始化');
  return state;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { persist(); } catch (e) { console.error('[store] save failed', e); }
  }, 400);
}

/* ------------------------------ 多客服 ------------------------------ */

/**
 * 多客服模型（本机多人协作，不是云端 SaaS）
 *
 * 每个 staff 对应一个本机操作员：
 *   { id, name, color, active, created_at }
 *
 * 会话分配：
 *   session.assignee_id  → 当前负责该会话的客服
 *
 * 协作方式：
 *   - 每个客服有独立的「我的会话」列表
 *   - 会话被某人接手后，其他人看到的自动回复会被抑制（避免重复回复）
 *   - 可通过 assignee 字段做简单的负载分配
 */

function listStaff() {
  return ready().staff || [];
}

function addStaff(name) {
  const s = ready();
  if (!s.staff) s.staff = [];
  // 暖色系调色板，与黄色主题统一
  const palette = ['#f59e0b', '#ea7317', '#16a34a', '#dc2626', '#d97706', '#b45309'];
  const staff = {
    id: s.staff.reduce((m, x) => Math.max(m, x.id), 0) + 1,
    name: String(name || '').trim() || `客服${s.staff.length + 1}`,
    color: palette[s.staff.length % palette.length],
    active: true,
    created_at: Date.now(),
  };
  s.staff.push(staff);
  scheduleSave();
  return staff;
}

function updateStaff(id, patch) {
  const s = ready();
  const st = (s.staff || []).find((x) => x.id === Number(id));
  if (!st) return null;
  for (const k of ['name', 'color', 'active']) {
    if (patch[k] !== undefined) st[k] = patch[k];
  }
  scheduleSave();
  return st;
}

function removeStaff(id) {
  const s = ready();
  s.staff = (s.staff || []).filter((x) => x.id !== Number(id));
  // 解绑其名下会话
  for (const sess of s.sessions) {
    if (sess.assignee_id === Number(id)) sess.assignee_id = null;
  }
  scheduleSave();
}

/** 把会话分配给某个客服（assigneeId 为 null 表示释放） */
function assignSession(accountId, sessionId, assigneeId) {
  const sess = ensureSession(accountId, sessionId);
  if (!sess) return null;
  sess.assignee_id = assigneeId == null ? null : Number(assigneeId);
  sess.assigned_at = Date.now();
  scheduleSave();
  return sess;
}

/** 该会话当前是否被「别人」接手（用于抑制自动回复） */
function isSessionOwnedByOther(accountId, sessionId, meId) {
  if (!meId) return false;
  const sess = findSession(accountId, sessionId);
  if (!sess || !sess.assignee_id) return false;
  return sess.assignee_id !== Number(meId);
}

/* ------------------------------ 当前操作员 ------------------------------ */

function getCurrentStaffId() {
  return ready().meta.current_staff_id || null;
}

function setCurrentStaffId(id) {
  ready().meta.current_staff_id = id == null ? null : Number(id);
  scheduleSave();
}

function persist() {
  if (file && state) writeJson(file, state);
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  msgStore.flushAll();
  persist();
}

/* ------------------------------ account ------------------------------ */

function listAccounts() { return ready().accounts; }

function getAccount(id) { return ready().accounts.find((a) => a.id === Number(id)); }

function addAccount(label) {
  const s = ready();
  const id = Math.max(Number(s.meta.account_seq) || 0,
    ...s.accounts.map((account) => Number(account.id) || 0)) + 1;
  s.meta.account_seq = id;
  const acc = {
    id, label,
    xy_user_id: null, seller_uid: null, user_type: 1,
    persona: '',                       // 该店铺的 AI 人设补充，空则用全局
    group_id: null,                    // 所属分组
    remark: '',                        // 备注
    disabled: false,                   // 是否停用
    created_at: Math.floor(Date.now() / 1000),
  };
  s.accounts.push(acc);
  scheduleSave();
  return acc;
}

function updateAccount(id, patch) {
  const acc = getAccount(id);
  if (!acc) return null;
  if (patch.disabled !== undefined && !!patch.disabled !== !!acc.disabled) {
    acc.automation_version = (acc.automation_version || 0) + 1;
  }
  for (const k of ['label', 'persona', 'xy_user_id', 'seller_uid', 'group_id', 'remark', 'disabled']) {
    if (patch[k] !== undefined) acc[k] = patch[k];
  }
  scheduleSave();
  return acc;
}

function removeAccount(id) {
  const s = ready();
  id = Number(id);
  try { msgStore.removeAccount(id); } catch (_) {}
  s.accounts = s.accounts.filter((a) => a.id !== id);
  for (const [key, value] of Object.entries(s)) {
    if (Array.isArray(value) && key !== 'accounts') {
      s[key] = value.filter((entry) => Number(entry.account_id ?? entry.accountId) !== id);
    }
  }
  if (s.meta.active_account === id) s.meta.active_account = null;
  scheduleSave();
}

function setActiveAccount(id) { ready().meta.active_account = Number(id); scheduleSave(); }
function getActiveAccount() { return ready().meta.active_account || null; }

/* ------------------------------ message ------------------------------ */

function extractText(message) {
  const c = message && message.content;
  if (!c) return null;
  if (typeof c === 'string') return c;
  if (c.text) return String(c.text);
  if (c.imgUrl) return '[图片]';
  if (c.audioUrl) return '[语音]';
  if (c.title) return String(c.title);
  return null;
}

function saveMessage(accountId, session, message) {
  const s = ready();
  accountId = Number(accountId);
  const ts = Number(message.ts) || Date.now();

  if (session && session.id) {
    const sid = String(session.id);
    let row = s.sessions.find((x) => x.account_id === accountId && x.id === sid);
    if (!row) {
      row = {
        id: sid, account_id: accountId,
        peer_user_id: null, peer_nick: null,
        item_id: null, order_id: null,
        last_ts: 0, last_text: null, unread: 0,
        last_human_ts: 0, last_ai_ts: 0,
      };
      s.sessions.push(row);
    }
    row.peer_user_id = session.peerUserId || row.peer_user_id;
    row.peer_nick = session.withWhoNick || row.peer_nick;
    row.item_id = session.itemId ? String(session.itemId) : row.item_id;
    row.order_id = session.orderId ? String(session.orderId) : row.order_id;
    if (ts >= (row.last_ts || 0)) { row.last_ts = ts; row.last_text = extractText(message); }
  }

  const messageId = message.messageId || `${ts}-${Math.random().toString(36).slice(2, 8)}`;

  // 消息落分片（按账号 + 月份），不再堆在 state.json 里
  const appended = msgStore.append(accountId, {
    session_id: String((session && session.id) || message.sessionId || ''),
    message_id: String(messageId),
    ts,
    direction: message.direction || 'in',
    source: message.source || null,        // human | ai | null
    msg_type: Number(message.type) || 1,
    sender_id: message.user ? String(message.user.id) : null,
    sender_nick: message.user ? (message.user.fishNick || message.user.nick) : null,
    text: extractText(message),
    raw_json: JSON.stringify(message),
  });
  scheduleSave();
  return appended;
}

function listMessages(accountId, sessionId, limit) {
  return msgStore.query(Number(accountId), String(sessionId), limit || 100);
}

/** 给 AI 用的上下文：最近 n 条，按时间正序 */
function listRecentMessages(accountId, sessionId, n) {
  return listMessages(accountId, sessionId, n || 10).map((m) => ({
    role: m.direction === 'out' ? 'assistant' : 'user',
    text: m.text || '',
    ts: m.ts,
  }));
}

/** 确保会话记录存在（分配 / 标记人工时可能早于第一条消息） */
function ensureSession(accountId, sessionId) {
  const s = ready();
  const sid = String(sessionId);
  let row = s.sessions.find((x) => x.account_id === Number(accountId) && x.id === sid);
  if (!row) {
    row = {
      id: sid, account_id: Number(accountId),
      peer_user_id: null, peer_nick: null,
      item_id: null, order_id: null,
      last_ts: 0, last_text: null, unread: 0,
      last_human_ts: 0, last_ai_ts: 0,
      assignee_id: null, assigned_at: null,
    };
    s.sessions.push(row);
    scheduleSave();
  }
  return row;
}

function findSession(accountId, sessionId) {
  return ready().sessions.find(
    (x) => x.account_id === Number(accountId) && x.id === String(sessionId),
  );
}

function markHumamActivity(accountId, sessionId, ts) {
  const row = ensureSession(accountId, sessionId);
  row.last_human_ts = ts || Date.now();
  row.human_version = (row.human_version || 0) + 1;
  scheduleSave();
}

function markAiActivity(accountId, sessionId, ts) {
  const row = ensureSession(accountId, sessionId);
  row.last_ai_ts = ts || Date.now();
  scheduleSave();
}

/* ------------------------------ rule ------------------------------ */

function listRules(accountId) {
  return ready().rules
    .filter((r) => r.account_id === Number(accountId))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.id - b.id);
}

function saveRule(rule) {
  const s = ready();
  const data = {
    account_id: Number(rule.accountId),
    name: rule.name || '',
    match_type: Number(rule.match_type) || 1,
    keywords: rule.keywords || [],
    content: rule.content || '',
    images: rule.images || [],
    exclude_items: (rule.exclude_items || []).map(String),
    status: rule.status === 0 ? 0 : 1,
    sort: Number(rule.sort) || 0,
  };
  if (rule.id) {
    const idx = s.rules.findIndex((r) => r.id === Number(rule.id));
    if (idx >= 0) { s.rules[idx] = { ...s.rules[idx], ...data }; scheduleSave(); return s.rules[idx].id; }
  }
  const id = s.rules.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  s.rules.push({ id, ...data, created_at: Math.floor(Date.now() / 1000) });
  scheduleSave();
  return id;
}

function removeRule(id) {
  const s = ready();
  s.rules = s.rules.filter((r) => r.id !== Number(id));
  scheduleSave();
}

/* ------------------------------ 快捷回复导入导出 ------------------------------ */

/**
 * CSV 列：分组,关键词,内容
 * 例如：物流,发货|几天到,亲24小时内发货哦~
 *
 * 关键词用 | 分隔（和规则内部结构一致）
 * 内容里的逗号和换行会被转义
 */
function exportRulesCsv(accountId) {
  const rows = listRules(accountId);
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = ['分组,关键词,内容'];
  for (const r of rows) {
    lines.push([
      esc(r.name || ''),
      esc((r.keywords || []).join('|')),
      esc(r.content || ''),
    ].join(','));
  }
  return lines.join('\r\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else { inQuotes = false; }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

function importRulesCsv(accountId, text) {
  const rows = parseCsv(String(text || ''));
  if (!rows.length) return { added: 0, skipped: 0 };

  // 首行是表头就跳过
  let start = 0;
  if (/分组|关键词|内容/.test(rows[0].join(''))) start = 1;

  const existing = new Set(
    listRules(accountId).map((r) => `${r.name}|${(r.keywords || []).join('|')}|${r.content}`),
  );

  let added = 0;
  let skipped = 0;
  for (let i = start; i < rows.length; i++) {
    const [name = '', keywords = '', content = ''] = rows[i];
    if (!content.trim()) { skipped++; continue; }
    const key = `${name.trim()}|${keywords}|${content}`;
    if (existing.has(key)) { skipped++; continue; }

    saveRule({
      accountId,
      name: name.trim() || '导入规则',
      match_type: 1,
      keywords: keywords.split('|').map((x) => x.trim()).filter(Boolean),
      content: content.trim(),
      status: 1,
    });
    existing.add(key);
    added++;
  }
  return { added, skipped };
}

/* ------------------------------ settings ------------------------------ */

function getSettings() { return ready().settings; }

function updateSettings(patch) {
  const s = ready().settings;
  if (patch.autoReply && patch.autoReply.enabled !== undefined
      && !!patch.autoReply.enabled !== !!s.autoReply.enabled) {
    ready().meta.automation_version = (ready().meta.automation_version || 0) + 1;
  }
  for (const section of Object.keys(patch || {})) {
    if (typeof patch[section] === 'object' && patch[section] !== null) {
      s[section] = mergeSettings(s[section], patch[section]);
    } else {
      s[section] = patch[section];
    }
  }
  scheduleSave();
  return s;
}

function mergeSettings(current, patch) {
  const result = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeSettings(result[key], value) : value;
  }
  return result;
}

function automationVersion(accountId, sessionId) {
  const account = getAccount(accountId);
  const session = findSession(accountId, sessionId);
  return JSON.stringify([ready().meta.automation_version || 0, account && account.automation_version || 0,
    session && session.human_version || 0, session && session.assignee_id || null, getCurrentStaffId()]);
}

/**
 * API Key 用 Electron safeStorage 加密后存盘（Windows 下走 DPAPI）。
 * safeStorage 不可用时降级为明文——并在 UI 上提示。
 */
let safeStorage = null;
function setSafeStorage(ss) { safeStorage = ss; }

function setAiKey(plain) {
  const s = ready().settings;
  if (!plain) { s.ai.apiKeyEnc = ''; scheduleSave(); return { ok: true, encrypted: false }; }
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    s.ai.apiKeyEnc = 'enc:' + safeStorage.encryptString(plain).toString('base64');
    scheduleSave();
    return { ok: true, encrypted: true };
  }
  s.ai.apiKeyEnc = 'plain:' + plain;
  scheduleSave();
  return { ok: true, encrypted: false };
}

function getAiKey() {
  const v = ready().settings.ai.apiKeyEnc;
  if (!v) return '';
  if (v.startsWith('enc:')) {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch (_) { return ''; }
  }
  return v.slice(6);
}

function setProductAiKey(plain) {
  if (!plain) { ready().settings.productAI.apiKeyEnc = ''; persist(); return; }
  if (!safeStorage?.isEncryptionAvailable()) throw new Error('系统密钥加密暂不可用，未保存 API Key，请稍后重试');
  ready().settings.productAI.apiKeyEnc = 'enc:' + safeStorage.encryptString(String(plain)).toString('base64');
  persist();
}
function getProductAiKey() {
  const value = ready().settings.productAI.apiKeyEnc || '';
  if (!value.startsWith('enc:') || !safeStorage?.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64')); } catch (_) { return ''; }
}

/* ------------------------------ ai log ------------------------------ */

function pushAiLog(entry) {
  const s = ready();
  s.aiLog.push({ ts: Date.now(), ...entry });
  if (s.aiLog.length > 500) s.aiLog = s.aiLog.slice(-500);
  scheduleSave();
}

function listAiLog(accountId, limit) {
  const s = ready();
  return s.aiLog
    .filter((x) => (accountId ? x.account_id === Number(accountId) : true))
    .slice(-(limit || 100))
    .reverse();
}

/* ------------------------------ 店铺分组 ------------------------------ */

function listShopGroups() {
  return (ready().shopGroups || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
}

function saveShopGroup(group) {
  const s = ready();
  if (!s.shopGroups) s.shopGroups = [];
  const name = String(group.name || '').trim();
  if (!name) return null;

  if (group.id) {
    const g = s.shopGroups.find((x) => x.id === Number(group.id));
    if (g) { g.name = name; scheduleSave(); return g; }
  }
  const id = s.shopGroups.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  const g = { id, name, sort: s.shopGroups.length, created_at: Date.now() };
  s.shopGroups.push(g);
  scheduleSave();
  return g;
}

function removeShopGroup(id) {
  const s = ready();
  s.shopGroups = (s.shopGroups || []).filter((g) => g.id !== Number(id));
  // 释放组内店铺
  for (const acc of s.accounts || []) {
    if (acc.group_id === Number(id)) acc.group_id = null;
  }
  scheduleSave();
}

/* ------------------------------ 客户 ------------------------------ */

/**
 * 客户档案
 * { id, account_id, buyer_uid, nick, avatar, remark, tags[], blacklisted,
 *   order_count, order_amount, last_active, created_at }
 */
function listCustomers(accountId, { search = '', tag = '', onlyBlack = false } = {}) {
  let list = (ready().customers || []).filter(
    (c) => !accountId || c.account_id === Number(accountId),
  );
  if (onlyBlack) list = list.filter((c) => c.blacklisted);
  if (tag) list = list.filter((c) => (c.tags || []).includes(tag));
  if (search) {
    const kw = String(search).toLowerCase();
    list = list.filter((c) =>
      String(c.nick || '').toLowerCase().includes(kw)
      || String(c.buyer_uid || '').includes(kw)
      || String(c.remark || '').toLowerCase().includes(kw));
  }
  return list.sort((a, b) => (b.last_active || 0) - (a.last_active || 0));
}

function upsertCustomer(accountId, buyer) {
  const s = ready();
  if (!s.customers) s.customers = [];
  const account_id = Number(accountId);
  const uid = String(buyer.buyer_uid || buyer.uid || '').trim();
  if (!uid) return null;

  let c = s.customers.find((x) => x.account_id === account_id && x.buyer_uid === uid);
  if (!c) {
    c = {
      id: s.customers.reduce((m, x) => Math.max(m, x.id), 0) + 1,
      account_id, buyer_uid: uid,
      nick: '', avatar: '', remark: '', tags: [],
      blacklisted: false, order_count: 0, order_amount: 0,
      first_seen: Date.now(), created_at: Date.now(),
    };
    s.customers.push(c);
  }
  if (buyer.nick != null) c.nick = buyer.nick;
  if (buyer.avatar != null) c.avatar = buyer.avatar;
  c.last_active = Date.now();
  scheduleSave();
  return c;
}

function updateCustomer(id, patch) {
  const s = ready();
  const c = (s.customers || []).find((x) => x.id === Number(id));
  if (!c) return null;
  for (const k of ['nick', 'remark', 'blacklisted', 'tags']) {
    if (patch[k] !== undefined) c[k] = patch[k];
  }
  scheduleSave();
  return c;
}

function removeCustomer(id) {
  const s = ready();
  s.customers = (s.customers || []).filter((c) => c.id !== Number(id));
  scheduleSave();
}

/** 客户标签汇总（用于筛选下拉） */
function listCustomerTags(accountId) {
  const set = new Set();
  for (const c of (ready().customers || [])) {
    if (accountId && c.account_id !== Number(accountId)) continue;
    for (const t of (c.tags || [])) set.add(t);
  }
  return [...set].sort();
}

/* ------------------------------ 快捷回复话术 ------------------------------ */

function listQuickReplies(accountId) {
  return (ready().quickReplies || [])
    .filter((q) => !accountId || q.account_id === Number(accountId))
    .sort((a, b) => (b.use_count || 0) - (a.use_count || 0));
}

function saveQuickReply(reply) {
  const s = ready();
  if (!s.quickReplies) s.quickReplies = [];
  const content = String(reply.content || '').trim();
  if (!content) return null;

  if (reply.id) {
    const q = s.quickReplies.find((x) => x.id === Number(reply.id));
    if (q) {
      q.content = content;
      q.title = reply.title || q.title;
      q.group = reply.group || q.group;
      scheduleSave();
      return q;
    }
  }
  const q = {
    id: s.quickReplies.reduce((m, x) => Math.max(m, x.id), 0) + 1,
    account_id: Number(reply.accountId) || null,
    title: reply.title || content.slice(0, 12),
    content,
    group: reply.group || '默认',
    use_count: 0,
    created_at: Date.now(),
  };
  s.quickReplies.push(q);
  scheduleSave();
  return q;
}

function removeQuickReply(id) {
  const s = ready();
  s.quickReplies = (s.quickReplies || []).filter((q) => q.id !== Number(id));
  scheduleSave();
}

/* ------------------------------ 通知日志 ------------------------------ */

function pushNotifyLog(entry) {
  const s = ready();
  if (!s.notifyLog) s.notifyLog = [];
  s.notifyLog.push({ ts: Date.now(), ...entry });
  if (s.notifyLog.length > 500) s.notifyLog = s.notifyLog.slice(-500);
  scheduleSave();
}

function listNotifyLog(limit) {
  const s = ready();
  return (s.notifyLog || []).slice(-(limit || 100)).reverse();
}

/* ------------------------------ 商品 ------------------------------ */

function listProducts(accountId, { search = '', status = '' } = {}) {
  const s = ready();
  let list = (s.products || []).filter((p) => !accountId || p.account_id === Number(accountId));
  if (status) list = list.filter((p) => p.status === status);
  if (search) {
    const kw = String(search).toLowerCase();
    list = list.filter((p) =>
      String(p.title || '').toLowerCase().includes(kw)
      || String(p.item_id || '').includes(kw));
  }
  return list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

function upsertProduct(accountId, item) {
  const s = ready();
  if (!s.products) s.products = [];
  const account_id = Number(accountId);
  const itemId = String(item.item_id || '').trim();
  if (!itemId) return null;

  let row = s.products.find((p) => p.account_id === account_id && p.item_id === itemId);
  const now = Date.now();
  if (!row) {
    row = {
      id: s.products.reduce((m, p) => Math.max(m, p.id), 0) + 1,
      account_id, item_id: itemId, created_at: now,
    };
    s.products.push(row);
  }
  Object.assign(row, {
    title: item.title || row.title || '',
    price: item.price != null ? String(item.price) : row.price || '',
    image: item.image || row.image || '',
    status: item.status || row.status || 'on_sale',
    stock: item.stock != null ? Number(item.stock) : (row.stock ?? null),
    updated_at: now,
  });
    for (const key of ['description', 'images', 'source_url', 'category_name', 'sku', 'platform_attributes', 'platform_address', 'platform_quantity']) {
    if (item[key] !== undefined) row[key] = item[key];
  }
  scheduleSave();
  return row;
}

function removeProduct(accountId, itemId) {
  const s = ready();
  s.products = (s.products || []).filter(
    (p) => !(p.account_id === Number(accountId) && p.item_id === String(itemId)),
  );
  scheduleSave();
}

/** 批量导入商品：CSV 格式「标题,价格,商品ID,状态」 */
function importProductsCsv(accountId, text) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  let added = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const line = rows[i].trim();
    // 跳过表头
    if (i === 0 && /标题|title|价格|price/i.test(line)) continue;

    // 简单 CSV 解析（支持引号包裹）
    const cells = [];
    let cur = '';
    let inQ = false;
    for (const ch of line) {
      if (inQ) {
        if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);

    // 兼容两种格式：
    //   标题,价格,商品ID,状态
    //   标题,价格,库存,商品ID,状态
    const c = cells.map((x) => x.trim());
    let title = '', price = '', itemId = '', status = '', stock = 0;
    if (c.length >= 5) {
      [title, price, stock, itemId, status] = c;
    } else {
      [title, price, itemId, status] = c;
    }
    if (!itemId) { skipped++; continue; }

    const st = /下架|off/i.test(status) ? 'off'
      : /售出|sold/i.test(status) ? 'sold' : 'on_sale';

    upsertProduct(accountId, {
      item_id: itemId,
      title,
      price,
      stock: Number(stock) || 0,
      status: st,
    });
    added++;
  }
  return { added, skipped };
}

/* ------------------------------ 订单 ------------------------------ */

function listOrders(accountId) {
  const s = ready();
  return (s.orders || [])
    .filter((o) => !accountId || o.account_id === Number(accountId))
    .sort((a, b) => (b.created_ts || 0) - (a.created_ts || 0));
}

function upsertOrder(accountId, order) {
  const s = ready();
  if (!s.orders) s.orders = [];
  const account_id = Number(accountId);
  const orderNo = String(order.order_no || '').trim();
  if (!orderNo) return null;

  let row = s.orders.find((o) => o.account_id === account_id && o.order_no === orderNo);
  const now = Date.now();
  if (!row) {
    row = { id: s.orders.reduce((m, o) => Math.max(m, o.id), 0) + 1, account_id, order_no: orderNo, created_ts: now };
    s.orders.push(row);
  }
  Object.assign(row, {
    item_id: order.item_id ? String(order.item_id) : row.item_id,
    item_title: order.item_title || row.item_title || '',
    buyer_nick: order.buyer_nick || row.buyer_nick || '',
    session_id: order.session_id ? String(order.session_id) : row.session_id || null,
    buyer_uid: order.buyer_uid ? String(order.buyer_uid) : row.buyer_uid || null,
    amount: order.amount != null ? Number(order.amount) : row.amount || 0,
    status: order.status || row.status || '',
    updated_at: now,
  });
  scheduleSave();
  return row;
}

/* ---- 商品/订单汇总（数据看板用） ---- */
function getStats(accountId) {
  const s = ready();
  const acc = accountId ? Number(accountId) : null;
  const products = (s.products || []).filter((p) => !acc || p.account_id === acc);
  const orders = (s.orders || []).filter((o) => !acc || o.account_id === acc);
  const sessions = (s.sessions || []).filter((x) => !acc || x.account_id === acc);

  const onSale = products.filter((p) => p.status === 'on_sale').length;
  const pending = orders.filter((o) => /待发货/.test(o.status || '')).length;
  const revenue = orders
    .filter((o) => !/关|退/.test(o.status || ''))
    .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);

  return {
    accounts: (s.accounts || []).length,
    products: products.length,
    onSale,
    orders: orders.length,
    pendingShip: pending,
    sessions: sessions.length,
    revenue: Math.round(revenue * 100) / 100,
    cardsUnused: (s.cards || []).filter((c) => !acc || c.account_id === acc)
      .filter((c) => c.status === 'unused').length,
  };
}

module.exports = {
  init, flush, persist, ready, DEFAULT_SETTINGS, scheduleSave, automationVersion,
  listAccounts, getAccount, addAccount, updateAccount, removeAccount, setActiveAccount, getActiveAccount,
  saveMessage, listMessages, listRecentMessages, findSession, ensureSession, markHumamActivity, markAiActivity,
  listRules, saveRule, removeRule, exportRulesCsv, importRulesCsv,
  getSettings, updateSettings, setSafeStorage, setAiKey, getAiKey, setProductAiKey, getProductAiKey,
  pushAiLog, listAiLog,
  pushNotifyLog, listNotifyLog,
  messageStats: (accountId) => msgStore.stats(accountId),
  messageCount: (accountId) => msgStore.count(accountId),
  listProducts, upsertProduct, removeProduct, importProductsCsv,
  listShopGroups, saveShopGroup, removeShopGroup,
  listCustomers, upsertCustomer, updateCustomer, removeCustomer, listCustomerTags,
  listQuickReplies, saveQuickReply, removeQuickReply,
  listOrders, upsertOrder, getStats,
  listStaff, addStaff, updateStaff, removeStaff, assignSession, isSessionOwnedByOther,
  getCurrentStaffId, setCurrentStaffId,
};

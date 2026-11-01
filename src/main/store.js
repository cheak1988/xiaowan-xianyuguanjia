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
  deliverRules: [],   // 自动发货配置（全局 / 账号 / 商品三级）
  deliverLog: [],     // 发货记录
  deliveries: [],     // 永久订单投递状态，不随展示日志轮换
  notifyLog: [],      // 通知发送记录
  staff: [],          // 多客服成员
  cardGroups: [],     // 卡券分组
  deliveryBlockRules: [], // 发货前风控规则
  deliveryBlockLog: [],   // 风控命中记录
  itemReplies: [],    // 商品专属回复
  defaultReplies: [], // 默认回复（按账号）
  replyLog: [],       // 回复决策日志
  messageFilters: [], // 消息过滤规则
  buyerInteraction: [], // 买家互动（按账号开关）
  interactionLog: [], // 买家互动执行记录
  interactionActions: [], // 永久动作状态；不随展示日志轮换
  orderSyncLog: [],   // 订单同步记录
  meta: {},
  settings: null,
};

const DEFAULT_SETTINGS = {
  autoReply: { enabled: true },
  messageAlerts: { enabled: true, soundEnabled: true, desktopEnabled: true, volume: 60 },
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
    orderSync: { enabled: false, intervalMinutes: 10 },  // 订单页常驻扫描
  },
  /** 买家互动：全部默认关闭，必须逐账号显式开启 */
  buyerInteraction: {
    thanks: { enabled: false, template: '感谢您的购买，收到货后有问题随时找我，祝您使用愉快~' },
    flower: { enabled: false, template: '如果这次交易还满意，方便的话送我一朵小红花呀，谢谢支持~' },
    rate: { enabled: false, template: '东西不错，发货很快，好评~', score: 5 },
    receiveFlower: { enabled: false },
    delayMinutes: 1,
  },
  /** 发货前风控（默认关闭，命中后拦截发货） */
  deliveryRisk: {
    buyerBlacklist: { enabled: true },
    buyerHasOpenOrder: { enabled: false, sameItemOnly: false },
    buyerHasOpenOrderGlobal: { enabled: false, sameItemOnly: false },
    buyerLowCredit: { enabled: false, threshold: 0 },
    /** 命中风控后自动到订单页关闭交易（仅待付款单可关）；关单结果不确定时不发货 */
    autoCloseOrder: { enabled: false },
    /** 开启后，只有平台确认关闭/取消的订单才允许补发卡密 */
    onlyCardAfterClose: false,
  },
  /** 订单同步 */
  orderSync: { autoOpenPage: false, pageIntervalSeconds: 30 },
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
let writesSuspended = false;

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function validState(value) {
  return value && !Array.isArray(value) && typeof value === 'object' && Array.isArray(value.accounts)
    && Object.keys(EMPTY).every((key) => !Array.isArray(EMPTY[key])
      || value[key] == null || Array.isArray(value[key]));
}

function init(userDataPath) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writesSuspended = false;
  file = path.join(userDataPath, STATE_FILE);
  state = readJson(file, () => clone(EMPTY), validState);
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
  // 兼容旧互动日志；未知结果也不能自动重试不可撤销的动作。
  for (const log of state.interactionLog) {
    if (!['thanks', 'flower', 'rate', 'receiveFlower'].includes(log.action)) continue;
    if (!state.interactionActions.some((entry) => entry.account_id === log.account_id
      && entry.order_no === String(log.order_no) && entry.action === log.action)) {
      state.interactionActions.push({ account_id: log.account_id, order_no: String(log.order_no),
        action: log.action, status: log.ok ? 'done' : 'uncertain', updated_at: log.ts });
    }
  }
  for (const entry of state.interactionActions) {
    if (entry.status === 'running') {
      entry.status = 'uncertain';
      entry.reason = '上次运行中断，请先人工核对，未自动重试';
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
  if (writesSuspended) return;
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
  if (!writesSuspended && file && state) writeJson(file, state);
}

function flush() {
  if (writesSuspended) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  msgStore.flushAll();
  persist();
}

/** 恢复备份后等待重启，旧异步任务和退出钩子都不得覆盖恢复的数据。 */
function suspendWrites() {
  writesSuspended = true;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  msgStore.suspendWrites();
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

/**
 * 会话列表的展示补充：昵称 / 头像缺失时，从聊天记录里回填。
 *
 * 为什么需要：早期版本的会话同步只写 peer_nick，而页面昵称提取依赖 DOM 类名，
 * 类名一改就全是空串，列表只能显示一串会话 ID。消息记录里其实存了 sender_nick，
 * 用它回填可以让历史数据也正常显示。
 *
 * @param {Array} sessions  会话行
 * @param {number} [limit]  最多回填多少个（避免一次读太多分片）
 */
function hydrateSessionNicks(sessions, limit = 200) {
  const out = [];
  let filled = 0;
  for (const row of sessions) {
    if (row.peer_nick || filled >= limit) { out.push(row); continue; }
    let nick = '';
    try {
      // 只读最近 20 条，找第一条「买家发来」且有昵称的消息
      const messages = msgStore.query(Number(row.account_id), String(row.id), 20);
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.direction !== 'in') continue;
        const candidate = String(m.sender_nick || '').trim();
        if (candidate) { nick = candidate; break; }
      }
    } catch (_) { /* 消息分片读失败不影响列表 */ }
    if (nick) {
      // 回写到会话上，下次直接命中；只在内存里改，调用方决定何时 persist
      row.peer_nick = nick;
      filled += 1;
    }
    out.push(row);
  }
  if (filled) scheduleSave();
  return out;
}

/* ------------------------------ rule ------------------------------ */

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

/** 一键发送后累计使用次数（供排序/展示） */
function touchQuickReply(id) {
  const q = (ready().quickReplies || []).find((x) => x.id === Number(id));
  if (q) { q.use_count = (q.use_count || 0) + 1; q.last_used_at = Date.now(); scheduleSave(); }
  return q || null;
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
  // 订单页同步出来的补充字段：只在有值时覆盖，避免扫描丢字段
  for (const key of ['buy_num', 'spec_name', 'spec_value', 'receiver_name', 'receiver_phone',
    'receiver_address', 'note', 'source', 'created_text', 'refund_amount', 'post_fee', 'buyer_credit']) {
    if (order[key] !== undefined && order[key] !== null && order[key] !== '') row[key] = order[key];
  }
  if (order.created_at && !row.created_ts_from_platform) {
    const parsed = Date.parse(String(order.created_at).replace(/\//g, '-'));
    if (Number.isFinite(parsed)) row.created_ts_from_platform = parsed;
  }
  scheduleSave();
  return row;
}

/** 身份只从订单或已人工关联的本店会话补全，不以昵称猜测。 */
function resolveOrderBuyer(accountId, order) {
  const session = order.session_id && findSession(accountId, order.session_id);
  const peerUid = session && session.peer_user_id;
  return { ...order, buyer_uid: order.buyer_uid || peerUid || null,
    buyer_identity_conflict: !!(order.buyer_uid && peerUid && String(order.buyer_uid) !== String(peerUid)) };
}

/** 更新单个订单的附加信息（备注、手动状态） */
function updateOrderField(accountId, orderNo, patch) {
  const s = ready();
  const row = (s.orders || []).find((o) => o.account_id === Number(accountId)
    && o.order_no === String(orderNo));
  if (!row) return null;
  for (const key of ['note', 'status', 'session_id', 'item_title']) {
    if (patch[key] !== undefined) row[key] = patch[key];
  }
  row.updated_at = Date.now();
  scheduleSave();
  return row;
}

function removeOrder(accountId, orderNo) {
  const s = ready();
  const before = (s.orders || []).length;
  s.orders = (s.orders || []).filter((o) => !(o.account_id === Number(accountId)
    && o.order_no === String(orderNo)));
  if (s.orders.length !== before) scheduleSave();
  return before !== s.orders.length;
}

function pushOrderSyncLog(entry) {
  const s = ready();
  if (!s.orderSyncLog) s.orderSyncLog = [];
  s.orderSyncLog.push({ ts: Date.now(), ...entry });
  if (s.orderSyncLog.length > 300) s.orderSyncLog = s.orderSyncLog.slice(-300);
  scheduleSave();
}

function listOrderSyncLog(limit) {
  return (ready().orderSyncLog || []).slice(-(limit || 50)).reverse();
}

/* ------------------------------ 卡券分组 ------------------------------ */

function listCardGroups(accountId) {
  return (ready().cardGroups || [])
    .filter((g) => !accountId || g.account_id === Number(accountId))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.id - b.id);
}

function saveCardGroup(group) {
  const s = ready();
  if (!s.cardGroups) s.cardGroups = [];
  const name = String(group.name || '').trim();
  if (!name) throw new Error('分组名称不能为空');
  if (group.id) {
    const row = s.cardGroups.find((g) => g.id === Number(group.id));
    if (!row) throw new Error('分组不存在');
    row.name = name;
    if (group.note !== undefined) row.note = String(group.note || '');
    scheduleSave();
    return row;
  }
  const row = {
    id: s.cardGroups.reduce((m, g) => Math.max(m, g.id), 0) + 1,
    account_id: Number(group.accountId) || null,
    name,
    note: String(group.note || ''),
    sort: s.cardGroups.length,
    created_at: Date.now(),
  };
  s.cardGroups.push(row);
  scheduleSave();
  return row;
}

function removeCardGroup(id) {
  const s = ready();
  const gid = Number(id);
  s.cardGroups = (s.cardGroups || []).filter((g) => g.id !== gid);
  // 卡密与发货规则上的分组引用一并清掉，避免出现悬空分组
  for (const card of s.cards || []) if (card.group_id === gid) card.group_id = null;
  for (const rule of s.deliverRules || []) if (rule.group_id === gid) rule.group_id = null;
  scheduleSave();
}

/* ------------------------------ 发货前风控规则 ------------------------------ */

/**
 * 风控规则（用户可配置的开关集合，规则本体在 auto-delivery 里评估）：
 *   buyerBlacklist       买家在当前店铺的客户档案被拉黑
 *   buyerHasOpenOrder    买家在当前店铺还有未完成的订单
 *   buyerHasOpenOrderGlobal 买家在本机任一店铺还有未完成的订单
 *   buyerLowCredit       买家评价数不高于阈值（需要在订单页抓到）
 */

function getDeliveryRiskSettings() {
  return mergeSettings(clone(DEFAULT_SETTINGS.deliveryRisk), ready().settings.deliveryRisk || {});
}

function saveDeliveryRiskSettings(patch) {
  const s = ready();
  s.settings.deliveryRisk = mergeSettings(s.settings.deliveryRisk || clone(DEFAULT_SETTINGS.deliveryRisk), patch || {});
  scheduleSave();
  return s.settings.deliveryRisk;
}

function listDeliveryBlockLog(accountId, limit) {
  return (ready().deliveryBlockLog || [])
    .filter((row) => !accountId || row.account_id === Number(accountId))
    .slice(-(limit || 100)).reverse();
}

function pushDeliveryBlockLog(entry) {
  const s = ready();
  if (!s.deliveryBlockLog) s.deliveryBlockLog = [];
  s.deliveryBlockLog.push({ ts: Date.now(), ...entry });
  if (s.deliveryBlockLog.length > 800) s.deliveryBlockLog = s.deliveryBlockLog.slice(-800);
  scheduleSave();
}

/* ------------------------------ 默认回复 / 商品回复 ------------------------------ */

/**
 * 默认回复：关键词和 AI 都没命中时的那一句，每个账号独立。
 * replyOnce=true 时，同一个会话只回一次默认回复。
 */
function getDefaultReply(accountId) {
  const row = (ready().defaultReplies || []).find((x) => x.account_id === Number(accountId));
  return row || { account_id: Number(accountId), enabled: false, content: '', reply_once: true, apply_to_items: [] };
}

function saveDefaultReply(accountId, patch) {
  const s = ready();
  if (!s.defaultReplies) s.defaultReplies = [];
  let row = s.defaultReplies.find((x) => x.account_id === Number(accountId));
  if (!row) {
    row = { account_id: Number(accountId), enabled: false, content: '', reply_once: true, apply_to_items: [] };
    s.defaultReplies.push(row);
  }
  if (patch.enabled !== undefined) row.enabled = !!patch.enabled;
  if (patch.content !== undefined) row.content = String(patch.content || '');
  if (patch.reply_once !== undefined) row.reply_once = !!patch.reply_once;
  if (patch.apply_to_items !== undefined) {
    row.apply_to_items = Array.isArray(patch.apply_to_items)
      ? patch.apply_to_items.map(String).filter(Boolean) : [];
  }
  row.updated_at = Date.now();
  scheduleSave();
  return row;
}

/** 默认回复是否已经对这个会话发过 */
function hasDefaultReplyRecord(accountId, sessionId) {
  const s = ready();
  const row = s.sessions.find((x) => x.account_id === Number(accountId) && x.id === String(sessionId));
  return !!(row && row.default_reply_at);
}

function markDefaultReply(accountId, sessionId) {
  const row = ensureSession(accountId, sessionId);
  row.default_reply_at = Date.now();
  scheduleSave();
}

function listItemReplies(accountId) {
  return (ready().itemReplies || [])
    .filter((x) => x.account_id === Number(accountId))
    .sort((a, b) => a.id - b.id);
}

function getItemReply(accountId, itemId) {
  return (ready().itemReplies || []).find((x) => x.account_id === Number(accountId)
    && String(x.item_id) === String(itemId)) || null;
}

function saveItemReply(reply) {
  const s = ready();
  if (!s.itemReplies) s.itemReplies = [];
  const itemId = String(reply.item_id || '').trim();
  const content = String(reply.content || '').trim();
  if (!itemId) throw new Error('请填写商品ID');
  if (!content) throw new Error('请填写回复内容');
  let row = s.itemReplies.find((x) => x.account_id === Number(reply.accountId)
    && x.item_id === itemId);
  if (!row) {
    row = {
      id: s.itemReplies.reduce((m, x) => Math.max(m, x.id), 0) + 1,
      account_id: Number(reply.accountId),
      item_id: itemId,
      item_title: String(reply.item_title || ''),
      content,
      enabled: reply.enabled === false ? false : true,
      created_at: Date.now(),
    };
    s.itemReplies.push(row);
  } else {
    row.content = content;
    if (reply.item_title !== undefined) row.item_title = String(reply.item_title || '');
    if (reply.enabled !== undefined) row.enabled = !!reply.enabled;
    row.updated_at = Date.now();
  }
  scheduleSave();
  return row;
}

function removeItemReply(id) {
  const s = ready();
  s.itemReplies = (s.itemReplies || []).filter((x) => x.id !== Number(id));
  scheduleSave();
}

/* ------------------------------ 消息过滤 ------------------------------ */

/**
 * 过滤规则：匹配到就不回（客户发来的消息里最常见的是「自动回复」「机器人」）。
 * type: 'ignore'（整条消息忽略，不记录决策以外的动作）
 */
function listMessageFilters(accountId) {
  return (ready().messageFilters || [])
    .filter((x) => x.account_id === Number(accountId))
    .sort((a, b) => a.id - b.id);
}

function saveMessageFilter(filter) {
  const s = ready();
  if (!s.messageFilters) s.messageFilters = [];
  const keyword = String(filter.keyword || '').trim();
  if (!keyword) throw new Error('请填写过滤词');
  let row = s.messageFilters.find((x) => x.account_id === Number(filter.accountId)
    && x.keyword === keyword);
  if (!row) {
    row = {
      id: s.messageFilters.reduce((m, x) => Math.max(m, x.id), 0) + 1,
      account_id: Number(filter.accountId),
      keyword,
      filter_type: filter.filter_type === 'exact' ? 'exact' : 'contains',
      note: String(filter.note || ''),
      created_at: Date.now(),
    };
    s.messageFilters.push(row);
  } else {
    row.filter_type = filter.filter_type === 'exact' ? 'exact' : 'contains';
    if (filter.note !== undefined) row.note = String(filter.note || '');
  }
  scheduleSave();
  return row;
}

function removeMessageFilter(id) {
  const s = ready();
  s.messageFilters = (s.messageFilters || []).filter((x) => x.id !== Number(id));
  scheduleSave();
}

/* ------------------------------ 回复决策日志 ------------------------------ */

function pushReplyLog(entry) {
  const s = ready();
  if (!s.replyLog) s.replyLog = [];
  s.replyLog.push({ ts: Date.now(), ...entry });
  // 决策日志是最容易堆积的：只留最近 1000 条，避免 state.json 无限膨胀
  if (s.replyLog.length > 1000) s.replyLog = s.replyLog.slice(-1000);
  scheduleSave();
}

function listReplyLog(accountId, limit) {
  return (ready().replyLog || [])
    .filter((row) => !accountId || row.account_id === Number(accountId))
    .slice(-(limit || 100)).reverse();
}

/* ------------------------------ 买家互动 ------------------------------ */

/**
 * 每个账号一组开关，默认全关。
 *   thanks       买家确认收货后发致谢
 *   flower       交易成功后求小红花
 *   rate         自动评价（高风险，评价不可撤销）
 *   receiveFlower 自动收下买家送的小红花
 */
function getBuyerInteraction(accountId) {
  const row = (ready().buyerInteraction || []).find((x) => x.account_id === Number(accountId));
  return mergeSettings(clone(DEFAULT_SETTINGS.buyerInteraction), row || {});
}

function saveBuyerInteraction(accountId, patch) {
  const s = ready();
  if (!s.buyerInteraction) s.buyerInteraction = [];
  let row = s.buyerInteraction.find((x) => x.account_id === Number(accountId));
  if (!row) {
    row = { account_id: Number(accountId) };
    s.buyerInteraction.push(row);
  }
  for (const key of ['thanks', 'flower', 'rate', 'receiveFlower']) {
    if (patch[key] && typeof patch[key] === 'object') {
      row[key] = { ...(row[key] || DEFAULT_SETTINGS.buyerInteraction[key]), ...patch[key] };
    }
  }
  if (patch.delayMinutes !== undefined) {
    row.delayMinutes = Math.max(0, Math.min(1440, Number(patch.delayMinutes) || 0));
  }
  row.updated_at = Date.now();
  scheduleSave();
  return getBuyerInteraction(accountId);
}

function listInteractionLog(accountId, limit) {
  return (ready().interactionLog || [])
    .filter((row) => !accountId || row.account_id === Number(accountId))
    .slice(-(limit || 100)).reverse();
}

function pushInteractionLog(entry) {
  const s = ready();
  if (!s.interactionLog) s.interactionLog = [];
  s.interactionLog.push({ ts: Date.now(), ...entry });
  if (s.interactionLog.length > 800) s.interactionLog = s.interactionLog.slice(-800);
  scheduleSave();
}

function getStats(accountId) {
  const s = ready();
  const acc = accountId ? Number(accountId) : null;
  const products = (s.products || []).filter((p) => !acc || p.account_id === acc);
  const orders = (s.orders || []).filter((o) => !acc || o.account_id === acc);
  const sessions = (s.sessions || []).filter((x) => !acc || x.account_id === acc);

  const onSale = products.filter((p) => p.status === 'on_sale').length;
  const pending = orders.filter((o) => /待发货/.test(o.status || '')).length;
  const isClosed = (o) => /关|退|取消/.test(o.status || '');
  const revenue = orders.filter((o) => !isClosed(o))
    .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
  const refunded = orders.filter((o) => /退款/.test(o.status || ''))
    .reduce((sum, o) => sum + (Number(o.refund_amount) || Number(o.amount) || 0), 0);
  const shipped = orders.filter((o) => /已发货|已收货|交易成功|已完成/.test(o.status || ''));

  return {
    accounts: (s.accounts || []).length,
    products: products.length,
    onSale,
    orders: orders.length,
    pendingShip: pending,
    shipped: shipped.length,
    sessions: sessions.length,
    revenue: Math.round(revenue * 100) / 100,
    refunded: Math.round(refunded * 100) / 100,
    cardsUnused: (s.cards || []).filter((c) => !acc || c.account_id === acc)
      .filter((c) => c.status === 'unused').length,
  };
}

module.exports = {
  init, flush, persist, ready, DEFAULT_SETTINGS, scheduleSave, automationVersion, validState, suspendWrites,
  listAccounts, getAccount, addAccount, updateAccount, removeAccount, setActiveAccount, getActiveAccount,
  saveMessage, listMessages, listRecentMessages, findSession, ensureSession, markHumamActivity, markAiActivity,
  hydrateSessionNicks,
  listRules, saveRule, removeRule, exportRulesCsv, importRulesCsv,
  getSettings, updateSettings, setSafeStorage, setAiKey, getAiKey, setProductAiKey, getProductAiKey,
  pushAiLog, listAiLog,
  pushNotifyLog, listNotifyLog,
  messageStats: (accountId) => msgStore.stats(accountId),
  messageCount: (accountId) => msgStore.count(accountId),
  listProducts, upsertProduct, removeProduct, importProductsCsv,
  listShopGroups, saveShopGroup, removeShopGroup,
  listCustomers, upsertCustomer, updateCustomer, removeCustomer, listCustomerTags,
  listQuickReplies, saveQuickReply, removeQuickReply, touchQuickReply,
  listOrders, upsertOrder, resolveOrderBuyer, updateOrderField, removeOrder, getStats,
  pushOrderSyncLog, listOrderSyncLog,
  listCardGroups, saveCardGroup, removeCardGroup,
  getDeliveryRiskSettings, saveDeliveryRiskSettings,
  listDeliveryBlockLog, pushDeliveryBlockLog,
  getDefaultReply, saveDefaultReply, hasDefaultReplyRecord, markDefaultReply,
  listItemReplies, getItemReply, saveItemReply, removeItemReply,
  listMessageFilters, saveMessageFilter, removeMessageFilter,
  pushReplyLog, listReplyLog,
  getBuyerInteraction, saveBuyerInteraction, listInteractionLog, pushInteractionLog,
  listStaff, addStaff, updateStaff, removeStaff, assignSession, isSessionOwnedByOther,
  getCurrentStaffId, setCurrentStaffId,
};

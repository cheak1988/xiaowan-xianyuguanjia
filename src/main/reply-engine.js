'use strict';

/**
 * 自动回复调度器
 *
 * 决策链（每次收到买家消息时执行）：
 *
 *   1. 关闭了自动回复？           → 直接返回，不回复
 *   2. 人工刚回复过（静默期内）？  → 跳过（避免抢人工的活）
 *   3. 命中关键词规则？           → 用规则内容（可多条）
 *   4. 规则没命中 && AI 已启用    → 调 AI
 *   5. AI 失败/未启用             → 不回（或按配置回兜底话术）
 *
 * 安全边界（比原厂更保守）：
 *   - 单会话 1 分钟内最多自动回 N 条
 *   - 同一内容 5 分钟内不重复发
 *   - 只回「买家发来的文本消息」，忽略系统卡片/图片（除非规则明确匹配）
 *   - 消息超过一定长度（疑似轰炸）直接忽略
 */

const store = require('./store');
const rules = require('./rules');
const ai = require('./ai');
const bargain = require('./ai-bargain');

const DEDUP_WINDOW_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60_000;

const lastContent = new Map();   // `${account}:${session}` -> { text, ts }
const rateBucket = new Map();    // `${account}:${session}` -> number[]  (时间戳)
const queues = new Map();

function textOf(message) {
  const c = message && message.content;
  if (!c) return '';
  // 兼容两种结构：{ text } 对象，或直接是字符串
  if (typeof c === 'string') return c.trim();
  if (typeof c === 'object') return String(c.text || '').trim();
  return '';
}

function recentRate(key, now) {
  const arr = (rateBucket.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  rateBucket.set(key, arr);
  return arr;
}

function bumpRate(key, now) {
  const arr = recentRate(key, now);
  arr.push(now);
  rateBucket.set(key, arr);
}

/**
 * 判断这条消息要不要处理
 * @returns {{action:'skip'|'reply', reason:string, replies:Array}}
 */
function decide({ accountId, account, session, message, settings }) {
  const s = settings || store.getSettings();
  const now = Date.now();

  const liveAccount = store.getAccount(accountId);
  if (!liveAccount || liveAccount.disabled) return { action: 'skip', reason: '店铺已停用或删除', replies: [] };

  if (!s.autoReply || s.autoReply.enabled === false) {
    return { action: 'skip', reason: '自动回复已关闭', replies: [] };
  }
  if (!message || typeof message !== 'object') {
    return { action: 'skip', reason: '无效消息', replies: [] };
  }
  if (message.direction === 'out') {
    return { action: 'skip', reason: '自己发的消息', replies: [] };
  }

  const text = textOf(message);
  if (!text) return { action: 'skip', reason: '非文本消息', replies: [] };
  if (text.length > 1000) return { action: 'skip', reason: '消息过长', replies: [] };

  const sid = String((session && session.id) || '');
  if (!sid || sid.startsWith('nick:')) return { action: 'skip', reason: '无法核验会话ID，请人工回复', replies: [] };
  const key = `${accountId}:${sid}`;

  // 人工静默期
  const row = store.findSession(accountId, sid);
  const quietMs = (Number(s.ai.quietMinutes) || 0) * 60_000;
  if (row && row.last_human_ts && quietMs && now - row.last_human_ts < quietMs) {
    return { action: 'skip', reason: `人工接管中（${s.ai.quietMinutes} 分钟内）`, replies: [] };
  }

  // 多客服：会话已被其他客服接手，就不要抢回复
  const meId = store.getCurrentStaffId();
  if (meId && store.isSessionOwnedByOther(accountId, sid, meId)) {
    const owner = store.listStaff().find(
      (x) => row && x.id === row.assignee_id,
    );
    return {
      action: 'skip',
      reason: `会话已由「${owner ? owner.name : row && row.assignee_id}」接手`,
      replies: [],
    };
  }

  // 频控
  const rateMax = Number(s.autoReply.maxPerMinute) || 5;
  if (recentRate(key, now).length >= rateMax) {
    return { action: 'skip', reason: `触发频控（${rateMax}/分钟）`, replies: [] };
  }

  // 内容去重
  const prev = lastContent.get(key);
  if (prev && prev.text === text && now - prev.ts < DEDUP_WINDOW_MS) {
    return { action: 'skip', reason: '重复内容', replies: [] };
  }

  // 1) 规则
  const ruleHits = rules.match(accountId, message, session);
  // 只保留有实际内容的回复（避免发出空白消息）
  const usable = ruleHits.filter((r) => {
    const hasText = r.content && String(r.content).trim();
    const hasImg = Array.isArray(r.images) && r.images.length > 0;
    return hasText || hasImg;
  });
  if (usable.length) {
    return {
      action: 'reply',
      reason: `命中规则 ${usable.map((r) => '#' + r.ruleId).join(',')}`,
      replies: usable.map((r) => ({
        kind: 'rule',
        ruleId: r.ruleId,
        content: (r.content || '').trim(),
        images: r.images || [],
      })),
    };
  }

  // 2) AI
  if (s.ai.enabled) {
    return {
      action: 'ai',
      reason: '规则未命中，走 AI',
      replies: [],
      pendingText: text,
      quietKey: key,
    };
  }

  return { action: 'skip', reason: '规则未命中且 AI 未启用', replies: [] };
}

/**
 * 真正执行一次决策（含 AI 异步）
 * @returns {Promise<{action, reason, replies}>}
 */
async function handle({ accountId, account, session, message, sendFn }) {
  const key = `${accountId}:${String(session && session.id || '')}`;
  const version = store.automationVersion(accountId, session && session.id);
  const previous = queues.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => {
    if (version !== store.automationVersion(accountId, session && session.id)) {
      return { action: 'skip', reason: '等待期间人工接管或设置已变化', replies: [] };
    }
    return handleOnce({ accountId, account: store.getAccount(accountId), session, message, sendFn });
  });
  queues.set(key, pending);
  try { return await pending; }
  finally { if (queues.get(key) === pending) queues.delete(key); }
}

async function handleOnce({ accountId, account, session, message, sendFn }) {
  const settings = store.getSettings();
  const decision = decide({ accountId, account, session, message, settings });
  if (decision.action === 'skip') return decision;

  const now = Date.now();
  const sid = String((session && session.id) || '');
  const key = `${accountId}:${sid}`;
  const version = store.automationVersion(accountId, sid);
  const sendReplies = async (replies, reason) => {
    const sent = [];
    for (const reply of replies) {
      const guard = () => {
        const current = store.getAccount(accountId);
        const cfg = store.getSettings();
        return !!current && !current.disabled && cfg.autoReply.enabled !== false
          && (reply.kind !== 'ai' || cfg.ai.enabled)
          && version === store.automationVersion(accountId, sid);
      };
      if (!guard()) return { action: 'skip', reason: '人工接管或自动回复已停用，已取消发送', replies: sent };
      const cfg = store.getSettings();
      if (recentRate(key, Date.now()).length >= (Number(cfg.autoReply.maxPerMinute) || 5)) {
        return { action: 'skip', reason: '触发发送频控', replies: sent };
      }
      const result = await sendFn(reply, guard);
      if (!result || result.ok !== true) return { action: 'error', reason: result && result.error || '发送结果未确认', replies: sent };
      bumpRate(key, Date.now());
      lastContent.set(key, { text: textOf(message), ts: Date.now() });
      store.markAiActivity(accountId, sid, Date.now());
      sent.push(reply);
    }
    return { action: 'reply', reason, replies: sent };
  };

  if (decision.action === 'reply') {
    return sendReplies(decision.replies, decision.reason);
  }

  // AI 路径：先过议价控制
  const history = store.listRecentMessages(accountId, sid, settings.ai.contextMessages || 10);
  const lastBuyerMsg = decision.pendingText;

  let bargainHints = null;
  if (settings.ai.bargain && settings.ai.bargain.enabled) {
    // 找商品价格：优先用会话关联的商品，其次本地商品库
    let listPrice = 0;
    if (session && session.itemId) {
      const prods = store.listProducts(accountId, {});
      const p = prods.find((x) => String(x.item_id) === String(session.itemId));
      if (p && p.price) listPrice = Number(p.price) || 0;
    }

    const bg = bargain.decide({
      accountId,
      sessionId: sid,
      userText: lastBuyerMsg,
      listPrice,
      cfg: settings.ai.bargain,
    });

    if (bg.action === 'refuse') {
      // 轮次用尽，直接回固定拒绝话术，不再调 AI（省钱也防乱说）
      const refuseText = (settings.ai.bargain.refuseText || '').trim()
        || '不好意思，这个价格已经是最低了，实在不能再让啦~';
      return sendReplies([{ kind: 'ai', content: refuseText }], `议价${bg.reason}`);
    }

    if (bg.action === 'skip') {
      // 仅砍价模式下非砍价消息 → 不回复（交给人工）
      return { action: 'skip', reason: bg.reason, replies: [] };
    }

    if (bg.hints) bargainHints = bg.hints;
  }

  const r = await ai.chat({
    account,
    session,
    history,
    userText: lastBuyerMsg,
    bargainHints,
  });

  if (!store.getAccount(accountId)) return { action: 'skip', reason: '店铺已删除', replies: [] };
  store.pushAiLog({
    account_id: accountId,
    session_id: sid,
    ok: r.ok,
    error: r.error || null,
    ms: r.ms || null,
    tokens: r.tokens || null,
    model: r.model || null,
    input: decision.pendingText.slice(0, 200),
    output: r.ok ? r.reply : null,
  });

  if (!r.ok) {
    return { action: 'skip', reason: `AI 失败：${r.error}`, replies: [] };
  }

  return sendReplies([{ kind: 'ai', content: r.reply }], 'AI 生成');
}

function resetAll() {
  lastContent.clear();
  rateBucket.clear();
}

module.exports = { decide, handle, resetAll };

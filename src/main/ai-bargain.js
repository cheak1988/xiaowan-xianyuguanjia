'use strict';

/**
 * AI 议价控制
 *
 * 解决的问题：
 *   买家砍价时，AI 不能无限让步，也不能一次让太多。
 *
 * 策略（每次买家消息进来时判断）：
 *   1. 识别是否为「砍价意图」（关键词 + 是否提到数字）
 *   2. 记录该会话已议价轮次
 *   3. 按轮次计算出「可让价区间」
 *   4. 轮次用尽 → 拒绝再让
 *
 * 配置项（每个账号可独立设置，也支持商品级覆盖）：
 *   {
 *     enabled: true,
 *     mode: 'full' | 'bargain',     // full=全场景客服，bargain=仅砍价
 *     maxRounds: 3,                  // 最多让价几轮
 *     maxDiscountPercent: 10,        // 最多让多少（百分比）
 *     minPrice: 0,                   // 底线价，绝不低于这个
 *     roundStepPercent: 3,           // 每轮让多少（百分比）
 *   }
 */

const store = require('./store');

/** 砍价意图关键词 */
const BARGAIN_WORDS = [
  '便宜', '少点', '低点', '优惠', '打折', '让价', '能少', '降价',
  '砍价', '刀', '包邮吗', '最低多少', '还能少', '再便宜', '减点',
  '多少钱能卖', '实在点', '给个底价', '最低价', '底价',
  // 常见变体
  '太贵', '好贵', '有点贵', '贵了', '贵些', '贵点', '高了吧',
  '便宜点', '少一点', '让一点', '能不能少', '可以少',
  '学生党', '预算不够', '预算有限', '手头紧',
  '抹个零', '凑个整', '整数吧', '包个邮',
  // 单字与短模式（放在最后，靠正则兜底）
  '贵', '少', '降',
];

/** 结构化的砍价表达：数字 + 卖/行/可以 等 */
const BARGAIN_PATTERNS = [
  /\d+(?:\.\d+)?\s*(?:元|块|块钱)?\s*(?:卖|行|可以|行不行|卖吗|卖不卖|拿走|要了)/i,
  /(?:卖|算|给)\s*\d+(?:\.\d+)?/i,
  /(?:能不能|可否|可以)\s*(?:\d+(?:\.\d+)?)?\s*(?:卖|便宜|少)/i,
];

/** 显式价格（必须带单位或货币符号，避免把"3天"当价格） */
const EXPLICIT_PRICE_RE = /(?:[¥￥]\s*\d+(?:\.\d+)?)|(?:\d+(?:\.\d+)?\s*(?:元|块|块钱|rmb))/i;

/** 价格数字提取（支持 19.9 / 19元 / ￥19） */
const PRICE_RE = /(\d+(?:\.\d+)?)\s*(?:元|块|rmb|¥|￥)?/gi;

function isBargainIntent(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (BARGAIN_WORDS.some((w) => t.includes(w))) return true;
  if (BARGAIN_PATTERNS.some((re) => re.test(t))) return true;
  if (EXPLICIT_PRICE_RE.test(t)) return true;
  return false;
}

function extractPrices(text) {
  const out = [];
  let m;
  PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(String(text || ''))) !== null) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 0 && v < 1e7) out.push(v);
  }
  return out;
}

/* ------------------------------ 会话议价状态 ------------------------------ */

/** sessionId -> { rounds, firstPrice, lastOffer, updatedAt } */
const sessions = new Map();

function getState(accountId, sessionId) {
  const key = `${accountId}:${sessionId}`;
  if (!sessions.has(key)) {
    sessions.set(key, { rounds: 0, firstPrice: null, lastOffer: null, updatedAt: Date.now() });
  }
  return sessions.get(key);
}

function resetState(accountId, sessionId) {
  sessions.delete(`${accountId}:${sessionId}`);
}

/* ------------------------------ 议价决策 ------------------------------ */

/**
 * 判断这一步该怎么回复
 *
 * @param {object} p
 * @param {number} p.accountId
 * @param {string} p.sessionId
 * @param {string} p.userText      买家的话
 * @param {number} [p.listPrice]   商品标价
 * @param {object} p.cfg           议价配置
 * @returns {{action:'skip'|'allow'|'refuse', reason:string, hints?:object}}
 */
function decide({ accountId, sessionId, userText, listPrice, cfg }) {
  const c = cfg || {};
  if (!c.enabled) return { action: 'skip', reason: '议价控制未启用' };

  const text = String(userText || '');
  const bargain = isBargainIntent(text);

  // 仅砍价模式：非砍价消息不处理（交给普通规则/AI）
  if (c.mode === 'bargain' && !bargain) {
    return { action: 'skip', reason: '非砍价消息（仅砍价模式）' };
  }

  if (!bargain) {
    return { action: 'allow', reason: '非砍价，正常回复', hints: { bargain: false } };
  }

  const st = getState(accountId, sessionId);
  const maxRounds = Math.max(1, Number(c.maxRounds) || 3);

  // 轮次用尽
  if (st.rounds >= maxRounds) {
    return {
      action: 'refuse',
      reason: `已议价 ${st.rounds} 轮，达到上限 ${maxRounds} 轮`,
      hints: { bargain: true, rounds: st.rounds, maxRounds, refuse: true },
    };
  }

  // 计算可让价上限
  const base = Number(listPrice) || Number(st.firstPrice) || 0;
  const maxPct = Math.max(0, Number(c.maxDiscountPercent) || 10);
  const stepPct = Math.max(0, Number(c.roundStepPercent) || 3);
  const floor = Number(c.minPrice) || 0;

  if (!base) {
    return {
      action: 'allow',
      reason: '未设置商品价格，无法计算让价空间',
      hints: { bargain: true, rounds: st.rounds, noPrice: true },
    };
  }

  if (st.firstPrice == null) st.firstPrice = base;

  const allowedTotal = base * (1 - maxPct / 100);
  const thisRoundLimit = Math.max(0, base * (stepPct / 100));
  const floorLimit = floor > 0 ? Math.max(floor, allowedTotal) : allowedTotal;
  const minAcceptable = Math.max(floorLimit, base - thisRoundLimit * (st.rounds + 1));

  st.rounds += 1;
  st.updatedAt = Date.now();

  // 买家提到的价格
  const prices = extractPrices(text);
  const buyerOffer = prices.length ? Math.min(...prices) : null;

  let suggestion = null;
  if (buyerOffer != null) {
    if (buyerOffer >= minAcceptable) {
      suggestion = buyerOffer;         // 可以接受
    } else {
      suggestion = Math.round(minAcceptable * 100) / 100;  // 报一个还价
    }
    st.lastOffer = suggestion;
  }

  return {
    action: 'allow',
    reason: `第 ${st.rounds}/${maxRounds} 轮议价`,
    hints: {
      bargain: true,
      rounds: st.rounds,
      maxRounds,
      listPrice: base,
      minAcceptable: Math.round(minAcceptable * 100) / 100,
      maxDiscountPercent: maxPct,
      buyerOffer,
      suggestion,
      /** 给 AI 的硬约束，必须遵守 */
      constraint: `本轮最低可接受 ${Math.round(minAcceptable * 100) / 100} 元，`
        + `绝不可低于此价；最多再让 ${Math.round(thisRoundLimit * 100) / 100} 元。`
        + (st.rounds >= maxRounds ? '这是最后一轮，之后不再让价。' : ''),
    },
  };
}

/** 清理过期会话状态（超过 2 小时） */
function gc() {
  const now = Date.now();
  for (const [k, v] of sessions.entries()) {
    if (now - v.updatedAt > 2 * 3600_000) sessions.delete(k);
  }
}

module.exports = { decide, isBargainIntent, extractPrices, resetState, gc, sessions };

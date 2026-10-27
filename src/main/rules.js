'use strict';

/**
 * 自动回复规则引擎
 *
 * 对照逆向结果（报告 3.7 节）：原厂是纯关键词匹配，没有 LLM。
 * 这里只负责「给定一条消息，找出命中的规则」——纯函数，无副作用。
 *
 * 去重 / 频控 / 人工静默等保护统一在 reply-engine 里做，
 * 避免两层去重叠加导致行为不可预期。
 */

const store = require('./store');

function isExcluded(rule, session) {
  if (!session || !session.itemId) return false;
  const excluded = rule.exclude_items || [];
  return excluded.map(String).includes(String(session.itemId));
}

function matchOne(rule, text) {
  if (!rule.status) return false;
  switch (Number(rule.match_type)) {
    case 3: // 全部消息
      return true;
    case 2: { // 正则
      const pattern = (rule.keywords || [])[0];
      if (!pattern) return false;
      try { return new RegExp(pattern, 'i').test(text); } catch (_) { return false; }
    }
    case 1: // 关键词（任一命中）
    default: {
      const kws = (rule.keywords || []).filter(Boolean);
      if (!kws.length) return false;
      const lower = text.toLowerCase();
      return kws.some((k) => lower.includes(String(k).toLowerCase()));
    }
  }
}

function extractText(message) {
  const c = message && message.content;
  if (!c) return '';
  if (typeof c === 'string') return c;
  return String(c.text || '');
}

/**
 * 找出所有命中的规则（按 sort 顺序，最多 3 条）
 * @returns {Array<{ruleId:number, content:string, images:string[]}>}
 */
function match(accountId, message, session) {
  const text = extractText(message);
  if (!text) return [];

  const out = [];
  for (const rule of store.listRules(accountId)) {
    if (!matchOne(rule, text)) continue;
    if (isExcluded(rule, session)) continue;

    // 跳过内容为空的规则：发了也是空白消息
    const hasText = rule.content && String(rule.content).trim();
    const hasImg = Array.isArray(rule.images) && rule.images.length > 0;
    if (!hasText && !hasImg) continue;

    out.push({
      ruleId: rule.id,
      content: String(rule.content || '').trim(),
      images: rule.images || [],
    });
    if (out.length >= 3) break; // 单条消息最多回 3 条，避免刷屏
  }
  return out;
}

/** 兼容旧调用；当前无内部状态，保留空实现 */
function resetDedup() {}

module.exports = { match, resetDedup, matchOne };

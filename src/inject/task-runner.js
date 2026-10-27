'use strict';

/**
 * 高风险任务执行器（注入到官方页面）
 *
 * 包含：
 *   - polish  擦亮（我的闲鱼 → 商品 → 擦亮按钮）
 *   - rate    自动评价（订单详情 → 评价）
 *
 * ⚠️ 这个脚本会点击官方页面的真实按钮。
 *    平台可能检测到自动化行为，风险由使用者承担。
 *
 * 频率限制（内置，不可通过配置关闭）：
 *   - 擦亮：每小时最多 1 次，每天最多 1 次成功
 *   - 评价：每分钟最多 3 条
 */

const { ipcRenderer } = require('electron');

const SEL = {
  // 商品列表里的「擦亮」按钮
  polishBtn: [
    '[class*="polish"]',
    '[class*="refresh"]',
    'button[class*="shine"]',
    '[title*="擦亮"]',
    '[aria-label*="擦亮"]',
  ],
  // 商品卡片
  productCard: [
    '[class*="item-card"]',
    '[class*="goods-card"]',
    '[data-item-id]',
    'a[href*="item?id="]',
  ],
  // 评价相关
  rateBtn: [
    '[class*="rate"]',
    '[class*="comment"]',
    '[title*="评价"]',
  ],
  rateTextarea: [
    'textarea[class*="content"]',
    'textarea',
    '[contenteditable="true"]',
  ],
  rateSubmit: [
    'button[class*="submit"]',
    'button[class*="confirm"]',
    '[class*="submit-btn"]',
  ],
};

function pick(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const s of list) {
    try {
      const el = document.querySelector(s);
      if (el) return { el, selector: s };
    } catch (_) { /* ignore */ }
  }
  return null;
}

function pickAll(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  for (const s of list) {
    try {
      const found = document.querySelectorAll(s);
      if (found.length) return { list: Array.from(found), selector: s };
    } catch (_) { /* ignore */ }
  }
  return null;
}

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 频率限制 ------------------------------ */

const lastRun = { polish: 0, rate: [] };
const POLISH_MIN_INTERVAL = 3600_000;   // 1 小时
const RATE_WINDOW = 60_000;             // 1 分钟
const RATE_MAX = 3;

function canPolish() {
  return Date.now() - lastRun.polish >= POLISH_MIN_INTERVAL;
}

function canRate() {
  const now = Date.now();
  lastRun.rate = lastRun.rate.filter((t) => now - t < RATE_WINDOW);
  return lastRun.rate.length < RATE_MAX;
}

/* ------------------------------ 擦亮 ------------------------------ */

async function runPolish() {
  if (!canPolish()) {
    return { ok: false, reason: '擦亮频率限制：每小时最多 1 次' };
  }

  const btn = pick(SEL.polishBtn);
  if (!btn || !visible(btn.el)) {
    return {
      ok: false,
      reason: '找不到「擦亮」按钮。可能原因：不在商品管理页、未登录、或页面结构已变。',
      needManual: true,
    };
  }

  // 只点一次（避免误点全部商品触发批量擦亮）
  btn.el.click();
  lastRun.polish = Date.now();
  await sleep(1500);

  // 检查是否有确认弹窗
  const confirm = pick(['[class*="confirm"] button[class*="primary"]', 'button[class*="sure"]']);
  if (confirm && visible(confirm.el)) {
    confirm.el.click();
    await sleep(800);
  }

  return { ok: true, count: 1, reason: '已点击擦亮按钮' };
}

/** 批量擦亮（逐个商品点，带间隔） */
async function runPolishBatch() {
  if (!canPolish()) {
    return { ok: false, reason: '擦亮频率限制：每小时最多 1 次' };
  }

  const cards = pickAll(SEL.productCard);
  if (!cards) {
    return { ok: false, reason: '找不到商品列表', needManual: true };
  }

  let count = 0;
  const maxPerRun = 20; // 单次最多擦 20 个，防止一次点太多触发风控

  for (const card of cards.list.slice(0, maxPerRun)) {
    const btn = pick(SEL.polishBtn);
    if (!btn || !visible(btn.el)) continue;
    btn.el.click();
    count++;
    // 每个之间 2-4 秒随机间隔（模拟人工）
    await sleep(2000 + Math.random() * 2000);
  }

  if (count > 0) lastRun.polish = Date.now();
  return {
    ok: count > 0,
    count,
    reason: count > 0 ? `已擦亮 ${count} 个商品` : '没有可擦亮的商品',
  };
}

/* ------------------------------ 自动评价 ------------------------------ */

async function runRate({ text } = {}) {
  if (!canRate()) {
    return { ok: false, reason: '评价频率限制：每分钟最多 3 条' };
  }

  const btn = pick(SEL.rateBtn);
  if (!btn || !visible(btn.el)) {
    return {
      ok: false,
      reason: '找不到「评价」按钮。请在订单页打开待评价订单。',
      needManual: true,
    };
  }
  btn.el.click();
  await sleep(1000);

  // 填评价内容
  const tpl = String(text || '东西不错，发货很快，好评~');
  const ta = pick(SEL.rateTextarea);
  if (ta && visible(ta.el)) {
    if (ta.el.tagName === 'TEXTAREA') {
      ta.el.value = tpl;
      ta.el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      ta.el.textContent = tpl;
      ta.el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await sleep(500);
  }

  // 提交
  const submit = pick(SEL.rateSubmit);
  if (!submit || !visible(submit.el)) {
    return { ok: false, reason: '找不到提交按钮', needManual: true };
  }
  submit.el.click();
  lastRun.rate.push(Date.now());
  await sleep(1200);

  // 二次确认
  const confirm = pick(['[class*="confirm"] button[class*="primary"]', 'button[class*="sure"]']);
  if (confirm && visible(confirm.el)) {
    confirm.el.click();
    await sleep(600);
  }

  return { ok: true, reason: '已提交评价' };
}

/* ------------------------------ IPC ------------------------------ */

ipcRenderer.on('task:run', async (_e, { taskId, payload, requestId }) => {
  let result;
  try {
    if (taskId === 'polish') {
      result = await globalThis.__xyAutomation.enqueue(() => payload && payload.batch ? runPolishBatch() : runPolish());
    } else if (taskId === 'rate') {
      result = await globalThis.__xyAutomation.enqueue(() => runRate(payload || {}));
    } else {
      result = { ok: false, reason: `未知任务 ${taskId}` };
    }
  } catch (e) {
    result = { ok: false, reason: String(e && e.message || e) };
  }
  ipcRenderer.send('task:result', { taskId, requestId, ...result });
});

// 调试用
window.__xyTask = { runPolish, runPolishBatch, runRate };

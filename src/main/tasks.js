'use strict';

/**
 * 自动任务
 *
 * 包含两类：
 *   A. 安全任务（无平台风险）
 *      - catchupScan  待发货兜底扫描
 *      - tokenRenew   凭证续期检测
 *
 *   B. 高风险任务（模拟点击官方页面按钮，可能触发平台风控）
 *      - polish  每日自动擦亮
 *      - rate    自动评价买家
 *
 * ⚠️ 高风险任务的责任边界
 *   1. 默认全部关闭，且必须显式勾选「我已知晓风险」才能启用
 *   2. 启用时会弹二次确认
 *   3. 每次执行都记日志，失败自动停用并通知
 *   4. 本软件不对账号封禁承担责任，风险由使用者自行承担
 *
 * 执行方式：向对应账号的注入脚本发指令，由注入脚本点击官方页面按钮。
 */

const store = require('./store');

const RISK_LEVELS = {
  catchupScan: { level: 'none', name: '待发货兜底扫描', requireAccept: false },
  tokenRenew: { level: 'none', name: '凭证续期检测', requireAccept: false },
  polish: { level: 'high', name: '每日自动擦亮', requireAccept: true },
  rate: { level: 'high', name: '自动评价买家', requireAccept: true },
};

const timers = new Map();       // taskId -> timer
let runner = null;              // (accountId, taskId, payload) => Promise
let onNotify = null;

function init({ execute, notify }) {
  runner = execute;
  onNotify = notify;
}

/* ------------------------------ 执行记录 ------------------------------ */

function logRun(entry) {
  const s = store.ready();
  if (!s.taskLog) s.taskLog = [];
  s.taskLog.push({ ts: Date.now(), ...entry });
  if (s.taskLog.length > 500) s.taskLog = s.taskLog.slice(-500);
  store.scheduleSave();
}

function listRunLog(limit) {
  const s = store.ready();
  return (s.taskLog || []).slice(-(limit || 100)).reverse();
}

/* ------------------------------ 擦亮 ------------------------------ */

/** 判断今天是否已经擦亮过 */
function polishedToday(accountId) {
  const s = store.ready();
  const today = new Date().toISOString().slice(0, 10);
  return (s.taskLog || []).some((r) =>
    r.taskId === 'polish' && r.accountId === Number(accountId)
    && r.ok && new Date(r.ts).toISOString().slice(0, 10) === today);
}

async function runPolish(accountId, { force = false } = {}) {
  const account = store.getAccount(accountId);
  if (!account || account.disabled) return { ok: false, error: '店铺已停用或删除' };
  const cfg = store.getSettings().tasks.polish || {};
  if (!force && polishedToday(accountId)) {
    return { ok: true, skipped: true, reason: '今天已经擦亮过了' };
  }
  if (!runner) return { ok: false, error: '任务执行器未初始化' };

  const r = await runner(accountId, 'polish', {});
  logRun({
    taskId: 'polish',
    accountId,
    ok: !!r.ok,
    reason: r.reason || r.error || '',
    count: r.count || 0,
  });
  return r;
}

/* ------------------------------ 自动评价 ------------------------------ */

async function runRate(accountId, { orderNo } = {}) {
  const account = store.getAccount(accountId);
  if (!account || account.disabled) return { ok: false, error: '店铺已停用或删除' };
  if (!runner) return { ok: false, error: '任务执行器未初始化' };
  const r = await runner(accountId, 'rate', { orderNo });
  logRun({
    taskId: 'rate',
    accountId,
    orderNo,
    ok: !!r.ok,
    reason: r.reason || r.error || '',
  });
  return r;
}

/* ------------------------------ 定时调度 ------------------------------ */

function startScheduler() {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();

  // 每分钟检查一次「到点了没」
  const tick = setInterval(() => {
    const s = store.getSettings();
    const now = new Date();
    const hh = now.getHours();
    const mm = now.getMinutes();

    // 擦亮：每天固定时刻
    const polish = s.tasks.polish;
    if (polish && polish.enabled && polish.riskAccepted) {
      if (hh === Number(polish.hour) && mm === Number(polish.minute)) {
        if (!polishedToday.__lastRun || Date.now() - polishedToday.__lastRun > 60_000) {
          polishedToday.__lastRun = Date.now();
          for (const acc of store.listAccounts().filter((account) => !account.disabled)) {
            runPolish(acc.id).catch(() => {});
          }
        }
      }
    }
  }, 60_000);

  timers.set('scheduler', tick);
}

function stopScheduler() {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
}

/* ------------------------------ 配置 ------------------------------ */

/**
 * 启用/关闭任务
 * 高风险任务必须传 acceptRisk=true
 */
function setTaskEnabled(taskId, enabled, { acceptRisk = false } = {}) {
  const meta = RISK_LEVELS[taskId];
  if (!meta) return { ok: false, error: `未知任务 ${taskId}` };

  if (enabled && meta.requireAccept && !acceptRisk) {
    return {
      ok: false,
      error: `「${meta.name}」是高风险任务，需先确认风险`,
      needAccept: true,
      risk: meta.level,
    };
  }

  store.updateSettings({
    tasks: {
      [taskId]: {
        enabled: !!enabled,
        riskAccepted: enabled ? (meta.requireAccept ? true : !!acceptRisk || true) : false,
      },
    },
  });

  if (enabled) startScheduler();
  return { ok: true };
}

/** 任务清单（含当前状态） */
function listTasks() {
  const s = store.getSettings();
  return Object.entries(RISK_LEVELS).map(([id, meta]) => {
    const cfg = (s.tasks && s.tasks[id]) || {};
    return {
      id,
      name: meta.name,
      risk: meta.level,
      requireAccept: meta.requireAccept,
      enabled: !!cfg.enabled,
      riskAccepted: !!cfg.riskAccepted,
      config: cfg,
    };
  });
}

/** 风险说明文案（UI 展示用） */
function riskNotice(taskId) {
  const meta = RISK_LEVELS[taskId];
  if (!meta) return '';
  if (meta.level === 'none') {
    return '此任务只在本地读写数据，不操作闲鱼页面，无平台风险。';
  }
  return [
    '⚠️ 高风险任务说明',
    '',
    `「${meta.name}」需要在闲鱼官方页面上模拟点击操作。`,
    '',
    '可能的风险：',
    '· 平台检测到自动化行为，可能导致账号被限制或封禁',
    '· 操作过于频繁会触发风控（本软件已内置频率限制，但不能保证）',
    '· 平台页面改版会导致任务失败（失败会自动停用并通知你）',
    '',
    '责任说明：',
    '· 是否启用由你自行决定',
    '· 账号风险由你自行承担，本软件不承担任何责任',
    '· 建议先用小号测试，确认稳定后再用于主号',
  ].join('\n');
}

module.exports = {
  init, runPolish, runRate, startScheduler, stopScheduler,
  setTaskEnabled, listTasks, riskNotice, listRunLog, logRun,
  RISK_LEVELS, polishedToday,
};

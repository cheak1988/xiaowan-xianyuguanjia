'use strict';

/**
 * 通知告警
 *
 * 支持渠道（全部纯 HTTP，零依赖）：
 *   - Bark（iOS 推送，最简单）
 *   - 钉钉机器人
 *   - 飞书机器人
 *   - 企业微信机器人
 *   - Telegram Bot
 *   - SMTP 邮件
 *   - 自定义 Webhook（POST JSON）
 *
 * 触发场景：
 *   - 会话超时未回复
 *   - 自动发货成功 / 失败
 *   - 卡密库存不足
 *   - 账号登录态失效
 *   - 任务执行失败
 *
 * 设计原则：
 *   1. 发送失败只记日志，绝不阻塞主流程
 *   2. 同一内容 60 秒内不重复推送（防轰炸）
 *   3. 每个渠道独立配置、独立开关
 */

const store = require('./store');

const DEDUP_MS = 60_000;
const lastSent = new Map(); // `${channel}:${hash}` -> ts

/* ------------------------------ HTTP ------------------------------ */

function request(urlStr, { method = 'POST', headers = {}, body, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (_) { resolve({ ok: false, error: 'URL 不合法' }); return; }

    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const payload = typeof body === 'string' ? body : (body == null ? '' : JSON.stringify(body));

    const req = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({
          ok,
          status: res.statusCode,
          body: text.slice(0, 300),
          // 非 2xx 时把响应体当错误信息，方便 UI 直接展示
          error: ok ? undefined : `HTTP ${res.statusCode}: ${text.slice(0, 150)}`,
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`超时(${timeoutMs}ms)`)));
    req.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

/* ------------------------------ 各渠道发送 ------------------------------ */

/** Bark：GET https://api.day.app/<key>/<title>/<body> */
async function sendBark(cfg, title, body) {
  if (!cfg.key) return { ok: false, error: '未配置 Bark Key' };
  const base = (cfg.server || 'https://api.day.app').replace(/\/+$/, '');
  const url = `${base}/${encodeURIComponent(cfg.key)}/${encodeURIComponent(title)}/${encodeURIComponent(body)}`;
  const r = await request(url, { method: 'GET' });
  return r;
}

/** 钉钉机器人 */
async function sendDingTalk(cfg, title, body) {
  if (!cfg.webhook) return { ok: false, error: '未配置钉钉 Webhook' };
  let url = cfg.webhook;
  // 支持加签
  if (cfg.secret) {
    const crypto = require('crypto');
    const ts = Date.now();
    const sign = crypto.createHash('sha256')
      .update(`${ts}\n${cfg.secret}`, 'utf8')
      .digest('base64');
    url += `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
  }
  return request(url, {
    body: {
      msgtype: 'markdown',
      markdown: { title, text: `### ${title}\n\n${body}` },
    },
  });
}

/** 飞书机器人 */
async function sendFeishu(cfg, title, body) {
  if (!cfg.webhook) return { ok: false, error: '未配置飞书 Webhook' };
  return request(cfg.webhook, {
    body: {
      msg_type: 'text',
      content: { text: `${title}\n\n${body}` },
    },
  });
}

/** 企业微信机器人 */
async function sendWeCom(cfg, title, body) {
  if (!cfg.webhook) return { ok: false, error: '未配置企业微信 Webhook' };
  return request(cfg.webhook, {
    body: {
      msgtype: 'markdown',
      markdown: { content: `**${title}**\n${body}` },
    },
  });
}

/** Telegram Bot */
async function sendTelegram(cfg, title, body) {
  if (!cfg.botToken || !cfg.chatId) return { ok: false, error: '未配置 Telegram BotToken / ChatId' };
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  return request(url, {
    body: {
      chat_id: cfg.chatId,
      text: `${title}\n\n${body}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    },
  });
}

/** SMTP 邮件（用 net 手写最简 SMTP） */
function sendMail(cfg, title, body) {
  return new Promise((resolve) => {
    if (!cfg.host || !cfg.user || !cfg.pass || !cfg.to) {
      resolve({ ok: false, error: '邮件配置不完整（host/user/pass/to）' });
      return;
    }
    const net = require('net');
    const tls = require('tls');
    const port = Number(cfg.port) || 465;
    let sock = null;
    const steps = [];
    let stage = 0;

    const send = (line) => { try { sock.write(line + '\r\n'); } catch (_) {} };
    const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      const code = text.slice(0, 3);
      if (code === '220' && stage === 0) { stage = 1; send('EHLO localhost'); return; }
      if (code === '250' && stage === 1) {
        if (port === 465) { sock = tls.connect({ socket: sock, servername: cfg.host }, () => {}); sock.on('data', onData); }
        stage = 2;
        send('AUTH LOGIN');
        return;
      }
      if (text.includes('334') && stage === 2) { stage = 3; send(b64(cfg.user)); return; }
      if (text.includes('334') && stage === 3) { stage = 4; send(b64(cfg.pass)); return; }
      if (code === '235' && stage === 4) {
        stage = 5;
        send(`MAIL FROM:<${cfg.user}>`);
        return;
      }
      if (code === '250' && stage === 5) { stage = 6; send(`RCPT TO:<${cfg.to}>`); return; }
      if (code === '250' && stage === 6) { stage = 7; send('DATA'); return; }
      if (code === '354' && stage === 7) {
        const msg = [
          `From: ${cfg.user}`,
          `To: ${cfg.to}`,
          `Subject: =?UTF-8?B?${b64(title)}?=`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          b64(body),
          '.',
        ].join('\r\n');
        send(msg);
        stage = 8;
        return;
      }
      if (code === '250' && stage === 8) { send('QUIT'); resolve({ ok: true }); }
      if (code.startsWith('5')) { resolve({ ok: false, error: `SMTP ${code}: ${text.slice(0, 120)}` }); }
    };

    try {
      if (port === 465) {
        sock = tls.connect({ host: cfg.host, port, servername: cfg.host, rejectUnauthorized: false });
      } else {
        sock = net.connect({ host: cfg.host, port });
      }
      sock.on('data', onData);
      sock.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e) }));
      sock.setTimeout(15000, () => { try { sock.destroy(); } catch (_) {} resolve({ ok: false, error: 'SMTP 超时' }); });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

/** 自定义 Webhook */
async function sendWebhook(cfg, title, body) {
  if (!cfg.url) return { ok: false, error: '未配置 Webhook URL' };
  return request(cfg.url, {
    method: cfg.method || 'POST',
    headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
    body: {
      title,
      body,
      text: `${title}\n${body}`,
      timestamp: Date.now(),
      source: '小丸闲鱼管家',
    },
  });
}

const SENDERS = {
  bark: sendBark,
  dingtalk: sendDingTalk,
  feishu: sendFeishu,
  wecom: sendWeCom,
  telegram: sendTelegram,
  mail: sendMail,
  webhook: sendWebhook,
};

/* ------------------------------ 对外接口 ------------------------------ */

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * 发送通知到所有已启用的渠道
 * @param {object} opt
 * @param {string} opt.title
 * @param {string} opt.body
 * @param {string} [opt.event]  事件类型，用于按事件过滤渠道
 * @param {boolean} [opt.force] 跳过去重
 * @returns {Promise<Array<{channel, ok, error?}>>}
 */
async function notify({ title, body, event = 'general', force = false }) {
  const settings = store.getSettings();
  const cfg = settings.notify || {};
  const results = [];

  const contentKey = hash(title + '|' + body);
  for (const [channel, sender] of Object.entries(SENDERS)) {
    const c = cfg[channel];
    if (!c || !c.enabled) continue;
    // 按事件订阅过滤
    if (Array.isArray(c.events) && c.events.length && !c.events.includes(event)) continue;

    const key = `${channel}:${contentKey}`;
    const prev = lastSent.get(key) || 0;
    if (!force && Date.now() - prev < DEDUP_MS) {
      results.push({ channel, ok: true, skipped: true });
      continue;
    }

    let r;
    try {
      r = await sender(c, title, body);
    } catch (e) {
      r = { ok: false, error: String(e && e.message || e) };
    }
    if (r.ok) lastSent.set(key, Date.now());
    results.push({ channel, ...r });

    store.pushNotifyLog({
      channel,
      title,
      body: body.slice(0, 200),
      ok: !!r.ok,
      error: r.error || null,
      skipped: false,
    });
  }

  if (lastSent.size > 500) {
    const arr = [...lastSent.entries()].sort((a, b) => b[1] - a[1]);
    lastSent.clear();
    for (const [k, v] of arr.slice(0, 100)) lastSent.set(k, v);
  }

  return results;
}

/** 测试单个渠道 */
async function testChannel(channel, cfgOverride) {
  const sender = SENDERS[channel];
  if (!sender) return { ok: false, error: `未知渠道 ${channel}` };

  const settings = store.getSettings();
  const cfg = { ...((settings.notify || {})[channel] || {}), ...(cfgOverride || {}) };
  if (!cfg.enabled) cfg.enabled = true; // 测试时忽略开关

  try {
    const r = await sender(cfg, '【测试】小丸闲鱼管家', '这是一条测试消息，收到说明配置正确。');
    store.pushNotifyLog({
      channel, title: '测试消息', body: '渠道连通性测试',
      ok: !!r.ok, error: r.error || null,
    });
    return r;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function listChannels() {
  return [
    { id: 'bark', name: 'Bark（iOS 推送）', fields: ['key', 'server'] },
    { id: 'dingtalk', name: '钉钉机器人', fields: ['webhook', 'secret'] },
    { id: 'feishu', name: '飞书机器人', fields: ['webhook'] },
    { id: 'wecom', name: '企业微信机器人', fields: ['webhook'] },
    { id: 'telegram', name: 'Telegram', fields: ['botToken', 'chatId'] },
    { id: 'mail', name: '邮件 SMTP', fields: ['host', 'port', 'user', 'pass', 'to'] },
    { id: 'webhook', name: '自定义 Webhook', fields: ['url', 'method'] },
  ];
}

module.exports = { notify, testChannel, listChannels, SENDERS };

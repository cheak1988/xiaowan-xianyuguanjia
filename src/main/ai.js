'use strict';

/**
 * AI 回复模块
 *
 * 兼容 OpenAI Chat Completions 协议，因此可以接：
 *   - OpenAI / DeepSeek / Moonshot / 通义 / 智谱 / 本地 Ollama / vLLM / one-api
 * 只需要在设置里填 baseURL + model + apiKey 即可。
 *
 * 设计取舍：
 *   - 不引入 SDK，纯 fetch，零依赖，避免打包体积和版本冲突
 *   - 带超时与重试，失败静默降级到规则回复（不阻塞客服）
 *   - 强制让模型只输出回复正文，不要解释
 */

const store = require('./store');

const TIMEOUT_MS = 30_000;

/**
 * 发起 JSON POST。
 * Electron 22 的 Node 没有全局 fetch，这里用内置 http/https，零依赖。
 */
function postJSON(urlStr, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('接口地址不合法')); return; }

    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const body = JSON.stringify(payload);
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        resolve(text);
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`超时(${timeoutMs}ms)`));
    });
    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
}

/**
 * 把对话历史 + 店铺人设 + 商品/订单上下文，拼成 messages 数组
 */
function buildMessages({ account, session, history, userText, settings, bargainHints }) {
  const ai = settings.ai;
  const sysParts = [ai.systemPrompt];

  const persona = (account && account.persona || '').trim();
  if (persona) sysParts.push(`店铺补充说明：${persona}`);

  if (session) {
    const ctx = [];
    if (session.item_id) ctx.push(`当前咨询商品ID：${session.item_id}`);
    if (session.order_id) ctx.push(`关联订单号：${session.order_id}`);
    if (ctx.length) sysParts.push(`会话上下文：${ctx.join('；')}`);
  }

  // 议价约束（硬性规则，必须让模型遵守）
  if (bargainHints && bargainHints.bargain) {
    const lines = [
      `买家正在砍价，这是第 ${bargainHints.rounds}/${bargainHints.maxRounds} 轮。`,
    ];
    if (bargainHints.constraint) lines.push(bargainHints.constraint);
    if (bargainHints.listPrice) lines.push(`商品标价 ${bargainHints.listPrice} 元。`);
    if (bargainHints.suggestion != null) {
      lines.push(`建议报价 ${bargainHints.suggestion} 元（可直接使用，也可略高于这个数）。`);
    }
    lines.push('绝对不能低于上面说的最低可接受价，也不要用"可以再便宜"这类暗示。');
    sysParts.push(lines.join('\n'));
  }

  sysParts.push(
    `只输出要发给买家的消息正文，不要加引号、不要解释、不要 Markdown。` +
    `如果无法回答，就输出：这个我确认一下，稍后回复您~`,
  );

  const messages = [{ role: 'system', content: sysParts.join('\n') }];

  // 最近若干轮对话作为上下文。
  // 调用方通常已把「当前这条消息」也存进了历史，这里按内容比对去掉它，
  // 避免同一条话出现两次（比无条件 slice(0,-1) 更稳）。
  const hist = (history || []).slice(-(ai.contextMessages || 10));
  const last = hist[hist.length - 1];
  const dropLast = last && last.role === 'user' && last.text === userText;
  const ctx = dropLast ? hist.slice(0, -1) : hist;

  for (const m of ctx) {
    if (!m.text) continue;
    messages.push({ role: m.role, content: m.text.slice(0, 1000) });
  }

  messages.push({ role: 'user', content: userText });
  return messages;
}

function cleanReply(text, maxChars) {
  let t = String(text || '').trim();
  t = t.replace(/^["'“”«»]+|["'“”«»]+$/g, '').trim();
  t = t.replace(/^(回复|答复)[:：]\s*/, '');
  // maxChars <= 0 视为「不限制」；否则按上限截断
  const limit = Number(maxChars) || 0;
  if (limit > 0 && t.length > limit) t = t.slice(0, limit);
  return t;
}

async function chat({ account, session, history, userText, bargainHints, testConfig }) {
  const saved = store.getSettings();
  const settings = testConfig ? { ...saved, ai: { ...saved.ai, ...testConfig, enabled: true } } : saved;
  const ai = settings.ai;

  if (!ai.enabled) return { ok: false, error: 'AI 未启用' };
  const apiKey = String(testConfig?.apiKey || store.getAiKey() || '').trim();

  let endpoint;
  try {
    endpoint = new URL(String(ai.baseURL || '').trim());
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
  } catch (_) { return { ok: false, error: '接口地址无效，请填写 HTTP 或 HTTPS 地址' }; }
  if (!apiKey && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(endpoint.hostname.toLowerCase())) return { ok: false, error: '未配置 API Key，本地免 Key 服务可留空' };
  const model = String(ai.model || '').trim();
  if (!model) return { ok: false, error: '请填写模型名称' };
  const base = endpoint.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

  const body = {
    model,
    messages: buildMessages({ account, session, history, userText, settings, bargainHints }),
    temperature: Number.isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.7,
    max_tokens: testConfig ? 100 : Number(ai.maxTokens) || 300,
    stream: false,
  };

  const started = Date.now();

  try {
    const text = await postJSON(
      `${base}/chat/completions`,
      apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body,
      TIMEOUT_MS,
    );

    let data;
    try { data = JSON.parse(text); } catch (_) {
      return { ok: false, error: '接口没有返回 OpenAI 兼容的 JSON 响应' };
    }

    const content = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'AI 返回内容为空，请检查模型名称或接口协议' };

    const reply = cleanReply(content, ai.maxReplyChars);
    if (!reply) return { ok: false, error: 'AI 回复清洗后为空' };

    return {
      ok: true,
      reply,
      ms: Date.now() - started,
      tokens: data.usage ? data.usage.total_tokens : null,
      model: data.model || ai.model,
    };
  } catch (e) {
    let msg = String(e && e.message || e);
    if (apiKey) msg = msg.split(apiKey).join('[已隐藏密钥]');
    if (msg.includes('ECONNREFUSED')) msg = '无法连接接口，请检查本机代理是否启动及端口是否正确';
    if (/HTTP 401/.test(msg)) msg = 'HTTP 401：接口认证失败，请检查 API Key 是否与代理配置一致';
    return { ok: false, error: msg, ms: Date.now() - started };
  }
}

/** 连通性测试：发一句最便宜的请求 */
async function test(config = {}) {
  const r = await chat({
    account: null,
    session: null,
    history: [],
    userText: '在吗',
    testConfig: config,
  });
  return r;
}

module.exports = { chat, test, buildMessages, cleanReply, postJSON };

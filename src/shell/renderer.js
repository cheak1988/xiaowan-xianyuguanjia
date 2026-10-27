'use strict';

let currentAccountId = null;
let accounts = [];
let statuses = {};       // accountId -> { loggedIn }
let rules = [];
let settings = null;
let activeTab = 'rules';

const $ = (id) => document.getElementById(id);

/**
 * 容器覆盖表
 * 设置页要把右侧面板的渲染逻辑复用到独立页面，
 * 这里把 tab-xxx 的查询重定向到 stab-xxx。
 */
const containerOverride = new Map();

/** 取容器：优先用覆盖表，其次按 id 查 */
function $$(id) {
  if (containerOverride.has(id)) {
    const el = containerOverride.get(id);
    if (el && el.isConnected) return el;
    containerOverride.delete(id);
  }
  return document.getElementById(id);
}
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(text, ms = 2500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* ------------------------------ 账号 ------------------------------ */

async function renderAccounts(list) {
  if (list) accounts = list;
  window.UI.setWorkspace({ accounts, statuses, accountId: currentAccountId, view: currentView });
  const box = $('accounts');
  box.innerHTML = '';

  if (!accounts.length) {
    box.innerHTML = '<div class="muted" style="padding:12px 8px">添加店铺后，会显示在这里</div>';
    return;
  }

  for (const acc of accounts) {
    const st = statuses[acc.id];
    const dotCls = acc.disabled ? '' : st ? (st.loggedIn ? 'on' : 'off') : '';
    const stateText = acc.disabled ? '已停用' : st ? (st.loggedIn ? '已连接' : '待登录') : '等待连接';
    const el = document.createElement('div');
    el.className = 'acc' + (acc.id === currentAccountId ? ' active' : '');
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.setAttribute('aria-pressed', String(acc.id === currentAccountId));
    el.innerHTML = `
      <span class="acc-avatar">${esc(String(acc.label || '店').slice(0, 1))}</span>
      <span class="acc-main"><span class="name">${esc(acc.label)}</span><span class="acc-state"><span class="dot ${dotCls}"></span>${stateText}</span></span>
      <button class="x" title="移除店铺" aria-label="移除店铺">${window.UI.icon('close')}</button>
    `;
    el.onclick = async (e) => {
      if (e.target.closest('.x')) {
        const okDel = await window.dlg.confirm({
          title: '移除账号',
          body: `确认移除「${acc.label}」？
该账号的会话、消息、规则、卡密都会一并删除，不可恢复。`,
          okText: '移除', danger: true,
        });
        if (!okDel) return;
        await window.api.accounts.remove(acc.id);
        if (currentAccountId === acc.id) {
          currentAccountId = null;
          $('placeholder').style.display = '';
        }
        await renderAccounts(await window.api.accounts.list());
        return;
      }
      currentAccountId = acc.id;
      $('placeholder').style.display = 'none';
      await window.api.accounts.activate(acc.id);
      await renderAccounts(await window.api.accounts.list());
      await Promise.all([loadRules(), loadLog()]);
      if (activeTab === 'ai') renderAi();
    };
    el.onkeydown = (event) => {
      if (event.target === el && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); el.click();
      }
    };
    box.appendChild(el);
  }
}

/* ------------------------------ 规则 ------------------------------ */

async function loadRules() {
  rules = currentAccountId ? await window.api.rules.list(currentAccountId) : [];
  renderRules();
}

function renderRules() {
  const box = $$('tab-rules');
  box.innerHTML = '';

  if (!currentAccountId) {
    box.innerHTML = '<div class="muted">请先选择左侧账号</div>';
    return;
  }

  const global = document.createElement('div');
  global.className = 'card';
  global.innerHTML = `
    <label class="switch">
      <input type="checkbox" id="chk-auto" ${settings && settings.autoReply.enabled ? 'checked' : ''} />
      <span>自动回复总开关</span>
    </label>
    <div class="muted" style="margin-top:4px">
      规则优先；规则未命中时，若已启用 AI 则交给 AI 生成。
    </div>
    <div style="margin-top:10px;padding-top:8px;border-top:1px solid #f0f1f3">
      <label class="switch">
        <input type="checkbox" id="chk-remind" ${settings && settings.reminder && settings.reminder.enabled ? 'checked' : ''} />
        <span>超时提醒</span>
      </label>
      <div class="row" style="margin-top:6px">
        <span class="muted">买家最后一句超过</span>
        <input id="remind-min" type="number" min="1" max="120"
          value="${settings && settings.reminder ? settings.reminder.timeoutMinutes : 5}"
          style="width:60px;padding:2px 6px" />
        <span class="muted">分钟未回复就提醒我</span>
      </div>
    </div>
    <div class="row" style="margin-top:10px;padding-top:8px;border-top:1px solid #f0f1f3">
      <button id="btn-import" style="font-size:13px">导入 CSV</button>
      <button id="btn-export" style="font-size:13px">导出 CSV</button>
    </div>
    <div class="muted" style="margin-top:4px;font-size:10px">CSV 格式：分组,关键词,内容（关键词用 | 分隔）</div>
  `;
  box.appendChild(global);

  global.querySelector('#chk-auto').onchange = async (e) => {
    settings = await window.api.settings.update({ autoReply: { enabled: e.target.checked } });
    toast(e.target.checked ? '自动回复已开启' : '自动回复已关闭');
  };

  const saveReminder = async () => {
    settings = await window.api.settings.update({
      reminder: {
        enabled: global.querySelector('#chk-remind').checked,
        timeoutMinutes: Number(global.querySelector('#remind-min').value) || 5,
      },
    });
  };
  global.querySelector('#chk-remind').onchange = async () => { await saveReminder(); toast('已保存'); };
  global.querySelector('#remind-min').onchange = async () => { await saveReminder(); toast('已保存'); };

  global.querySelector('#btn-import').onclick = async () => {
    const r = await window.api.rules.importCsv(currentAccountId);
    if (!r.ok) return;
    toast(`导入完成：新增 ${r.added} 条，跳过 ${r.skipped} 条`);
    await loadRules();
  };
  global.querySelector('#btn-export').onclick = async () => {
    const r = await window.api.rules.exportCsv(currentAccountId);
    if (r.ok) toast('已导出到 ' + r.path, 4000);
  };

  if (!rules.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.margin = '12px 0';
    empty.textContent = '还没有规则';
    box.appendChild(empty);
  }

  for (const rule of rules) {
    const el = document.createElement('div');
    el.className = 'card';
    const typeName = rule.match_type === 3 ? '全部消息' : (rule.match_type === 2 ? '正则' : '关键词');
    el.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <b style="font-size:13px">${esc(rule.name || '未命名')}</b>
        <label class="switch"><input type="checkbox" ${rule.status ? 'checked' : ''}/><span class="muted">启用</span></label>
      </div>
      <div class="muted" style="margin-top:4px">
        ${typeName}${rule.keywords.length ? '：' + esc(rule.keywords.join(' / ')) : ''}
      </div>
      <div style="font-size:13px;margin-top:4px;color:var(--ink-2);word-break:break-all">${esc(rule.content).slice(0, 140)}</div>
      <div class="row" style="margin-top:6px">
        <button data-act="edit" style="font-size:13px">编辑</button>
        <button data-act="del" style="font-size:13px;color:var(--danger)">删除</button>
      </div>
    `;
    el.querySelector('input[type=checkbox]').onchange = async (e) => {
      await window.api.rules.save({ ...rule, accountId: currentAccountId, status: e.target.checked ? 1 : 0 });
      await loadRules();
    };
    el.querySelector('[data-act=edit]').onclick = () => editRule(rule);
    el.querySelector('[data-act=del]').onclick = async () => {
      const okRule = await window.dlg.confirm({
        title: '删除规则',
        body: `确认删除「${rule.name || '未命名'}」？`,
        okText: '删除', danger: true,
      });
      if (!okRule) return;
      await window.api.rules.remove(rule.id);
      await loadRules();
    };
    box.appendChild(el);
  }

  const add = document.createElement('button');
  add.className = 'primary';
  add.textContent = '＋ 新增规则';
  add.onclick = () => editRule(null);
  box.appendChild(add);
}

async function editRule(rule) {
  const isNew = !rule;
  const base = rule || { match_type: 1, keywords: [], content: '', status: 1, name: '' };

  const r = await window.dlg.form({
    title: isNew ? '新增回复规则' : '编辑回复规则',
    okText: '保存',
    fields: [
      { key: 'name', label: '规则名称', value: base.name || '', placeholder: '例如：发货时效', required: true },
      { key: 'match_type', label: '匹配方式', type: 'select', value: String(base.match_type || 1),
        options: [
          { value: '1', label: '关键词（包含任一）' },
          { value: '2', label: '正则表达式' },
          { value: '3', label: '全部消息' },
        ] },
      { key: 'keywords', label: '关键词', value: (base.keywords || []).join(','),
        placeholder: '多个用英文逗号分隔，如：发货,几天到',
        hint: '选「全部消息」可留空；选「正则」时填一条正则' },
      { key: 'content', label: '回复内容', type: 'textarea', rows: 4, value: base.content || '',
        placeholder: '买家命中后自动回复的内容', required: true },
    ],
  });
  if (!r) return;

  const matchType = Number(r.match_type) || 1;
  const keywords = matchType === 3 ? []
    : String(r.keywords || '').split(',').map((x) => x.trim()).filter(Boolean);

  await window.api.rules.save({
    ...base,
    id: isNew ? undefined : base.id,
    accountId: currentAccountId,
    name: r.name.trim(),
    match_type: matchType,
    keywords,
    content: r.content.trim(),
  });
  await loadRules();
  toast(isNew ? '规则已新增' : '规则已保存');
}

/* ------------------------------ AI 设置 ------------------------------ */

function renderAi() {
  const box = $$('tab-ai');
  const ai = settings.ai;
  box.innerHTML = `
    <div class="card">
      <label class="switch">
        <input type="checkbox" id="ai-enabled" ${ai.enabled ? 'checked' : ''} />
        <span>启用 AI 回复（规则未命中时兜底）</span>
      </label>
    </div>

    <div class="field">
      <label>接口地址（OpenAI 兼容）</label>
      <input id="ai-base" value="${esc(ai.baseURL)}" placeholder="https://api.openai.com/v1" />
      <div class="muted" style="margin-top:3px">
        可填 DeepSeek: https://api.deepseek.com/v1 ｜ Ollama: http://127.0.0.1:11434/v1
      </div>
    </div>

    <div class="field">
      <label>API Key ${ai.apiKeySet ? '<span style="color:var(--ok)">（已配置）</span>' : ''}</label>
      <input id="ai-key" type="password" placeholder="${ai.apiKeySet ? '已保存，留空则不修改' : 'sk-...'}" />
    </div>

    <div class="field">
      <label>模型</label>
      <input id="ai-model" value="${esc(ai.model)}" placeholder="gpt-4o-mini / deepseek-chat / qwen2.5" />
    </div>

    <div class="row" style="gap:10px">
      <div class="field" style="flex:1">
        <label>温度</label>
        <input id="ai-temp" type="number" step="0.1" min="0" max="2" value="${ai.temperature}" />
      </div>
      <div class="field" style="flex:1">
        <label>最大字数</label>
        <input id="ai-max" type="number" min="30" max="2000" value="${ai.maxReplyChars}" />
      </div>
    </div>

    <div class="field">
      <label>人工接管静默（分钟）</label>
      <input id="ai-quiet" type="number" min="0" max="120" value="${ai.quietMinutes}" />
      <div class="muted" style="margin-top:3px">你手动发过消息后，这段时间内不会自动回复</div>
    </div>

    <div class="field">
      <label>系统提示词</label>
      <textarea id="ai-prompt" rows="5">${esc(ai.systemPrompt)}</textarea>
    </div>

    <div class="row" style="margin-bottom:8px">
      <button class="primary" id="ai-save">保存</button>
      <button id="ai-test">测试连通</button>
      <span class="muted" id="ai-test-result"></span>
    </div>

    <div class="muted">
      测试使用当前填写的配置，不会自动开启回复或保存设置。本机免 Key 服务可以留空；正式自动回复需保存并启用。
    </div>
  `;

  box.querySelector('#ai-save').onclick = async () => {
    const patch = {
      ai: {
        enabled: box.querySelector('#ai-enabled').checked,
        baseURL: box.querySelector('#ai-base').value.trim(),
        model: box.querySelector('#ai-model').value.trim(),
        temperature: Number(box.querySelector('#ai-temp').value),
        maxReplyChars: Number(box.querySelector('#ai-max').value),
        quietMinutes: Number(box.querySelector('#ai-quiet').value),
        systemPrompt: box.querySelector('#ai-prompt').value,
      },
    };
    settings = await window.api.settings.update(patch);

    const key = box.querySelector('#ai-key').value.trim();
    if (key) {
      const r = await window.api.ai.setKey(key);
      toast(r.encrypted ? 'Key 已加密保存' : 'Key 已保存（本机无法加密，明文存储）');
    }
    settings = await window.api.settings.get();
    renderAi();
    toast('已保存');
  };

  box.querySelector('#ai-test').onclick = async () => {
    const out = box.querySelector('#ai-test-result');
    const button = box.querySelector('#ai-test');
    out.textContent = '测试中…';
    button.disabled = true;
    try {
      const r = await window.api.ai.test({ baseURL: box.querySelector('#ai-base').value.trim(), model: box.querySelector('#ai-model').value.trim(),
        apiKey: box.querySelector('#ai-key').value.trim(), temperature: Number(box.querySelector('#ai-temp').value),
        maxReplyChars: Number(box.querySelector('#ai-max').value), systemPrompt: box.querySelector('#ai-prompt').value });
      out.className = r.ok ? 'log-ok' : 'log-fail';
      out.textContent = r.ok ? `成功：${r.reply.slice(0, 30)}（${r.ms}ms）` : `失败：${r.error}`;
    } catch (error) { out.className = 'log-fail'; out.textContent = `失败：${error.message}`; }
    finally { button.disabled = false; }
  };
}

/* ------------------------------ 自动发货 ------------------------------ */

let deliverRules = [];
let cardStats = {};

async function loadDelivery() {
  if (!currentAccountId) { deliverRules = []; cardStats = {}; renderDelivery(); return; }
  deliverRules = await window.api.delivery.rules(currentAccountId);
  cardStats = await window.api.delivery.cardStats(currentAccountId);
  renderDelivery();
}

function renderDelivery() {
  const box = $$('tab-delivery');
  box.innerHTML = '';

  if (!currentAccountId) {
    box.innerHTML = '<div class="muted">请先选择账号</div>';
    return;
  }

  const intro = document.createElement('div');
  intro.className = 'card';
  intro.innerHTML = `
    <div style="font-size:13px;font-weight:600">虚拟商品自动发货</div>
    <div class="muted" style="margin-top:4px;line-height:1.6">
      原理：在官方订单页识别「待发货」订单 → 匹配商品 → 取一条卡密 → 通过 IM 发给买家。<br/>
      支持文本卡密、图片卡密和 API 按订单取卡。每张图片作为一份卡密，发送结果不明确时保留占用，先核对后处理。
    </div>
    <div class="row" style="margin-top:8px">
      <button id="btn-open-order">打开订单页</button>
      <span class="muted">需要先在官方订单页登录</span>
    </div>
  `;
  box.appendChild(intro);
  intro.querySelector('#btn-open-order').onclick = async () => {
    const ok = await window.api.delivery.openOrderPage(currentAccountId);
    toast(ok ? '订单页已在后台打开（可能在另一个标签/窗口）' : '打开失败');
  };

  if (!deliverRules.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.margin = '12px 0';
    empty.textContent = '还没有配置商品';
    box.appendChild(empty);
  }

  for (const rule of deliverRules) {
    const stats = cardStats[rule.item_id] || { total: 0, unused: 0, used: 0 };
    const low = stats.unused === 0;
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <b style="font-size:13px">${esc(rule.item_title || rule.item_id)}</b>
        <label class="switch"><input type="checkbox" ${rule.enabled ? 'checked' : ''}/><span class="muted">启用</span></label>
      </div>
      <div class="muted" style="margin-top:3px">商品ID：${esc(rule.item_id)}</div>
      <div class="muted">发货类型：${({ text: '文本卡密', image: '图片卡密', api: 'API 按订单取卡' })[rule.card_type] || '文本卡密'}</div>
      <div style="margin-top:6px;font-size:13px">
        卡密库存：
        <b style="color:${low ? '#dc2626' : '#16a34a'}">${stats.unused}</b> 条可用
        <span class="muted">（共 ${stats.total}，已用 ${stats.used}）</span>
      </div>
      ${rule.delay_seconds ? `<div class="muted">延迟 ${rule.delay_seconds} 秒发送</div>` : ''}
      <div class="muted" style="margin-top:4px;word-break:break-all">
        模板：${esc(rule.template).slice(0, 80)}
      </div>
      <div class="row" style="margin-top:6px">
        <button data-act="cards" style="font-size:13px">管理卡密</button>
        <button data-act="edit" style="font-size:13px">编辑</button>
        <button data-act="del" style="font-size:13px;color:var(--danger)">删</button>
      </div>
    `;
    el.querySelector('input[type=checkbox]').onchange = async (e) => {
      await window.api.delivery.saveRule({
        ...rule, accountId: currentAccountId, enabled: e.target.checked,
      });
      await loadDelivery();
    };
    el.querySelector('[data-act=cards]').onclick = () => openCardManager(rule);
    el.querySelector('[data-act=edit]').onclick = () => editDeliverRule(rule);
    el.querySelector('[data-act=del]').onclick = async () => {
      const okRule2 = await window.dlg.confirm({
        title: '删除发货配置',
        body: `确认删除「${rule.item_title || rule.item_id}」的自动发货配置？
已导入的卡密不会被删除。`,
        okText: '删除', danger: true,
      });
      if (!okRule2) return;
      await window.api.delivery.removeRule(rule.id);
      await loadDelivery();
    };
    box.appendChild(el);
  }

  const add = document.createElement('button');
  add.className = 'primary';
  add.style.marginTop = '4px';
  add.textContent = '＋ 添加商品';
  add.onclick = () => editDeliverRule(null);
  box.appendChild(add);

  // 发货记录
  const logBox = document.createElement('div');
  logBox.id = 'deliver-log';
  logBox.style.marginTop = '14px';
  box.appendChild(logBox);
  loadDeliverLog(logBox);
}

async function loadDeliverLog(container) {
  const logs = await window.api.delivery.log(currentAccountId, 30);
  if (!logs.length) {
    container.innerHTML = '<div class="muted" style="font-size:13px">暂无发货记录</div>';
    return;
  }
  const rows = logs.map((l) => {
    const t = new Date(l.ts).toLocaleString('zh-CN', { hour12: false });
    return `<div class="log-item">
      <div class="muted">${t} · ${esc(l.order_no)}</div>
      <div class="${l.ok ? 'log-ok' : 'log-fail'}">${l.ok ? '✓ ' : '✕ '}${esc(l.reason)}</div>
    </div>`;
  }).join('');
  container.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:4px">发货记录</div>${rows}`;
}

async function editDeliverRule(rule) {
  const isNew = !rule;
  const base = rule || {
    item_id: '', item_title: '', enabled: true,
    template: '您好，您的卡密是：{卡密}\n订单号：{订单号}\n请尽快使用，有问题随时联系~',
    delay_seconds: 0, full_auto: false,
  };

  const r = await window.dlg.form({
    title: isNew ? '添加自动发货商品' : '编辑自动发货',
    body: '商品ID 在闲鱼商品详情页链接里，形如 id=123456789',
    okText: '保存',
    fields: [
      { key: 'item_id', label: '闲鱼商品ID', value: base.item_id, placeholder: '123456789', required: true },
      { key: 'item_title', label: '商品标题', value: base.item_title || '', placeholder: '方便你辨认，如：腾讯视频月卡' },
      { key: 'card_type', label: '卡密类型', type: 'select', value: base.card_type || 'text', options: [
        { value: 'text', label: '文本卡密（每行一份）' }, { value: 'image', label: '图片卡密（每张一份）' }, { value: 'api', label: 'API 按订单取卡（无需导入卡池）' },
      ] },
      { key: 'api_url', label: '取卡接口（仅 API 类型填写）', value: base.api_url || '', placeholder: 'https://... 可使用 {订单号} 和 {商品ID}' },
      { key: 'delay_seconds', label: '延迟发送（秒）', type: 'number', value: base.delay_seconds || 0,
        hint: '0 = 立即发送；建议 5~30 秒，避免秒发被判定异常' },
      { key: 'template', label: '消息模板', type: 'textarea', rows: 5, value: base.template || '',
        hint: '可用变量：{卡密} {订单号} {买家昵称} {商品标题} {时间}', required: true },
    ],
  });
  if (!r) return;

  await window.api.delivery.saveRule({
    id: isNew ? undefined : base.id,
    accountId: currentAccountId,
    item_id: String(r.item_id).trim(),
    item_title: (r.item_title || '').trim(),
    enabled: base.enabled,
    template: r.template,
    card_type: r.card_type, api_url: r.api_url.trim(),
    delay_seconds: Math.max(0, Number(r.delay_seconds) || 0),
    full_auto: false,
  });
  await loadDelivery();
  toast(isNew ? '商品已添加' : '已保存');
}

async function openCardManager(rule) {
  if (rule.card_type === 'api') { toast('API 类型会按订单请求取卡接口，无需导入卡池。可在编辑中修改接口。', 5000); return; }
  const cards = await window.api.delivery.cards(currentAccountId, rule.item_id);
  const unused = cards.filter((c) => c.status === 'unused');
  const used = cards.filter((c) => c.status === 'used');
  const title = rule.item_title || rule.item_id;

  // 用一个选择框代替「输入 1/2/3」的原始交互
  const r = await window.dlg.form({
    title: '卡密管理',
    body: `商品：${title}
库存：${unused.length} 条可用 / ${used.length} 条已用`,
    okText: '下一步',
    fields: [
      {
        key: 'act', label: '操作', type: 'select', value: 'import',
        options: [
          { value: 'import', label: rule.card_type === 'image' ? '批量导入图片卡密（每张一份）' : '批量导入卡密（一行一条）' },
          { value: 'view_used', label: '查看已用卡密' },
          { value: 'clear', label: '清空该商品所有卡密' },
        ],
      },
    ],
  });
  if (!r) return;

  if (r.act === 'import') {
    if (rule.card_type === 'image') {
      const res = await window.api.delivery.importImageCards(currentAccountId, rule.item_id);
      if (!res.ok) { toast(res.error || '图片导入失败', 5000); return; }
      if (!res.canceled) toast(`图片卡密：新增 ${res.added} 张，重复 ${res.skipped} 张`, 3500);
      await loadDelivery(); return;
    }
    const r2 = await window.dlg.form({
      title: '导入卡密',
      body: `为「${title}」导入卡密，一行一条。重复的会自动跳过。`,
      okText: '导入',
      fields: [{
        key: 'text', label: '卡密列表', type: 'textarea', rows: 10, required: true,
        placeholder: 'CARD-AAA-111\nCARD-BBB-222\nCARD-CCC-333',
      }],
    });
    if (!r2) return;
    const res = await window.api.delivery.importCards(currentAccountId, rule.item_id, r2.text);
    toast(`导入完成：新增 ${res.added} 条，跳过重复 ${res.skipped} 条`, 3500);
    await loadDelivery();
    return;
  }

  if (r.act === 'clear') {
    const okClear = await window.dlg.confirm({
      title: '清空卡密',
      body: `确认清空「${title}」的全部 ${cards.length} 条卡密？
此操作不可恢复。`,
      okText: '清空', danger: true,
    });
    if (!okClear) return;
    await window.api.delivery.clearCards(currentAccountId, rule.item_id);
    toast('已清空');
    await loadDelivery();
    return;
  }

  if (r.act === 'view_used') {
    if (!used.length) { toast('还没有已使用的卡密'); return; }
    const list = used.slice(-20).map((c) =>
      `${new Date(c.used_at).toLocaleString('zh-CN', { hour12: false })}  订单${c.used_order_no}  ${c.content}`,
    ).join('\n');
    await window.dlg.alert({ title: '最近 20 条已用卡密', body: list });
  }
}

/* ------------------------------ 页面级操作 ------------------------------ */

let quickProducts = [];

async function loadActions() {
  if (!currentAccountId) { quickProducts = []; renderActions(); return; }
  quickProducts = await window.api.products.quick.list(currentAccountId);
  renderActions();
}

function renderActions() {
  const box = $$('tab-actions');
  box.innerHTML = '';

  if (!currentAccountId) {
    box.innerHTML = '<div class="muted">请先选择账号</div>';
    return;
  }

  const intro = document.createElement('div');
  intro.className = 'card';
  intro.innerHTML = `
    <div style="font-size:13px;font-weight:600">页面操作</div>
    <div class="muted" style="margin-top:4px;line-height:1.6">
      这两个动作需要在官方页面上点按钮，所以必须<b>已登录</b>且当前有会话。
      如果提示"找不到按钮"，点下面的诊断看实际页面结构。
    </div>
    <button id="btn-diagnose" style="margin-top:8px;font-size:13px">诊断页面结构</button>
    <pre id="diag-out" class="muted" style="display:none;margin-top:6px;font-size:10px;max-height:180px;overflow:auto;background:#f7f8fa;padding:6px;border-radius:5px;white-space:pre-wrap"></pre>
  `;
  box.appendChild(intro);

  intro.querySelector('#btn-diagnose').onclick = async () => {
    const out = intro.querySelector('#diag-out');
    out.style.display = 'block';
    out.textContent = '探测中…';
    const r = await window.api.actions.diagnose(currentAccountId);
    out.textContent = JSON.stringify(r, null, 1).slice(0, 3000);
  };

  // 常用商品
  const prodCard = document.createElement('div');
  prodCard.className = 'card';
  prodCard.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <b style="font-size:13px">常用商品</b>
      <button id="btn-add-prod" style="font-size:13px">＋ 添加</button>
    </div>
    <div class="muted" style="margin-top:3px;font-size:10px">点商品名可一键发送到当前会话</div>
  `;
  box.appendChild(prodCard);

  if (!quickProducts.length) {
    const e = document.createElement('div');
    e.className = 'muted';
    e.style.cssText = 'margin:8px 0;font-size:13px';
    e.textContent = '还没有常用商品，点「＋ 添加」';
    prodCard.appendChild(e);
  }

  for (const p of quickProducts) {
    const el = document.createElement('div');
    el.className = 'row';
    el.style.cssText = 'justify-content:space-between;padding:6px 0;border-bottom:1px solid #f4f5f7';
    el.innerHTML = `
      <span style="font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer"
            data-act="send" title="点击发送">${esc(p.title || p.item_id)}</span>
      <button data-act="del" style="font-size:10px;color:var(--danger);padding:1px 6px">删</button>
    `;
    el.querySelector('[data-act=send]').onclick = async () => {
      toast('正在发送商品卡片…', 2000);
      const r = await window.api.actions.sendProduct(currentAccountId, {
        itemId: p.item_id,
        keyword: p.title,
      });
      if (r.ok) toast(`已发送：${p.title || p.item_id}`, 3000);
      else toast(`发送失败：${r.error}`, 6000);
    };
    el.querySelector('[data-act=del]').onclick = async () => {
      quickProducts = await window.api.products.quick.remove(currentAccountId, p.item_id);
      renderActions();
    };
    prodCard.appendChild(el);
  }

  prodCard.querySelector('#btn-add-prod').onclick = async () => {
    const pr = await window.dlg.form({
      title: '添加常用商品',
      okText: '添加',
      fields: [
        { key: 'item_id', label: '闲鱼商品ID', placeholder: '商品详情页链接里的 id=xxx', required: true },
        { key: 'title', label: '商品标题', placeholder: '方便辨认，如：腾讯视频月卡' },
      ],
    });
    if (!pr) return;
    quickProducts = await window.api.products.quick.save({
      accountId: currentAccountId,
      item_id: String(pr.item_id).trim(),
      title: String(pr.title || '').trim(),
    });
    renderActions();
    toast('已添加');
  };

  // 拉黑
  const blockCard = document.createElement('div');
  blockCard.className = 'card';
  blockCard.innerHTML = `
    <div style="font-size:13px;font-weight:600">买家拉黑</div>
    <div class="muted" style="margin-top:4px;line-height:1.6">
      对<b>当前打开的会话</b>的买家执行。请先在右侧页面点开要操作的会话。
    </div>
    <div class="row" style="margin-top:8px">
      <button id="btn-block" style="font-size:13px;color:var(--danger)">拉黑当前买家</button>
      <button id="btn-unblock" style="font-size:13px">解除拉黑</button>
    </div>
  `;
  box.appendChild(blockCard);

  blockCard.querySelector('#btn-block').onclick = async () => {
    const okBlock = await window.dlg.confirm({
      title: '拉黑买家',
      body: '确认拉黑当前会话的买家？\n拉黑后对方无法给你发消息。',
      okText: '拉黑', danger: true,
    });
    if (!okBlock) return;
    const r = await window.api.actions.setBlocked(currentAccountId, { unblock: false });
    toast(r.ok ? `已拉黑${r.peerNick ? '：' + r.peerNick : ''}` : `失败：${r.error}`, r.ok ? 3000 : 6000);
  };
  blockCard.querySelector('#btn-unblock').onclick = async () => {
    const r = await window.api.actions.setBlocked(currentAccountId, { unblock: true });
    toast(r.ok ? `已解除拉黑${r.peerNick ? '：' + r.peerNick : ''}` : `失败：${r.error}`, r.ok ? 3000 : 6000);
  };
}

/* ------------------------------ 设置页（复用原面板逻辑） ------------------------------ */

let currentSettingsTab = 'rules';

async function loadSettingsPage() {
  if (!settings) settings = await window.api.settings.get();
  switchSettingsTab(currentSettingsTab);
}

/**
 * 设置页的 tab 切换
 * 关键：现有的 renderRules / renderAi / renderDelivery 等都写死挂到 #tab-xxx
 * 这里做一次「临时改指向」—— 把目标容器 id 换成设置页的 #stab-xxx
 */
function switchSettingsTab(tab) {
  currentSettingsTab = tab;

  for (const el of document.querySelectorAll('.snav-item')) {
    el.classList.toggle('on', el.dataset.stab === tab);
  }

  const map = {
    rules: 'stab-rules',
    quick: 'stab-quick',
    ai: 'stab-ai',
    'product-ai': 'stab-product-ai',
    relist: 'stab-relist', remote: 'stab-remote',
    delivery: 'stab-delivery',
    actions: 'stab-actions',
    notify: 'stab-notify',
    staff: 'stab-staff',
    disclaimer: 'stab-disclaimer',
    licenses: 'stab-licenses',
  };
  for (const [k, id] of Object.entries(map)) {
    const el = $(id);
    if (el) el.style.display = k === tab ? '' : 'none';
  }

  // 把数据渲染到设置页容器里
  renderInto(map[tab], tab);
}

/**
 * 把渲染结果输出到设置页容器
 * 做法：设置覆盖表 → 调用原渲染函数 → 清除覆盖
 */
function renderInto(containerId, tab) {
  const container = $(containerId);
  if (!container) return;

  // 快捷话术是设置页独有的，不走覆盖
  if (tab === 'quick') { renderQuickReplies(container); return; }
  if (tab === 'product-ai') { window.ProductAISettings.render(container); return; }
  if (['remote', 'relist'].includes(tab)) { window.OperationsSettings[tab](container).catch(error => toast(error.message, 6000)); return; }
  if (tab === 'disclaimer') { renderDisclaimer(container); return; }
  if (tab === 'licenses') { renderLicenses(container); return; }

  const proxyId = {
    rules: 'tab-rules',
    ai: 'tab-ai',
    delivery: 'tab-delivery',
    actions: 'tab-actions',
    notify: 'tab-notify',
    staff: 'tab-staff',
  }[tab];

  if (!proxyId) return;

  container.innerHTML = '';
  containerOverride.set(proxyId, container);

  try {
    if (tab === 'rules') loadRules();
    else if (tab === 'ai') renderAi();
    else if (tab === 'delivery') loadDelivery();
    else if (tab === 'actions') loadActions();
    else if (tab === 'notify') loadNotify();
    else if (tab === 'staff') loadStaff();
  } finally {
    // 渲染是同步/异步混合的，延迟清除覆盖
    setTimeout(() => containerOverride.delete(proxyId), 300);
  }
}

/* ------------------------------ 免责声明 / 开源声明 ------------------------------ */

const LEGAL_SECTIONS = [
  { h: '一、软件性质', body: [
    '小丸闲鱼管家是一款<strong>本地运行的第三方桌面工具</strong>，由开源项目与公开技术方案整合而成，用于协助卖家管理自己的闲鱼店铺。',
    '它不是闲鱼官方产品，与闲鱼、淘宝、阿里巴巴集团及其关联公司<strong>没有任何隶属、合作或授权关系</strong>。',
    '软件的名称与图标为个人开发者所有；"闲鱼""淘宝"等名称与商标归其各自权利人所有，本软件仅在描述用途时以叙述方式提及。',
  ] },
  { h: '二、技术实现方式', list: [
    '通过内置浏览器加载<strong>闲鱼官方网页</strong>，登录由你在官方页面扫码完成，软件不代存账号密码。',
    '消息读取、发送、发货等操作，是在官方页面上模拟用户操作实现（DOM 交互），<strong>不破解、不调用平台私有签名接口</strong>。',
    '官方页面结构可能随时调整，部分依赖页面结构的自动化功能<strong>可能失效</strong>，需要等待更新。',
  ] },
  { h: '三、风险与责任', list: [
    '<strong>账号风险：</strong>使用任何在官方页面上模拟操作的工具，都可能触发平台风控。是否启用相关功能<strong>完全由你自行决定</strong>，因使用本软件导致的账号限流、功能受限、封禁或资金损失，<strong>由你自行承担</strong>。',
    '<strong>交易风险：</strong>自动发货发出的卡密、自动回复的措辞、AI 生成的商品文案，均需你自行核对。因内容错误导致的交易纠纷由你承担。',
    '<strong>数据风险：</strong>所有数据保存在本机，软件不做云端备份。请自行备份数据目录；因硬盘损坏、误删、重装系统导致的数据丢失，本软件不承担责任。',
    '<strong>合规风险：</strong>请遵守《闲鱼社区公约》及相关法律法规。请勿用于批量营销、刷单、虚假交易、骚扰他人等违规用途。',
  ] },
  { h: '四、我们不承诺的事', list: [
    '不承诺软件与官方页面的兼容性长期有效，不承诺任何功能永久可用。',
    '不承诺 AI 生成的标题、详情能提升搜索排名或带来流量。',
    '不承诺自动发货一定送达——发送结果以官方页面显示为准，结果不明时软件会停止并提示人工核对。',
    '不承诺软件无缺陷。使用前请自行评估并做好数据备份。',
  ] },
  { h: '五、软件免费提供', body: [
    '本软件<strong>免费提供，不收取任何费用</strong>，也没有会员等级或功能付费墙。',
    '免费不代表承担担保责任：软件按 <code>现状（AS IS）</code> 提供，不附带任何明示或暗示的担保。',
  ] },
];

function renderDisclaimer(container) {
  // 确认状态可能在本会话内刚刚写入（首次启动弹窗），必须取最新值而不是启动时的缓存
  window.api.settings.get().then((latest) => {
    if (latest) settings = latest;
    paintDisclaimer(container);
  }).catch(() => paintDisclaimer(container));
}

function paintDisclaimer(container) {
  const legal = (settings && settings.legal) || {};
  const accepted = !!legal.disclaimerAccepted;
  const acceptedAt = legal.acceptedAt ? new Date(legal.acceptedAt) : null;

  container.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'card';
  head.innerHTML = '<div style="font-size:13px;font-weight:700">风险与责任声明</div>'
    + '<div class="muted" style="margin-top:6px;line-height:1.8">'
    + (accepted && acceptedAt
      ? '你已在 <b>' + acceptedAt.toLocaleString('zh-CN') + '</b> 确认本声明（版本 ' + esc(legal.acceptedVersion || '-') + '）。内容有实质修改时会重新要求确认。'
      : '你尚未确认本声明。')
    + '</div>';
  container.appendChild(head);

  const body = document.createElement('div');
  body.className = 'card';
  body.style.lineHeight = '1.9';
  body.innerHTML = LEGAL_SECTIONS.map((section) => {
    const items = section.list
      ? '<ul style="margin:6px 0 0;padding-left:20px;color:var(--ink-2)">' + section.list.map((line) => '<li style="margin-bottom:6px">' + line + '</li>').join('') + '</ul>'
      : section.body.map((line) => '<p style="margin:0 0 10px;color:var(--ink-2)">' + line + '</p>').join('');
    return '<div style="margin-bottom:18px"><div style="font-size:12.5px;font-weight:700;margin-bottom:8px">' + section.h + '</div>' + items + '</div>';
  }).join('');
  container.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'card';
  foot.innerHTML = '<div class="muted" style="line-height:1.8">'
    + '本声明为软件许可与免责条款的一部分。继续使用本软件即表示你接受上述全部内容。<br/>'
    + '开源组件清单见「设置 → 开源声明」，或程序目录下的 <code>THIRD-PARTY-NOTICES.md</code>。<br/>'
    + '完整声明：https://xianyuguanjia.com/legal.html</div>';
  container.appendChild(foot);
}

/** 运行时实际使用、随包分发的第三方组件。构建期工具单独标注。 */
const OPEN_SOURCE_COMPONENTS = [
  { name: 'Electron', version: '22.3.27', license: 'MIT',
    copyright: 'Copyright (c) Electron contributors；Copyright (c) 2013-2020 GitHub Inc.',
    usage: '桌面应用运行时：窗口、Chromium 渲染引擎、Node.js 环境。',
    url: 'https://github.com/electron/electron',
    files: 'LICENSE.electron.txt · LICENSES.chromium.html',
    runtime: true },
  { name: 'Semi Design 主题与图标', version: '2.104.0', license: 'MIT',
    copyright: 'Copyright (c) 2021 DouyinFE',
    usage: '界面设计变量（颜色/间距/圆角）与静态 SVG 图标。仅使用主题 CSS 变量与图标资源，未引入 React 运行时，也未使用其 React 组件实现。',
    url: 'https://github.com/DouyinFE/semi-design',
    files: 'src/shell/vendor/semi/LICENSE-theme.txt · LICENSE-icons.txt',
    runtime: true },
  { name: 'electron-builder', version: '24.13.3', license: 'MIT',
    copyright: '', usage: '仅在构建阶段生成 Windows 安装包，不随程序分发。',
    url: 'https://github.com/electron-userland/electron-builder', files: '—', runtime: false },
  { name: 'cross-env', version: '7.0.3', license: 'MIT',
    copyright: '', usage: '仅在构建脚本中跨平台设置环境变量，不随程序分发。',
    url: 'https://github.com/kentcdodds/cross-env', files: '—', runtime: false },
  { name: 'Node.js', version: '构建环境自带', license: 'MIT',
    copyright: '', usage: '构建脚本运行环境；运行时由 Electron 内嵌。',
    url: 'https://github.com/nodejs/node', files: '—', runtime: false },
];

const NOT_USED_COMPONENTS = ['React / Vue / Angular 等前端框架', 'jQuery / Lodash 等通用工具库',
  'ECharts / Chart.js 等图表库（图表为自绘 Canvas）', 'SQLite / better-sqlite3 等原生数据库', '任何闭源 SDK'];

/** 功能设计参考过的社区开源项目。未复制其代码，技术实现不同。 */
const REFERENCED_PROJECTS = [
  { name: 'Ydisks-Xianyu-Helper', url: 'https://github.com/Christ9038/Ydisks-Xianyu-Helper',
    scope: '功能清单与交互设计：多账号管理、凭证续期、即时消息、自动化中心、卡密库存、商品管理、发货模板、订单管理、AI 回复、数据看板、通知告警、待发货兜底扫描等模块的划分方式。',
    diff: '该项目后端为 Go + MTOP 私有签名接口；本项目未使用其代码，采用 Electron 壳 + 闲鱼官方网页注入的独立实现，不调用平台私有接口。' },
];

function renderLicenses(container) {
  container.innerHTML = '';
  const intro = document.createElement('div');
  intro.className = 'card';
  intro.innerHTML = '<div style="font-size:13px;font-weight:700">第三方开源组件与参考项目声明</div>'
    + '<div class="muted" style="margin-top:6px;line-height:1.8">'
    + '本软件<strong>不是原创开发的产品</strong>，由社区开源项目与公开技术方案整合而成，本项目负责整合、封装与界面适配。'
    + '以下列出参考的项目，以及运行时实际使用、随程序分发的第三方组件。MIT 许可证要求的版权声明与许可条款均已随程序分发。</div>';
  container.appendChild(intro);

  const refCard = document.createElement('div');
  refCard.innerHTML = '<div style="font-size:12.5px;font-weight:700;margin:16px 0 8px">功能设计参考的开源项目</div>'
    + REFERENCED_PROJECTS.map((project) => '<div class="card" style="margin-bottom:10px">'
      + '<div class="row" style="justify-content:space-between;align-items:baseline">'
      + '<b style="font-size:12.5px">' + esc(project.name) + '</b>'
      + '<span class="badge" style="background:var(--y-50);color:var(--semi-color-primary);font-size:11px">参考</span>'
      + '</div>'
      + '<div class="muted" style="margin-top:5px;font-size:11.5px">项目地址：<a href="' + esc(project.url) + '" style="color:var(--semi-color-primary)">' + esc(project.url) + '</a></div>'
      + '<div class="muted" style="margin-top:8px"><strong style="color:var(--ink)">参考范围：</strong>' + esc(project.scope) + '</div>'
      + '<div class="muted" style="margin-top:6px"><strong style="color:var(--ink)">实现差异：</strong>' + esc(project.diff) + '</div>'
      + '</div>').join('')
    + '<div class="card" style="margin-bottom:10px">'
    + '<b style="font-size:12.5px">其他公开技术方案</b>'
    + '<div class="muted" style="margin-top:6px">技术选型与实现细节还参考了公开的开源技术文档与社区讨论，包括 Electron 多分区会话隔离、CDP 文件上传、DOM 注入与页面状态探测等公开做法。这些属于公开技术知识，不逐一列举。</div>'
    + '</div>';
  container.appendChild(refCard);

  const runtime = OPEN_SOURCE_COMPONENTS.filter((c) => c.runtime);
  const build = OPEN_SOURCE_COMPONENTS.filter((c) => !c.runtime);

  const card = (c) => '<div class="card" style="margin-bottom:10px">'
    + '<div class="row" style="justify-content:space-between;align-items:baseline">'
    + '<b style="font-size:12.5px">' + esc(c.name) + '</b>'
    + '<span class="badge" style="background:var(--semi-color-success-light-default);color:var(--semi-color-success);font-size:11px">' + esc(c.license) + '</span>'
    + '</div>'
    + '<div class="muted" style="margin-top:5px;font-size:11.5px;font-family:ui-monospace,Consolas,monospace">v' + esc(c.version) + '</div>'
    + (c.copyright ? '<div class="muted" style="margin-top:5px;font-size:11.5px">' + esc(c.copyright) + '</div>' : '')
    + '<div class="muted" style="margin-top:6px">' + esc(c.usage) + '</div>'
    + '<div class="muted" style="margin-top:6px;font-size:11.5px">许可证文件：<code>' + esc(c.files) + '</code></div>'
    + '<div class="muted" style="margin-top:3px;font-size:11.5px">项目地址：<a href="' + esc(c.url) + '" style="color:var(--semi-color-primary)">' + esc(c.url) + '</a></div>'
    + '</div>';

  const runCard = document.createElement('div');
  runCard.innerHTML = '<div style="font-size:12.5px;font-weight:700;margin:16px 0 8px">运行时组件（随程序分发）</div>'
    + runtime.map(card).join('')
    + '<div style="font-size:12.5px;font-weight:700;margin:18px 0 8px">构建期工具（不随程序分发）</div>'
    + build.map(card).join('');
  container.appendChild(runCard);

  const clarify = document.createElement('div');
  clarify.className = 'card';
  clarify.innerHTML = '<div style="font-size:12.5px;font-weight:700;margin-bottom:8px">本软件未使用以下组件</div>'
    + '<ul style="margin:0;padding-left:20px" class="muted">' + NOT_USED_COMPONENTS.map((n) => '<li style="margin-bottom:4px">' + esc(n) + '</li>').join('') + '</ul>';
  container.appendChild(clarify);

  const footer = document.createElement('div');
  footer.className = 'card';
  footer.innerHTML = '<div class="muted" style="line-height:1.8">'
    + '完整声明（含商标说明与合规说明）见程序目录下的 <code>THIRD-PARTY-NOTICES.md</code>。<br/>'
    + '如你认为本软件某部分侵犯了你的权利，请通过项目仓库 Issue 联系，我们会及时处理。<br/>'
    + '最后更新：2026-10-27</div>';
  container.appendChild(footer);
}

/* ------------------------------ 快捷话术 ------------------------------ */

let quickReplyList = [];

async function renderQuickReplies(container) {
  quickReplyList = await window.api.quickReplies.list(currentAccountId || null);

  container.innerHTML = '';
  const intro = document.createElement('div');
  intro.className = 'card';
  intro.innerHTML = '<div style="font-size:12.5px;font-weight:600">快捷话术</div>'
    + '<div class="muted" style="margin-top:4px">常用回复存成话术，聊天时一键发送。'
    + (currentAccountId ? '' : '<br/><b>当前未选店铺，显示的是全部话术</b>')
    + '</div>';
  container.appendChild(intro);

  for (const q of quickReplyList) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = '<div class="row" style="justify-content:space-between">'
      + '<b style="font-size:12.5px">' + esc(q.title) + '</b>'
      + '<span class="muted" style="font-size:10.5px">用 ' + (q.use_count || 0) + ' 次</span>'
      + '</div>'
      + '<div class="muted" style="margin-top:5px;white-space:pre-wrap">' + esc(q.content).slice(0, 120) + '</div>'
      + '<div class="row" style="margin-top:7px;gap:8px">'
      + '<button data-act="edit" style="font-size:13px">编辑</button>'
      + '<button data-act="del" style="font-size:13px;color:var(--danger)">删除</button>'
      + '</div>';

    el.querySelector('[data-act=edit]').onclick = async () => {
      const r = await window.dlg.form({
        title: '编辑话术',
        okText: '保存',
        fields: [
          { key: 'title', label: '标题', value: q.title, required: true },
          { key: 'content', label: '内容', type: 'textarea', rows: 4, value: q.content, required: true },
        ],
      });
      if (!r) return;
      await window.api.quickReplies.save({
        id: q.id, title: r.title, content: r.content, accountId: currentAccountId || null,
      });
      toast('已保存');
      renderQuickReplies(container);
    };

    el.querySelector('[data-act=del]').onclick = async () => {
      const ok = await window.dlg.confirm({
        title: '删除话术',
        body: '确认删除「' + q.title + '」？',
        okText: '删除', danger: true,
      });
      if (!ok) return;
      await window.api.quickReplies.remove(q.id);
      toast('已删除');
      renderQuickReplies(container);
    };

    container.appendChild(el);
  }

  const add = document.createElement('button');
  add.className = 'primary';
  add.textContent = '＋ 新增话术';
  add.onclick = async () => {
    const r = await window.dlg.form({
      title: '新增话术',
      okText: '保存',
      fields: [
        { key: 'title', label: '标题', placeholder: '例如：发货时效', required: true },
        { key: 'content', label: '内容', type: 'textarea', rows: 4, placeholder: '例如：亲，24小时内发货哦~', required: true },
      ],
    });
    if (!r) return;
    await window.api.quickReplies.save({
      title: r.title, content: r.content, accountId: currentAccountId || null,
    });
    toast('已新增');
    renderQuickReplies(container);
  };
  container.appendChild(add);
}

for (const el of document.querySelectorAll('.snav-item')) {
  el.onclick = () => switchSettingsTab(el.dataset.stab);
}

/* ------------------------------ 一级导航 / 多视图 ------------------------------ */

let currentView = 'chat';

/** 切换一级视图：客服 / 商品 / 订单 / 任务 / 数据 */
async function switchView(view) {
  if (view !== 'products' && window.ProductEditor && !(await window.ProductEditor.beforeLeave())) return;
  currentView = view;
  window.UI.closeMenu();
  window.UI.setWorkspace({ accounts, statuses, accountId: currentAccountId, view });

  for (const el of document.querySelectorAll('#nav .nav-item')) {
    el.classList.toggle('on', el.dataset.view === view);
  }

  const views = {
    chat: 'view-chat',
    shops: 'view-shops',
    customers: 'view-customers',
    products: 'view-products',
    orders: 'view-orders',
    tasks: 'view-tasks',
    stats: 'view-stats',
    settings: 'view-settings',
  };
  for (const k of Object.keys(views)) {
    $(views[k]).classList.toggle('show', k === view);
  }

  // 客服视图才有账号栏；其他视图隐藏官方页面（避免遮挡）
  $('acc-panel').classList.toggle('hide', view !== 'chat');
  // 「回复日志」按钮只在客服视图显示
  const dock = document.getElementById('dock');
  if (dock) dock.style.display = view === 'chat' ? '' : 'none';
  await window.api.setChatView(view === 'chat');
  if (view !== 'chat') {
    $('panel').classList.remove('open');
    await window.api.setPanelOpen(false);
  }

  if (view === 'shops') await loadShops();
  if (view === 'customers') await loadCustomers();
  if (view === 'products') await loadProducts();
  if (view === 'orders') await loadOrders();
  if (view === 'tasks') loadTasks();
  if (view === 'stats') await loadStats();
  if (view === 'settings') await loadSettingsPage();
}

for (const el of document.querySelectorAll('#nav .nav-item')) {
  el.onclick = () => switchView(el.dataset.view);
}

/* ------------------------------ 商品管理（表格） ------------------------------ */

let productTable = null;

function initProductTable() {
  if (productTable) return productTable;

  productTable = new window.DataTable({
    mount: $('product-list'),
    title: '商品列表',
    emptyIcon: '📦',
    emptyText: '还没有商品',
    emptyHint: '点「同步商品」从闲鱼拉取，或「批量导入」从表格导入',
    pageSizeOptions: [20, 50, 100],
    rowKey: (r) => `${r.account_id}:${r.item_id}`,

    toolbarButtons: [
      { icon: '⟳', title: '刷新', onClick: (t) => t.reload() },
      { icon: '⭳', title: '导出', onClick: () => exportProducts() },
    ],

    columns: [
      { key: '_check', label: '', width: '42px' },
      {
        key: 'title', label: '商品', sortable: true,
        render: (r) => {
          const img = r.image
            ? `<img class="cell-thumb" src="${esc(r.image)}" referrerpolicy="no-referrer" alt="商品主图" />`
            : '<div class="cell-thumb">📦</div>';
          return `<div style="display:flex;gap:10px;align-items:center">
            ${img}
            <div style="min-width:0">
              <div class="cell-title">${esc(r.title || '(无标题)')}</div>
              <div class="cell-sub">ID: ${esc(r.item_id)}</div>
            </div>
          </div>`;
        },
      },
      {
        key: 'price', label: '价格', width: '100px', align: 'right', sortable: true,
        render: (r) => r.price
          ? `<span class="cell-price">￥${esc(r.price)}</span>`
          : '<span class="muted">-</span>',
      },
      {
        key: 'status', label: '状态', width: '90px',
        render: (r) => {
          const map = {
            on_sale: ['on', '在售'],
            sold: ['warn', '已售出'],
            off: ['off', '已下架'],
          };
          const [cls, text] = map[r.status] || ['off', '未知'];
          return `<span class="st ${cls}">${text}</span>`;
        },
      },
      {
        key: 'account', label: '店铺', width: '120px',
        render: (r) => {
          const name = (accounts.find((a) => a.id === r.account_id) || {}).label || '-';
          return `<span class="cell-sub" style="font-size:13px">${esc(name)}</span>`;
        },
      },
      {
        key: 'ops', label: '操作', width: '130px',
        render: () => `<button class="act-link" data-row-act="edit">编辑</button>
          <button class="act-link" data-row-act="more" aria-label="更多商品操作" aria-haspopup="menu">${window.UI.icon('more')}</button>`,
      },
    ],

    rowActions: {
      edit: async (row) => {
        toast('正在读取闲鱼商品编辑信息…', 3000);
        try { await window.ProductEditor.editItem(row); }
        catch (error) { await window.dlg.alert({ title: '暂时无法读取商品', body: error.message }); }
      },
      more: (row, table, event) => window.UI.menu(event.currentTarget, [
        { label: '复制为新草稿', icon: 'copy', action: () => window.ProductEditor.copy(row) },
        { label: '加入快捷发送', icon: 'send', action: () => table.opt.rowActions.quick(row) },
        { label: '本地移除', icon: 'trash', danger: true, action: () => table.opt.rowActions.remove(row) },
      ]),
      remove: async (row) => {
        const ok = await window.dlg.confirm({
          title: '移除商品',
          body: '从本地商品库移除「' + (row.title || row.item_id) + '」？\n（不会影响闲鱼上的商品）',
          okText: '移除', danger: true,
        });
        if (!ok) return;
        await window.api.products.remove(row.account_id, row.item_id);
        toast('已移除');
        productTable.reload();
      },
      quick: async (row) => {
        // 跳到常用商品配置（快捷发送）
        await window.api.products.quick.save({
          accountId: row.account_id,
          item_id: row.item_id,
          title: row.title,
        });
        toast('已加入「操作 → 常用商品」，可在聊天中一键发送');
      },
    },

    batchActions: [
      {
        label: '批量移除',
        danger: true,
        onClick: async (rows, t) => {
          const ok = await window.dlg.confirm({
            title: '批量移除',
            body: `从本地商品库移除选中的 ${rows.length} 个商品？`,
            okText: '移除', danger: true,
          });
          if (!ok) return;
          for (const r of rows) await window.api.products.remove(r.account_id, r.item_id);
          toast(`已移除 ${rows.length} 个`);
          t.selected.clear();
          t.reload();
        },
      },
      {
        label: '加入快捷短语',
        onClick: async (rows) => {
          for (const r of rows) {
            await window.api.products.quick.save({
              accountId: r.account_id, item_id: r.item_id, title: r.title,
            });
          }
          toast(`已将 ${rows.length} 个商品加入快捷发送`);
        },
      },
    ],

    fetch: async ({ page, pageSize, sortKey, sortDir }) => {
      const kw = $('pf-kw').value.trim();
      const status = $('pf-status').value;
      const accSel = $('pf-account');
      const accFilter = accSel && accSel.value ? Number(accSel.value) : null;

      let list = await window.api.products.list({
        accountId: accFilter || null,
        search: kw,
        status,
      });

      // 排序
      if (sortKey && sortDir) {
        list = [...list].sort((a, b) => {
          let av = a[sortKey];
          let bv = b[sortKey];
          if (sortKey === 'price' || sortKey === 'stock') {
            av = Number(av) || 0;
            bv = Number(bv) || 0;
          } else {
            av = String(av || '');
            bv = String(bv || '');
          }
          if (av < bv) return sortDir === 'asc' ? -1 : 1;
          if (av > bv) return sortDir === 'asc' ? 1 : -1;
          return 0;
        });
      }

      const total = list.length;
      const start = (page - 1) * pageSize;
      return { list: list.slice(start, start + pageSize), total };
    },
  });

  return productTable;
}

async function loadProducts() {
  initProductTable();
  if (window.ProductEditor) await window.ProductEditor.refresh();
  await productTable.reload();
}

async function exportProducts() {
  const list = await window.api.products.list({ accountId: currentAccountId || null });
  if (!list.length) { toast('没有可导出的商品'); return; }
  const csv = ['标题,价格,库存,商品ID,状态,店铺']
    .concat(list.map((r) => {
      const name = (accounts.find((a) => a.id === r.account_id) || {}).label || '';
      const st = { on_sale: '在售', sold: '已售出', off: '已下架' }[r.status] || '';
      return [r.title, r.price, r.stock || 0, r.item_id, st, name]
        .map((v) => /[",\n]/.test(String(v || '')) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v || ''))
        .join(',');
    })).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `商品导出-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  toast(`已导出 ${list.length} 个商品`, 3000);
}

/* 筛选区事件 */
if ($('pf-search')) {
  $('pf-search').onclick = () => { productTable.page = 1; productTable.reload(); };
  $('pf-reset').onclick = () => {
    $('pf-kw').value = '';
    $('pf-status').value = '';
    if ($('pf-account')) $('pf-account').value = '';
    productTable.page = 1;
    productTable.reload();
  };
  $('pf-kw').onkeydown = (e) => { if (e.key === 'Enter') $('pf-search').click(); };
  $('pf-status').onchange = () => { productTable.page = 1; productTable.reload(); };

  // 填店铺下拉
  const sel = $('pf-account');
  if (sel) {
    sel.innerHTML = '<option value="">全部店铺</option>'
      + accounts.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('');
  }
}

if ($('btn-sync-products')) {
  $('btn-sync-products').onclick = async () => {
    const button = $('btn-sync-products'), note = $('product-sync-note');
    button.disabled = true;
    try {
      const accId = await window.ProductEditor.chooseAccount();
      if (!accId) return;
      $('pf-account').value = String(accId);
      note.classList.remove('error');
      note.textContent = '正在读取该店铺的在售和已售出商品，请稍候…';
      const result = await window.api.products.scanPreview(accId);
      if (!result.ok) throw new Error(result.error || '同步未完成');
      if (!result.products.length) {
        note.textContent = '扫描完成：该店铺主页没有读取到在售或已售出的商品。' + (result.scope || '');
        toast('没有扫描到商品', 4000);
        return;
      }
      const onSale = result.products.filter((p) => p.status === 'on_sale').length;
      const picked = await window.dlg.form({
        title: '选择要导入的商品',
        body: `扫描到 ${result.products.length} 件商品（在售 ${onSale}、已售出 ${result.products.length - onSale}）。\n只导入勾选的商品：未勾选的不会新增，已有记录也不会更新。`,
        okText: '导入所选',
        fields: [{
          key: 'ids', type: 'checklist', required: true,
          quick: [
            { label: '全选', select: 'all' },
            { label: '全不选', select: 'none' },
            { label: '只选在售', select: 'on_sale' },
          ],
          options: result.products.map((p) => ({
            value: p.item_id, label: p.title, checked: true, group: p.status,
            meta: '¥' + p.price + ' · ID ' + p.item_id + (p.exists ? ' · 已有记录，导入会更新' : ' · 新商品'),
            badge: p.status === 'on_sale' ? '在售' : '已售出', badgeKind: p.status === 'on_sale' ? 'on' : 'warn',
          })),
        }],
      });
      if (!picked || !picked.ids || !picked.ids.length) {
        note.textContent = '已取消导入，本地商品保持不变。';
        return;
      }
      const imported = await window.api.products.syncImport(accId, result.scanId, picked.ids);
      if (!imported.ok) throw new Error(imported.error || '导入未完成');
      note.textContent = (imported.complete ? '同步完成：' : '本次部分同步：')
        + `勾选导入 ${imported.count} 件（新增 ${imported.added}、更新 ${imported.updated}），未勾选的商品保持不变。` + (imported.scope || '');
      toast(`已导入 ${imported.count} 件商品（新增 ${imported.added}、更新 ${imported.updated}）`, 4000);
      await loadProducts();
    } catch (error) {
      note.classList.add('error'); note.textContent = error.message + '。可点击「打开店铺主页」检查登录和页面提示。';
      await window.dlg.alert({ title: '商品同步未完成', body: note.textContent });
    } finally { button.disabled = false; }
  };
}

if ($('btn-import-products')) {
  $('btn-import-products').onclick = async () => {
    const accId = await window.ProductEditor.chooseAccount();
    if (!accId) return;

    const r = await window.dlg.form({
      title: '批量导入商品',
      body: '每行一个商品，格式：\n标题,价格,商品ID,状态\n\n状态可填：在售 / 已售出 / 已下架（留空默认在售）',
      okText: '导入',
      fields: [{
        key: 'text', label: '商品数据', type: 'textarea', rows: 10, required: true,
        placeholder: '腾讯视频月卡,19.9,123456789,在售\n网易云年卡,88,987654321,在售',
      }],
    });
    if (!r) return;

    const res = await window.api.products.importCsv(accId, r.text);
    toast('导入完成：新增 ' + res.added + ' 条，跳过 ' + res.skipped + ' 条', 4000);
    await loadProducts();
  };
}

/* ------------------------------ 订单管理（表格） ------------------------------ */

let orderTable = null;

function initOrderTable() {
  if (orderTable) return orderTable;

  orderTable = new window.DataTable({
    mount: $('order-list'),
    title: '订单列表',
    emptyIcon: '📋',
    emptyText: '还没有订单',
    emptyHint: '自动发货识别到订单时会自动记录',
    pageSizeOptions: [20, 50, 100],
    rowKey: (r) => `${r.account_id}:${r.order_no}`,

    toolbarButtons: [
      { icon: '⟳', title: '刷新', onClick: (t) => t.reload() },
    ],

    columns: [
      { key: '_check', label: '', width: '42px' },
      {
        key: 'order_no', label: '订单号', width: '170px', sortable: true,
        render: (r) => `<span class="cell-num" style="font-weight:600">${esc(r.order_no)}</span>`,
      },
      {
        key: 'item_title', label: '商品', sortable: true,
        render: (r) => `<div class="cell-title">${esc(r.item_title || '(未知商品)')}</div>
          ${r.item_id ? `<div class="cell-sub">ID: ${esc(r.item_id)}</div>` : ''}`,
      },
      {
        key: 'buyer_nick', label: '买家', width: '110px', sortable: true,
        render: (r) => `<span style="font-size:13px">${esc(r.buyer_nick || '-')}</span>`,
      },
      {
        key: 'amount', label: '金额', width: '100px', align: 'right', sortable: true,
        render: (r) => r.amount
          ? `<span class="cell-price">￥${Number(r.amount).toFixed(2)}</span>`
          : '<span class="muted">-</span>',
      },
      {
        key: 'status', label: '状态', width: '100px',
        render: (r) => {
          if (r.delivery_status === 'uncertain') return '<span class="st err">发送待核对</span>';
          const s = String(r.status || '');
          if (/待发货|待付款/.test(s)) return `<span class="st warn">${esc(s)}</span>`;
          if (/已发货|已完成/.test(s)) return `<span class="st on">${esc(s)}</span>`;
          if (/退款|关闭|取消/.test(s)) return `<span class="st err">${esc(s)}</span>`;
          return `<span class="st info">${esc(s || '未知')}</span>`;
        },
      },
      {
        key: 'created', label: '时间', width: '130px', sortable: true,
        render: (r) => {
          const ts = r.updated_at || r.created_ts;
          if (!ts) return '<span class="muted">-</span>';
          const d = new Date(ts);
          const p = (n) => String(n).padStart(2, '0');
          return `<span class="cell-num" style="font-size:13px">${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}</span>`;
        },
      },
      {
        key: 'ops', label: '操作', width: '130px',
        render: (r) => `<button class="act-link" data-row-act="${r.delivery_status === 'uncertain' ? 'resolve' : /已发货|已完成/.test(r.status || '') ? 'resend' : 'ship'}">${r.delivery_status === 'uncertain' ? '核对发送' : /已发货|已完成/.test(r.status || '') ? '补发' : '发货'}</button>
          <button class="act-link" data-row-act="more" title="更多订单操作" aria-label="更多订单操作" aria-haspopup="menu">${window.UI.icon('more')}</button>`,
      },
    ],

    rowActions: {
      ship: (row) => doShipOrder(row),
      resend: (row) => doResendOrder(row),
      confirm: (row) => doConfirmOrder(row),
      resolve: (row) => doResolveDelivery(row),
      'link-session': (row) => doLinkOrderSession(row),
      more: (row, table, event) => window.UI.menu(event.currentTarget, [
        { label: '关联买家会话', icon: 'link', action: () => doLinkOrderSession(row) },
        { label: '补发卡密', icon: 'key', action: () => doResendOrder(row) },
        { label: '在闲鱼上发货', icon: 'send', action: () => doShipOrder(row) },
        { label: '仅本地确认发货', icon: 'check', action: () => doConfirmOrder(row) },
      ]),
    },

    batchActions: [
      {
        label: '批量确认发货',
        onClick: async (rows, t) => {
          const ok = await window.dlg.confirm({
            title: '批量确认',
            body: `把选中的 ${rows.length} 个订单标记为「已发货」（仅本地）？`,
            okText: '确认',
          });
          if (!ok) return;
          for (const r of rows) {
            await window.api.orders.operate(r.account_id, r.order_no, 'confirm');
          }
          toast(`已确认 ${rows.length} 个订单`);
          t.selected.clear();
          t.reload();
        },
      },
    ],

    fetch: async ({ page, pageSize, sortKey, sortDir }) => {
      const kw = $('of-kw').value.trim().toLowerCase();
      const st = $('of-status').value;

      let list = await window.api.orders.list(currentAccountId || null);
      if (kw) {
        list = list.filter((o) =>
          String(o.order_no).toLowerCase().includes(kw)
          || String(o.buyer_nick || '').toLowerCase().includes(kw)
          || String(o.item_title || '').toLowerCase().includes(kw));
      }
      if (st) list = list.filter((o) => st === 'uncertain' ? o.delivery_status === 'uncertain' : String(o.status || '').includes(st));

      if (sortKey && sortDir) {
        list = [...list].sort((a, b) => {
          let av = a[sortKey];
          let bv = b[sortKey];
          if (sortKey === 'amount') { av = Number(av) || 0; bv = Number(bv) || 0; }
          else if (sortKey === 'created') { av = a.updated_at || a.created_ts || 0; bv = b.updated_at || b.created_ts || 0; }
          else { av = String(av || ''); bv = String(bv || ''); }
          if (av < bv) return sortDir === 'asc' ? -1 : 1;
          if (av > bv) return sortDir === 'asc' ? 1 : -1;
          return 0;
        });
      }

      const total = list.length;
      const start = (page - 1) * pageSize;
      return { list: list.slice(start, start + pageSize), total };
    },
  });

  return orderTable;
}

async function loadOrders() {
  initOrderTable();
  await orderTable.reload();
}

async function doShipOrder(row) {
  const r = await window.dlg.form({
    title: '在闲鱼上发货',
    body: '会在官方订单页点击「发货」并填写单号。\n请确保该订单当前是「待发货」状态。',
    okText: '发货',
    fields: [
      { key: 'waybillNo', label: '快递单号', placeholder: 'SF1234567890', required: true },
      { key: 'expressCode', label: '快递公司代码（可选）', placeholder: 'SF / YTO / ZTO' },
    ],
  });
  if (!r) return;

  toast('正在执行发货…', 3000);
  const res = await window.api.orders.operate(row.account_id, row.order_no, 'ship', {
    waybillNo: r.waybillNo,
    expressCode: r.expressCode,
  });
  if (res.ok) { toast('发货成功', 3500); orderTable.reload(); }
  else {
    await window.dlg.alert({
      title: '发货失败',
      body: (res.error || res.reason || '未知错误')
        + '\n\n可能原因：订单页未打开、订单状态不对、页面结构变了。',
    });
  }
}

async function doResendOrder(row) {
  const ok = await window.dlg.confirm({
    title: '补发卡密',
    body: '给对方补发一条卡密消息？\n将从卡密池取一条新的（不影响原卡密记录）。',
    okText: '补发',
  });
  if (!ok) return;
  const r = await window.api.orders.operate(row.account_id, row.order_no, 'resend');
  if (r.ok) toast('已补发：' + (r.text || '').slice(0, 30), 4000);
  else toast('失败：' + (r.error || r.reason || '未知'), 5000);
  orderTable.reload();
}

async function doResolveDelivery(row) {
  const result = await window.dlg.form({
    title: '核对卡密发送结果',
    body: '请先打开该买家的聊天记录核对。\n确认未收到后可补发新卡密；原卡密继续保留，避免迟到消息造成重复出售。',
    okText: '保存核对结果',
    fields: [{ key: 'result', label: '核对结果', type: 'select', value: '', required: true,
      options: [{ value: '', label: '请选择核对结果' }, { value: 'received', label: '买家已收到' },
        { value: 'not-received', label: '买家未收到，需要补发新卡密' }] }],
  });
  if (!result) return;
  const response = await window.api.orders.operate(row.account_id, row.order_no, 'resolve', result);
  toast(response.ok ? response.reason : response.error || '保存失败', 5000);
  await orderTable.reload();
}

async function doLinkOrderSession(row) {
  const sessions = (await window.api.sessions.list(row.account_id))
    .filter((session) => session.id && !String(session.id).startsWith('nick:'));
  if (!sessions.length) { toast('请先打开该买家的会话并接收一条消息，识别会话ID后再关联', 6000); return; }
  const result = await window.dlg.form({
    title: '关联订单与买家会话',
    body: `订单：${row.order_no}\n买家：${row.buyer_nick || '未知'}\n请核对买家身份后选择，关联结果用于卡密发送。`,
    okText: '确认关联',
    fields: [{ key: 'sessionId', label: '买家会话', type: 'select', value: row.session_id || '', required: true,
      options: [{ value: '', label: '请选择正确买家的会话' }, ...sessions.map((session) => ({
        value: String(session.id), label: `${session.peer_nick || '未知买家'} · ${session.id}`,
      }))] }],
  });
  if (!result) return;
  const response = await window.api.orders.operate(row.account_id, row.order_no, 'link-session', result);
  toast(response.ok ? response.reason : response.error || '关联失败', 5000);
  await orderTable.reload();
}

async function doConfirmOrder(row) {
  const ok = await window.dlg.confirm({
    title: '确认发货（仅本地）',
    body: '只把本地状态改为「已发货」，不会操作闲鱼页面。\n\n适合：你已经在闲鱼上发了货，只想让本地记录同步。',
    okText: '确认',
  });
  if (!ok) return;
  const r = await window.api.orders.operate(row.account_id, row.order_no, 'confirm');
  if (r.ok) { toast('已标记为已发货'); orderTable.reload(); }
  else toast('失败：' + (r.error || ''), 4000);
}

/* 订单筛选事件 */
if ($('of-search')) {
  $('of-search').onclick = () => { orderTable.page = 1; orderTable.reload(); };
  $('of-reset').onclick = () => {
    $('of-kw').value = '';
    $('of-status').value = '';
    orderTable.page = 1;
    orderTable.reload();
  };
  $('of-kw').onkeydown = (e) => { if (e.key === 'Enter') $('of-search').click(); };
  $('of-status').onchange = () => { orderTable.page = 1; orderTable.reload(); };
}

if ($('btn-sync-orders')) {
  $('btn-sync-orders').onclick = async () => {
    toast('订单同步需登录官方订单页；当前先记录自动发货产生的订单', 4500);
    await loadOrders();
  };
}

/* ------------------------------ 店铺管理（表格） ------------------------------ */

let shopTable = null;
let shopGroups = [];

function initShopTable() {
  if (shopTable) return shopTable;

  shopTable = new window.DataTable({
    mount: $('shop-list'),
    title: '店铺列表',
    emptyIcon: '🏪',
    emptyText: '还没有店铺',
    emptyHint: '点右上「＋ 新增店铺」添加，然后在客服页扫码登录',
    pageSizeOptions: [20, 50],
    rowKey: (r) => r.id,

    toolbarButtons: [
      { icon: '⟳', title: '刷新', onClick: (t) => { loadShopGroups(); t.reload(); } },
    ],

    columns: [
      { key: '_check', label: '', width: '42px' },
      {
        key: 'label', label: '店铺', sortable: true,
        render: (r) => {
          const st = statuses[r.id];
          const online = st && st.loggedIn;
          const dotColor = r.disabled ? '#9ca3af' : (online ? '#16a34a' : '#f59e0b');
          const dotTitle = r.disabled ? '已停用' : (online ? '在线' : (st ? '未登录' : '状态未知'));
          return `<div style="display:flex;gap:9px;align-items:center">
            <span style="width:7px;height:7px;border-radius:50%;background:${dotColor};flex-shrink:0" title="${dotTitle}"></span>
            <div style="min-width:0">
              <div class="cell-title">${esc(r.label)}</div>
              ${r.remark ? `<div class="cell-sub">${esc(r.remark)}</div>` : ''}
            </div>
          </div>`;
        },
      },
      {
        key: 'xy_user_id', label: '闲鱼号', width: '150px',
        render: (r) => r.xy_user_id
          ? `<span class="cell-num">${esc(r.xy_user_id)}</span>`
          : '<span class="muted">未登录</span>',
      },
      {
        key: 'group', label: '分组', width: '110px',
        render: (r) => {
          const g = shopGroups.find((x) => x.id === r.group_id);
          return g
            ? `<span class="badge" style="background:var(--y-50);color:var(--semi-color-primary)">${esc(g.name)}</span>`
            : '<span class="muted">-</span>';
        },
      },
      {
        key: 'products', label: '商品', width: '80px', align: 'right',
        render: (r) => {
          const n = (window.__allProducts || []).filter((p) => p.account_id === r.id).length;
          return `<span class="cell-num">${n}</span>`;
        },
      },
      {
        key: 'status', label: '状态', width: '90px',
        render: (r) => {
          if (r.disabled) return '<span class="st off">已停用</span>';
          const st = statuses[r.id];
          if (!st) return '<span class="st off">未知</span>';
          return st.loggedIn
            ? '<span class="st on">在线</span>'
            : '<span class="st warn">未登录</span>';
        },
      },
      {
        key: 'ops', label: '操作', width: '158px',
        render: (r) => `<button class="act-link" data-row-act="${r.disabled ? 'toggle' : 'open'}">${r.disabled ? '启用店铺' : '打开工作台'}</button>
          <button class="act-link" data-row-act="more" title="更多店铺操作" aria-label="更多店铺操作" aria-haspopup="menu">${window.UI.icon('more')}</button>`,
      },
    ],

    rowActions: {
      more: (row, table, event) => window.UI.menu(event.currentTarget, [
        { label: '编辑店铺', icon: 'edit', action: () => table.opt.rowActions.edit(row) },
        { label: row.disabled ? '启用店铺' : '停用店铺', icon: 'settings', action: () => table.opt.rowActions.toggle(row) },
        { label: '删除店铺', icon: 'trash', danger: true, action: () => table.opt.rowActions.remove(row) },
      ]),
      open: async (row) => {
        currentAccountId = row.id;
        await switchView('chat');
        await selectAccount(row.id);
      },
      edit: (row) => editShop(row),
      toggle: async (row) => {
        await window.api.accounts.update(row.id, { disabled: !row.disabled });
        toast(row.disabled ? '已启用' : '已停用');
        shopTable.reload();
      },
      remove: async (row) => {
        const ok = await window.dlg.confirm({
          title: '删除店铺',
          body: `确认删除「${row.label}」？\n该店铺的消息、规则、卡密都会被删除，不可恢复。`,
          okText: '删除', danger: true,
        });
        if (!ok) return;
        await window.api.accounts.remove(row.id);
        if (currentAccountId === row.id) currentAccountId = null;
        toast('已删除');
        await renderAccounts(await window.api.accounts.list());
        shopTable.reload();
      },
    },

    batchActions: [
      {
        label: '批量启用',
        onClick: async (rows, t) => {
          for (const r of rows) await window.api.accounts.update(r.id, { disabled: false });
          toast(`已启用 ${rows.length} 个店铺`);
          t.reload();
        },
      },
      {
        label: '批量停用',
        onClick: async (rows, t) => {
          for (const r of rows) await window.api.accounts.update(r.id, { disabled: true });
          toast(`已停用 ${rows.length} 个店铺`);
          t.reload();
        },
      },
      {
        label: '批量删除',
        danger: true,
        onClick: async (rows, t) => {
          const ok = await window.dlg.confirm({
            title: '批量删除',
            body: `确认删除选中的 ${rows.length} 个店铺？此操作不可恢复。`,
            okText: '删除', danger: true,
          });
          if (!ok) return;
          for (const r of rows) await window.api.accounts.remove(r.id);
          toast(`已删除 ${rows.length} 个店铺`);
          await renderAccounts(await window.api.accounts.list());
          t.selected.clear();
          t.reload();
        },
      },
    ],

    fetch: async ({ page, pageSize, sortKey, sortDir }) => {
      const kw = ($('sf-kw').value || '').trim().toLowerCase();
      const gid = $('sf-group').value;
      const st = $('sf-status').value;

      let list = await window.api.accounts.list();
      window.__allProducts = await window.api.products.list({ accountId: null });

      if (kw) {
        list = list.filter((a) =>
          String(a.label || '').toLowerCase().includes(kw)
          || String(a.xy_user_id || '').includes(kw)
          || String(a.remark || '').toLowerCase().includes(kw));
      }
      if (gid) list = list.filter((a) => String(a.group_id) === gid);
      if (st === 'disabled') list = list.filter((a) => a.disabled);
      else if (st === 'online') list = list.filter((a) => !a.disabled && statuses[a.id] && statuses[a.id].loggedIn);
      else if (st === 'offline') list = list.filter((a) => !a.disabled && (!statuses[a.id] || !statuses[a.id].loggedIn));

      if (sortKey && sortDir) {
        list = [...list].sort((a, b) => {
          const av = String(a[sortKey] || ''); const bv = String(b[sortKey] || '');
          if (av < bv) return sortDir === 'asc' ? -1 : 1;
          if (av > bv) return sortDir === 'asc' ? 1 : -1;
          return 0;
        });
      }

      const total = list.length;
      const start = (page - 1) * pageSize;
      return { list: list.slice(start, start + pageSize), total };
    },
  });

  return shopTable;
}

async function loadShopGroups() {
  shopGroups = await window.api.shopGroups.list();
  const sel = $('sf-group');
  if (sel) {
    sel.innerHTML = '<option value="">全部分组</option>'
      + shopGroups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  }
}

async function loadShops() {
  initializeDataTables();
  await loadShopGroups();
  await shopTable.reload();
}

async function editShop(row) {
  const isNew = !row;
  const base = row || { label: '', remark: '', group_id: null, persona: '' };

  const r = await window.dlg.form({
    title: isNew ? '新增店铺' : '编辑店铺',
    okText: '保存',
    fields: [
      { key: 'label', label: '店铺名称', value: base.label, placeholder: '例如：小丸商城', required: true },
      {
        key: 'group_id', label: '分组', type: 'select', value: base.group_id || '',
        options: [{ value: '', label: '不分组' }]
          .concat(shopGroups.map((g) => ({ value: g.id, label: g.name }))),
      },
      { key: 'remark', label: '备注', value: base.remark || '', placeholder: '例如：主营虚拟商品' },
      {
        key: 'persona', label: 'AI 人设（可选）', type: 'textarea', rows: 3,
        value: base.persona || '',
        hint: '补充这家店的客服风格，AI 回复时会参考',
      },
    ],
  });
  if (!r) return;

  if (isNew) {
    const acc = await window.api.accounts.add(r.label.trim());
    await window.api.accounts.update(acc.id, {
      group_id: r.group_id ? Number(r.group_id) : null,
      remark: r.remark || '',
      persona: r.persona || '',
    });
    toast('店铺已创建，请到「客服」页扫码登录');
  } else {
    await window.api.accounts.update(row.id, {
      label: r.label.trim(),
      group_id: r.group_id ? Number(r.group_id) : null,
      remark: r.remark || '',
      persona: r.persona || '',
    });
    toast('已保存');
  }

  await renderAccounts(await window.api.accounts.list());
  shopTable.reload();
}

if ($('btn-add-shop')) {
  $('btn-add-shop').onclick = () => editShop(null);
}

if ($('sf-search')) {
  $('sf-search').onclick = () => { shopTable.page = 1; shopTable.reload(); };
  $('sf-reset').onclick = () => {
    $('sf-kw').value = ''; $('sf-group').value = ''; $('sf-status').value = '';
    shopTable.page = 1; shopTable.reload();
  };
  $('sf-kw').onkeydown = (e) => { if (e.key === 'Enter') $('sf-search').click(); };
  $('sf-group').onchange = () => { shopTable.page = 1; shopTable.reload(); };
  $('sf-status').onchange = () => { shopTable.page = 1; shopTable.reload(); };
}

if ($('btn-manage-groups')) {
  $('btn-manage-groups').onclick = async () => {
    const list = shopGroups.length
      ? shopGroups.map((g) => '· ' + g.name).join('\n')
      : '（还没有分组）';

    const act = await window.dlg.form({
      title: '管理分组',
      body: '当前分组：\n' + list + '\n\n输入分组名可新增；输入「删除 分组名」可删除。',
      okText: '确定',
      fields: [{ key: 'input', label: '操作', placeholder: '例如：虚拟商品  或  删除 虚拟商品' }],
    });
    if (!act || !act.input) return;

    const text = act.input.trim();
    if (text.startsWith('删除')) {
      const name = text.replace(/^删除\s*/, '').trim();
      const g = shopGroups.find((x) => x.name === name);
      if (!g) { toast('找不到该分组'); return; }
      const ok = await window.dlg.confirm({
        title: '删除分组',
        body: `删除分组「${name}」？组内店铺会变成「不分组」。`,
        okText: '删除', danger: true,
      });
      if (!ok) return;
      await window.api.shopGroups.remove(g.id);
      toast('已删除');
    } else {
      await window.api.shopGroups.save({ name: text });
      toast('已创建分组「' + text + '」');
    }
    await loadShopGroups();
    shopTable.reload();
  };
}

/* ------------------------------ 客户管理（表格） ------------------------------ */

let customerTable = null;
let customerTags = [];

function initCustomerTable() {
  if (customerTable) return customerTable;

  customerTable = new window.DataTable({
    mount: $('customer-list'),
    title: '客户列表',
    emptyIcon: '👥',
    emptyTitle: '还没有客户',
    emptyHint: '收到买家消息或点「从会话同步」后会自动建档',
    pageSizeOptions: [20, 50, 100],
    rowKey: (r) => r.id,

    toolbarButtons: [
      { icon: '⟳', title: '刷新', onClick: (t) => { loadCustomerTags(); t.reload(); } },
    ],

    columns: [
      { key: '_check', label: '', width: '42px' },
      {
        key: 'nick', label: '客户', sortable: true,
        render: (r) => {
          const avatar = r.avatar
            ? `<img class="cell-thumb" style="border-radius:50%" src="${esc(r.avatar)}" />`
            : '<div class="cell-thumb" style="border-radius:50%">👤</div>';
          return `<div style="display:flex;gap:9px;align-items:center">
            ${avatar}
            <div style="min-width:0">
              <div class="cell-title">${esc(r.nick || '(未命名)')}
                ${r.blacklisted ? '<span class="badge" style="background:var(--semi-color-danger-light-default);color:var(--danger);margin-left:6px">黑名单</span>' : ''}
              </div>
              <div class="cell-sub">ID: ${esc(r.buyer_uid)}</div>
            </div>
          </div>`;
        },
      },
      {
        key: 'tags', label: '标签', width: '180px',
        render: (r) => {
          const tags = r.tags || [];
          if (!tags.length) return '<span class="muted">-</span>';
          return tags.map((t) =>
            `<span class="badge" style="background:var(--y-50);color:var(--semi-color-primary);margin-right:4px">${esc(t)}</span>`,
          ).join('');
        },
      },
      {
        key: 'remark', label: '备注', width: '160px',
        render: (r) => r.remark
          ? `<span style="font-size:13px">${esc(r.remark).slice(0, 30)}</span>`
          : '<span class="muted">-</span>',
      },
      {
        key: 'order_count', label: '成交', width: '80px', align: 'right', sortable: true,
        render: (r) => `<span class="cell-num">${r.order_count || 0}</span>`,
      },
      {
        key: 'amount', label: '累计金额', width: '110px', align: 'right',
        render: (r) => r.order_amount
          ? `<span class="cell-price">￥${Number(r.order_amount).toFixed(2)}</span>`
          : '<span class="muted">-</span>',
      },
      {
        key: 'last_active', label: '最近活跃', width: '130px', sortable: true,
        render: (r) => {
          if (!r.last_active) return '<span class="muted">-</span>';
          const d = new Date(r.last_active);
          const p = (n) => String(n).padStart(2, '0');
          return `<span class="cell-num" style="font-size:13px">${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}</span>`;
        },
      },
      {
        key: 'ops', label: '操作', width: '180px',
        render: (r) => `<button class="act-link" data-row-act="edit">编辑</button>
          <button class="act-link" data-row-act="tag">加标签</button>
          <button class="act-link ${r.blacklisted ? '' : 'danger'}" data-row-act="black">${r.blacklisted ? '移出黑名单' : '拉黑'}</button>`,
      },
    ],

    rowActions: {
      edit: async (row) => {
        const r = await window.dlg.form({
          title: '编辑客户',
          okText: '保存',
          fields: [
            { key: 'nick', label: '昵称', value: row.nick || '' },
            { key: 'remark', label: '备注', value: row.remark || '', placeholder: '例如：老客户，讲价厉害' },
            { key: 'tags', label: '标签', value: (row.tags || []).join(','), hint: '多个用英文逗号分隔' },
          ],
        });
        if (!r) return;
        await window.api.customers.update(row.id, {
          nick: r.nick || row.nick,
          remark: r.remark || '',
          tags: String(r.tags || '').split(',').map((x) => x.trim()).filter(Boolean),
        });
        toast('已保存');
        await loadCustomerTags();
        customerTable.reload();
      },
      tag: async (row) => {
        const r = await window.dlg.prompt({
          title: '添加标签',
          body: '给「' + (row.nick || row.buyer_uid) + '」加一个标签',
          placeholder: '例如：大客户 / 爱讲价 / 需催付',
        });
        if (!r || !r.trim()) return;
        const tags = [...new Set([...(row.tags || []), r.trim()])];
        await window.api.customers.update(row.id, { tags });
        toast('已添加标签');
        await loadCustomerTags();
        customerTable.reload();
      },
      black: async (row) => {
        const toBlack = !row.blacklisted;
        const ok = await window.dlg.confirm({
          title: toBlack ? '加入黑名单' : '移出黑名单',
          body: toBlack
            ? `把「${row.nick || row.buyer_uid}」加入本店黑名单？\n（仅本地标记，不会操作闲鱼）`
            : `把「${row.nick || row.buyer_uid}」移出黑名单？`,
          okText: toBlack ? '拉黑' : '移出',
          danger: toBlack,
        });
        if (!ok) return;
        await window.api.customers.update(row.id, { blacklisted: toBlack });
        toast(toBlack ? '已加入黑名单' : '已移出黑名单');
        customerTable.reload();
      },
    },

    batchActions: [
      {
        label: '批量加标签',
        onClick: async (rows, t) => {
          const r = await window.dlg.prompt({
            title: '批量加标签',
            body: `给选中的 ${rows.length} 个客户加标签`,
            placeholder: '例如：老客户',
          });
          if (!r || !r.trim()) return;
          for (const row of rows) {
            const tags = [...new Set([...(row.tags || []), r.trim()])];
            await window.api.customers.update(row.id, { tags });
          }
          toast(`已给 ${rows.length} 个客户加上「${r.trim()}」`);
          await loadCustomerTags();
          t.reload();
        },
      },
      {
        label: '批量拉黑',
        danger: true,
        onClick: async (rows, t) => {
          const ok = await window.dlg.confirm({
            title: '批量拉黑',
            body: `把选中的 ${rows.length} 个客户加入黑名单？`,
            okText: '拉黑', danger: true,
          });
          if (!ok) return;
          for (const row of rows) await window.api.customers.update(row.id, { blacklisted: true });
          toast(`已拉黑 ${rows.length} 个客户`);
          t.reload();
        },
      },
    ],

    fetch: async ({ page, pageSize, sortKey, sortDir }) => {
      const kw = ($('cf-kw').value || '').trim();
      const tag = $('cf-tag').value;
      const type = $('cf-type').value;

      let list = await window.api.customers.list({
        accountId: currentAccountId || null,
        search: kw,
        tag,
        onlyBlack: type === 'black',
      });

      if (sortKey && sortDir) {
        list = [...list].sort((a, b) => {
          let av = a[sortKey]; let bv = b[sortKey];
          if (sortKey === 'order_count') { av = Number(av) || 0; bv = Number(bv) || 0; }
          else if (sortKey === 'last_active') { av = av || 0; bv = bv || 0; }
          else { av = String(av || ''); bv = String(bv || ''); }
          if (av < bv) return sortDir === 'asc' ? -1 : 1;
          if (av > bv) return sortDir === 'asc' ? 1 : -1;
          return 0;
        });
      }

      const total = list.length;
      const start = (page - 1) * pageSize;
      return { list: list.slice(start, start + pageSize), total };
    },
  });

  return customerTable;
}

async function loadCustomerTags() {
  customerTags = await window.api.customers.tags(currentAccountId || null);
  const sel = $('cf-tag');
  if (sel) {
    sel.innerHTML = '<option value="">全部标签</option>'
      + customerTags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  }
}

async function loadCustomers() {
  initializeDataTables();
  await loadCustomerTags();
  await customerTable.reload();
}

if ($('cf-search')) {
  $('cf-search').onclick = () => { customerTable.page = 1; customerTable.reload(); };
  $('cf-reset').onclick = () => {
    $('cf-kw').value = ''; $('cf-tag').value = ''; $('cf-type').value = '';
    customerTable.page = 1; customerTable.reload();
  };
  $('cf-kw').onkeydown = (e) => { if (e.key === 'Enter') $('cf-search').click(); };
  $('cf-tag').onchange = () => { customerTable.page = 1; customerTable.reload(); };
  $('cf-type').onchange = () => { customerTable.page = 1; customerTable.reload(); };
}

/** 从现有会话同步客户档案 */
if ($('btn-sync-customers')) {
  $('btn-sync-customers').onclick = async () => {
    const accId = currentAccountId || (accounts[0] && accounts[0].id);
    if (!accId) { toast('请先新增店铺'); return; }

    const sessions = await window.api.sessions.list(accId);
    if (!sessions.length) { toast('还没有会话，先到客服页收消息'); return; }

    let n = 0;
    for (const s of sessions) {
      if (!s.peer_user_id && !s.peer_nick) continue;
      await window.api.customers.upsertFromSession(accId, s);
      n++;
    }
    toast(`已同步 ${n} 个客户`);
    await loadCustomers();
  };
}

/** 统一的表格初始化入口（避免重复创建） */
function initializeDataTables() {
  initProductTable();
  initOrderTable();
  initShopTable();
  initCustomerTable();
}

/* ------------------------------ 自动任务 ------------------------------ */

/* ------------------------------ 自动任务 ------------------------------ */

let taskList = [];
let taskLogList = [];
let tokenStatusList = [];

async function loadTasks() {
  taskList = await window.api.tasks.list();
  taskLogList = await window.api.tasks.log(50);
  tokenStatusList = await window.api.tasks.tokenStatus();
  renderTasks();
}

function renderTasks() {
  const box = $('task-list');
  if (!box) return;
  box.innerHTML = '';

  // ===== 账号登录状态 =====
  const tokenCard = document.createElement('div');
  tokenCard.className = 'card';
  const onlineCount = tokenStatusList.filter((t) => t.ok).length;
  tokenCard.innerHTML = '<div class="row" style="justify-content:space-between">'
    + '<b style="font-size:12.5px">账号登录状态</b>'
    + '<span class="muted">' + onlineCount + '/' + tokenStatusList.length + ' 在线</span>'
    + '</div>'
    + '<div style="margin-top:8px">'
    + (tokenStatusList.length
      ? tokenStatusList.map((t) => {
        const ok = t.ok === true;
        const unknown = t.ok === null;
        const color = unknown ? '#9ca3af' : (ok ? '#16a34a' : '#dc2626');
        const text = unknown ? '未知' : (ok ? '在线' : (t.error || '离线'));
        return '<div class="row" style="justify-content:space-between;padding:4px 0">'
          + '<span style="font-size:13px">' + esc(t.label) + '</span>'
          + '<span style="font-size:13px;color:' + color + '">● ' + esc(text) + '</span>'
          + '</div>';
      }).join('')
      : '<div class="muted" style="font-size:13px">还没有账号</div>')
    + '</div>';
  box.appendChild(tokenCard);

  // ===== 任务列表 =====
  const riskColor = { none: '#16a34a', high: '#dc2626' };
  const riskText = { none: '无风险', high: '高风险' };

  for (const t of taskList) {
    const el = document.createElement('div');
    el.className = 'card';
    const color = riskColor[t.risk] || '#6b7280';
    el.innerHTML = '<div class="row" style="justify-content:space-between">'
      + '<div class="row" style="gap:6px">'
      + '<b style="font-size:12.5px">' + esc(t.name) + '</b>'
      + '<span class="badge" style="background:' + color + '20;color:' + color + '">'
      + (riskText[t.risk] || t.risk) + '</span>'
      + '</div>'
      + '<label class="switch"><input type="checkbox" ' + (t.enabled ? 'checked' : '') + ' /><span class="muted">启用</span></label>'
      + '</div>'
      + '<div class="muted" style="margin-top:6px">' + esc(descOf(t.id)) + '</div>'
      + '<div class="row" style="margin-top:8px">'
      + '<button data-act="run" style="font-size:13px">立即执行</button>'
      + '<button data-act="risk" style="font-size:13px">' + (t.risk === 'none' ? '说明' : '风险说明') + '</button>'
      + '</div>';

    const chk = el.querySelector('input[type=checkbox]');
    chk.onchange = async (e) => {
      const wantOn = e.target.checked;

      if (wantOn && t.requireAccept) {
        // 二次确认风险
        const notice = await window.api.tasks.riskNotice(t.id);
        const agreed = await window.dlg.confirm({
          title: '⚠️ 高风险任务确认',
          body: notice,
          okText: '我已知晓，仍然启用',
          cancelText: '取消',
          danger: true,
        });
        if (!agreed) {
          e.target.checked = false;
          return;
        }
        const r = await window.api.tasks.setEnabled(t.id, true, true);
        if (!r.ok) { e.target.checked = false; toast(r.error || '启用失败'); return; }
        toast('已启用「' + t.name + '」，请注意账号风险', 4000);
      } else {
        const r = await window.api.tasks.setEnabled(t.id, wantOn, false);
        if (!r.ok) { e.target.checked = false; toast(r.error || '操作失败'); return; }
        toast(wantOn ? '已启用' : '已停用');
      }
      await loadTasks();
    };

    el.querySelector('[data-act=run]').onclick = async () => {
      const accId = currentAccountId || (accounts[0] && accounts[0].id);
      if (!accId) { toast('请先新增账号'); return; }

      if (t.risk === 'high') {
        const ok = await window.dlg.confirm({
          title: '确认立即执行',
          body: '「' + t.name + '」会操作官方页面，有账号风险。\n\n确认执行？',
          okText: '执行', danger: true,
        });
        if (!ok) return;
      }

      toast('执行中…', 2500);
      const r = await window.api.tasks.runNow(t.id, accId);
      if (r.ok) toast('完成：' + (r.reason || '成功'), 3500);
      else toast('失败：' + (r.reason || r.error || '未知'), 5000);
      await loadTasks();
    };

    el.querySelector('[data-act=risk]').onclick = async () => {
      const notice = await window.api.tasks.riskNotice(t.id);
      await window.dlg.alert({ title: t.name + ' — 说明', body: notice });
    };

    box.appendChild(el);
  }

  // ===== 执行记录 =====
  const logCard = document.createElement('div');
  logCard.className = 'card';
  logCard.innerHTML = '<div style="font-size:13px;font-weight:600">执行记录</div>'
    + (taskLogList.length
      ? taskLogList.slice(0, 15).map((r) => {
        const t = new Date(r.ts).toLocaleString('zh-CN', { hour12: false });
        return '<div class="log-item">'
          + '<div class="muted">' + t + ' · ' + esc(r.taskId) + '</div>'
          + '<div class="' + (r.ok ? 'log-ok' : 'log-fail') + '">'
          + (r.ok ? '✓ ' : '✕ ') + esc(r.reason || '') + '</div>'
          + '</div>';
      }).join('')
      : '<div class="muted" style="margin-top:6px;font-size:13px">还没有执行记录</div>');
  box.appendChild(logCard);

  // ===== 免责声明 =====
  const disclaimer = document.createElement('div');
  disclaimer.className = 'card';
  disclaimer.style.borderColor = '#fca5a5';
  disclaimer.innerHTML = '<div style="font-size:13px;font-weight:700;color:var(--danger)">⚠️ 风险与责任声明</div>'
    + '<div class="muted" style="margin-top:6px;line-height:1.8">'
    + '本软件中的「自动擦亮」「自动评价」等功能，需要在闲鱼官方页面上模拟点击操作。<br/>'
    + '这可能触发平台风控，导致账号被限制功能或封禁。<br/><br/>'
    + '<b style="color:var(--danger)">是否启用完全由你自行决定，账号风险由你自行承担。</b><br/>'
    + '本软件不承担任何因使用这些功能导致的账号损失责任。<br/><br/>'
    + '建议：先用小号测试，确认稳定后再考虑用于主号。'
    + '</div>';
  box.appendChild(disclaimer);
}

function descOf(id) {
  const map = {
    polish: '按设定时间每天自动擦亮商品，提升曝光',
    rate: '订单完成后自动给买家好评',
    catchupScan: '定时扫描待发货订单，漏发的自动补发卡密',
    tokenRenew: '定时检测登录状态，掉线时立即通知你',
  };
  return map[id] || '';
}

/* ------------------------------ 通知设置 ------------------------------ */

let notifyChannels = [];
let notifyLogList = [];

async function loadNotify() {
  notifyChannels = await window.api.notify.channels();
  notifyLogList = await window.api.notify.log(50);
  renderNotify();
}

function renderNotify() {
  const box = $$('tab-notify');
  if (!box) return;

  const settings = window.__settings || {};
  const cfg = (settings.notify) || {};

  box.innerHTML = '';

  const intro = document.createElement('div');
  intro.className = 'card';
  intro.innerHTML = '<div style="font-size:12.5px;font-weight:600">通知告警</div>'
    + '<div class="muted" style="margin-top:4px;line-height:1.7">'
    + '配置后，超时未回复 / 发货失败 / 卡密不足 / 账号掉线 会推送到你的手机。<br/>'
    + '可以配置多个渠道，同时接收。'
    + '</div>'
    + '<button id="btn-test-all" class="primary" style="margin-top:8px;font-size:13px">发送测试消息到所有已启用渠道</button>';
  box.appendChild(intro);

  intro.querySelector('#btn-test-all').onclick = async () => {
    toast('发送中…', 2000);
    const r = await window.api.notify.testAll();
    if (!r || !r.length) { toast('没有启用的渠道，请先配置并开启', 4000); return; }
    const okCount = r.filter((x) => x.ok).length;
    toast('测试完成：' + okCount + '/' + r.length + ' 个渠道成功', 4000);
    await loadNotify();
  };

  for (const ch of notifyChannels) {
    const c = cfg[ch.id] || {};
    const el = document.createElement('div');
    el.className = 'card';

    const fields = ch.fields.map((f) => {
      const isPass = f === 'pass' || f === 'botToken';
      return '<div class="field" style="margin-bottom:8px">'
        + '<label>' + labelOf(f) + '</label>'
        + '<input data-f="' + f + '" type="' + (isPass ? 'password' : 'text') + '" '
        + 'value="' + esc(c[f] == null ? '' : c[f]) + '" '
        + 'placeholder="' + placeholderOf(f) + '" />'
        + '</div>';
    }).join('');

    el.innerHTML = '<div class="row" style="justify-content:space-between">'
      + '<b style="font-size:12.5px">' + esc(ch.name) + '</b>'
      + '<label class="switch"><input type="checkbox" ' + (c.enabled ? 'checked' : '') + ' /><span class="muted">启用</span></label>'
      + '</div>'
      + '<div style="margin-top:8px">' + fields + '</div>'
      + '<div class="row" style="margin-top:6px">'
      + '<button data-act="save" style="font-size:13px">保存</button>'
      + '<button data-act="test" style="font-size:13px">测试</button>'
      + '</div>';

    el.querySelector('[data-act=save]').onclick = async () => {
      const patch = { enabled: el.querySelector('input[type=checkbox]').checked };
      for (const f of ch.fields) {
        const inp = el.querySelector('[data-f="' + f + '"]');
        if (inp) patch[f] = inp.value.trim();
      }
      const next = await window.api.settings.update({ notify: { [ch.id]: patch } });
      window.__settings = next; settings = next;
      toast('已保存「' + ch.name + '」');
    };

    el.querySelector('[data-act=test]').onclick = async () => {
      const patch = { enabled: true };
      for (const f of ch.fields) {
        const inp = el.querySelector('[data-f="' + f + '"]');
        if (inp) patch[f] = inp.value.trim();
      }
      toast('发送测试中…', 2000);
      const r = await window.api.notify.test(ch.id, patch);
      if (r.ok) toast('「' + ch.name + '」测试成功，请查看手机', 3000);
      else toast('失败：' + (r.error || r.body || '未知'), 5000);
      await loadNotify();
    };

    box.appendChild(el);
  }

  // 通知记录
  const logCard = document.createElement('div');
  logCard.className = 'card';
  logCard.innerHTML = '<div style="font-size:13px;font-weight:600">推送记录</div>'
    + (notifyLogList.length
      ? notifyLogList.slice(0, 15).map((r) => {
        const t = new Date(r.ts).toLocaleString('zh-CN', { hour12: false });
        return '<div class="log-item">'
          + '<div class="muted">' + t + ' · ' + esc(r.channel) + '</div>'
          + '<div class="' + (r.ok ? 'log-ok' : 'log-fail') + '">'
          + (r.ok ? '✓ ' : '✕ ') + esc(r.title) + (r.error ? ' — ' + esc(r.error) : '')
          + '</div></div>';
      }).join('')
      : '<div class="muted" style="margin-top:6px;font-size:13px">还没有推送记录</div>');
  box.appendChild(logCard);
}

function labelOf(f) {
  const map = {
    key: 'Bark Key（App 里的推送 Key）',
    server: 'Bark 服务器（默认 api.day.app）',
    webhook: 'Webhook 地址',
    secret: '加签密钥（可选）',
    botToken: 'Bot Token',
    chatId: 'Chat ID',
    host: 'SMTP 服务器',
    port: '端口（465 / 587）',
    user: '邮箱账号',
    pass: '邮箱密码/授权码',
    to: '收件邮箱',
    url: 'URL',
    method: '请求方法',
  };
  return map[f] || f;
}

function placeholderOf(f) {
  const map = {
    key: '例如：aBcDeFgH123',
    webhook: 'https://oapi.dingtalk.com/robot/send?access_token=xxx',
    secret: 'SEC开头',
    botToken: '123456:ABC-DEF...',
    chatId: '123456789',
    host: 'smtp.qq.com',
    port: '465',
    user: 'you@qq.com',
    to: 'you@qq.com',
    url: 'https://your-server.com/webhook',
  };
  return map[f] || '';
}


/* ------------------------------ 数据看板 ------------------------------ */

async function loadStats() {
  const s = await window.api.stats.get(currentAccountId || null);
  const box = $('stats-grid');
  if (!box) return;

  // ===== 指标卡 =====
  const cards = [
    { label: '店铺数', value: s.accounts, unit: '个', ico: window.UI.icon('shop') },
    { label: '商品总数', value: s.products, unit: '个', ico: window.UI.icon('product') },
    { label: '在售商品', value: s.onSale, unit: '个', ico: window.UI.icon('check') },
    { label: '订单总数', value: s.orders, unit: '单', ico: window.UI.icon('order') },
    { label: '待发货', value: s.pendingShip, unit: '单', ico: window.UI.icon('timer') },
    { label: '累计营收', value: '￥' + s.revenue, unit: '', ico: window.UI.icon('coin') },
    { label: '会话数', value: s.sessions, unit: '个', ico: window.UI.icon('chat') },
    { label: '可用卡密', value: s.cardsUnused, unit: '条', ico: window.UI.icon('key') },
  ];

  box.innerHTML = cards.map((c) =>
    '<div class="stat-card">'
    + '<div class="stat-top"><span class="label">' + c.label + '</span>'
    + '<span class="stat-ico">' + c.ico + '</span></div>'
    + '<div class="value">' + c.value
    + (c.unit ? '<span class="unit">' + c.unit + '</span>' : '')
    + '</div></div>',
  ).join('');

  // ===== 图表数据 =====
  const orders = await window.api.orders.list(currentAccountId || null);
  const products = await window.api.products.list({ accountId: currentAccountId || null });

  // 1) 近 7 天订单趋势
  const days = [];
  const dayLabels = [];
  const dayCounts = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push(key);
    dayLabels.push((d.getMonth() + 1) + '/' + d.getDate());
    dayCounts.push(orders.filter((o) => {
      const ts = o.updated_at || o.created_ts;
      return ts && new Date(ts).toISOString().slice(0, 10) === key;
    }).length);
  }
  const trendCanvas = $('chart-trend');
  if (trendCanvas) {
    window.Chart.line(trendCanvas, { labels: dayLabels, values: dayCounts, height: 210 });
    const sub = $('chart-trend-sub');
    if (sub) {
      const sum = dayCounts.reduce((a, b) => a + b, 0);
      sub.textContent = '合计 ' + sum + ' 单';
    }
  }

  // 2) 商品状态分布
  const prodCanvas = $('chart-product');
  if (prodCanvas) {
    const onSale = products.filter((p) => p.status === 'on_sale').length;
    const sold = products.filter((p) => p.status === 'sold').length;
    const off = products.filter((p) => p.status === 'off').length;
    window.Chart.donut(prodCanvas, {
      height: 210,
      centerLabel: '个商品',
      data: [
        { label: '在售', value: onSale, color: '#16a34a' },
        { label: '已售出', value: sold, color: '#f59e0b' },
        { label: '已下架', value: off, color: '#9ca3af' },
      ],
    });
  }

  // 3) 各店铺商品数量
  const shopCanvas = $('chart-shop');
  if (shopCanvas) {
    const shopMap = {};
    for (const p of products) {
      const name = (accounts.find((a) => a.id === p.account_id) || {}).label || ('店铺' + p.account_id);
      shopMap[name] = (shopMap[name] || 0) + 1;
    }
    const entries = Object.entries(shopMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
    window.Chart.bar(shopCanvas, {
      height: 210,
      labels: entries.map((e) => e[0].slice(0, 6)),
      values: entries.map((e) => e[1]),
    });
  }

  // 4) 订单状态分布
  const orderCanvas = $('chart-order');
  if (orderCanvas) {
    const stMap = {};
    for (const o of orders) {
      const st = String(o.status || '未知');
      const key = /待发货/.test(st) ? '待发货'
        : /已发货/.test(st) ? '已发货'
        : /退款|关闭/.test(st) ? '退款/关闭' : '其他';
      stMap[key] = (stMap[key] || 0) + 1;
    }
    window.Chart.donut(orderCanvas, {
      height: 210,
      centerLabel: '个订单',
      data: [
        { label: '待发货', value: stMap['待发货'] || 0, color: '#f59e0b' },
        { label: '已发货', value: stMap['已发货'] || 0, color: '#16a34a' },
        { label: '退款/关闭', value: stMap['退款/关闭'] || 0, color: '#dc2626' },
        { label: '其他', value: stMap['其他'] || 0, color: '#9ca3af' },
      ],
    });
  }
}

/* ------------------------------ 多客服 ------------------------------ */

let staffList = [];
let currentStaffId = null;

async function loadStaff() {
  staffList = await window.api.staff.list();
  currentStaffId = await window.api.staff.current();
  renderStaffSelect();
  renderStaffPanel();
}

function renderStaffSelect() {
  const sel = $('staff-select');
  sel.innerHTML = '<option value="">未指定客服</option>' +
    staffList.filter((s) => s.active).map((s) =>
      `<option value="${s.id}" ${s.id === currentStaffId ? 'selected' : ''}>${esc(s.name)}</option>`,
    ).join('');
}

function renderStaffPanel() {
  const box = $$('tab-staff');
  box.innerHTML = '';

  if (!currentAccountId) {
    box.innerHTML = '<div class="muted">请先选择账号</div>';
    return;
  }

  const intro = document.createElement('div');
  intro.className = 'card';
  intro.innerHTML = `
    <div style="font-size:13px;font-weight:600">多客服协作</div>
    <div class="muted" style="margin-top:4px;line-height:1.6">
      本机多人轮班用。会话可分配给某个客服，被接手后其他人不会自动回复该会话。<br/>
      当前操作客服在窗口右上角切换。
    </div>
  `;
  box.appendChild(intro);

  if (!staffList.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.margin = '12px 0';
    empty.textContent = '还没有客服成员';
    box.appendChild(empty);
  }

  for (const st of staffList) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <div class="row">
          <span style="width:8px;height:8px;border-radius:50%;background:${esc(st.color)}"></span>
          <b style="font-size:13px">${esc(st.name)}</b>
          ${st.id === currentStaffId ? '<span class="muted">（当前）</span>' : ''}
        </div>
        <button data-act="del" style="font-size:13px;color:var(--danger)">移除</button>
      </div>
    `;
    el.querySelector('[data-act=del]').onclick = async () => {
      const okStaff = await window.dlg.confirm({
        title: '移除客服',
        body: `确认移除客服「${st.name}」？
其名下已分配的会话会被释放。`,
        okText: '移除', danger: true,
      });
      if (!okStaff) return;
      await window.api.staff.remove(st.id);
      await loadStaff();
    };
    box.appendChild(el);
  }

  const add = document.createElement('button');
  add.className = 'primary';
  add.textContent = '＋ 添加客服';
  add.onclick = async () => {
    const sr = await window.dlg.prompt({
      title: '添加客服',
      body: '这是本机的操作员身份，用于会话分配和「谁在负责」。',
      placeholder: '例如：小王',
    });
    if (!sr || !sr.trim()) return;
    await window.api.staff.add(sr.trim());
    await loadStaff();
  };
  box.appendChild(add);

  // 会话分配
  const sessBox = document.createElement('div');
  sessBox.style.marginTop = '14px';
  sessBox.innerHTML = '<div style="font-size:13px;font-weight:600;margin-bottom:4px">会话分配</div>';
  box.appendChild(sessBox);
  loadSessionAssign(sessBox);
}

async function loadSessionAssign(container) {
  if (!staffList.length) {
    container.innerHTML += '<div class="muted" style="font-size:13px">先添加客服成员</div>';
    return;
  }
  const sessions = await window.api.sessions.list(currentAccountId);
  if (!sessions.length) {
    container.innerHTML += '<div class="muted" style="font-size:13px">还没有会话</div>';
    return;
  }

  for (const sess of sessions.slice(0, 20)) {
    const el = document.createElement('div');
    el.className = 'row';
    el.style.cssText = 'justify-content:space-between;padding:6px 0;border-bottom:1px solid #f4f5f7';
    const opts = '<option value="">未分配</option>' + staffList.map((s) =>
      `<option value="${s.id}" ${sess.assignee_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`,
    ).join('');
    el.innerHTML = `
      <span style="font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${esc(sess.peer_nick || sess.id)}
      </span>
      <select data-sid="${esc(sess.id)}" style="font-size:13px;max-width:100px">${opts}</select>
    `;
    el.querySelector('select').onchange = async (e) => {
      const id = e.target.value ? Number(e.target.value) : null;
      await window.api.sessions.assign(currentAccountId, sess.id, id);
      toast('已分配');
    };
    container.appendChild(el);
  }
}



async function loadLog() {
  const box = $('log');
  const scope = $('log-scope');
  if (!currentAccountId) {
    box.innerHTML = '<div class="muted">请先选择账号</div>';
    if (scope) scope.textContent = '';
    return;
  }
  if (scope) scope.textContent = '当前店铺';

  const [aiLog, sessions] = await Promise.all([
    window.api.ai.log(currentAccountId, 50),
    window.api.sessions.list(currentAccountId),
  ]);

  box.innerHTML = '';
  if (!aiLog.length) {
    box.innerHTML = '<div class="muted">暂无 AI 调用记录</div>';
    return;
  }

  for (const entry of aiLog) {
    const el = document.createElement('div');
    el.className = 'log-item';
    const t = new Date(entry.ts).toLocaleString('zh-CN', { hour12: false });
    el.innerHTML = `
      <div class="muted">${t} · session ${esc(entry.session_id)}</div>
      <div>${esc(entry.input)}</div>
      <div class="${entry.ok ? 'log-ok' : 'log-fail'}">
        ${entry.ok ? '→ ' + esc(entry.output) : '✕ ' + esc(entry.error)}
      </div>
      <div class="muted">${entry.ms ? entry.ms + 'ms' : ''} ${entry.tokens ? '· ' + entry.tokens + ' tokens' : ''} ${entry.model ? '· ' + esc(entry.model) : ''}</div>
    `;
    box.appendChild(el);
  }
}

/* ------------------------------ 面板切换 ------------------------------ */

function switchTab(tab) {
  activeTab = tab;
  for (const el of document.querySelectorAll('#panel .tabs div')) {
    el.classList.toggle('on', el.dataset.tab === tab);
  }
  const map = {
    rules: 'tab-rules',
    ai: 'tab-ai',
    delivery: 'tab-delivery',
    actions: 'tab-actions',
    notify: 'tab-notify',
    staff: 'tab-staff',
    log: 'tab-log',
  };
  for (const [k, id] of Object.entries(map)) {
    $(id).style.display = k === tab ? '' : 'none';
  }
  if (tab === 'ai') renderAi();
  if (tab === 'delivery') loadDelivery();
  if (tab === 'actions') loadActions();
  if (tab === 'notify') loadNotify();
  if (tab === 'staff') loadStaff();
  if (tab === 'log') loadLog();
  if (tab === 'rules') loadRules();
}

/* ------------------------------ 主题切换 ------------------------------ */

const THEMES = ['blue', 'amber', 'dark'];

function applyTheme(name) {
  if (!THEMES.includes(name)) name = 'blue';
  document.body.classList.remove(...THEMES.map((t) => 'theme-' + t));
  document.body.classList.add('theme-' + name);
  document.body.setAttribute('theme-mode', name === 'dark' ? 'dark' : 'light');
  window.api.setTheme(name).catch((error) => console.error('标题栏主题更新失败', error));

  for (const btn of document.querySelectorAll('#theme-switch button')) {
    btn.classList.toggle('on', btn.dataset.theme === name);
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === name));
  }
  try { localStorage.setItem('xy-theme', name); } catch (_) {}

  // 主题变了要重画图表（Canvas 不会自动跟着 CSS 变量变）
  if (typeof currentView !== 'undefined' && currentView === 'stats') {
    setTimeout(() => loadStats().catch(() => {}), 120);
  }
}

for (const btn of document.querySelectorAll('#theme-switch button')) {
  btn.onclick = () => applyTheme(btn.dataset.theme);
}

// 启动时恢复上次选的主题
(function restoreTheme() {
  let saved = null;
  try { saved = localStorage.getItem('xy-theme'); } catch (_) {}
  applyTheme(saved || 'blue');
})();

/* ------------------------------ 帮助与反馈 ------------------------------ */

async function openHelpModal() {
  const result = await window.dlg.form({
    title: '帮助与反馈',
    body: '本项目为开源整合的本地客户端，使用说明见仓库 README。\n如需反馈问题，请在项目仓库提交 Issue。',
    okText: '查看声明', cancelText: '关闭',
    fields: [],
  });
  if (!result) return;
  try { await window.api.openExternal('https://xianyuguanjia.com/legal.html'); }
  catch (_) { toast('请在浏览器打开 xianyuguanjia.com/legal.html'); }
}

/* ------------------------------ 事件 ------------------------------ */

$('btn-wx').onclick = openHelpModal;
$('btn-settings').onclick = () => switchView('settings');
$('btn-first-shop').onclick = () => $('btn-add').click();
$('btn-first-settings').onclick = () => switchView('settings');
for (const button of document.querySelectorAll('[data-shop-status]')) {
  button.onclick = () => { $('sf-status').value = button.dataset.shopStatus; $('sf-search').click(); };
}
for (const button of document.querySelectorAll('[data-order-status]')) {
  button.onclick = () => { $('of-status').value = button.dataset.orderStatus; $('of-search').click(); };
}

$('btn-add').onclick = async () => {
  const label = await window.dlg.prompt({
    title: '新增闲鱼账号',
    body: '给这个账号起个名字，方便你在左侧列表里辨认。',
    value: '店铺' + (accounts.length + 1),
    placeholder: '例如：小丸商城',
  });
  if (!label || !label.trim()) return;
  const acc = await window.api.accounts.add(label.trim());
  await selectAccount(acc.id);
  toast('账号已创建，请在右侧登录闲鱼');
};

/** 统一的「选中账号」入口，避免各处逻辑不一致 */
async function selectAccount(accountId) {
  currentAccountId = accountId;
  $('placeholder').style.display = 'none';
  await window.api.accounts.activate(accountId);
  await renderAccounts(await window.api.accounts.list());
  await Promise.all([loadRules(), loadLog()]);
}

$('btn-panel').onclick = async () => {
  const panel = $('panel');
  panel.classList.toggle('open');
  const isOpen = panel.classList.contains('open');
  // 关键：BrowserView 是原生视图，会盖住面板，
  // 所以开合面板时必须通知主进程收缩/放宽 view 的宽度
  await window.api.setPanelOpen(isOpen);
  if (isOpen) {
    if (!settings) settings = await window.api.settings.get();
    switchTab(activeTab);
  }
};

$('btn-close-panel').onclick = async () => {
  $('panel').classList.remove('open');
  await window.api.setPanelOpen(false);
};

$('btn-log').onclick = async () => {
  $('panel').classList.add('open');
  await window.api.setPanelOpen(true);
  if (!settings) settings = await window.api.settings.get();
  switchTab('log');
};

for (const el of document.querySelectorAll('#panel .tabs div')) {
  el.onclick = () => switchTab(el.dataset.tab);
}

$('btn-refresh-log').onclick = loadLog;

/* 实时反馈 */

window.api.accounts.onSync(renderAccounts);

window.api.accounts.onStatus((s) => {
  statuses[s.accountId] = { loggedIn: s.loggedIn };
  renderAccounts();
  if (s.loggedIn) toast(`账号「${(accounts.find((a) => a.id === s.accountId) || {}).label || s.accountId}」已登录`);
});

$('staff-select').onchange = async (e) => {
  const id = e.target.value ? Number(e.target.value) : null;
  await window.api.staff.setCurrent(id);
  currentStaffId = id;
  toast(id ? '已切换操作客服' : '已取消指定客服');
};

window.api.staff.onSync(({ staff, currentId }) => {
  staffList = staff;
  currentStaffId = currentId;
  renderStaffSelect();
  if (activeTab === 'staff' && $('panel').classList.contains('open')) renderStaffPanel();
});

window.api.sessions.onUpdated(() => {
  if (activeTab === 'staff' && $('panel').classList.contains('open')) loadStaff();
});

window.api.delivery.onResult((r) => {
  const label = (accounts.find((a) => a.id === r.accountId) || {}).label || r.accountId;
  if (r.ok) {
    toast(`[${label}] ${r.reason}${r.card ? '：' + r.card.slice(0, 20) : ''}`, 4000);
  } else {
    toast(`[${label}] 发货失败：${r.reason}`, 5000);
  }
  if (activeTab === 'delivery' && $('panel').classList.contains('open')) loadDelivery();
});

/* ------------------------------ 超时提醒 ------------------------------ */

async function refreshTimeoutBar() {
  const list = await window.api.reminder.pending();
  const bar = $('timeout-bar');
  if (!list.length) {
    bar.classList.remove('show');
    bar.innerHTML = '';
    return;
  }
  bar.classList.add('show');
  bar.innerHTML = list.slice(0, 5).map((item) => `
    <div class="timeout-item" data-acc="${item.accountId}" data-sid="${esc(item.sessionId)}">
      <div><b>${esc(item.peerNick)}</b> <span class="t">等待 ${item.waitingMinutes} 分钟</span></div>
      <div class="muted" style="margin-top:2px">${esc(item.lastText).slice(0, 50)}</div>
    </div>
  `).join('');
  for (const el of bar.querySelectorAll('.timeout-item')) {
    el.onclick = async () => {
      const accId = Number(el.dataset.acc);
      if (accId !== currentAccountId) await selectAccount(accId);
      win_focus_hint(el.dataset.sid);
    };
  }
}

function win_focus_hint(sid) {
  toast('请在上方聊天窗口回复该会话：' + sid, 4000);
}

// 窗口太窄时自动收起面板，避免把官方页面挤变形
window.api.onSpaceTight(async ({ width }) => {
  const panel = $('panel');
  if (!panel.classList.contains('open')) return;
  panel.classList.remove('open');
  await window.api.setPanelOpen(false);
  toast(`窗口太窄（官方页面仅剩 ${width}px），已自动收起设置面板。
放大窗口后再打开。`, 4000);
});

window.api.reminder.onAlert(() => refreshTimeoutBar());
window.api.reminder.onFocusSession(() => refreshTimeoutBar());

setInterval(refreshTimeoutBar, 60_000);

window.api.messages.onMessage(({ accountId, message, session }) => {
  if (accountId === currentAccountId) refreshTimeoutBar();
});

window.api.messages.onMessage(({ accountId, message }) => {
  if (accountId !== currentAccountId) return;
  if (activeTab === 'log' && $('panel').classList.contains('open')) loadLog();
});

window.api.messages.onDecision((p) => {
  const label = (accounts.find((a) => a.id === p.accountId) || {}).label || p.accountId;
  if (p.action === 'reply') {
    const preview = (p.replies || []).map((r) => r.content).join(' | ').slice(0, 40);
    toast(`[${label}] 自动回复：${preview}`);
  } else if (p.action === 'skip' && p.reason && !/未命中/.test(p.reason)) {
    toast(`[${label}] 跳过：${p.reason}`);
  }
});

window.api.messages.onSendResult((r) => {
  if (!r.ok) toast(`发送失败：${r.error}`, 4000);
});

/* ------------------------------ 启动 ------------------------------ */

(async function boot() {
  // macOS：原生红绿灯在左上，标题栏需要不同的左右留白
  if (window.api.platform === 'darwin') document.body.classList.add('mac');

  settings = await window.api.settings.get();
  await loadStaff();

  const list = await window.api.accounts.list();
  await renderAccounts(list);

  if (list.length) {
    await selectAccount(list[0].id);
  }
  await refreshTimeoutBar();
})();

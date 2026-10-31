'use strict';

/**
 * 二期功能界面：卡密库、消息中心、发货风控、买家互动、默认回复、商品专属回复、数据备份
 *
 * 单独成文件的原因：renderer.js 已经有 3000+ 行，
 * 继续往里堆会让「改一处要先读全文」的问题更严重。
 *
 * 依赖 renderer.js 暴露的全局：$(id)、esc、toast、accounts、currentAccountId。
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function accountLabel(accountId) {
    const list = (window.__xyAccounts && window.__xyAccounts()) || [];
    const row = list.find((a) => Number(a.id) === Number(accountId));
    return row ? row.label : `店铺${accountId}`;
  }

  function accountOptions(selected) {
    const list = (window.__xyAccounts && window.__xyAccounts()) || [];
    return '<option value="">请选择店铺</option>' + list
      .filter((a) => !a.disabled)
      .map((a) => `<option value="${a.id}" ${Number(selected) === Number(a.id) ? 'selected' : ''}>${esc(a.label)}</option>`)
      .join('');
  }

  /** 简单的分段开关渲染 */
  function toggleRow({ id, label, hint, checked, disabled }) {
    return `<label class="switch" style="display:flex;align-items:flex-start;gap:8px;margin:10px 0">
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
      <span><b style="font-weight:600">${esc(label)}</b>
      ${hint ? `<div class="muted" style="margin-top:2px;line-height:1.55">${esc(hint)}</div>` : ''}</span>
    </label>`;
  }

  /* ============================== 卡密库 ============================== */

  let cardTable = null;
  let cardGroupList = [];
  let cardStatsCache = [];

  async function loadCardLibrary() {
    const accountSel = $('cf-account-cards');
    if (accountSel) {
      const list = (window.__xyAccounts && window.__xyAccounts()) || [];
      accountSel.innerHTML = '<option value="">全部店铺</option>'
        + list.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('');
    }
    cardGroupList = await window.api.cardGroups.list(null);
    initCardTable();
    await cardTable.reload();
    await renderCardStats();
  }

  async function renderCardStats() {
    const box = $('card-stat-grid');
    if (!box) return;
    const rows = await window.api.delivery.cards(null, null);
    const total = rows.length;
    const unused = rows.filter((r) => r.status === 'unused').length;
    const reserved = rows.filter((r) => r.status === 'reserved').length;
    const used = rows.filter((r) => r.status === 'used').length;
    const card = (label, value, color) => `<div class="stat-card">
      <div class="label">${label}</div>
      <div class="value" style="color:${color || 'inherit'}">${value}</div>
    </div>`;
    box.innerHTML = card('卡密总数', total) + card('可用库存', unused, 'var(--ok)')
      + card('占用中', reserved, 'var(--warn)') + card('已使用', used, 'var(--ink-3)');
  }

  function initCardTable() {
    if (cardTable) return cardTable;
    cardTable = new window.DataTable({
      mount: $('card-list'),
      title: '卡密列表',
      emptyIcon: '🔑',
      emptyText: '还没有卡密',
      emptyHint: '点右上「导入卡密」，或在「自动发货」里给商品导入',
      pageSizeOptions: [20, 50, 100],
      rowKey: (r) => r.id,
      toolbarButtons: [{ icon: '⟳', title: '刷新', onClick: (t) => { t.reload(); renderCardStats(); } }],
      columns: [
        { key: '_check', label: '', width: '42px' },
        {
          key: 'content', label: '卡密内容', sortable: true,
          render: (r) => `<span class="cell-num" style="word-break:break-all">${esc(r.content)}</span>`,
        },
        {
          key: 'item', label: '商品', width: '200px',
          render: (r) => `<div class="cell-sub">${esc(r.item_id || '-')}</div>
            <div class="cell-sub">${esc(accountLabel(r.account_id))}</div>`,
        },
        {
          key: 'group', label: '分组', width: '110px',
          render: (r) => {
            const g = cardGroupList.find((row) => row.id === r.group_id);
            return g ? `<span class="badge">${esc(g.name)}</span>` : '<span class="muted">-</span>';
          },
        },
        {
          key: 'status', label: '状态', width: '90px',
          render: (r) => {
            const map = {
              unused: ['on', '可用'],
              reserved: ['warn', '占用中'],
              used: ['off', '已用'],
            };
            const [cls, text] = map[r.status] || ['off', r.status || '未知'];
            return `<span class="st ${cls}">${text}</span>`;
          },
        },
        {
          key: 'order', label: '使用订单', width: '170px',
          render: (r) => r.used_order_no
            ? `<span class="cell-num" style="font-size:12px">${esc(r.used_order_no)}</span>`
            : '<span class="muted">-</span>',
        },
        {
          key: 'ops', label: '操作', width: '90px',
          render: (r) => (r.status === 'reserved' ? '<span class="muted" style="font-size:12px">待核对</span>'
            : '<button class="act-link danger" data-row-act="remove">删除</button>'),
        },
      ],
      rowActions: {
        remove: async (row) => {
          const ok = await window.dlg.confirm({
            title: '删除卡密', body: `确认删除这条卡密？\n${row.content}\n\n删除后无法恢复。`,
            okText: '删除', danger: true,
          });
          if (!ok) return;
          try {
            await window.api.delivery.removeCard(row.id);
            toast('已删除');
          } catch (error) { toast(error.message, 5000); }
          cardTable.reload(); renderCardStats();
        },
      },
      batchActions: [{
        label: '批量删除',
        danger: true,
        onClick: async (rows, t) => {
          const ok = await window.dlg.confirm({
            title: '批量删除卡密', body: `删除选中的 ${rows.length} 条卡密？占用中的会被跳过。`,
            okText: '删除', danger: true,
          });
          if (!ok) return;
          let done = 0, skipped = 0;
          for (const row of rows) {
            try { await window.api.delivery.removeCard(row.id); done += 1; }
            catch (_) { skipped += 1; }
          }
          toast(`已删除 ${done} 条${skipped ? `，跳过 ${skipped} 条（占用中）` : ''}`, 4000);
          t.selected.clear(); t.reload(); renderCardStats();
        },
      }],
      fetch: async ({ page, pageSize }) => {
        const kw = String(($('cf-kw-cards') || {}).value || '').trim().toLowerCase();
        const accountId = Number((($('cf-account-cards') || {}).value) || 0) || null;
        const status = ($('cf-status-cards') || {}).value || '';
        let list = await window.api.delivery.cards(accountId, null);
        if (status) list = list.filter((row) => row.status === status);
        if (kw) {
          list = list.filter((row) => String(row.content || '').toLowerCase().includes(kw)
            || String(row.item_id || '').includes(kw));
        }
        const total = list.length;
        return { list: list.slice((page - 1) * pageSize, page * pageSize), total };
      },
    });
    return cardTable;
  }

  async function importCardsDialog() {
    const accSel = $('cf-account-cards');
    const selected = accSel && accSel.value ? Number(accSel.value) : (window.__xyCurrentAccount() || null);
    if (!selected) { toast('请先在筛选里选择店铺', 4000); return; }
    const groups = cardGroupList.filter((g) => !g.account_id || g.account_id === Number(selected));
    const r = await window.dlg.form({
      title: '导入卡密',
      body: '一行一条，重复的会自动跳过。',
      okText: '导入',
      fields: [
        { key: 'item_id', label: '商品ID', placeholder: '123456789', required: true,
          hint: '卡密会绑定到这个商品，自动发货时按商品取' },
        { key: 'group_id', label: '分组', type: 'select', value: '',
          options: [{ value: '', label: '不分组' }].concat(groups.map((g) => ({ value: g.id, label: g.name }))) },
        { key: 'text', label: '卡密列表', type: 'textarea', rows: 10, required: true,
          placeholder: 'CARD-AAA-111\nCARD-BBB-222\nCARD-CCC-333' },
      ],
    });
    if (!r) return;
    const res = await window.api.delivery.importCards(selected, r.item_id.trim(), r.text,
      r.group_id ? Number(r.group_id) : null);
    toast(`导入完成：新增 ${res.added} 条，跳过重复 ${res.skipped} 条`, 4000);
    if (cardTable) cardTable.reload();
    renderCardStats();
  }

  async function manageCardGroups() {
    const list = await window.api.cardGroups.list(null);
    const box = document.createElement('div');
    const render = () => {
      box.innerHTML = list.length
        ? list.map((g) => `<div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">
            <div><b>${esc(g.name)}</b>${g.note ? `<div class="muted">${esc(g.note)}</div>` : ''}</div>
            <button data-del="${g.id}" class="act-link danger">删除</button>
          </div>`).join('')
        : '<div class="muted">还没有分组</div>';
    };
    render();

    const ok = await window.dlg.open({
      title: '卡券分组',
      body: box,
      okText: '新增分组',
      cancelText: '关闭',
    });
    if (!ok) return;
    const r = await window.dlg.form({
      title: '新增分组', okText: '保存',
      fields: [
        { key: 'name', label: '分组名称', required: true, placeholder: '例如：月卡 / 年卡 / 测试卡' },
        { key: 'note', label: '备注', placeholder: '可选' },
      ],
    });
    if (!r) return;
    await window.api.cardGroups.save({ accountId: null, name: r.name, note: r.note });
    cardGroupList = await window.api.cardGroups.list(null);
    toast('分组已创建');
  }

  /* ============================== 消息中心 ============================== */

  let inboxMode = 'sessions';

  async function loadInbox() {
    const sel = $('ib-account');
    if (sel) {
      const list = (window.__xyAccounts && window.__xyAccounts()) || [];
      sel.innerHTML = '<option value="">全部店铺</option>'
        + list.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('');
    }
    for (const tab of document.querySelectorAll('[data-inbox-mode]')) {
      tab.classList.toggle('on', tab.dataset.inboxMode === inboxMode);
    }
    const bar = $('inbox-filter-bar');
    if (bar) bar.style.display = inboxMode === 'filters' ? 'none' : '';
    const box = $('inbox-list');
    if (!box) return;

    if (inboxMode === 'sessions') return renderInboxSessions(box);
    if (inboxMode === 'replylog') return renderInboxReplyLog(box);
    return renderInboxFilters(box);
  }

  async function renderInboxSessions(box) {
    const accountId = Number((($('ib-account') || {}).value) || 0) || null;
    const kw = String((($('ib-kw') || {}).value) || '').trim().toLowerCase();
    const list = await window.api.sessions.listAll(accountId);
    const rows = kw
      ? list.filter((row) => String(row.peer_nick || '').toLowerCase().includes(kw)
        || String(row.last_text || '').toLowerCase().includes(kw))
      : list;
    if (!rows.length) {
      box.innerHTML = '<div class="card muted">还没有会话。打开店铺聊天页并接收一条消息后，会话会出现在这里。</div>';
      return;
    }
    box.innerHTML = `<div class="card" style="padding:0;overflow:hidden">
      ${rows.slice(0, 200).map((row) => {
        const t = row.last_ts ? new Date(row.last_ts).toLocaleString('zh-CN', { hour12: false }) : '';
        return `<div class="row" style="justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);cursor:pointer"
            data-open="${row.account_id}|${esc(row.id)}">
          <div style="min-width:0;flex:1">
            <div><b>${esc(row.peer_nick || row.id)}</b>
              <span class="badge" style="margin-left:6px">${esc(accountLabel(row.account_id))}</span>
              ${row.unread ? '<span class="badge" style="background:var(--danger);color:#fff;margin-left:6px">未读</span>' : ''}
            </div>
            <div class="muted" style="margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${esc(row.last_text || '（无消息）')}
            </div>
          </div>
          <span class="muted" style="font-size:12px;flex-shrink:0">${esc(t)}</span>
        </div>`;
      }).join('')}
    </div>`;
    for (const node of box.querySelectorAll('[data-open]')) {
      node.onclick = async () => {
        const [accountIdRaw, sessionId] = node.dataset.open.split('|');
        await window.api.messageAlerts.focus(Number(accountIdRaw), sessionId);
        await window.showView('chat');
      };
    }
  }

  async function renderInboxReplyLog(box) {
    const accountId = Number((($('ib-account') || {}).value) || 0) || null;
    const kw = String((($('ib-kw') || {}).value) || '').trim().toLowerCase();
    let list = await window.api.replyLog.list(accountId, 300);
    if (kw) {
      list = list.filter((row) => String(row.buyer_nick || '').toLowerCase().includes(kw)
        || String(row.message || '').toLowerCase().includes(kw));
    }
    if (!list.length) {
      box.innerHTML = '<div class="card muted">还没有回复决策记录。买家发来消息并触发自动回复后，这里会记录「为什么回 / 为什么没回」。</div>';
      return;
    }
    const colorOf = (action) => ({
      reply: 'var(--ok)', skip: 'var(--ink-3)', error: 'var(--danger)', ai: 'var(--semi-color-primary)',
    }[action] || 'inherit');
    box.innerHTML = `<div class="card" style="padding:0;overflow:hidden">
      ${list.map((row) => {
        const t = new Date(row.ts).toLocaleString('zh-CN', { hour12: false });
        return `<div style="padding:10px 16px;border-bottom:1px solid var(--line)">
          <div class="row"><b>${esc(row.buyer_nick || '买家')}</b>
            <span class="badge">${esc(accountLabel(row.account_id))}</span>
            <span class="muted" style="font-size:12px">${esc(t)}</span></div>
          <div style="margin-top:2px;font-size:13px;color:${colorOf(row.action)}">
            ${esc(row.action)} · ${esc(row.reason || '')}
          </div>
          ${row.message ? `<div class="muted" style="margin-top:2px">买家：${esc(row.message)}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  }

  async function renderInboxFilters(box) {
    const accountId = Number((($('ib-account') || {}).value) || 0) || null;
    const targets = accountId
      ? [accountId]
      : ((window.__xyAccounts() || []).filter((a) => !a.disabled).map((a) => a.id));
    box.innerHTML = '';
    for (const id of targets) {
      const filters = await window.api.messageFilters.list(id);
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="row" style="justify-content:space-between">
          <b>${esc(accountLabel(id))}</b>
          <button class="act-link" data-add>＋ 添加过滤词</button>
        </div>
        <div class="muted" style="margin-top:4px">买家消息包含这些词时不自动回复（例如「自动回复」「机器人」）。</div>
        <div style="margin-top:8px">${filters.length ? filters.map((f) =>
          `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">
            <span>${esc(f.keyword)} <span class="muted">(${f.filter_type === 'exact' ? '完全匹配' : '包含'})</span></span>
            <button class="act-link danger" data-del="${f.id}">删除</button>
          </div>`).join('') : '<div class="muted">暂无过滤词</div>'}</div>`;
      card.querySelector('[data-add]').onclick = async () => {
        const r = await window.dlg.form({
          title: '添加过滤词', okText: '添加',
          fields: [
            { key: 'keyword', label: '过滤词', required: true, placeholder: '自动回复' },
            { key: 'filter_type', label: '匹配方式', type: 'select', value: 'contains',
              options: [{ value: 'contains', label: '包含即忽略' }, { value: 'exact', label: '完全一致才忽略' }] },
          ],
        });
        if (!r) return;
        await window.api.messageFilters.save({ accountId: id, keyword: r.keyword, filter_type: r.filter_type });
        toast('已添加');
        renderInboxFilters(box);
      };
      for (const btn of card.querySelectorAll('[data-del]')) {
        btn.onclick = async () => {
          await window.api.messageFilters.remove(Number(btn.dataset.del));
          renderInboxFilters(box);
        };
      }
      box.appendChild(card);
    }
  }

  /* ============================== 发货风控 ============================== */

  const RISK_RULES = [
    { key: 'buyerBlacklist', name: '买家黑名单',
      hint: '买家在「客户管理」里被拉黑时，拦截其订单的自动发货' },
    { key: 'buyerHasOpenOrder', name: '买家本店有未完成订单',
      hint: '同一买家在本店还有待发货/待收货订单时拦截，防止一单多拍薅卡密' },
    { key: 'buyerHasOpenOrderGlobal', name: '买家跨店铺有未完成订单',
      hint: '同一买家在本机任一店铺还有未完成订单时拦截' },
    { key: 'buyerLowCredit', name: '买家信用过低',
      hint: '买家评价数不高于阈值时拦截；需要订单页能读到评价数才会生效' },
  ];

  async function renderDeliveryRisk(container) {
    const cfg = await window.api.delivery.riskSettings();
    const log = await window.api.delivery.blockLog(null, 30);
    container.innerHTML = `
      <div class="card">
        <div style="font-size:14px;font-weight:600">发货前风控</div>
        <div class="muted" style="margin-top:4px;line-height:1.6">
          发货前先按本地订单与客户数据检查，命中就<b>拦截并记录</b>，不会把卡密发出去。
          规则只读本地数据，不额外请求平台，所以判定偏保守。
        </div>
        ${RISK_RULES.map((rule) => {
          const row = cfg[rule.key] || {};
          const extra = rule.key === 'buyerLowCredit'
            ? `<div class="row" style="margin:2px 0 0 26px"><span class="muted" style="font-size:12.5px">评价数不高于</span>
                <input id="risk-threshold" type="number" min="0" max="999" value="${row.threshold || 0}" style="width:64px;height:26px" /></div>`
            : '';
          const sameOnly = (rule.key.startsWith('buyerHasOpenOrder'))
            ? `<div style="margin:2px 0 0 26px"><label class="switch" style="display:inline-flex">
                <input type="checkbox" id="risk-same-${rule.key}" ${row.sameItemOnly ? 'checked' : ''} ${row.enabled ? '' : 'disabled'} />
                <span class="muted" style="font-size:12.5px">仅限同一商品</span></label></div>`
            : '';
          return `<div style="border-top:1px solid var(--line);padding-top:12px;margin-top:12px">
            ${toggleRow({ id: `risk-${rule.key}`, label: rule.name, hint: rule.hint, checked: !!row.enabled })}
            ${extra}${sameOnly}
          </div>`;
        }).join('')}
        <div class="row" style="margin-top:14px"><button class="primary" id="risk-save">保存风控设置</button></div>
      </div>
      <div class="card">
        <div style="font-size:14px;font-weight:600">拦截记录</div>
        <div class="muted" style="margin-top:2px">最近 30 条</div>
        <div style="margin-top:8px">${log.length ? log.map((row) => {
          const t = new Date(row.ts).toLocaleString('zh-CN', { hour12: false });
          return `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
            <div class="muted">${esc(t)} · ${esc(accountLabel(row.account_id))} · 订单 ${esc(row.order_no)}</div>
            <div style="color:var(--danger)">${esc(row.reason)}</div>
          </div>`;
        }).join('') : '<div class="muted">还没有拦截记录</div>'}</div>
      </div>`;

    container.querySelector('#risk-save').onclick = async () => {
      const patch = {};
      for (const rule of RISK_RULES) {
        const enabled = container.querySelector(`#risk-${rule.key}`).checked;
        patch[rule.key] = { enabled };
        if (rule.key === 'buyerLowCredit') {
          patch[rule.key].threshold = Math.max(0, Number(container.querySelector('#risk-threshold').value) || 0);
        }
        if (rule.key.startsWith('buyerHasOpenOrder')) {
          patch[rule.key].sameItemOnly = container.querySelector(`#risk-same-${rule.key}`).checked;
        }
      }
      await window.api.delivery.saveRisk(patch);
      toast('风控设置已保存');
    };

    // 子选项跟随父开关：关掉主规则时，子项置灰，避免看起来还在生效
    for (const rule of RISK_RULES) {
      if (!rule.key.startsWith('buyerHasOpenOrder')) continue;
      const parent = container.querySelector(`#risk-${rule.key}`);
      const child = container.querySelector(`#risk-same-${rule.key}`);
      if (parent && child) parent.onchange = () => { child.disabled = !parent.checked; };
    }
  }

  /* ============================== 买家互动 ============================== */

  const INTERACTION_ITEMS = [
    { key: 'thanks', name: '收货致谢', hint: '买家确认收货、交易成功后发一条感谢消息', risk: false },
    { key: 'flower', name: '索要小红花', hint: '交易成功后向买家要一朵小红花（会发消息）', risk: false },
    { key: 'rate', name: '自动评价买家', hint: '在订单页提交好评。评价一旦提交不可撤销', risk: true },
    { key: 'receiveFlower', name: '自动收下小红花', hint: '买家赠送小红花时自动点「收下」', risk: false },
  ];

  async function renderBuyerInteraction(container) {
    if (!window.__xyCurrentAccount()) {
      container.innerHTML = '<div class="card muted">请先在「客服工作台」选择一家店铺，买家互动是按店铺单独开关的。</div>';
      return;
    }
    const accountId = window.__xyCurrentAccount();
    const cfg = await window.api.interaction.get(accountId);
    const log = await window.api.interaction.log(accountId, 30);

    container.innerHTML = `
      <div class="card">
        <div style="font-size:14px;font-weight:600">买家互动 · ${esc(accountLabel(accountId))}</div>
        <div class="muted" style="margin-top:4px;line-height:1.6">
          全部默认关闭，逐店铺单独开启。每笔订单每项只执行一次，失败会记入下方日志。
          <b style="color:var(--danger)">自动评价不可撤销</b>，开启前请确认评价文案。
        </div>
        <div class="row" style="margin-top:10px">
          <span class="muted">交易成功后延迟</span>
          <input id="bi-delay" type="number" min="0" max="1440" value="${cfg.delayMinutes || 0}" style="width:70px" />
          <span class="muted">分钟执行</span>
        </div>
        ${INTERACTION_ITEMS.map((item) => {
          const row = cfg[item.key] || {};
          const tpl = item.key === 'receiveFlower' ? '' : `
            <div style="margin:6px 0 0 24px">
              <input id="bi-tpl-${item.key}" value="${esc(row.template || '')}" style="width:100%"
                placeholder="${item.key === 'rate' ? '评价内容' : '消息内容，可用 {买家昵称}'}" />
              ${item.key === 'rate' ? `<div class="row" style="margin-top:4px"><span class="muted">评分数</span>
                <select id="bi-score"><option value="5" ${Number(row.score) !== 4 ? 'selected' : ''}>5 星好评</option>
                <option value="4" ${Number(row.score) === 4 ? 'selected' : ''}>4 星</option></select></div>` : ''}
            </div>`;
          return `<div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
            ${toggleRow({
              id: `bi-${item.key}`,
              label: `${item.name}${item.risk ? '（高风险）' : ''}`,
              hint: item.hint,
              checked: !!row.enabled,
            })}
            ${tpl}
          </div>`;
        }).join('')}
        <div class="row" style="margin-top:14px"><button class="primary" id="bi-save">保存</button></div>
      </div>
      <div class="card">
        <div style="font-size:14px;font-weight:600">执行记录</div>
        <div style="margin-top:8px">${log.length ? log.map((row) => {
          const t = new Date(row.ts).toLocaleString('zh-CN', { hour12: false });
          const names = { thanks: '致谢', flower: '求花', rate: '评价', receiveFlower: '收花', skip: '跳过' };
          return `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
            <div class="muted">${esc(t)} · 订单 ${esc(row.order_no)}</div>
            <div class="${row.ok ? 'log-ok' : 'log-fail'}">
              ${row.ok ? '✓' : '✕'} ${esc(names[row.action] || row.action)} ${esc(row.reason || '')}
            </div>
          </div>`;
        }).join('') : '<div class="muted">还没有执行记录</div>'}</div>
      </div>`;

    container.querySelector('#bi-save').onclick = async () => {
      const patch = { delayMinutes: Math.max(0, Number(container.querySelector('#bi-delay').value) || 0) };
      for (const item of INTERACTION_ITEMS) {
        patch[item.key] = { enabled: container.querySelector(`#bi-${item.key}`).checked };
        if (item.key !== 'receiveFlower') {
          patch[item.key].template = container.querySelector(`#bi-tpl-${item.key}`).value;
        }
        if (item.key === 'rate') {
          patch[item.key].score = Number(container.querySelector('#bi-score').value) || 5;
        }
      }
      await window.api.interaction.save(accountId, patch);
      toast('买家互动设置已保存');
    };
  }

  /* ============================== 默认回复 ============================== */

  async function renderDefaultReply(container) {
    if (!window.__xyCurrentAccount()) {
      container.innerHTML = '<div class="card muted">请先选择店铺。默认回复是按店铺单独设置的。</div>';
      return;
    }
    const accountId = window.__xyCurrentAccount();
    const cfg = await window.api.defaultReply.get(accountId);
    container.innerHTML = `
      <div class="card">
        <div style="font-size:14px;font-weight:600">默认回复 · ${esc(accountLabel(accountId))}</div>
        <div class="muted" style="margin-top:4px;line-height:1.6">
          关键词规则和 AI 都没有命中时，用这一句兜底。<br/>
          顺序：商品专属回复 → 关键词规则 → AI → 默认回复。
        </div>
        ${toggleRow({ id: 'dr-enabled', label: '启用默认回复', checked: !!cfg.enabled })}
        ${toggleRow({ id: 'dr-once', label: '每个会话只回一次',
          hint: '开启后同一个买家只收到一次默认回复，避免反复打扰', checked: cfg.reply_once !== false })}
        <label style="display:block;margin-top:10px;font-size:13px">回复内容</label>
        <textarea id="dr-content" rows="5" style="width:100%;margin-top:4px"
          placeholder="您好，我这边稍后回复您，有问题可以先留言~">${esc(cfg.content || '')}</textarea>
        <div class="row" style="margin-top:14px"><button class="primary" id="dr-save">保存</button></div>
      </div>`;
    container.querySelector('#dr-save').onclick = async () => {
      await window.api.defaultReply.save(accountId, {
        enabled: container.querySelector('#dr-enabled').checked,
        reply_once: container.querySelector('#dr-once').checked,
        content: container.querySelector('#dr-content').value,
      });
      toast('默认回复已保存');
    };
  }

  /* ============================== 商品专属回复 ============================== */

  async function renderItemReplies(container) {
    if (!window.__xyCurrentAccount()) {
      container.innerHTML = '<div class="card muted">请先选择店铺。</div>';
      return;
    }
    const accountId = window.__xyCurrentAccount();
    const list = await window.api.itemReplies.list(accountId);
    container.innerHTML = `
      <div class="card">
        <div style="font-size:14px;font-weight:600">商品专属回复 · ${esc(accountLabel(accountId))}</div>
        <div class="muted" style="margin-top:4px;line-height:1.6">
          买家在当前商品会话里发消息时，优先回这条内容（优先级高于关键词规则）。<br/>
          适合「这个链接对应的自动回复」——例如发卡密的商品统一回「拍下自动发货」。
        </div>
        <button id="ir-add" class="primary" style="margin-top:10px">＋ 添加商品回复</button>
      </div>
      <div id="ir-list"></div>`;

    const listBox = container.querySelector('#ir-list');
    const draw = () => {
      listBox.innerHTML = list.length ? list.map((row) => `
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <b>${esc(row.item_title || row.item_id)}</b>
            <label class="switch"><input type="checkbox" data-enable="${row.id}" ${row.enabled ? 'checked' : ''} /><span class="muted">启用</span></label>
          </div>
          <div class="muted">商品ID：${esc(row.item_id)}</div>
          <div style="margin-top:6px;white-space:pre-wrap">${esc(row.content)}</div>
          <div class="row" style="margin-top:8px">
            <button data-edit="${row.id}">编辑</button>
            <button class="danger" data-del="${row.id}">删除</button>
          </div>
        </div>`).join('') : '<div class="card muted">还没有商品专属回复</div>';

      for (const node of listBox.querySelectorAll('[data-enable]')) {
        node.onchange = async (event) => {
          const row = list.find((r) => r.id === Number(node.dataset.enable));
          await window.api.itemReplies.save({ ...row, accountId, enabled: event.target.checked });
          toast(event.target.checked ? '已启用' : '已停用');
        };
      }
      for (const node of listBox.querySelectorAll('[data-del]')) {
        node.onclick = async () => {
          await window.api.itemReplies.remove(Number(node.dataset.del));
          toast('已删除');
          renderItemReplies(container);
        };
      }
      for (const node of listBox.querySelectorAll('[data-edit]')) {
        node.onclick = () => editItemReply(list.find((r) => r.id === Number(node.dataset.edit)), container);
      }
    };
    draw();

    container.querySelector('#ir-add').onclick = () => editItemReply(null, container);
  }

  async function editItemReply(row, container) {
    const accountId = window.__xyCurrentAccount();
    const products = await window.api.products.list({ accountId, search: '', status: '' });
    const r = await window.dlg.form({
      title: row ? '编辑商品回复' : '添加商品回复',
      okText: '保存',
      fields: [
        { key: 'item_id', label: '商品', type: 'select', value: row ? row.item_id : '', required: true,
          options: [{ value: '', label: '选择商品' }].concat(products.slice(0, 200).map((p) => ({
            value: p.item_id, label: `${p.title || p.item_id}（${p.item_id}）`,
          }))) },
        { key: 'content', label: '回复内容', type: 'textarea', rows: 5, required: true,
          value: row ? row.content : '',
          hint: '买家打开这个商品的会话时使用。支持多段消息，用 --- 分隔' },
      ],
    });
    if (!r) return;
    const product = products.find((p) => String(p.item_id) === String(r.item_id));
    await window.api.itemReplies.save({
      accountId, item_id: r.item_id, content: r.content,
      item_title: product ? product.title : (row ? row.item_title : ''),
      enabled: row ? row.enabled : true,
    });
    toast('已保存');
    renderItemReplies(container);
  }

  /* ============================== 数据备份 ============================== */

  async function renderBackup(container) {
    let backups = [];
    try { backups = await window.api.backup.list(); } catch (_) { backups = []; }
    container.innerHTML = `
      <div class="card">
        <div style="font-size:14px;font-weight:600">数据备份</div>
        <div class="muted" style="margin-top:4px;line-height:1.6">
          导出会生成一个文件夹，包含：<br/>
          · state.json —— 店铺、规则、卡密、订单、客户、设置（不含登录态）<br/>
          · messages/ —— 聊天记录<br/>
          · product-images/ —— 图片卡密与商品图片（兼容旧版 assets/）<br/><br/>
          导入前会保存当前数据并暂停后台操作。导入后会清除对应店铺的旧登录态，请退出并重启，再逐店铺启用并重新扫码登录。
        </div>
        <div class="row" style="margin-top:14px">
          <button class="primary" id="bk-export">导出备份</button>
          <button id="bk-import">导入备份</button>
        </div>
      </div>
      <div class="card">
        <div style="font-size:14px;font-weight:600">自动备份记录</div>
        <div class="muted" style="margin-top:2px">每次导入前的保护性备份，以及手动导出的记录</div>
        <div style="margin-top:8px">${backups.length ? backups.slice(0, 20).map((row) => {
          const t = new Date(row.at).toLocaleString('zh-CN', { hour12: false });
          return `<div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">
            <span class="cell-num" style="font-size:12px">${esc(row.name)}</span>
            <span class="muted" style="font-size:12px">${esc(t)}</span>
          </div>`;
        }).join('') : '<div class="muted">还没有备份记录</div>'}</div>
      </div>`;

    container.querySelector('#bk-export').onclick = async () => {
      const r = await window.api.backup.export();
      if (r.canceled) return;
      if (r.ok) {
        await window.dlg.alert({
          title: '备份完成',
          body: `已导出 ${r.files} 个文件到：\n${r.path}\n\n把这个文件夹拷到安全的位置即可。`,
        });
      } else {
        await window.dlg.alert({ title: '备份失败', body: r.error || '未知错误' });
      }
    };

    container.querySelector('#bk-import').onclick = async () => {
      const ok = await window.dlg.confirm({
        title: '导入备份',
        body: '导入会用备份中的数据覆盖当前数据。\n当前数据会先自动备份到 backups/ 目录。\n\n后台操作会暂停，并清除对应店铺的旧登录态。导入后请退出并重启，再逐店铺启用并重新扫码登录。',
        okText: '选择备份文件夹', danger: true,
      });
      if (!ok) return;
      const r = await window.api.backup.import();
      if (r.canceled) return;
      if (r.ok) {
        await window.dlg.alert({
          title: '导入完成',
          body: `已导入 ${r.files} 个文件。\n当前数据已保护性备份到：\n${r.backup}\n\n请重启软件后使用。`,
        });
      } else {
        await window.dlg.alert({ title: '导入失败', body: r.error || '未知错误' });
      }
    };
  }

  /* ============================== 注册到全局 ============================== */

  window.XYFeatures = {
    loadCardLibrary, importCardsDialog, manageCardGroups,
    loadInbox,
    renderDeliveryRisk, renderBuyerInteraction,
    renderDefaultReply, renderItemReplies, renderBackup,
  };

  /** 切到消息中心 tab */
  window.__xyInboxMode = (mode) => { inboxMode = mode; loadInbox(); };

  /* ============================== 页面事件绑定 ============================== */

  function bindOnce(id, fn) {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  }

  document.addEventListener('DOMContentLoaded', () => {
    // 卡密库
    bindOnce('btn-import-cards', () => importCardsDialog());
    bindOnce('btn-card-groups', () => manageCardGroups());
    bindOnce('cf-search-cards', () => { if (cardTable) { cardTable.page = 1; cardTable.reload(); } renderCardStats(); });
    bindOnce('cf-reset-cards', () => {
      $('cf-kw-cards').value = '';
      $('cf-account-cards').value = '';
      $('cf-status-cards').value = '';
      if (cardTable) { cardTable.page = 1; cardTable.reload(); }
      renderCardStats();
    });
    const kwCards = $('cf-kw-cards');
    if (kwCards) kwCards.onkeydown = (e) => { if (e.key === 'Enter') $('cf-search-cards').click(); };
    const statusCards = $('cf-status-cards');
    if (statusCards) statusCards.onchange = () => { if (cardTable) { cardTable.page = 1; cardTable.reload(); } };
    const accCards = $('cf-account-cards');
    if (accCards) accCards.onchange = () => { if (cardTable) { cardTable.page = 1; cardTable.reload(); } renderCardStats(); };

    // 消息中心
    bindOnce('btn-refresh-inbox', () => loadInbox());
    bindOnce('ib-search', () => loadInbox());
    const ibKw = $('ib-kw');
    if (ibKw) ibKw.onkeydown = (e) => { if (e.key === 'Enter') loadInbox(); };
    for (const tab of document.querySelectorAll('[data-inbox-mode]')) {
      tab.onclick = () => { inboxMode = tab.dataset.inboxMode; loadInbox(); };
    }
    const ibAccount = $('ib-account');
    if (ibAccount) ibAccount.onchange = () => loadInbox();
  });
})();

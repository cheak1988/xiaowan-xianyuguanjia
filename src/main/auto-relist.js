'use strict';
const crypto = require('crypto');
function createAutoRelist({ store, drafts, products, onUpdated = () => {} }) {
  let timer, running = false;
  const state = () => { const s = store.ready(); s.relistRules ||= []; s.relistLog ||= []; return s; };
  for (const log of state().relistLog) if (['preparing', 'publishing'].includes(log.status)) { log.status = 'uncertain'; log.error = '上次运行中断，请核对商品后登记结果'; }
  const list = () => ({ rules: state().relistRules.map(({ template, ...row }) => ({ ...row, template_title: template.title })), log: state().relistLog.slice(-200).reverse() });
  async function save(input) {
    const account = store.getAccount(Number(input.account_id)); if (!account || account.disabled) throw new Error('请选择已启用的店铺');
    const source = drafts.get(input.draft_id);
    if (source.account_id !== account.id || !source.source_item_id) throw new Error('请选择从该店铺商品读取的完整编辑草稿');
    drafts.validate(source);
    if (source.sku?.enabled) throw new Error('多规格商品优先使用闲鱼库存持续销售，暂不支持整件售罄后的自动续售');
    const itemId = String(source.source_item_id), s = state();
    const existing = s.relistRules.find((row) => row.id === input.id || row.account_id === account.id && row.item_id === itemId);
    if (existing && s.relistLog.some((log) => log.rule_id === existing.id && ['preparing', 'publishing', 'uncertain'].includes(log.status))) throw new Error('续售结果尚未核对，请先处理记录');
    const live = input.enabled ? await products.sync(account.id, { background: true }) : null;
    if (input.enabled && (!live?.ok || !live.complete)) throw new Error('未完整确认店铺在售商品，请同步后重试');
    const product = (live?.products || store.listProducts(account.id)).find((row) => row.item_id === itemId);
    if (input.enabled && product?.status !== 'on_sale') throw new Error('请先同步并选择当前在售商品，历史已售出商品不会自动重发');
    const template = JSON.parse(JSON.stringify(source)); delete template.id; delete template.preparation; delete template.source_item_id; delete template.published_item_id;
    const row = { id: existing?.id || crypto.randomUUID(), account_id: account.id, item_id: itemId, template, enabled: !!input.enabled,
      wait_delivery: input.wait_delivery !== false, delay_seconds: Math.max(30, Math.min(86400, Number(input.delay_seconds) || 60)),
      min_cards: Math.max(1, Math.min(9999, Number(input.min_cards) || 1)), enabled_at: Date.now(), seen_on_sale: product?.status === 'on_sale', sold_at: 0, error: '' };
    if (existing) s.relistRules[s.relistRules.indexOf(existing)] = row; else s.relistRules.push(row);
    store.persist(); return list();
  }
  async function toggle(id, enabled) {
    const rule = state().relistRules.find((row) => row.id === id); if (!rule) throw new Error('续售规则不存在');
    if (enabled) {
      if (state().relistLog.some((log) => log.rule_id === id && ['uncertain', 'preparing', 'publishing'].includes(log.status))) throw new Error('请先核对未完成的续售');
      const live = await products.sync(rule.account_id, { background: true });
      const product = live.products?.find((row) => row.item_id === rule.item_id);
      const retry = product?.status === 'sold' && rule.seen_on_sale && state().relistLog.some((log) => log.rule_id === id && log.item_id === rule.item_id && log.status === 'cancelled');
      if (!live.ok || !live.complete || product?.status !== 'on_sale' && !retry) throw new Error('请先同步并确认商品在售；续售失败需先登记确认未发布');
      if (!retry) { rule.enabled_at = Date.now(); rule.seen_on_sale = true; rule.sold_at = 0; }
    }
    rule.enabled = !!enabled; store.persist(); return list();
  }
  function migrate(rule, log, newId) {
    const s = state(), oldId = log.item_id;
    if (s.deliverRules.some((row) => row.account_id === rule.account_id && row.item_id === newId)) throw new Error('新商品已有发货规则，请人工核对后迁移');
    const deliveryRule = s.deliverRules.find((row) => row.account_id === rule.account_id && row.item_id === oldId);
    if (deliveryRule) s.deliverRules.push({ ...deliveryRule, id: s.deliverRules.reduce((max, row) => Math.max(max, row.id), 0) + 1, item_id: newId, created_at: Date.now() });
    for (const card of s.cards) if (card.account_id === rule.account_id && card.item_id === oldId && card.status === 'unused') card.item_id = newId;
    for (const row of s.rules) if (row.account_id === rule.account_id && row.exclude_items?.includes(oldId) && !row.exclude_items.includes(newId)) row.exclude_items.push(newId);
    const quick = s.quickProducts.find((row) => row.account_id === rule.account_id && row.item_id === oldId);
    if (quick && !s.quickProducts.some((row) => row.account_id === rule.account_id && row.item_id === newId)) s.quickProducts.push({ ...quick, item_id: newId });
    rule.item_id = newId; rule.enabled_at = Date.now(); rule.seen_on_sale = true; rule.sold_at = 0; rule.error = '';
    log.status = 'completed'; log.new_item_id = newId; log.updated_at = Date.now(); store.persist(); onUpdated(list());
  }
  async function tick() {
    if (running) return; running = true;
    try {
      for (const rule of state().relistRules.filter((row) => row.enabled)) {
        const account = store.getAccount(rule.account_id); if (!account || account.disabled) continue;
        if (drafts.list?.(rule.account_id).some((draft) => ['preparing', 'prepared', 'submitting'].includes(draft.status))) { rule.error = '店铺有正在处理的商品草稿，稍后再续售'; continue; }
        const blocked = state().relistLog.find((log) => log.rule_id === rule.id && log.item_id === rule.item_id && log.status !== 'cancelled');
        if (blocked) continue;
        try {
          const scan = await products.sync(rule.account_id, { background: true });
          if (!scan.ok || !scan.complete) { rule.error = '商品同步不完整，暂停本次续售'; continue; }
          const item = scan.products.find((row) => row.item_id === rule.item_id);
          if (!item || item.status !== 'sold') { if (item?.status === 'on_sale') rule.seen_on_sale = true; rule.sold_at = 0; continue; }
          if (!rule.seen_on_sale) continue;
          if (!rule.sold_at) { rule.sold_at = Date.now(); store.persist(); continue; }
          if (Date.now() - rule.sold_at < rule.delay_seconds * 1000) continue;
          const deliverRule = state().deliverRules.find((row) => row.account_id === rule.account_id && row.item_id === rule.item_id && row.enabled);
          const orders = store.listOrders(rule.account_id).filter((order) => order.item_id === rule.item_id && order.created_ts >= rule.enabled_at);
          if (rule.wait_delivery && !orders.some((order) => state().deliveries.some((entry) => entry.account_id === rule.account_id && entry.order_no === order.order_no && entry.status === 'sent'))) { rule.error = '等待新订单发货确认'; continue; }
          if (deliverRule && deliverRule.card_type !== 'api' && state().cards.filter((card) => card.account_id === rule.account_id && card.item_id === rule.item_id && card.status === 'unused' && (deliverRule.card_type === 'image' ? card.type === 'image' : card.type !== 'image')).length < rule.min_cards) { rule.error = '剩余可用卡密不足，暂停续售'; continue; }
          const active = () => rule.enabled && !!store.getAccount(rule.account_id) && !store.getAccount(rule.account_id).disabled;
          if (!active()) continue;
          const log = { id: crypto.randomUUID(), rule_id: rule.id, account_id: rule.account_id, item_id: rule.item_id, status: 'preparing', created_at: Date.now() };
          state().relistLog.push(log); store.persist();
          try {
            const draft = drafts.save({ ...rule.template, account_id: rule.account_id, source_item_id: '' }); log.draft_id = draft.id; store.persist();
            const ready = await products.prepare(draft.id, { background: true });
            if (!ready.ok || !active()) throw new Error(ready.error || '规则已停用');
            log.status = 'publishing'; store.persist();
            const result = await products.submit(draft.id, { guard: active });
            if (!result.ok) { log.status = result.uncertain ? 'uncertain' : 'failed'; log.error = result.error; rule.enabled = false; }
            else { log.status = 'published'; log.new_item_id = result.itemId; store.persist(); migrate(rule, log, result.itemId); }
          } catch (error) { if (log.status !== 'published') log.status = log.draft_id && ['uncertain', 'submitting'].includes(drafts.get(log.draft_id).status) ? 'uncertain' : 'failed'; log.error = error.message; rule.enabled = false; }
          store.persist(); onUpdated(list());
        } catch (error) { rule.error = error.message; }
      }
      store.persist();
    } finally { running = false; }
  }
  async function resolve(id, itemId) {
    const log = state().relistLog.find((row) => row.id === id), rule = log && state().relistRules.find((row) => row.id === log.rule_id);
    if (!rule || !['uncertain', 'published', 'failed'].includes(log.status)) throw new Error('该记录无需核对');
    if (!itemId) { if (log.status === 'published') throw new Error('平台已确认发布，请填写新商品ID完成迁移'); log.status = 'cancelled'; rule.enabled = false; store.persist(); return list(); }
    const scan = await products.sync(rule.account_id);
    if (!scan.ok || !scan.products.some((item) => item.item_id === String(itemId) && item.status === 'on_sale') || itemId === log.item_id) throw new Error('未在同一店铺找到新的在售商品');
    migrate(rule, log, String(itemId)); rule.enabled = false; store.persist(); return list();
  }
  return { list, save, toggle, resolve, tick, start() { timer ||= setInterval(() => tick().catch(console.error), 60000); }, stop() { clearInterval(timer); timer = null; } };
}
module.exports = { createAutoRelist };

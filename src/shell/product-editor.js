'use strict';

(() => {
  const api = window.api.products;
  const byId = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const stateNames = { draft: '草稿', preparing: '准备中', prepared: '待确认发布', submitting: '正在提交', uncertain: '结果待核对', published: '已发布' };
  let draft = null, shops = [], layer = null, dirty = false, processing = false, mode = 'products', message = '', goodsOptions = null;
  function unwrap(result) { if (!result?.ok) throw new Error(result?.error || '操作未完成，请重试'); return result; }
  function report(error) { message = error.message || String(error); if (layer) renderState(true); else window.toast(message, 5000); }
  const click = (element, fn) => { element.onclick = () => Promise.resolve().then(fn).catch(report); };
  async function chooseAccount() {
    const available = (await window.api.accounts.list()).filter((shop) => !shop.disabled);
    if (!available.length) throw new Error('请先添加并启用店铺');
    const selected = Number(byId('pf-account').value);
    if (selected && available.some((shop) => shop.id === selected)) return selected;
    if (available.length === 1) return available[0].id;
    const result = await window.dlg.form({ title: '选择操作店铺', body: '本次商品操作只针对所选店铺。', okText: '确定',
      fields: [{ key: 'accountId', label: '店铺', type: 'select', value: String(typeof currentAccountId !== 'undefined' && currentAccountId || available[0].id),
        options: available.map((shop) => ({ value: String(shop.id), label: shop.label })) }] });
    return result ? Number(result.accountId) : null;
  }
  function shopName(id) { return (shops.find((shop) => shop.id === Number(id)) || {}).label || '店铺已移除'; }
  function readInput() {
    return { ...draft, account_id: Number(byId('goods-account').value), title: byId('goods-title').value.trim(), description: byId('goods-description').value.trim(),
      price: byId('goods-price').value.trim(), original_price: byId('goods-original-price').value.trim(), stock: draft.stock ?? 1,
      ai_keyword: byId('goods-ai-keyword').value.trim(), ai_facts: byId('goods-ai-facts').value.trim(),
      shipping: byId('goods-shipping').value, shipping_fee: byId('goods-shipping-fee').value.trim(), images: draft.images, ...goodsOptions?.read(),
    };
  }
  function renderPreview() {
    if (!layer) return;
    const input = readInput(), image = input.images[0];
    byId('goods-preview-image').innerHTML = image?.preview ? `<img src="${escape(image.preview)}" referrerpolicy="no-referrer" alt="商品主图预览" />` : window.UI.icon('image');
    byId('goods-preview-title').textContent = input.title || '商品标题';
    byId('goods-preview-description').textContent = input.description || '写清楚商品特点、规格、成色和交付内容，让买家更容易了解。';
    byId('goods-preview-price').textContent = '¥ ' + (input.price || '0.00');
    byId('goods-preview-shop').textContent = shopName(input.account_id);
    const length = [input.title, input.description].filter(Boolean).join('\n\n').length;
    byId('goods-counter').textContent = length + ' / 1500 字';
    byId('goods-counter').classList.toggle('invalid', length > 1500);
    byId('goods-shipping-fee-field').style.display = input.shipping === 'fixed' ? '' : 'none';
  }
  function renderImages() {
    const container = byId('goods-images'); container.innerHTML = '';
    draft.images.forEach((image, index) => {
      const item = document.createElement('div'); item.className = 'goods-image' + (image.missing ? ' missing' : '');
      item.innerHTML = `<img src="${escape(image.preview || '')}" referrerpolicy="no-referrer" alt="第 ${index + 1} 张商品图片" />${index === 0 ? '<span class="goods-image-badge">主图</span>' : ''}
        <span class="goods-image-name">${escape(image.name || '商品图片')}</span><div class="goods-image-actions">
        <button type="button" data-image-action="first" ${index === 0 ? 'disabled' : ''}>设主图</button>
        <button type="button" data-image-action="left" title="前移一张" aria-label="前移一张" ${index === 0 ? 'disabled' : ''}>${window.UI.icon('chevron-left')}</button>
        <button type="button" data-image-action="right" title="后移一张" aria-label="后移一张" ${index === draft.images.length - 1 ? 'disabled' : ''}>${window.UI.icon('chevron-right')}</button>
        <button type="button" data-image-action="remove" class="danger" title="移除图片" aria-label="移除图片">${window.UI.icon('trash')}</button></div>`;
      item.querySelectorAll('[data-image-action]').forEach((button) => { button.dataset.boundary = String(button.disabled); click(button, () => {
        const action = button.dataset.imageAction;
        if (action === 'remove') draft.images.splice(index, 1);
        else { const target = action === 'first' ? 0 : action === 'left' ? index - 1 : index + 1; draft.images.splice(index, 1); draft.images.splice(target, 0, image); }
        changed(); renderImages();
      }); });
      container.appendChild(item);
    });
    if (draft.images.length < 9) {
      const add = document.createElement('button'); add.type = 'button'; add.className = 'goods-image-add';
      add.innerHTML = window.UI.icon('add') + `<span>添加图片</span><span class="muted">${draft.images.length} / 9 张</span>`;
      click(add, async () => {
        const selected = unwrap(await api.chooseImages());
        if (selected.canceled) return;
        if (selected.images.length + draft.images.length > 9) throw new Error('合计最多 9 张图片，请减少本次选择数量');
        draft.images.push(...selected.images); changed(); renderImages();
      }); container.appendChild(add);
    }
    renderState(); renderPreview();
  }
  function changed() {
    dirty = true; message = '';
    if (draft.status === 'prepared') draft.status = 'draft';
    renderState(); renderPreview();
  }
  function renderState(error = false) {
    if (!layer) return;
    const immutable = ['published', 'uncertain', 'submitting'].includes(draft.status);
    layer.querySelectorAll('input,select,textarea,#goods-images button').forEach((element) => { element.disabled = processing || immutable || element.dataset.boundary === 'true'; });
    byId('goods-account').disabled = processing || !!draft.id;
    byId('goods-save').disabled = processing || immutable;
    for (const id of ['goods-ai-generate', 'goods-ai-apply']) byId(id).disabled = processing || immutable;
    byId('goods-ai-settings').disabled = processing;
    byId('goods-prepare').disabled = processing || immutable;
    byId('goods-prepare').textContent = draft.status === 'prepared' ? '重新准备' : '准备发布';
    byId('goods-submit').style.display = draft.status === 'prepared' ? '' : 'none';
    byId('goods-submit').disabled = processing || dirty;
    byId('goods-verify').style.display = draft.status === 'prepared' ? '' : 'none';
    byId('goods-verify').disabled = processing;
    byId('goods-official').style.display = ['prepared', 'uncertain', 'published'].includes(draft.status) || draft.error ? '' : 'none';
    byId('goods-resolve').style.display = draft.status === 'uncertain' ? '' : 'none';
    byId('goods-close').disabled = processing;
    byId('goods-close').title = processing ? '当前操作完成后可关闭' : '保存草稿并关闭';
    const status = byId('goods-editor-status');
    status.textContent = message || draft.error || (draft.status === 'prepared' ? '图片和基本信息已填入闲鱼。可在官方窗口检查属性、规格和所在地，再返回此处确认发布。'
      : draft.status === 'published' ? `平台已确认商品 ID：${draft.published_item_id}`
        : draft.status === 'uncertain' ? '提交结果待核对，暂时停止重复发布。请在店铺主页确认后登记结果。'
          : '先保存本地草稿；点击「准备发布」后才会向该店铺上传图片，最后由你确认提交。');
    status.className = 'goods-editor-status' + (error || draft.error || draft.status === 'uncertain' ? ' error' : draft.status === 'prepared' || draft.status === 'published' ? ' ready' : '');
    byId('goods-save-state').textContent = processing ? '正在处理，请稍候…' : dirty ? '有未保存的修改 · 关闭时保存草稿' : draft.id ? '草稿已保存在本机' : '关闭时保存到本机';
  }
  async function save() {
    if (['uncertain', 'published'].includes(draft.status)) return draft;
    draft = unwrap(await api.drafts.save(readInput())).draft; dirty = false; renderState(); return draft;
  }
  async function close() {
    if (!layer) return true;
    if (processing) { window.toast('当前商品操作尚未完成，请稍候'); return false; }
    if (dirty || !draft.id) await save();
    layer.remove(); layer = null; draft = null; goodsOptions = null; await refreshDrafts(); return true;
  }
  async function operate(fn) {
    processing = true; message = ''; renderState();
    try { return await fn(); }
    finally { processing = false; renderState(); }
  }
  async function resolve(current) {
    const result = await window.dlg.form({ title: '核对商品提交结果', body: '先打开店铺主页确认是否已经发布，避免重复上架。', okText: '登记核对结果',
      fields: [{ key: 'outcome', label: '核对结果', type: 'select', value: 'published', options: [
        { value: 'published', label: '已发布，填写商品 ID' }, { value: 'not-published', label: '已确认没有发布成功，允许重新准备' },
      ] }, { key: 'itemId', label: '已发布商品 ID（未发布则留空）' }] });
    if (!result) return;
    const updated = unwrap(await api.drafts.resolve(current.id, { itemId: result.itemId.trim(), notPublished: result.outcome === 'not-published' }));
    if (layer && draft.id === current.id) { draft = updated.draft; message = ''; renderState(); }
    await refreshDrafts();
  }
  function aiOperate(fn) {
    return operate(async () => {
      try { return await fn(); }
      catch (error) { byId('goods-ai-feedback').textContent = error.message; throw error; }
    });
  }
  async function open(input) {
    if (layer && !(await close())) return;
    shops = (await window.api.accounts.list()).filter((shop) => !shop.disabled);
    if (!shops.length) throw new Error('请先添加并启用店铺');
    const aiConfig = unwrap(await api.ai.config()).config;
    draft = input || { account_id: Number(byId('pf-account').value) || (typeof currentAccountId !== 'undefined' && currentAccountId) || shops[0].id,
      title: '', description: '', price: '', original_price: '', shipping: 'free', shipping_fee: '', stock: 1, images: [], status: 'draft' };
    if (!shops.some((shop) => shop.id === draft.account_id)) throw new Error('该草稿所属店铺已停用，请先启用店铺');
    dirty = false; message = '';
    layer = document.createElement('section'); layer.className = 'goods-editor'; layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-label', '商品编辑器');
    layer.innerHTML = `<header class="goods-editor-header"><button id="goods-close" class="icon-button" title="保存并关闭" aria-label="保存并关闭">${window.UI.icon('chevron-left')}</button>
      <div><h2>${draft.source_item_id ? '编辑商品' : '发布商品'}</h2><p>${draft.source_item_id ? '闲鱼商品 ID：' + escape(draft.source_item_id) : '整理图片和文案，在电脑上完成商品发布'}</p></div><span class="spacer"></span><div class="goods-editor-owner"><label for="goods-account">操作店铺</label><select id="goods-account">${shops.map((shop) => `<option value="${shop.id}">${escape(shop.label)}</option>`).join('')}</select></div><span class="muted">${draft.id ? '已有草稿' : '新建草稿'}</span></header>
      <div class="goods-editor-content"><div id="goods-editor-status" class="goods-editor-status" role="status"></div>
      <div class="goods-editor-grid"><div class="goods-editor-form">
        <section class="goods-section"><div class="goods-section-title"><h3>商品图片<span class="goods-required">*</span></h3><span class="muted">第一张为主图</span></div><p class="goods-caption">最多 9 张，支持 JPG、PNG、WebP，每张不超过 5 MB。可调整顺序或更换主图。</p><div id="goods-images" class="goods-image-grid"></div></section>
        <section class="goods-section"><h3>商品文案</h3>
          <div class="goods-ai-composer"><div class="goods-ai-heading"><strong>AI 文案助手</strong><span class="muted">根据关键词生成闲鱼标题和详情</span></div>
            <div class="field"><label for="goods-ai-keyword">商品关键词</label><input id="goods-ai-keyword" maxlength="200" placeholder="例如：电竞队徽设计、俱乐部 logo 定制" /></div>
            <div class="field"><label for="goods-ai-facts">补充真实信息（选填）</label><textarea id="goods-ai-facts" rows="2" maxlength="4000" placeholder="填写实际规格、成色或服务内容；未提供的信息不会要求 AI 编造。"></textarea></div>
            <div class="row"><button id="goods-ai-generate" type="button" class="primary">生成标题和详情</button><span class="muted">生成后先预览，采用后仍可编辑</span></div>
            <div class="goods-ai-settings-bar"><span id="goods-ai-config-state" class="muted"></span><button id="goods-ai-settings" type="button">前往 AI 设置</button></div><p class="goods-caption">在「设置 → 商品文案 AI」配置一次，所有商品共用，无需逐件填写。</p><div id="goods-ai-feedback" class="goods-caption" role="status"></div>
            <div id="goods-ai-result" class="goods-ai-result" hidden><strong>生成结果 · 待采用</strong><label for="goods-ai-result-title">建议标题</label><input id="goods-ai-result-title" readonly /><label for="goods-ai-result-description">建议详情</label><textarea id="goods-ai-result-description" readonly rows="6"></textarea><div class="row"><button id="goods-ai-apply" type="button" class="primary">采用这版文案</button><button id="goods-ai-discard" type="button">放弃</button></div><p class="goods-caption">请核对事实后采用；关键词优化不保证排名或流量。</p></div>
          </div><div class="field"><label for="goods-title">商品标题<span class="goods-required">*</span></label><input id="goods-title" maxlength="60" placeholder="品牌、型号、成色或交付内容，最多 60 字" /></div>
          <div class="field"><label for="goods-description">详细描述</label><textarea id="goods-description" rows="9" placeholder="描述商品情况、规格和交付方式。标题会和描述一起提交到闲鱼。"></textarea><div id="goods-counter" class="goods-counter"></div></div></section>
        <section class="goods-section"><h3>价格与发货</h3><div class="goods-fields"><div class="field"><label for="goods-price">售价 / 元<span class="goods-required">*</span></label><input id="goods-price" inputmode="decimal" placeholder="0.00" /></div><div class="field"><label for="goods-original-price">原价 / 元（选填）</label><input id="goods-original-price" inputmode="decimal" placeholder="0.00" /></div>
        <div class="field"><label for="goods-shipping">发货方式</label><select id="goods-shipping"><option value="free">包邮</option><option value="fixed">固定邮费</option><option value="distance">按距离计费</option><option value="none">无需邮寄</option></select></div><div id="goods-shipping-fee-field" class="field"><label for="goods-shipping-fee">固定邮费 / 元</label><input id="goods-shipping-fee" inputmode="decimal" placeholder="0.00" /></div>
        </div><p class="goods-caption">确认发布成功后，商品会出现在所选闲鱼店铺；「保存草稿」只保存在本机。规格与闲鱼库存可在下方设置。</p></section>
      <section id="goods-options" class="goods-section"></section></div><aside class="goods-preview"><div class="goods-preview-caption"><span>内容预览</span><span>以闲鱼展示为准</span></div><div class="goods-preview-card"><div id="goods-preview-image" class="goods-preview-image"></div><div class="goods-preview-text"><div id="goods-preview-price" class="goods-preview-price"></div><div id="goods-preview-title" class="goods-preview-title"></div><div id="goods-preview-description" class="goods-preview-desc"></div><div id="goods-preview-shop" class="goods-preview-shop"></div></div></div></aside></div></div>
      <footer class="goods-editor-footer"><span id="goods-save-state" class="muted"></span><button id="goods-official">查看官方窗口</button><button id="goods-resolve">核对结果</button><button id="goods-save">保存草稿</button><button id="goods-verify">核验官方填写</button><button id="goods-prepare" class="primary">准备发布</button><button id="goods-submit" class="primary">${draft.source_item_id ? '确认修改到闲鱼' : '确认发布到闲鱼'}</button></footer>`;
    document.body.appendChild(layer);
    for (const [id, key] of [['goods-account', 'account_id'], ['goods-title', 'title'], ['goods-description', 'description'], ['goods-price', 'price'], ['goods-original-price', 'original_price'], ['goods-ai-keyword', 'ai_keyword'], ['goods-ai-facts', 'ai_facts'], ['goods-shipping', 'shipping'], ['goods-shipping-fee', 'shipping_fee']]) byId(id).value = draft[key] ?? '';
    byId('goods-ai-config-state').textContent = '全局模型：' + (aiConfig.model || '未设置');
    layer.querySelectorAll('input:not([readonly]),textarea:not([readonly]),select').forEach((element) => element.addEventListener('input', changed));
    click(byId('goods-ai-settings'), async () => {
      if (dirty || !draft.id) await save();
      window.ProductAISettings.setReturnDraft(draft.id);
      await switchView('settings'); switchSettingsTab('product-ai');
    });
    click(byId('goods-ai-generate'), () => aiOperate(async () => {
      const keyword = byId('goods-ai-keyword').value.trim();
      if (!keyword) { byId('goods-ai-keyword').focus(); throw new Error('请先输入商品关键词'); }
      byId('goods-ai-feedback').textContent = '正在生成标题和详情…'; byId('goods-ai-result').hidden = true;
      const result = unwrap(await api.ai.generate({ keyword, facts: [byId('goods-ai-facts').value.trim(), byId('goods-title').value.trim(), byId('goods-description').value.trim()].filter(Boolean).join('\n\n') }));
      byId('goods-ai-result-title').value = result.title; byId('goods-ai-result-description').value = result.description;
      byId('goods-ai-result').hidden = false; byId('goods-ai-feedback').textContent = '生成完成 · ' + result.model + '，请核对后采用。';
    }));
    click(byId('goods-ai-apply'), () => { byId('goods-title').value = byId('goods-ai-result-title').value; byId('goods-description').value = byId('goods-ai-result-description').value; byId('goods-ai-result').hidden = true; changed(); byId('goods-ai-feedback').textContent = '文案已采用，可继续编辑后保存或准备发布。'; });
    click(byId('goods-ai-discard'), () => { byId('goods-ai-result').hidden = true; byId('goods-ai-feedback').textContent = '已放弃生成结果，原文案保留。'; });
    click(byId('goods-close'), close);
    click(byId('goods-save'), async () => { await save(); window.toast('商品草稿已保存'); await refreshDrafts(); });
    click(byId('goods-official'), async () => unwrap(await api.showWindow(draft.account_id)));
    click(byId('goods-resolve'), () => resolve(draft));
    click(byId('goods-prepare'), async () => {
      await save();
      await operate(async () => { const result = unwrap(await api.drafts.prepare(draft.id)); draft = result.draft; message = result.errors?.length ? '请在官方窗口补全：' + result.errors.join('；') : ''; });
      await refreshDrafts();
    });
    click(byId('goods-verify'), () => operate(async () => { const result = unwrap(await api.drafts.verify(draft.id)); draft = result.draft; message = result.errors?.length ? '待补全：' + result.errors.join('；') : '基本信息核验通过，可确认提交。'; }));
    click(byId('goods-submit'), async () => {
      const confirmed = await window.dlg.confirm({ title: draft.source_item_id ? '确认修改商品' : '确认发布商品',
        body: `店铺：${shopName(draft.account_id)}\n商品：${draft.title}\n售价：¥ ${draft.price}\n\n确认后将提交到闲鱼。`, okText: draft.source_item_id ? '确认修改' : '确认发布' });
      if (!confirmed) return;
      await operate(async () => {
        const result = await api.drafts.submit(draft.id);
        if (result.draft) draft = result.draft;
        if (!result.ok) { message = result.error; return; }
        message = '闲鱼已确认商品 ID：' + result.itemId; window.toast('商品提交成功'); dirty = false;
      });
      await refreshDrafts(); await loadProducts();
    });
    goodsOptions = window.GoodsOptions.mount(layer, draft, changed, async () => { await save(); return unwrap(await api.drafts.options(draft.id)); });
    renderImages(); byId('goods-title').focus({ preventScroll: true }); layer.querySelector('.goods-editor-content').scrollTop = 0;
  }
  async function refreshDrafts() {
    shops = await window.api.accounts.list();
    const selected = Number(byId('pf-account').value) || null;
    const result = unwrap(await api.drafts.list(selected));
    byId('product-draft-count').textContent = result.drafts.length;
    const container = byId('product-draft-list'); container.innerHTML = '';
    const search = byId('pf-kw').value.trim().toLowerCase();
    const list = result.drafts.filter((row) => !search || (row.title + row.description).toLowerCase().includes(search));
    if (!list.length) { container.innerHTML = `<div class="empty-page"><div class="big">${window.UI.icon('edit')}</div><h3>还没有发布草稿</h3><p>点击「发布商品」，添加图片、填写文案后保存。</p></div>`; return; }
    const grid = document.createElement('div'); grid.className = 'goods-drafts';
    for (const row of list) {
      const card = document.createElement('article'); card.className = 'goods-draft';
      const preview = row.images[0]?.preview;
      card.innerHTML = `<div class="goods-draft-main">${preview ? `<img class="goods-draft-image" src="${escape(preview)}" alt="草稿主图" />` : `<div class="goods-draft-image">${window.UI.icon('image')}</div>`}<div style="min-width:0;flex:1"><span class="st ${row.status === 'published' ? 'on' : row.status === 'uncertain' ? 'err' : 'info'}">${stateNames[row.status] || '草稿'}</span><div class="goods-draft-title">${escape(row.title || '未填写标题')}</div><div class="muted">${escape(shopName(row.account_id))} · ¥ ${escape(row.price || '未定价')} · ${row.images.length} 张图片</div></div></div>
        ${row.error ? `<div class="goods-draft-error">${escape(row.error)}</div>` : ''}<div class="row"><span class="muted" style="flex:1">${new Date(row.updated_at).toLocaleString('zh-CN')}</span><button data-draft-open>${row.status === 'published' ? '查看记录' : '继续编辑'}</button>${row.status === 'uncertain' ? '<button data-draft-resolve>核对结果</button>' : ''}<button data-draft-remove class="danger">删除</button></div>`;
      click(card.querySelector('[data-draft-open]'), () => open(row));
      if (row.status === 'uncertain') click(card.querySelector('[data-draft-resolve]'), () => resolve(row));
      click(card.querySelector('[data-draft-remove]'), async () => {
        if (!(await window.dlg.confirm({ title: '删除本地草稿', body: '只删除本地草稿，不会下架闲鱼商品。', danger: true, okText: '删除草稿' }))) return;
        unwrap(await api.drafts.remove(row.id)); await refreshDrafts();
      }); grid.appendChild(card);
    }
    container.appendChild(grid);
  }
  async function refresh() {
    shops = await window.api.accounts.list();
    const select = byId('pf-account'), value = select.value;
    select.innerHTML = '<option value="">全部店铺</option>' + shops.map((shop) => `<option value="${shop.id}">${escape(shop.label)}</option>`).join('');
    if (shops.some((shop) => String(shop.id) === value)) select.value = value;
    await refreshDrafts();
  }
  window.ProductEditor = {
    open, chooseAccount, refresh, close, beforeLeave: close,
    async editItem(row) { const result = unwrap(await api.drafts.editItem(row.account_id, row.item_id)); await open(result.draft); },
    copy(row) { return open({ sku: row.sku, platform_attributes: row.platform_attributes, platform_address: row.platform_address, account_id: row.account_id, title: row.title || '', description: row.description || '', price: row.price || '',
      original_price: '', shipping: 'free', shipping_fee: '', stock: row.stock || 1, images: (row.images?.length ? row.images : [row.image]).filter(Boolean).map((url) => ({ url, preview: url, name: '原商品图片' })), status: 'draft' }); },
  };
  click(byId('btn-create-product'), () => open());
  click(byId('btn-open-product-page'), async () => { const accountId = await chooseAccount(); if (accountId) unwrap(await api.openPage(accountId)); });
  document.querySelectorAll('[data-product-mode]').forEach((button) => click(button, async () => {
    mode = button.dataset.productMode;
    document.querySelectorAll('[data-product-mode]').forEach((item) => { item.classList.toggle('on', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    byId('product-list').style.display = mode === 'products' ? '' : 'none'; byId('product-draft-list').style.display = mode === 'drafts' ? '' : 'none';
    await refreshDrafts();
  }));
  byId('pf-account').addEventListener('change', async () => { await loadProducts(); });
  byId('pf-search').addEventListener('click', () => refreshDrafts().catch(report));
  api.onUpdated((payload) => {
    if (payload.draftId && draft?.id === payload.draftId) { message = payload.progress; renderState(); }
    if (!payload.draftId && typeof currentView !== 'undefined' && currentView === 'products') loadProducts().catch(report);
  });
})();

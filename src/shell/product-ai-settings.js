'use strict';

(() => {
  const api = window.api.products.ai;
  let returnDraftId = null;
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function unwrap(result) { if (!result?.ok) throw new Error(result?.error || '操作未完成，请重试'); return result; }
  async function render(container) {
    const panel = document.createElement('section'); panel.className = 'product-ai-settings';
    panel.innerHTML = '<div class="muted">正在读取全局 AI 配置…</div>'; container.replaceChildren(panel);
    try {
      const config = unwrap(await api.config()).config;
      if (!panel.isConnected) return;
      panel.innerHTML = `<div class="card"><h3>商品文案 AI</h3><p class="goods-caption">全局配置，保存一次后所有商品共用。仅用于手动生成商品标题和详情，与客服自动回复独立。</p><span id="product-ai-config-state" class="muted"></span></div>
        <div class="goods-fields"><div class="field"><label for="product-ai-base">接口地址（OpenAI 兼容）</label><input id="product-ai-base" placeholder="https://api.deepseek.com/v1" /></div><div class="field"><label for="product-ai-model">模型名称</label><input id="product-ai-model" placeholder="deepseek-chat / 你的模型名称" /></div></div>
        <div class="field"><label for="product-ai-key">API Key</label><input id="product-ai-key" type="password" autocomplete="off" /><label class="product-ai-clear"><input id="product-ai-clear-key" type="checkbox" />清除已保存的 Key（用于切换免 Key 服务）</label><p class="goods-caption">支持自定义接口。本地免 Key 服务可留空；已有 Key 留空则保留。</p></div>
        <div class="field"><label for="product-ai-prompt">自定义写作要求（选填）</label><textarea id="product-ai-prompt" rows="4" maxlength="4000" placeholder="例如：语气自然，侧重使用场景，避免夸张宣传。"></textarea></div>
        <div class="row"><button id="product-ai-save" class="primary">保存配置</button><button id="product-ai-test">保存并测试连接</button>${returnDraftId ? '<button id="product-ai-back">返回商品草稿</button>' : ''}</div><p id="product-ai-feedback" class="goods-caption" role="status"></p>`;
      const byId = (id) => panel.querySelector('#' + id);
      function show(value) {
        byId('product-ai-base').value = value.baseURL || ''; byId('product-ai-model').value = value.model || '';
        byId('product-ai-prompt').value = value.systemPrompt || ''; byId('product-ai-key').value = '';
        byId('product-ai-key').placeholder = value.apiKeySet ? '已加密保存，留空保留原 Key' : 'API Key（本地免 Key 服务可留空）';
        byId('product-ai-clear-key').checked = false;
        byId('product-ai-config-state').textContent = '当前模型：' + (value.model || '未设置') + (value.apiKeySet ? ' · 已保存 Key' : ' · Key 为空');
      }
      async function save() {
        const result = unwrap(await api.saveConfig({ baseURL: byId('product-ai-base').value.trim(), model: byId('product-ai-model').value.trim(), apiKey: byId('product-ai-key').value.trim(),
          clearKey: byId('product-ai-clear-key').checked, systemPrompt: byId('product-ai-prompt').value.trim() }));
        show(result.config); byId('product-ai-feedback').textContent = '配置已保存，所有商品共用，无需逐件填写。';
      }
      let busy = false;
      const action = (id, callback) => { byId(id).onclick = async () => {
        if (busy) return; busy = true;
        panel.querySelectorAll('input,textarea,button').forEach((element) => { element.disabled = true; });
        try { await callback(); }
        catch (error) { byId('product-ai-feedback').textContent = error.message; window.toast(error.message, 5000); }
        finally { busy = false; panel.querySelectorAll('input,textarea,button').forEach((element) => { element.disabled = false; }); }
      }; };
      show(config);
      action('product-ai-save', save);
      action('product-ai-test', async () => { await save(); byId('product-ai-feedback').textContent = '正在测试连接…'; const result = unwrap(await api.test()); byId('product-ai-feedback').textContent = '连接成功 · ' + result.model; });
      if (returnDraftId) action('product-ai-back', async () => {
        const id = returnDraftId, rows = unwrap(await window.api.products.drafts.list()).drafts;
        const row = rows.find((draft) => draft.id === id); if (!row) throw new Error('原商品草稿已被移除，请从商品管理重新打开');
        await switchView('products'); await window.ProductEditor.open(row); returnDraftId = null;
      });
    } catch (error) { panel.innerHTML = `<div class="goods-caption">${escape(error.message)}</div>`; }
  }
  window.ProductAISettings = { render, setReturnDraft(id) { returnDraftId = id; } };
})();

'use strict';

/**
 * 统一定制对话框
 *
 * 替代 Electron 里丑陋的原生 prompt/confirm/alert。
 * 全部返回 Promise，可以在 async 流程里直接 await。
 *
 *   const name = await dlg.prompt({ title: '账号名称', value: '店铺1' });
 *   if (await dlg.confirm({ title: '确认删除？', danger: true })) { ... }
 *   await dlg.alert({ title: '提示', body: '导入完成' });
 *
 * 特点：
 *   - 多字段表单（一次收集多个值，避免连续弹 4 次 prompt）
 *   - 支持 textarea（粘贴卡密）
 *   - 黄色系主题，与主界面一致
 *   - ESC 取消、Enter 确认、点遮罩取消
 */

(function () {
  const HOST_ID = 'xy-dialog-host';

  function host() {
    let h = document.getElementById(HOST_ID);
    if (!h) {
      h = document.createElement('div');
      h.id = HOST_ID;
      h.className = 'xydlg-host';
      document.body.appendChild(h);
    }
    return h;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * 内部通用实现
   * @param {object} opt
   * @param {string} opt.title
   * @param {string} [opt.body]      纯文本说明
   * @param {Array}  [opt.fields]    字段定义 [{ key, label, type, value, placeholder, rows, options, hint }]
   * @param {string} [opt.okText]
   * @param {string} [opt.cancelText]
   * @param {boolean}[opt.danger]
   * @param {boolean}[opt.onlyOk]    只有确认按钮（alert 用）
   * @returns {Promise<object|null>} 字段值对象，或 null（取消）
   */
  function open(opt) {
    return new Promise((resolve) => {
      const fields = opt.fields || [];
      const h = host();

      const fieldHtml = fields.map((f, i) => {
        const id = `xydlg-f-${i}`;
        const common = `id="${id}" class="xydlg-input" placeholder="${esc(f.placeholder || '')}"`;
        let input;
        if (f.type === 'textarea') {
          input = `<textarea ${common} rows="${f.rows || 4}">${esc(f.value || '')}</textarea>`;
        } else if (f.type === 'select') {
          const opts = (f.options || []).map((o) =>
            `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`,
          ).join('');
          input = `<select ${common}>${opts}</select>`;
        } else if (f.type === 'number') {
          input = `<input ${common} type="number" value="${esc(f.value == null ? '' : f.value)}" />`;
        } else if (f.type === 'checklist') {
          const quick = (f.quick || []).map((q) =>
            `<button type="button" class="xydlg-quick" data-quick="${i}:${esc(q.select)}">${esc(q.label)}</button>`).join('');
          const rows = (f.options || []).map((o) => `<label class="checklist-item">
            <input type="checkbox" data-check="${id}" value="${esc(o.value)}" ${o.checked ? 'checked' : ''} />
            <span class="checklist-main">
              <span class="checklist-title">${esc(o.label)}</span>
              ${o.meta ? `<span class="checklist-meta">${esc(o.meta)}</span>` : ''}
            </span>
            ${o.badge ? `<span class="st ${esc(o.badgeKind || '')}">${esc(o.badge)}</span>` : ''}
          </label>`).join('');
          input = `<div class="checklist" data-checklist="${i}">
            ${quick ? `<div class="checklist-head">${quick}<span class="checklist-count"></span></div>` : ''}
            ${rows || '<div class="checklist-meta" style="padding:12px 10px">没有可选项</div>'}
          </div>`;
        } else if (f.type === 'checkbox') {
          input = `<label class="xydlg-check"><input id="${id}" type="checkbox" ${f.value ? 'checked' : ''} /> ${esc(f.checkLabel || '')}</label>`;
        } else {
          input = `<input ${common} type="text" value="${esc(f.value == null ? '' : f.value)}" />`;
        }
        return `<div class="xydlg-field">
          ${f.label ? `<label for="${id}">${esc(f.label)}</label>` : ''}
          ${input}
          ${f.hint ? `<div class="xydlg-hint">${esc(f.hint)}</div>` : ''}
        </div>`;
      }).join('');

      const mask = document.createElement('div');
      mask.className = 'xydlg-mask';
      mask.innerHTML = `
        <div class="xydlg-box ${opt.danger ? 'danger' : ''}" role="dialog">
          <div class="xydlg-head">
            <span class="xydlg-title">${esc(opt.title || '')}</span>
          </div>
          <div class="xydlg-body">
            ${opt.body ? `<div class="xydlg-text">${esc(opt.body).replace(/\n/g, '<br>')}</div>` : ''}
            ${fieldHtml}
          </div>
          <div class="xydlg-foot">
            ${opt.onlyOk ? '' : `<button class="xydlg-btn" data-act="cancel">${esc(opt.cancelText || '取消')}</button>`}
            <button class="xydlg-btn primary ${opt.danger ? 'danger' : ''}" data-act="ok">${esc(opt.okText || '确定')}</button>
          </div>
        </div>
      `;
      h.appendChild(mask);

      // 焦点到第一个输入
      const firstInput = mask.querySelector('.xydlg-input');
      setTimeout(() => { try { firstInput && firstInput.focus(); if (firstInput && firstInput.select) firstInput.select(); } catch (_) {} }, 30);

      // checklist 快捷勾选与已选计数
      fields.forEach((f, i) => {
        if (f.type !== 'checklist') return;
        const boxes = () => [...mask.querySelectorAll(`[data-check="xydlg-f-${i}"]`)];
        const count = mask.querySelector(`[data-checklist="${i}"] .checklist-count`);
        const refresh = () => {
          if (count) count.textContent = `已选 ${boxes().filter((el) => el.checked).length} / ${boxes().length}`;
          const fieldEl = mask.querySelector(`[data-field="${i}"]`), errEl = mask.querySelector(`[data-err="${i}"]`);
          if (fieldEl) fieldEl.classList.remove('invalid');
          if (errEl) errEl.classList.remove('show');
        };
        mask.querySelectorAll(`[data-checklist="${i}"] .xydlg-quick`).forEach((btn) => {
          btn.onclick = () => {
            const select = btn.dataset.quick.split(':')[1];
            boxes().forEach((el) => {
              if (select === 'all') el.checked = true;
              else if (select === 'none') el.checked = false;
              else el.checked = (f.options || []).some((o) => String(o.value) === el.value && o.group === select);
            });
            refresh();
          };
        });
        boxes().forEach((el) => el.addEventListener('change', refresh));
        refresh();
      });

      function collect() {
        const out = {};
        fields.forEach((f, i) => {
          if (f.type === 'checklist') {
            out[f.key] = [...mask.querySelectorAll(`[data-check="xydlg-f-${i}"]:checked`)].map((row) => row.value);
            return;
          }
          const el = mask.querySelector(`#xydlg-f-${i}`);
          if (!el) return;
          if (f.type === 'checkbox') out[f.key] = el.checked;
          else if (f.type === 'number') out[f.key] = el.value === '' ? null : Number(el.value);
          else out[f.key] = el.value;
        });
        return out;
      }

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        mask.classList.add('closing');
        // 立刻从可交互层移除，避免挡住后续点击；120ms 后再删 DOM
        mask.style.pointerEvents = 'none';
        setTimeout(() => { try { mask.remove(); } catch (_) {} }, 120);
        resolve(result);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
        // Ctrl+Enter 或 plain Enter（非 textarea）确认
        if (e.key === 'Enter') {
          const tag = (e.target && e.target.tagName) || '';
          if (tag !== 'TEXTAREA' || e.ctrlKey || e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            close(collect());
          }
        }
      }
      document.addEventListener('keydown', onKey, true);

      mask.querySelector('[data-act=ok]').onclick = () => close(collect());
      const cancelBtn = mask.querySelector('[data-act=cancel]');
      if (cancelBtn) cancelBtn.onclick = () => close(null);
      mask.onclick = (e) => { if (e.target === mask) close(null); };
    });
  }

  /* ------------------------- 对外 API ------------------------- */

  /**
   * 优先使用系统级对话框窗口（不会被 BrowserView 遮挡）
   * 不可用时回退到 HTML 内联弹窗
   */
  async function openSystem(opt) {
    if (!window.api || !window.api.dlg || !window.api.dlg.open) return undefined;
    try {
      return await window.api.dlg.open(opt);
    } catch (e) {
      console.warn('[dlg] 系统对话框失败，回退内联', e);
      return undefined;
    }
  }

  /** 单输入框 */
  async function prompt({ title, body, value = '', placeholder = '', okText = '确定', cancelText = '取消', multiline = false, rows = 4, number = false }) {
    const opt = {
      title, body, okText, cancelText,
      fields: [{
        key: 'value',
        type: multiline ? 'textarea' : (number ? 'number' : 'text'),
        value, placeholder, rows,
      }],
    };
    // 先试系统窗口
    const sys = await openSystem(opt);
    if (sys !== undefined) return sys ? sys.value : null;
    // 回退
    const r = await open(opt);
    return r ? r.value : null;
  }

  /** 确认框 */
  async function confirm({ title, body, okText = '确定', cancelText = '取消', danger = false }) {
    const opt = { title, body, okText, cancelText, danger };
    const sys = await openSystem(opt);
    if (sys !== undefined) return sys !== null;
    const r = await open(opt);
    return r !== null;
  }

  /** 提示框 */
  async function alert({ title = '提示', body, okText = '知道了' }) {
    const opt = { title, body, okText, onlyOk: true };
    const sys = await openSystem(opt);
    if (sys !== undefined) return undefined;
    await open(opt);
    return undefined;
  }

  /** 多字段表单 */
  async function form({ title, body, fields, okText = '保存', cancelText = '取消', danger = false }) {
    const opt = { title, body, fields, okText, cancelText, danger };
    const sys = await openSystem(opt);
    if (sys !== undefined) return sys;   // 必填校验在系统窗口里做了

    const r = await open(opt);
    if (!r) return null;
    for (const f of fields) {
      if (f.required && (r[f.key] === '' || r[f.key] === null || r[f.key] === undefined || (Array.isArray(r[f.key]) && !r[f.key].length))) {
        alert({ title: '请填写必填项', body: f.label || f.key });
        return null;
      }
    }
    return r;
  }

  window.dlg = { open, prompt, confirm, alert, form };
})();

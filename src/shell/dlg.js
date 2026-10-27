'use strict';

/**
 * 独立对话框窗口的渲染逻辑
 * 与主界面的 dialog.js 保持相同的 API 语义（fields 定义一致）
 */

let cfg = { fields: [] };

window.dlgApi.onInit((c) => {
  cfg = c || { fields: [] };

  // 主题跟随主窗口
  try {
    const theme = localStorage.getItem('xy-theme') || 'blue';
    document.body.className = 'theme-' + theme;
    document.body.classList.add('dialog-page');
    document.body.setAttribute('theme-mode', theme === 'dark' ? 'dark' : 'light');
  } catch (_) { /* ignore */ }

  document.getElementById('title').textContent = c.title || '';

  const desc = document.getElementById('desc');
  if (c.body) {
    desc.textContent = c.body;
  } else {
    desc.style.display = 'none';
  }

  // 渲染字段
  const box = document.getElementById('fields');
  box.innerHTML = (c.fields || []).map((f, i) => {
    const id = 'f' + i;
    const common = `id="${id}" data-idx="${i}" placeholder="${esc(f.placeholder || '')}"`;
    let input;

    if (f.type === 'textarea') {
      input = `<textarea ${common} rows="${f.rows || 5}">${esc(f.value || '')}</textarea>`;
    } else if (f.type === 'select') {
      const opts = (f.options || []).map((o) =>
        `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`,
      ).join('');
      input = `<select ${common}>${opts}</select>`;
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
      input = `<label class="check"><input id="${id}" data-idx="${i}" type="checkbox" ${f.value ? 'checked' : ''} /> ${esc(f.checkLabel || '')}</label>`;
    } else if (f.type === 'number') {
      input = `<input ${common} type="number" value="${esc(f.value == null ? '' : f.value)}" />`;
    } else {
      input = `<input ${common} type="text" value="${esc(f.value == null ? '' : f.value)}" />`;
    }

    return `<div class="field" data-field="${i}">
      ${f.label ? `<label for="${id}">${esc(f.label)}${f.required ? ' <span style="color:#dc2626">*</span>' : ''}</label>` : ''}
      ${input}
      ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}
      <div class="err" data-err="${i}"></div>
    </div>`;
  }).join('');

  // checklist 快捷勾选与已选计数
  (c.fields || []).forEach((f, i) => {
    if (f.type !== 'checklist') return;
    const boxes = () => [...box.querySelectorAll(`[data-check="f${i}"]`)];
    const count = box.querySelector(`[data-checklist="${i}"] .checklist-count`);
    const refresh = () => {
      if (count) count.textContent = `已选 ${boxes().filter((el) => el.checked).length} / ${boxes().length}`;
      const fieldEl = box.querySelector(`[data-field="${i}"]`), errEl = box.querySelector(`[data-err="${i}"]`);
      if (fieldEl) fieldEl.classList.remove('invalid');
      if (errEl) errEl.classList.remove('show');
    };
    box.querySelectorAll(`[data-checklist="${i}"] .xydlg-quick`).forEach((btn) => {
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

  // 按钮文案
  const okBtn = document.getElementById('btn-ok');
  okBtn.textContent = c.okText || '确定';
  if (c.danger) okBtn.classList.add('danger');

  const cancelBtn = document.getElementById('btn-cancel');
  if (c.onlyOk) cancelBtn.style.display = 'none';
  else cancelBtn.textContent = c.cancelText || '取消';

  // 焦点
  setTimeout(() => {
    const first = box.querySelector('input:not([type=checkbox]), textarea, select');
    if (first) {
      first.focus();
      if (first.select) first.select();
    } else {
      okBtn.focus();
    }
  }, 60);
});

/* ---------------- 收集与校验 ---------------- */

function collect() {
  const values = {};
  let valid = true;

  (cfg.fields || []).forEach((f, i) => {
    const fieldEl = document.querySelector(`[data-field="${i}"]`);
    const errEl = document.querySelector(`[data-err="${i}"]`);
    const invalid = (message) => {
      valid = false;
      if (fieldEl) fieldEl.classList.add('invalid');
      if (errEl) { errEl.textContent = message; errEl.classList.add('show'); }
    };

    if (f.type === 'checklist') {
      const checked = [...document.querySelectorAll(`[data-check="f${i}"]:checked`)].map((row) => row.value);
      values[f.key] = checked;
      if (f.required && !checked.length) invalid('请至少勾选一项');
      return;
    }

    const el = document.querySelector(`[data-idx="${i}"]`);
    if (!el) return;

    let v;
    if (f.type === 'checkbox') v = el.checked;
    else if (f.type === 'number') v = el.value === '' ? null : Number(el.value);
    else v = el.value;

    values[f.key] = v;

    // 必填校验
    if (f.required) {
      const empty = v === '' || v === null || v === undefined;
      if (empty) invalid('此项为必填');
      else {
        if (fieldEl) fieldEl.classList.remove('invalid');
        if (errEl) errEl.classList.remove('show');
      }
    }
  });

  return { valid, values };
}

function submit() {
  const { valid, values } = collect();
  if (!valid) {
    const first = document.querySelector('.field.invalid input, .field.invalid textarea, .field.invalid select');
    if (first) first.focus();
    return;
  }
  window.dlgApi.result(true, values);
}

/* ---------------- 事件 ---------------- */

document.getElementById('btn-ok').onclick = submit;
document.getElementById('btn-cancel').onclick = () => window.dlgApi.result(false, null);
document.getElementById('close').onclick = () => window.dlgApi.result(false, null);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.dlgApi.result(false, null);
  }
  // Ctrl+Enter 或 Enter（非 textarea）提交
  if (e.key === 'Enter') {
    const tag = (e.target && e.target.tagName) || '';
    if (tag !== 'TEXTAREA' || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      submit();
    }
  }
});

// 输入时清除错误态
document.addEventListener('input', (e) => {
  const field = e.target.closest('.field');
  if (field) {
    field.classList.remove('invalid');
    const err = field.querySelector('.err');
    if (err) err.classList.remove('show');
  }
});

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

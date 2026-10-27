'use strict';

(() => {
  const names = new Set(['chat', 'shop', 'product', 'order', 'customer', 'task', 'chart', 'settings',
    'search', 'add', 'refresh', 'columns', 'more', 'chevron-down', 'chevron-left', 'chevron-right',
    'arrow-right', 'close', 'check', 'warning', 'info', 'moon', 'sun', 'help', 'link', 'download',
    'upload', 'key', 'shield', 'bell', 'copy', 'edit', 'trash', 'image', 'send', 'user', 'coin', 'timer', 'folder', 'palette']);
  const viewNames = { chat: '客服工作台', shops: '店铺管理', products: '商品管理', orders: '订单管理',
    customers: '客户管理', tasks: '自动任务', stats: '数据概览', settings: '系统设置' };
  function icon(name) {
    if (!names.has(name)) name = 'info';
    return `<span class="ui-icon icon-${name}" aria-hidden="true"></span>`;
  }

  const legacyIcons = { '🏪': 'shop', '📦': 'product', '📋': 'order', '👥': 'customer', '💬': 'chat',
    '⚡': 'task', '📊': 'chart', '⚙️': 'settings', '⚙': 'settings', '⟳': 'refresh', '📭': 'folder',
    '✅': 'check', '⏳': 'timer', '💰': 'coin', '🔑': 'key', '＋': 'add', '📥': 'download', '📤': 'upload', '👤': 'user' };
  function decorateControls() {
    for (const element of document.querySelectorAll('button, .empty-page .big, .stat-ico, .cell-thumb')) {
      if (element.querySelector('.ui-icon')) continue;
      const text = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (!text) continue;
      const value = text.textContent.trimStart();
      const match = Object.keys(legacyIcons).find((prefix) => value.startsWith(prefix));
      if (!match) continue;
      const span = document.createElement('span');
      span.className = 'ui-icon icon-' + legacyIcons[match];
      span.setAttribute('aria-hidden', 'true');
      text.textContent = value.slice(match.length).trimStart();
      element.insertBefore(span, text);
      if (!element.textContent.trim() && element.title) element.setAttribute('aria-label', element.title);
    }
  }

  function setWorkspace({ accounts = [], statuses = {}, accountId, view = 'chat' }) {
    document.body.dataset.view = view;
    document.getElementById('current-view-name').textContent = viewNames[view] || '工作台';
    const online = accounts.filter((account) => !account.disabled && statuses[account.id] && statuses[account.id].loggedIn).length;
    document.getElementById('shop-count').textContent = accounts.length ? `· ${accounts.length}` : '';
    document.getElementById('workspace-summary').textContent = accounts.length
      ? `${accounts.length} 家店铺 · ${online} 家在线` : '尚未添加店铺';
    const current = accounts.find((account) => account.id === accountId);
    const label = document.getElementById('active-shop-label');
    label.textContent = current ? current.label : '尚未选择店铺';
    label.title = current ? current.label : '';
    const counts = { all: accounts.length, online,
      disabled: accounts.filter((account) => account.disabled).length };
    counts.offline = counts.all - counts.online - counts.disabled;
    for (const element of document.querySelectorAll('[data-shop-count]')) {
      element.textContent = counts[element.dataset.shopCount];
    }
    const welcomeTitle = document.querySelector('.welcome h2');
    welcomeTitle.textContent = accounts.length ? '选择一家店铺，开始接待' : '添加店铺，开始接待买家';
    document.getElementById('btn-first-shop').innerHTML = icon('add') + (accounts.length ? '添加店铺' : '添加第一家店铺');
  }

  function syncStatusTabs() {
    for (const [kind, filter] of [['shop', 'sf-status'], ['order', 'of-status']]) {
      const value = document.getElementById(filter).value;
      for (const button of document.querySelectorAll(`[data-${kind}-status]`)) {
        const active = button.getAttribute(`data-${kind}-status`) === value;
        button.classList.toggle('on', active);
        button.setAttribute('aria-pressed', String(active));
      }
    }
  }

  let closeMenu = null;
  function menu(anchor, items) {
    if (closeMenu) closeMenu();
    const popup = document.createElement('div');
    popup.className = 'action-menu';
    popup.setAttribute('role', 'menu');
    popup.setAttribute('aria-label', '更多操作');
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      if (item.danger) button.classList.add('danger');
      button.innerHTML = icon(item.icon || 'arrow-right');
      button.append(document.createTextNode(item.label));
      button.onclick = () => { closeMenu(); Promise.resolve(item.action()).catch((error) => window.toast(error.message || '操作失败')); };
      popup.appendChild(button);
    }
    document.body.appendChild(popup);
    anchor.setAttribute('aria-expanded', 'true');
    const rect = anchor.getBoundingClientRect();
    popup.style.left = Math.max(8, Math.min(window.innerWidth - popup.offsetWidth - 8, rect.right - popup.offsetWidth)) + 'px';
    popup.style.top = (rect.bottom + popup.offsetHeight + 6 < window.innerHeight
      ? rect.bottom + 6 : Math.max(8, rect.top - popup.offsetHeight - 6)) + 'px';
    const outside = (event) => { if (!popup.contains(event.target) && !anchor.contains(event.target)) closeMenu(); };
    const keyboard = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); anchor.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(popup.querySelectorAll('button'));
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
      }
    };
    closeMenu = () => {
      popup.remove(); anchor.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keyboard);
      closeMenu = null;
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard);
    popup.querySelector('button').focus();
  }

  window.UI = { icon, setWorkspace, syncStatusTabs, menu, closeMenu: () => closeMenu && closeMenu() };
  document.addEventListener('DOMContentLoaded', () => {
    decorateControls();
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; decorateControls(); });
    }).observe(document.body, { childList: true, subtree: true });
  });
})();

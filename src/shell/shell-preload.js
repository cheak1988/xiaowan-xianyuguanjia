'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  /** 用系统浏览器打开白名单内的说明页面 */
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  /** 通知主进程「设置面板」开合，用于重排 BrowserView 区域 */
  setPanelOpen: (open) => ipcRenderer.invoke('ui:set-panel-open', open),

  /** 切换一级视图时，控制官方页面是否挂载 */
  setChatView: (isChat) => ipcRenderer.invoke('ui:set-chat-view', isChat),

  /** 同步 Windows 原生标题栏按钮的主题 */
  setTheme: (theme) => ipcRenderer.invoke('ui:set-theme', theme),

  /** 打开系统级对话框（不被 BrowserView 遮挡） */
  dlg: {
    open: (opt) => ipcRenderer.invoke('dlg:open', opt),
  },

  /** 主进程提示「空间太窄」，渲染层应自动收起面板 */
  onSpaceTight: (cb) => ipcRenderer.on('ui:space-tight', (_e, p) => cb(p)),
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: (label) => ipcRenderer.invoke('accounts:add', { label }),
    update: (id, patch) => ipcRenderer.invoke('accounts:update', { id, patch }),
    activate: (id) => ipcRenderer.invoke('accounts:activate', id),
    remove: (id) => ipcRenderer.invoke('accounts:remove', id),
    onSync: (cb) => ipcRenderer.on('accounts:sync', (_e, list) => cb(list)),
    onStatus: (cb) => ipcRenderer.on('accounts:status', (_e, s) => cb(s)),
  },
  messages: {
    list: (accountId, sessionId, limit) =>
      ipcRenderer.invoke('messages:list', { accountId, sessionId, limit }),
    onMessage: (cb) => ipcRenderer.on('ui:message', (_e, p) => cb(p)),
    onDecision: (cb) => ipcRenderer.on('ui:reply-decision', (_e, p) => cb(p)),
    onSendResult: (cb) => ipcRenderer.on('ui:send-result', (_e, p) => cb(p)),
  },
  rules: {
    list: (accountId) => ipcRenderer.invoke('rules:list', accountId),
    save: (rule) => ipcRenderer.invoke('rules:save', rule),
    remove: (id) => ipcRenderer.invoke('rules:remove', id),
    exportCsv: (accountId) => ipcRenderer.invoke('rules:export', accountId),
    importCsv: (accountId) => ipcRenderer.invoke('rules:import', accountId),
  },
  reminder: {
    pending: () => ipcRenderer.invoke('reminder:pending'),
    scan: () => ipcRenderer.invoke('reminder:scan'),
    onAlert: (cb) => ipcRenderer.on('ui:timeout-alert', (_e, p) => cb(p)),
    onFocusSession: (cb) => ipcRenderer.on('ui:focus-session', (_e, p) => cb(p)),
  },
  actions: {
    sendProduct: (accountId, payload) =>
      ipcRenderer.invoke('action:send-product', { accountId, ...payload }),
    setBlocked: (accountId, payload) =>
      ipcRenderer.invoke('action:set-blocked', { accountId, ...payload }),
    diagnose: (accountId) => ipcRenderer.invoke('action:diagnose', accountId),
    onResult: (cb) => ipcRenderer.on('ui:action-result', (_e, p) => cb(p)),
  },
  products: {
    /** 商品库（多店铺商品管理） */
    list: (args) => ipcRenderer.invoke('products:list', args),
    remove: (accountId, itemId) => ipcRenderer.invoke('products:remove', { accountId, itemId }),
    importCsv: (accountId, text) => ipcRenderer.invoke('products:import', { accountId, text }),
    sync: (accountId) => ipcRenderer.invoke('products:sync', accountId),
    /** 先扫描出商品清单供勾选，不写入本地；确认后用 syncImport 只导入勾选的商品 */
    scanPreview: (accountId) => ipcRenderer.invoke('products:scan-preview', accountId),
    syncImport: (accountId, scanId, itemIds) => ipcRenderer.invoke('products:sync-import', { accountId, scanId, itemIds }),
    publish: (accountId, items) => ipcRenderer.invoke('products:publish', { accountId, items }),
    openPage: (accountId) => ipcRenderer.invoke('products:open-page', accountId),
    onUpdated: (cb) => ipcRenderer.on('ui:products-updated', (_e, p) => cb(p)),
    chooseImages: () => ipcRenderer.invoke('products:choose-images'),
    ai: {
      config: () => ipcRenderer.invoke('products:ai-config'),
      saveConfig: (input) => ipcRenderer.invoke('products:ai-save-config', input),
      generate: (input) => ipcRenderer.invoke('products:ai-generate', input),
      test: () => ipcRenderer.invoke('products:ai-test'),
    },
    showWindow: (accountId) => ipcRenderer.invoke('products:show-window', accountId),
    drafts: {
      list: (accountId) => ipcRenderer.invoke('products:drafts-list', accountId),
      save: (input) => ipcRenderer.invoke('products:draft-save', input),
      remove: (id) => ipcRenderer.invoke('products:draft-remove', id),
      editItem: (accountId, itemId) => ipcRenderer.invoke('products:draft-edit-item', { accountId, itemId }),
      prepare: (id) => ipcRenderer.invoke('products:draft-prepare', id),
      verify: (id) => ipcRenderer.invoke('products:draft-verify', id),
      options: (id) => ipcRenderer.invoke('products:draft-options', id),
      submit: (id) => ipcRenderer.invoke('products:draft-submit', id),
      resolve: (id, result) => ipcRenderer.invoke('products:draft-resolve', { id, ...result }),
    },

    // 常用商品（快捷发送）走独立 IPC，和商品库分开
    quick: {
      list: (accountId) => ipcRenderer.invoke('quick-products:list', accountId),
      save: (product) => ipcRenderer.invoke('quick-products:save', product),
      remove: (accountId, itemId) => ipcRenderer.invoke('quick-products:remove', { accountId, itemId }),
    },
    save: (product) => ipcRenderer.invoke('products:save', product),
    remove: (accountId, itemId) => ipcRenderer.invoke('products:remove', { accountId, itemId }),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
  },
  remote: {
    status: () => ipcRenderer.invoke('remote:status'), configure: (input) => ipcRenderer.invoke('remote:configure', input),
    saveUser: (input) => ipcRenderer.invoke('remote:save-user', input), removeUser: (id) => ipcRenderer.invoke('remote:remove-user', id),
  },
  relist: {
    list: () => ipcRenderer.invoke('relist:list'), save: (input) => ipcRenderer.invoke('relist:save', input),
    toggle: (id, enabled) => ipcRenderer.invoke('relist:toggle', { id, enabled }), resolve: (id, itemId) => ipcRenderer.invoke('relist:resolve', { id, itemId }),
  },
  ai: {
    setKey: (key) => ipcRenderer.invoke('ai:set-key', key),
    test: (config) => ipcRenderer.invoke('ai:test', config),
    log: (accountId, limit) => ipcRenderer.invoke('ai:log', { accountId, limit }),
  },
  delivery: {
    openOrderPage: (accountId) => ipcRenderer.invoke('delivery:open-order-page', accountId),
    rules: (accountId) => ipcRenderer.invoke('delivery:rules', accountId),
    saveRule: (rule) => ipcRenderer.invoke('delivery:save-rule', rule),
    removeRule: (id) => ipcRenderer.invoke('delivery:remove-rule', id),
    cards: (accountId, itemId) => ipcRenderer.invoke('delivery:cards', { accountId, itemId }),
    cardStats: (accountId) => ipcRenderer.invoke('delivery:card-stats', { accountId }),
    importCards: (accountId, itemId, text) =>
      ipcRenderer.invoke('delivery:import-cards', { accountId, itemId, text }),
    importImageCards: (accountId, itemId) => ipcRenderer.invoke('delivery:import-image-cards', { accountId, itemId }),
    clearCards: (accountId, itemId) => ipcRenderer.invoke('delivery:clear-cards', { accountId, itemId }),
    log: (accountId, limit) => ipcRenderer.invoke('delivery:log', { accountId, limit }),
    preview: (accountId, itemId) => ipcRenderer.invoke('delivery:preview', { accountId, itemId }),
    onResult: (cb) => ipcRenderer.on('ui:delivery-result', (_e, p) => cb(p)),
  },
  shopGroups: {
    list: () => ipcRenderer.invoke('shopgroups:list'),
    save: (g) => ipcRenderer.invoke('shopgroups:save', g),
    remove: (id) => ipcRenderer.invoke('shopgroups:remove', id),
  },
  customers: {
    list: (args) => ipcRenderer.invoke('customers:list', args),
    update: (id, patch) => ipcRenderer.invoke('customers:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('customers:remove', id),
    tags: (accountId) => ipcRenderer.invoke('customers:tags', accountId),
    upsertFromSession: (accountId, session) =>
      ipcRenderer.invoke('customers:upsert-session', { accountId, session }),
  },
  quickReplies: {
    list: (accountId) => ipcRenderer.invoke('quickreplies:list', accountId),
    save: (r) => ipcRenderer.invoke('quickreplies:save', r),
    remove: (id) => ipcRenderer.invoke('quickreplies:remove', id),
  },
  orders: {
    list: (accountId) => ipcRenderer.invoke('orders:list', accountId),
    operate: (accountId, orderNo, action, payload) =>
      ipcRenderer.invoke('order:operate', { accountId, orderNo, action, payload }),
  },
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    riskNotice: (taskId) => ipcRenderer.invoke('tasks:risk-notice', taskId),
    setEnabled: (taskId, enabled, acceptRisk) =>
      ipcRenderer.invoke('tasks:set-enabled', { taskId, enabled, acceptRisk }),
    runNow: (taskId, accountId) => ipcRenderer.invoke('tasks:run-now', { taskId, accountId }),
    log: (limit) => ipcRenderer.invoke('tasks:log', limit),
    tokenStatus: () => ipcRenderer.invoke('tasks:token-status'),
  },
  notify: {
    channels: () => ipcRenderer.invoke('notify:channels'),
    test: (channel, config) => ipcRenderer.invoke('notify:test', { channel, config }),
    testAll: () => ipcRenderer.invoke('notify:send-test'),
    log: (limit) => ipcRenderer.invoke('notify:log', limit),
  },
  stats: {
    get: (accountId) => ipcRenderer.invoke('stats:get', accountId),
  },
  staff: {
    list: () => ipcRenderer.invoke('staff:list'),
    add: (name) => ipcRenderer.invoke('staff:add', { name }),
    update: (id, patch) => ipcRenderer.invoke('staff:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('staff:remove', id),
    current: () => ipcRenderer.invoke('staff:current'),
    setCurrent: (id) => ipcRenderer.invoke('staff:set-current', id),
    onSync: (cb) => ipcRenderer.on('staff:sync', (_e, p) => cb(p)),
  },
  sessions: {
    list: (accountId) => ipcRenderer.invoke('sessions:list', accountId),
    assign: (accountId, sessionId, assigneeId) =>
      ipcRenderer.invoke('sessions:assign', { accountId, sessionId, assigneeId }),
    onUpdated: (cb) => ipcRenderer.on('sessions:updated', (_e, p) => cb(p)),
  },
});

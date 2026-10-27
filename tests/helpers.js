'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { EventEmitter } = require('events');
const root = path.join(__dirname, '..');

function fixture(t, imports = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-regression-'));
  const cache = new Map();
  const timers = new Set();
  function load(relative) {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const localRequire = (name) => {
      if (Object.hasOwn(imports, name)) return imports[name];
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.js'));
      return require(name);
    };
    const context = { console, process, Buffer, URL, __dirname: path.dirname(file),
      setTimeout(fn, milliseconds) { const timer = setTimeout(fn, milliseconds); timers.add(timer); return timer; },
      clearTimeout, setInterval(fn, milliseconds) { const timer = setInterval(fn, milliseconds); timers.add(timer); return timer; },
      clearInterval };
    const code = fs.readFileSync(file, 'utf8') + (relative.endsWith('src/main/index.js')
      ? '\nif (typeof require("electron").capture === "function") require("electron").capture({ createWindow, sendToSession, ensureOrderView, ensureProductView });' : '');
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, context, { filename: file })(localRequire, module, module.exports);
    return module.exports;
  }
  const store = load('src/main/store.js');
  store.init(directory);
  t.after(() => {
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    const relative = path.relative(os.tmpdir(), directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('拒绝清理临时目录以外的路径');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, load, store };
}

function fakeElectron() {
  const handles = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, handler) => handles.set(name, handler);
  const views = [];
  const windows = [];
  let nextId = 0;
  class Contents extends EventEmitter {
    constructor() {
      super(); this.id = ++nextId; this.mainFrame = {}; this.sent = []; this.destroyed = false;
      this.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        cookies: { get: async () => this.cookieJar || [] },
        clearStorageData: async () => { this.storageCleared = true; },
        clearCache: async () => { this.cacheCleared = true; } };
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    send(channel, payload) { this.sent.push({ channel, payload }); }
    destroy() { this.destroyed = true; }
    executeJavaScript() { return Promise.resolve(false); }
    isLoading() { return false; }
  }
  class View { constructor(options) { this.options = options; this.webContents = new Contents(); views.push(this); } setBounds() {} }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); windows.push(this); }
    loadFile() {} show() {} focus() {} hide() {} addBrowserView() {} removeBrowserView() {}
    getContentSize() { return [1500, 900]; } isDestroyed() { return false; }
  }
  const electron = { ipcMain, BrowserView: View, BrowserWindow: Window,
    app: { setName() {}, isPackaged: true, requestSingleInstanceLock: () => false, quit() {} },
    shell: { openExternal: async () => {} }, capture(api) { electron.api = api; },
    session: { fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {} }) } };
  return { electron, handles, views, windows, ipcMain };
}

module.exports = { fixture, fakeElectron, root };

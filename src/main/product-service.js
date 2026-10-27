'use strict';

const { app, BrowserWindow, BrowserView, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { secureRemoteView } = require('./remote-security');
const { remoteImage, MAX_IMAGE_BYTES } = require('./product-drafts');
const { normalizeOptions, optionsMatch } = require('./product-options');
const ORIGIN = 'https://www.goofish.com';
const WRITE_API = /\/h5\/mtop\.idle\.pc\.idleitem\.(publish|edit)\//i;
function isWriteRequest(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'goofish.com' || url.hostname.endsWith('.goofish.com')) && WRITE_API.test(url.pathname); }
  catch (_) { return false; }
}

function parsePlatformResponse(body) {
  let value = String(body).trim();
  if (!value.startsWith('{')) value = value.replace(/^[\w.$]+\s*\(/, '').replace(/\)\s*;?$/, '');
  const result = JSON.parse(value);
  const ret = Array.isArray(result.ret) ? result.ret.map(String) : [];
  const itemId = String(result.data?.itemId || '');
  if (ret.some((entry) => /^SUCCESS(?:::|$)/.test(entry)) && /^\d{6,24}$/.test(itemId)) return { ok: true, itemId };
  if (ret.some((entry) => /^FAIL_/.test(entry))) return { ok: false, uncertain: false, error: ret.join('；').slice(0, 700) };
  return { ok: false, uncertain: true, error: '平台未返回可确认的商品 ID，请先核对发布结果' };
}

function downloadImage(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (!remoteImage(url) || redirects > 3) { reject(new Error('商品图片地址无效')); return; }
    const imageUrl = new URL(url);
    if (imageUrl.hostname.endsWith('.alicdn.com')) {
      // 官方个人主页和编辑页使用的 450/170 像素预览后缀；上传时取原文件。
      imageUrl.pathname = imageUrl.pathname.replace(/_(?:170|450)x10000\.(?:jpe?g|png)(?:_\.webp)?$/i, '');
    }
    url = imageUrl.href;
    const request = https.get(url, { timeout: 20000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        downloadImage(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error('原商品图片下载失败，请重新选择图片')); return; }
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > MAX_IMAGE_BYTES) request.destroy(new Error('原商品图片超过 5 MB，请选择较小的图片')); else chunks.push(chunk); });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('图片下载超时'))); request.on('error', reject);
  });
}

function createProductService({ store, views, parent, onUpdated, scanTtlMs = 15 * 60000 }) {
  const windows = new Map(), requests = new Map(), busy = new Set(), network = new Map(), pageVersions = new WeakMap();
  const pendingScans = new Map();
  let drafts;
  function account(id) { const row = store.getAccount(Number(id)); if (!row || row.disabled) throw new Error('店铺不存在或已停用'); return row; }
  function purgeScans() { for (const [key, entry] of pendingScans) if (Date.now() - entry.at > scanTtlMs) pendingScans.delete(key); }
  function ensureView(id) {
    id = Number(id); account(id);
    if (views.has(id) && !views.get(id).webContents.isDestroyed?.()) return views.get(id);
    const view = new BrowserView({ webPreferences: {
      partition: `persist:xy-${id}`, preload: path.join(__dirname, '..', 'inject', 'product-bundle.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false,
    } });
    secureRemoteView(view, shell); views.set(id, view);
    const page = { version: 0 }; pageVersions.set(view.webContents, page);
    view.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) page.version++;
    });
    view.webContents.on('did-finish-load', () => {
      for (const [key, pending] of requests) {
        if (pending.contents !== view.webContents || pending.pageVersion === page.version) continue;
        if (['scan', 'read-form'].includes(pending.action) && pending.retries < 2) {
          pending.retries++; pending.pageVersion = page.version;
          view.webContents.send('product:command', { requestId: key, action: pending.action, payload: pending.payload });
        } else {
          clearTimeout(pending.timer); requests.delete(key);
          pending.resolve({ ok: false, uncertain: pending.action === 'submit', error: '闲鱼页面重新加载，请重新准备；已提交的操作需要先核对结果' });
        }
      }
    });
    view.webContents.on('destroyed', () => {
      for (const [key, pending] of requests) if (pending.contents === view.webContents) {
        clearTimeout(pending.timer); requests.delete(key); pending.resolve({ ok: false, error: '商品页面已关闭', uncertain: pending.action === 'submit' });
      }
      const pending = network.get(view.webContents.id)?.pending;
      if (pending) pending.finish({ ok: false, uncertain: true, error: '提交过程中页面关闭，请核对结果' });
    });
    return view;
  }
  function showWindow(id, hidden = false) {
    const view = ensureView(id); let win = windows.get(Number(id));
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({ width: 1250, height: 900, minWidth: 1000, minHeight: 700, show: false,
        title: account(id).label + ' · 闲鱼商品工作台', icon: path.join(__dirname, '..', 'shell', 'icon.png'),
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      win.addBrowserView(view);
      const layout = () => { if (!win.isDestroyed()) { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); } };
      win.on('resize', layout); layout();
      win.on('close', (event) => { if (!app.isQuitting && !parent()?.isDestroyed()) { event.preventDefault(); win.hide(); } });
      windows.set(Number(id), win);
    }
    if (!hidden) { win.show(); win.focus(); } return win;
  }
  async function identity(id) {
    const view = ensureView(id);
    const cookies = await view.webContents.session.cookies.get({ url: ORIGIN });
    const ids = [...new Set(cookies.filter((cookie) => cookie.name === 'unb' && /^\d{4,24}$/.test(cookie.value)).map((cookie) => cookie.value))];
    if (ids.length !== 1) throw new Error('未识别到该店铺的登录身份，请打开店铺主页扫码登录后重试');
    return ids[0];
  }
  async function navigate(id, url) {
    const view = ensureView(id); let timer;
    showWindow(id, true);
    try {
      await Promise.race([view.webContents.loadURL(url), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('闲鱼页面加载超时，请检查网络')), 25000); })]);
    } finally { clearTimeout(timer); }
    account(id); return view;
  }
  function request(id, action, payload = {}, milliseconds = 30000, guard = () => true) {
    const view = ensureView(id), requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { requests.delete(requestId); resolve({ ok: false, error: '官方页面操作超时，请打开商品窗口检查', uncertain: action === 'submit' }); }, milliseconds);
      requests.set(requestId, { contents: view.webContents, accountId: Number(id), action, payload, guard, retries: 0,
        pageVersion: pageVersions.get(view.webContents).version, timer, resolve });
      try { view.webContents.send('product:command', { requestId, action, payload }); }
      catch (error) { clearTimeout(timer); requests.delete(requestId); resolve({ ok: false, error: error.message }); }
    });
  }
  ipcMain.handle('product:can-submit', (event, requestId) => {
    const pending = requests.get(requestId);
    return !!pending && pending.action === 'submit' && pending.contents === event.sender
      && (!event.senderFrame || event.senderFrame === event.sender.mainFrame)
      && !!store.getAccount(pending.accountId) && !store.getAccount(pending.accountId).disabled && pending.guard();
  });
  ipcMain.on('product:response', (event, result) => {
    const pending = result && requests.get(result.requestId);
    if (!pending || pending.contents !== event.sender || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) return;
    clearTimeout(pending.timer); requests.delete(result.requestId);
    const owner = store.getAccount(pending.accountId);
    pending.resolve(owner && !owner.disabled ? result : { ok: false, error: '店铺已停用或删除' });
  });
  async function locked(id, operation) {
    id = Number(id);
    if (busy.has(id)) return { ok: false, code: 'BUSY', error: '该店铺正在处理商品，请等待当前操作完成' };
    busy.add(id);
    try { account(id); return await operation(); }
    catch (error) { return { ok: false, error: error.message }; }
    finally { busy.delete(id); }
  }
  async function scan(id, { background = false, preview = false } = {}) {
    const uid = await identity(id);
    await navigate(id, `${ORIGIN}/personal?userId=${encodeURIComponent(uid)}`);
    const result = await request(id, 'scan', { userId: uid }, 75000);
    if (!result.ok) { if (!background) showWindow(id); return result; }
    if (uid !== await identity(id)) throw new Error('同步期间登录账号发生变化，未保存结果');
    if (!Array.isArray(result.products) || result.products.length > 5000 || result.products.some((item) =>
      !/^\d{6,24}$/.test(String(item.item_id)) || !item.title || !['on_sale', 'sold'].includes(item.status)
      || !/^\d+(\.\d{1,2})?$/.test(String(item.price)))) throw new Error('商品数据无法校验，未改动已有商品');
    if (!result.products.length && result.complete !== true) throw new Error('商品列表未完成读取，未改动已有商品；请检查店铺登录或网络后重试');
    const products = result.products.map((item) => ({ ...item, item_id: String(item.item_id), image: remoteImage(item.image) }));
    if (preview) {
      purgeScans();
      const existing = new Set(store.listProducts(id).map((row) => row.item_id));
      const scanId = crypto.randomUUID();
      pendingScans.set(scanId, { accountId: Number(id), uid, products, complete: !!result.complete, scope: result.scope || '', at: Date.now() });
      while (pendingScans.size > 20) {
        const oldest = [...pendingScans.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        pendingScans.delete(oldest[0]);
      }
      return { ok: true, preview: true, scanId, count: products.length, complete: result.complete, scope: result.scope,
        products: products.map((item) => ({ ...item, exists: existing.has(item.item_id) })) };
    }
    for (const item of products) store.upsertProduct(id, item);
    store.updateAccount(id, { seller_uid: uid }); store.persist();
    onUpdated?.({ accountId: Number(id), count: products.length });
    return { ok: true, count: products.length, complete: result.complete, scope: result.scope, products };
  }
  async function importSelected(id, scanId, itemIds) {
    return locked(id, async () => {
      const entry = pendingScans.get(String(scanId));
      if (!entry || entry.accountId !== Number(id)) throw new Error('同步预览不存在或已失效，请重新同步');
      if (Date.now() - entry.at > scanTtlMs) { pendingScans.delete(String(scanId)); throw new Error('同步预览已过期，请重新同步后再勾选导入'); }
      const wanted = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(String))];
      if (!wanted.length) throw new Error('请先勾选要导入的商品');
      const known = new Map(entry.products.map((item) => [item.item_id, item]));
      if (wanted.some((itemId) => !known.has(itemId))) throw new Error('勾选的商品不在本次同步结果中，请重新同步');
      const existing = new Set(store.listProducts(id).map((row) => row.item_id));
      const selected = entry.products.filter((item) => wanted.includes(item.item_id));
      for (const item of selected) store.upsertProduct(id, item);
      store.updateAccount(id, { seller_uid: entry.uid }); store.persist();
      onUpdated?.({ accountId: Number(id), count: selected.length });
      return { ok: true, count: selected.length,
        added: selected.filter((item) => !existing.has(item.item_id)).length,
        updated: selected.filter((item) => existing.has(item.item_id)).length,
        complete: entry.complete, scope: entry.scope };
    });
  }
  function watchNetwork(id) {
    const contents = ensureView(id).webContents;
    if (network.has(contents.id)) return network.get(contents.id);
    if (contents.debugger.isAttached()) throw new Error('请关闭该商品窗口的开发者工具后重试图片上传');
    contents.debugger.attach('1.3');
    const state = { pending: null }; network.set(contents.id, state);
    contents.debugger.on('message', async (_event, method, params) => {
      const pending = state.pending; if (!pending) return;
      if (method === 'Network.requestWillBeSent' && isWriteRequest(params.request.url)) {
        pending.ids.add(params.requestId); pending.writeSeen = true;
      }
      if (method === 'Network.loadingFinished' && pending.ids.has(params.requestId)) {
        try {
          const response = await contents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
          const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
          const result = parsePlatformResponse(body);
          if (result.ok && pending.sourceItemId && result.itemId !== pending.sourceItemId) pending.finish({ ok: false, uncertain: true, error: '平台返回的商品与正在编辑的商品不一致，请核对' });
          else pending.finish(result);
        } catch (_) { pending.finish({ ok: false, uncertain: true, error: '平台响应无法核验，请先检查商品是否已发布' }); }
      }
      if (method === 'Network.loadingFailed' && pending.ids.has(params.requestId)) pending.finish({ ok: false, uncertain: true, error: '提交连接中断，发布结果待核对' });
    });
    contents.debugger.on('detach', () => {
      if (state.pending) state.pending.finish({ ok: false, uncertain: true, error: '提交结果监听中断，请核对商品' });
      network.delete(contents.id);
    });
    state.ready = contents.debugger.sendCommand('Network.enable');
    return state;
  }
  const contentOf = (row) => [row.title, row.description].filter(Boolean).join('\n\n');
  const payloadOf = (row) => ({ source_item_id: row.source_item_id, content: contentOf(row), price: row.price,
    original_price: row.original_price, shipping: row.shipping, shipping_fee: row.shipping_fee, ...normalizeOptions(row) });
  async function verify(id, preparing = false) {
    const row = drafts.get(id), uid = await identity(row.account_id), view = ensureView(row.account_id);
    const previous = row.preparation;
    if (!(preparing && row.status === 'preparing') && (row.status !== 'prepared' || !previous
        || previous.webContentsId !== view.webContents.id || previous.uid !== uid || previous.fingerprint !== drafts.fingerprint(row))) {
      throw new Error('当前草稿尚未准备，或提交结果待核对，不能直接重新核验');
    }
    const url = new URL(view.webContents.getURL());
    if (url.origin !== ORIGIN || url.pathname !== '/publish' || (url.searchParams.get('itemId') || '') !== row.source_item_id) throw new Error('官方商品页面已改变，请重新准备');
    const current = await request(row.account_id, 'read-form');
    if (!current.ok || current.loggedOut || current.description.replace(/\s+/g, ' ').trim() !== contentOf(row).replace(/\s+/g, ' ').trim()
        || Number(current.price) !== Number(row.price) || Number(current.original_price) !== Number(row.original_price)
        || current.imageCount !== row.images.length || current.images.length !== row.images.length
        || (!preparing && current.images.some((image, index) => image !== previous.images[index]))
        || current.shipping !== row.shipping || !optionsMatch(row, current) || (row.shipping === 'fixed' && Number(current.shipping_fee) !== Number(row.shipping_fee))) {
      throw new Error('官方页面的文字、售价、图片或发货方式尚未匹配草稿，请重新准备或查看官方窗口');
    }
    const result = drafts.patch(id, { status: 'prepared', error: '', preparation: {
      uid, webContentsId: view.webContents.id, fingerprint: drafts.fingerprint(row), images: current.images, options: JSON.stringify(Object.fromEntries(['sku_supported', 'sku', 'platform_attributes', 'platform_address', 'platform_quantity', 'attribute_options'].filter((key) => current[key] !== undefined).map((key) => [key, current[key]]))), created_at: Date.now(),
    } });
    return { ok: true, draft: result, errors: current.errors };
  }
  async function prepare(id, { background = false } = {}) {
    const original = drafts.get(id);
    return locked(original.account_id, async () => {
      if (['submitting', 'uncertain', 'published'].includes(original.status)) throw new Error('请先核对发布结果，不可重复提交');
      const row = JSON.parse(JSON.stringify(drafts.validate(original)));
      drafts.patch(id, { status: 'preparing', preparation: null, error: '' });
      try {
        const uid = await identity(row.account_id);
        if (row.source_item_id) {
          const owned = await scan(row.account_id);
          if (!owned.ok || !owned.products.some((item) => item.item_id === row.source_item_id)) throw new Error('未能从该店铺主页确认目标商品的归属，已停止编辑');
        }
        const url = `${ORIGIN}/publish` + (row.source_item_id ? '?scene=pcMainPublish&itemId=' + row.source_item_id : '');
        const view = await navigate(row.account_id, url); if (!background) showWindow(row.account_id);
        const state = watchNetwork(row.account_id); await state.ready;
        const filled = await request(row.account_id, 'fill', payloadOf(row));
        if (!filled.ok) throw new Error(filled.error || '官方表单尚未就绪，请查看官方窗口');
        const keepImages = !!row.source_item_id && filled.imageCount === row.images.length
          && filled.images.length === row.images.length
          && row.images.every((image, index) => image.url && image.url === filled.images[index]);
        if (!keepImages) {
          const cleared = await request(row.account_id, 'clear-images');
          if (!cleared.ok) throw new Error(cleared.error || '无法重置商品图片');
        }
        for (let index = 0; !keepImages && index < row.images.length; index++) {
          account(row.account_id);
          if (uid !== await identity(row.account_id)) throw new Error('上传期间登录账号发生变化，已停止');
          let image = row.images[index];
          if (!image.assetId) {
            const temporary = path.join(os.tmpdir(), 'xianyu-product-image-' + crypto.randomUUID());
            try {
              fs.writeFileSync(temporary, await downloadImage(image.url), { flag: 'wx' });
              image = drafts.importFiles([temporary])[0];
            } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
          }
          const { root } = await view.webContents.debugger.sendCommand('DOM.getDocument');
          const { nodeId } = await view.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'form input[type=file]' });
          if (!nodeId) throw new Error('官方页面没有图片上传入口');
          await view.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [drafts.asset(image.assetId).file] });
          const uploaded = await request(row.account_id, 'wait-image', { count: index + 1 });
          if (!uploaded.ok) throw new Error(uploaded.error || '图片上传未完成');
          onUpdated?.({ accountId: row.account_id, draftId: id, progress: `正在上传图片 ${index + 1}/${row.images.length}` });
        }
        const options = await request(row.account_id, 'apply-options', normalizeOptions(row));
        if (!options.ok) throw new Error(options.error || '官方属性、规格或库存未能匹配草稿');
        if (drafts.fingerprint(drafts.get(id)) !== drafts.fingerprint(row)) throw new Error('准备期间草稿已修改，请重新准备');
        return await verify(id, true);
      } catch (error) { drafts.patch(id, { status: 'draft', preparation: null, error: error.message }); throw error; }
    });
  }
  async function submit(id, { guard = () => true } = {}) {
    const row = drafts.get(id);
    return locked(row.account_id, async () => {
      drafts.validate(row);
      if (!guard()) throw new Error('当前操作的授权已失效');
      const preparation = row.preparation, view = ensureView(row.account_id);
      if (row.status !== 'prepared' || !preparation || preparation.webContentsId !== view.webContents.id
          || Date.now() - preparation.created_at > 30 * 60 * 1000 || preparation.fingerprint !== drafts.fingerprint(row)
          || preparation.uid !== await identity(row.account_id)) throw new Error('草稿、登录状态或预览已变化，请重新准备');
      const state = watchNetwork(row.account_id); await state.ready;
      drafts.patch(id, { status: 'submitting', error: '' });
      let timer, validationTimer;
      const outcome = new Promise((resolve) => {
        const pending = { ids: new Set(), writeSeen: false, sourceItemId: row.source_item_id,
          finish(result) { if (state.pending !== pending) return; clearTimeout(timer); clearTimeout(validationTimer); state.pending = null; resolve(result); } };
        state.pending = pending;
        timer = setTimeout(() => pending.finish({ ok: false, uncertain: true, error: '未收到平台确认，请核对后再操作，避免重复发布' }), 35000);
        validationTimer = setTimeout(async () => {
          if (state.pending !== pending || pending.writeSeen) return;
          const current = await request(row.account_id, 'read-form', {}, 5000);
          if (state.pending === pending && !pending.writeSeen && current.errors?.length) pending.finish({ ok: false, uncertain: false, error: current.errors.join('；') });
        }, 5000);
      });
      const checked = await request(row.account_id, 'read-form');
      if (!checked.ok || !optionsMatch(row, checked) || !guard()) { state.pending?.finish({ ok: false, uncertain: false, error: '授权、属性、规格或库存已改变，请重新准备' }); }
      const clicked = state.pending ? request(row.account_id, 'submit', { ...payloadOf(row), expectedOptions: preparation.options, imageCount: row.images.length, images: preparation.images }, 10000, guard) : Promise.resolve({ clicked: false });
      const first = await Promise.race([clicked.then((value) => ({ command: value })), outcome.then((value) => ({ outcome: value }))]);
      let result;
      if (first.outcome) result = first.outcome;
      else if (!first.command.clicked && !first.command.uncertain && !state.pending?.writeSeen) {
        state.pending?.finish({ ok: false, uncertain: false, error: first.command.error || '尚未提交' }); result = await outcome;
      } else result = await outcome;
      if (result.ok) {
        if (!store.getAccount(row.account_id)) return { ...result, accountRemoved: true };
        store.upsertProduct(row.account_id, { item_id: result.itemId, title: row.title, description: row.description, price: row.price, stock: row.stock,
          image: preparation.images[0], images: preparation.images, ...normalizeOptions(row), status: 'on_sale', source_url: `${ORIGIN}/item?id=${result.itemId}` });
        const draft = drafts.patch(id, { status: 'published', published_item_id: result.itemId, preparation: null, error: '' });
        onUpdated?.({ accountId: row.account_id, count: 1 }); return { ...result, draft };
      }
      return { ...result, draft: drafts.patch(id, { status: result.uncertain ? 'uncertain' : 'draft', preparation: null, error: result.error }) };
    }).then((result) => {
      if (!result.ok && row.status === 'submitting' && store.getAccount(row.account_id)) {
        return { ...result, uncertain: true, draft: drafts.patch(id, { status: 'uncertain', preparation: null, error: result.error || '提交中断，请先核对平台结果' }) };
      }
      return result;
    });
  }
  return { ensureView, request, identity, navigate, watchNetwork,
    setDraftManager(value) { drafts = value; },
    sync(id, options) { return locked(id, () => scan(id, options)); },
    scanPreview(id) { return locked(id, () => scan(id, { preview: true })); },
    importSelected,
    async open(id) {
      try { const uid = await identity(id); await navigate(id, `${ORIGIN}/personal?userId=${uid}`); }
      catch (_) { await navigate(id, `${ORIGIN}/personal`); }
      showWindow(id); return { ok: true };
    },
    show(id) {
      if (!/^https:/.test(ensureView(id).webContents.getURL())) return this.open(id);
      showWindow(id); return { ok: true };
    }, prepare, submit,
    options(id) { return locked(drafts.get(id).account_id, async () => {
      const row = drafts.get(id), view = ensureView(row.account_id);
      const current = new URL(view.webContents.getURL() || 'about:blank');
      if (current.origin !== ORIGIN || current.pathname !== '/publish' || (current.searchParams.get('itemId') || '') !== row.source_item_id) await navigate(row.account_id, ORIGIN + '/publish' + (row.source_item_id ? '?itemId=' + row.source_item_id : ''));
      return request(row.account_id, 'read-form');
    }); },
    verify(id) { return locked(drafts.get(id).account_id, () => verify(id)); },
    readItem(accountId, itemId) { return locked(accountId, async () => {
      if (!/^\d{6,24}$/.test(String(itemId))) throw new Error('商品 ID 无效');
      const owned = await scan(accountId);
      const product = owned.products?.find((item) => item.item_id === String(itemId));
      if (!owned.ok || !product) throw new Error('未能在该店铺主页确认商品归属，请先同步');
      await navigate(accountId, `${ORIGIN}/publish?scene=pcMainPublish&itemId=${itemId}`);
      const current = await request(accountId, 'read-form');
      if (!current.ok) { showWindow(accountId); throw new Error('该类目暂不支持网页版编辑，或需要在官方窗口完成验证'); }
      const fullText = current.description.trim();
      const title = product.title.slice(0, 60);
      const description = fullText.startsWith(title) ? fullText.slice(title.length).trim() : fullText;
      return { ok: true, draft: drafts.save({ account_id: Number(accountId), source_item_id: String(itemId), title, description,
        price: current.price, original_price: current.original_price, images: current.images.map((url) => ({ url })), shipping: current.shipping,
        shipping_fee: current.shipping_fee, ...normalizeOptions(current), stock: store.listProducts(accountId).find((item) => item.item_id === String(itemId))?.stock || 1 }) };
    }); },
    resolve(id, { itemId, notPublished }) { return locked(drafts.get(id).account_id, async () => {
      const row = drafts.get(id); if (row.status !== 'uncertain') throw new Error('只有待核对的提交可以登记核对结果');
      if (notPublished === true) return { ok: true, draft: drafts.patch(id, { status: 'draft', preparation: null, error: '已人工核对未发布，可重新准备' }) };
      const owned = await scan(row.account_id);
      if (!owned.ok || !owned.products.some((item) => item.item_id === String(itemId))) throw new Error('没有在该店铺同步结果中找到此商品 ID');
      return { ok: true, draft: drafts.patch(id, { status: 'published', published_item_id: String(itemId), preparation: null, error: '' }) };
    }); },
    stop(id) {
      const win = windows.get(Number(id)); if (win && !win.isDestroyed()) win.destroy(); windows.delete(Number(id));
      const contents = views.get(Number(id))?.webContents;
      if (contents && !contents.isDestroyed?.()) contents.destroy(); views.delete(Number(id));
    },
  };
}

module.exports = { createProductService, parsePlatformResponse, downloadImage };

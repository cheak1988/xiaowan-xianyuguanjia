'use strict';

// Read-only page diagnosis in a disposable copy of an account partition.
// Never prints cookies, headers, input values or auth query strings.
if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-product-probe-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  env.XIANYU_PROBE_DIRECTORY = temporary;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, encoding: 'utf8', stdio: 'inherit', windowsHide: true, timeout: 100000,
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exit(result.status === 0 ? 0 : 1);
}
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const temporary = process.env.XIANYU_PROBE_DIRECTORY || fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-product-probe-'));
const profile = path.join(temporary, 'OpenFish');
const original = path.join(process.env.APPDATA, 'OpenFish');
const accountId = Number(process.argv[2]) || 1;
fs.mkdirSync(profile, { recursive: true });
for (const relative of ['Local State', `Partitions/xy-${accountId}/Network`, `Partitions/xy-${accountId}/Local Storage`]) {
  const source = path.join(original, relative);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(profile, relative), { recursive: true });
}
app.setPath('appData', temporary); app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
const timeout = setTimeout(() => app.exit(1), 95000);
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_e, file, error) => { console.error('PRELOAD:', path.basename(file), error.message); app.exit(1); });
  contents.on('console-message', (_e, level, value) => { if (level >= 3) console.error('PAGE:', value.slice(0, 180)); });
});
ipcMain.on('product:response', (event, result) => console.log(JSON.stringify({ responseReceived: true, hasRequestId: !!result.requestId, frameMatches: event.senderFrame === event.sender.mainFrame, ok: result.ok, count: result.products?.length })));
app.whenReady().then(async () => {
  const partition = `persist:xy-${accountId}`;
  const cookies = await session.fromPartition(partition).cookies.get({ url: 'https://www.goofish.com' });
  const uid = (cookies.find((cookie) => cookie.name === 'unb') || {}).value;
  console.log(JSON.stringify({ accountId, identityCookiePresent: !!uid }));
  if (process.argv.includes('--verify-sync')) {
    BrowserWindow.prototype.show = function () {};
    BrowserWindow.prototype.focus = function () {};
    const store = require('../src/main/store'); store.init(profile);
    store.ready().accounts.push({ id: accountId, label: '只读同步验收', disabled: false });
    const { createProductService } = require('../src/main/product-service');
    const service = createProductService({ store, views: new Map(), parent: () => null });
    const result = await service.sync(accountId);
    if (!result.ok) console.log(JSON.stringify(await service.ensureView(accountId).webContents.executeJavaScript(`({
      page:location.pathname,tabs:document.querySelectorAll('[class*=filterTab]').length,cards:document.querySelectorAll('a[href*=\"item?id=\"]').length,
      loginFrames:Array.from(document.querySelectorAll('iframe[src*=mini_login],[class*=login-iframe-wrap]')).map(e=>({class:e.className,rect:{width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height},display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility})),
      text:document.body.innerText.slice(0,150)
    })`)));
    console.log(JSON.stringify({ scope: 'read-only live profile; disposable copied session; original data unchanged',
      ok: result.ok, error: result.error, count: result.count, complete: result.complete,
      stored: store.listProducts(accountId).length,
      statuses: store.listProducts(accountId).reduce((counts, item) => { counts[item.status] = (counts[item.status] || 0) + 1; return counts; }, {}) }));
    if (result.ok && process.argv.includes('--verify-images')) {
      const urls = result.products.map((item) => item.image).filter(Boolean);
      const loaded = await service.ensureView(accountId).webContents.executeJavaScript(`Promise.all(${JSON.stringify(urls)}.map(url=>new Promise(resolve=>{
        const image=new Image();const timeout=setTimeout(()=>resolve(false),8000);
        image.onload=()=>{clearTimeout(timeout);resolve(image.naturalWidth>2&&image.naturalHeight>2)};
        image.onerror=()=>{clearTimeout(timeout);resolve(false)};image.referrerPolicy='no-referrer';image.src=url;
      })))`);
      console.log(JSON.stringify({ scope: 'read-only live product images', products: result.count,
        realImageUrls: urls.filter((url) => !/[-_]2[-_]2\.(png|gif)/i.test(url)).length,
        loadedImages: loaded.filter(Boolean).length, allImagesLoaded: loaded.length === result.count && loaded.every(Boolean) }));
      if (!loaded.every(Boolean) || !urls.length) console.log(JSON.stringify(await service.ensureView(accountId).webContents.executeJavaScript(`({visibility:document.visibilityState,images:Array.from(document.querySelectorAll('[class*="feeds-image-container"] img')).slice(0,12).map(image=>({tail:image.src.split('?')[0].slice(-75),dataSrc:!!image.getAttribute('data-src'),width:image.naturalWidth,display:getComputedStyle(image).display,boxWidth:image.getBoundingClientRect().width})),cards:document.querySelectorAll('a[class*="feeds-item-wrap"]').length})`)));
    }
    if (result.ok && process.argv.includes('--verify-edit')) {
      service.setDraftManager(require('../src/main/product-drafts').createDraftManager({ store, directory: profile, nativeImage: require('electron').nativeImage }));
      const item = result.products.find((product) => product.status === 'on_sale');
      if (item) {
        const edit = await service.readItem(accountId, item.item_id);
        console.log(JSON.stringify({ scope: 'read-only official edit form; no fill, upload or submit', ok: edit.ok,
          error: edit.error, images: edit.draft?.images.length,
          distinctImages: edit.draft ? new Set(edit.draft.images.map((image) => image.url)).size : 0,
          imageTransforms: edit.draft?.images.map((image) => new URL(image.url).pathname.match(/\.(?:jpg|jpeg|png|webp)(_.+)?$/i)?.[1] || ''),
          descriptionLength: edit.draft?.description.length, pricePresent: !!edit.draft?.price }));
        if (edit.ok && !edit.draft.images.length) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          console.log(JSON.stringify(await service.ensureView(accountId).webContents.executeJavaScript(`({
            images:Array.from(document.querySelectorAll('form img')).map(e=>({class:e.className,parent:e.parentElement.className,grandparent:e.parentElement.parentElement.className,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})).filter(e=>e.width>30),
            imageSections:Array.from(document.querySelectorAll('form label')).filter(e=>/图片/.test(e.innerText)).map(e=>({for:e.htmlFor,classes:Array.from(e.closest('.ant-form-item')?.querySelectorAll('[class]')||[]).map(n=>n.className).slice(0,25)}))
          })`)));
        }
      }
    }
    service.stop(accountId); store.flush(); clearTimeout(timeout); app.quit(); return;
  }
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: {
    partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  const urls = ['https://seller.goofish.com/', 'https://www.goofish.com/personal' + (uid ? '?userId=' + encodeURIComponent(uid) : '')];
  if (process.argv.includes('--publish')) urls.push('https://www.goofish.com/publish');
  for (const url of urls) {
    try {
      await win.loadURL(url);
      await new Promise((resolve) => setTimeout(resolve, 4500));
      const result = await win.webContents.executeJavaScript(`(()=>({
        origin:location.origin,path:location.pathname,hash:location.hash.split('?')[0],title:document.title,
        buttons:Array.from(document.querySelectorAll('button,[role=menuitem],a')).map(e=>({text:e.innerText.trim().slice(0,60),path:e.href?new URL(e.href,location.href).pathname:undefined})).filter(e=>e.text).slice(0,70),
        frames:Array.from(document.querySelectorAll('iframe')).map(e=>{try{return new URL(e.src).origin+new URL(e.src).pathname}catch{return ''}}),
        fields:Array.from(document.querySelectorAll('input,textarea')).map(e=>({tag:e.tagName,type:e.type,placeholder:e.placeholder})),
        editables:Array.from(document.querySelectorAll('[contenteditable]')).map(e=>({tag:e.tagName,role:e.getAttribute('role'),placeholder:e.getAttribute('data-placeholder'),class:e.className})),
        productCards:Array.from(document.querySelectorAll('a[href*=\"item?id=\"]')).slice(0,2).map(e=>e.outerHTML.slice(0,3200)),
        actions:Array.from(document.querySelectorAll('button,[role=button],label')).map(e=>({tag:e.tagName,text:e.innerText.trim().slice(0,60),class:e.className})).filter(e=>e.text).slice(0,50),
        form:document.querySelector('form')?.outerHTML.slice(0,15000),
        tabs:Array.from(document.querySelectorAll('div,span')).filter(e=>e.childElementCount===0&&/^(综合|在售\\d*|已售出\\d*)$/.test(e.innerText.trim())).map(e=>e.parentElement.outerHTML.slice(0,1400)).slice(0,6),
        cardLinks:document.querySelectorAll('a[href*=\"item?id=\"]').length,
        text:document.body.innerText.slice(0,1400)
      }))()`);
      console.log(JSON.stringify(result));
      if (url.includes('/personal') && process.argv.includes('--publish')) {
        const detail = await win.webContents.executeJavaScript('document.querySelector(\'a[href*="item?id="]\')?.href');
        if (detail) urls.push(detail);
      }
    } catch (error) { console.log(JSON.stringify({ origin: new URL(url).origin, error: error.message })); }
  }
  clearTimeout(timeout); win.destroy(); app.quit();
}).catch((error) => { console.error(error.message); app.exit(1); });

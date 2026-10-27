'use strict';

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, stdio: 'inherit', windowsHide: true, timeout: 180000,
  });
  process.exit(result.status === 0 ? 0 : 1);
}

const { app, BrowserWindow, session, dialog, nativeImage } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const root = path.join(__dirname, '..');
const outputDirectory = require('../package.json').build.directories.output;
const source = process.argv.includes('--packed') ? path.join(root, outputDirectory, 'win-unpacked/resources/app.asar') : root;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-products-check-'));
const output = path.join(root, '_bench', 'product-ui'); fs.mkdirSync(output, { recursive: true });
app.setPath('appData', temporary); app.setPath('userData', path.join(temporary, 'OpenFish'));
app.commandLine.appendSwitch('disable-gpu');
BrowserWindow.prototype.show = function () {}; BrowserWindow.prototype.focus = function () {};
BrowserWindow.prototype.showInactive = function () {};
require('https').get = () => { throw new Error('Unexpected external Node request in offline verification'); };
const errors = [], checks = [], uploads = [], writes = [];
const aiRequests = [];
const aiServer = require('http').createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  aiRequests.push(JSON.parse(Buffer.concat(chunks)));
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '演示 · 桌面收纳盒 分区整理', description: '奶白色桌面收纳盒，分区整理。具体尺寸以实际商品为准。' }) } }] }));
});
const aiReady = new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
let skuSupported = false;
let responseMode = 'success', nextId = 900000000010, checked = false;
const catalog = {
  '11112222': [{ item_id: '100000000001', title: '演示 · 桌面收纳盒', price: '29.90', status: 'on_sale' },
    { item_id: '100000000002', title: '演示 · 旧款收纳盒', price: '19.90', status: 'sold' }],
  '33334444': [{ item_id: '200000000001', title: '另一店铺的演示商品', price: '39.00', status: 'on_sale' }],
};
const imageA = path.join(temporary, 'demo-front.png'), imageB = path.join(temporary, 'demo-detail.png');
for (const [file, color] of [[imageA, [236, 218, 193, 255]], [imageB, [178, 202, 222, 255]]]) {
  const pixels = Buffer.alloc(300 * 300 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    const x = (index / 4) % 300, y = Math.floor(index / 4 / 300);
    const box = x > 55 && x < 245 && y > 85 && y < 235;
    for (let component = 0; component < 4; component++) pixels[index + component] = component === 3 ? 255 : box ? color[component] : Math.min(255, color[component] + 25);
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(pixels, { width: 300, height: 300 }).toPNG());
}
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imageA, imageB] });
dialog.showErrorBox = (title, error) => { console.error(title, error); app.exit(1); };
const pause = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
function pass(name) { checks.push(name); console.log('PASS ' + name); }
function html(body) { return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>' + body + '</body></html>'; }
function profilePage(uid) {
  const list = catalog[uid] || [], on = list.filter((item) => item.status === 'on_sale').length, sold = list.length - on;
  return html(`<section data-owned-product-list><div class="filterTab--fixture"><div data-product-tab data-status="all">综合</div><div data-product-tab data-status="on_sale">在售${on}</div><div data-product-tab data-status="sold">已售出${sold}</div></div><div id="owned"></div></section>
  <aside><a class="feeds-item-wrap--recommendation" href="https://www.goofish.com/item?id=999999999999"><span data-product-title>其他人的推荐商品</span><span data-product-price>¥ 999</span></a></aside>
  <script>const items=${JSON.stringify(list)};function render(status){document.querySelector('#owned').innerHTML=items.filter(i=>status==='all'||i.status===status).map(i=>'<a class="feeds-item-wrap--fixture" href="https://www.goofish.com/item?id='+i.item_id+'"><span data-product-title>'+i.title+'</span><span data-product-price>¥ '+i.price+'</span><div class="feeds-image-container--fixture"><img src="https://img.alicdn.com/fixture/tps-2-2.png"><img src="https://img.alicdn.com/fixture/card.png"></div></a>').join('');const first=document.querySelector('#owned .feeds-image-container--fixture');if(first){first.innerHTML='<img src="https://img.alicdn.com/fixture/tps-2-2.png">';first.__reactProps$fixture={children:[{props:{src:'http://img.alicdn.com/fixture/card.png',enableLazyLoad:true}}]}}};
  document.querySelectorAll('[data-product-tab]').forEach(t=>t.onclick=()=>setTimeout(()=>render(t.dataset.status),60));render('all');</script>`);
}
function publishPage(itemId) {
  const item = Object.values(catalog).flat().find((row) => row.item_id === itemId);
  const field = (key, placeholder) => `<div class="ant-form-item"><label for="${key}">${placeholder}</label><input placeholder="${placeholder}" data-field="${key}" /></div>`;
  return html(`<form><h2>官方表单模拟页 · 离线验收</h2>${skuSupported ? '<h3>商品规格</h3>' : ''}<input type="file" multiple /><div id="photos"></div>
    <div class="ant-form-item"><label>宝贝描述</label><div contenteditable="true" data-product-description data-placeholder="描述宝贝"></div></div>
    ${field('itemPriceDTO_priceInCent', '价格')}${field('itemPriceDTO_origPriceInCent', '原价')}${field('itemPostFeeDTO_postPriceInCent', '邮费')}
    <label><input type="radio" name="shipping" value="0" checked />包邮</label><label><input type="radio" name="shipping" value="1" />按距离</label>
    <label><input type="radio" name="shipping" value="2" />固定邮费</label><label><input type="radio" name="shipping" value="3" />无需邮寄</label><button type="submit">发布</button><div id="form-error"></div></form>
    <script>const initial=${JSON.stringify(item || {})};window.model={description:initial.description||'',price:initial.price||'',original_price:'',shipping:'0',shipping_fee:'',images:initial.images||[]};
    window.nativeCategory='';window.platformValues={itemProperties:[],itemSkuList:[],itemLabelExtList:[],itemAddrDTO:null};
    document.querySelector('form').__reactFiber$fixture={memoizedProps:{form:{getFieldsValue:()=>window.platformValues,setFieldsValue:patch=>{Object.assign(window.platformValues,patch);if(patch.itemProperties)setTimeout(()=>{if(!patch.itemSkuList)window.platformValues.itemSkuList=[]},100);}}}};
    const category=document.createElement('div');category.innerHTML='<span data-category-option>收纳用品</span>';document.querySelector('form').append(category);category.__reactProps$fixture={cardData:{propertyId:'-10000',propertyName:'类目',valuesList:[{propertyId:'-10000',propertyName:'类目',channelCatId:'500123',catName:'收纳用品'}]}};category.querySelector('span').onclick=()=>{nativeCategory='500123';platformValues.itemLabelExtList=[{text:'收纳用品',properties:'-10000##类目:500123##收纳用品'}];};
    const editor=document.querySelector('[contenteditable]');editor.innerText=model.description;editor.oninput=()=>model.description=editor.innerText;
    const keys={itemPriceDTO_priceInCent:'price',itemPriceDTO_origPriceInCent:'original_price',itemPostFeeDTO_postPriceInCent:'shipping_fee'};
    document.querySelectorAll('[data-field]').forEach(e=>{e.value=model[keys[e.dataset.field]];e.oninput=()=>model[keys[e.dataset.field]]=e.value});
    document.querySelectorAll('input[type=radio]').forEach(e=>e.onchange=()=>model.shipping=e.value);
    function photos(){document.querySelector('#photos').innerHTML=model.images.map((url,i)=>'<div class="preview-container--fixture"><img src="https://img.alicdn.com/fixture/spinner.gif" style="display:none;width:24px;height:24px"><img style="width:96px;height:96px" src="'+url+'"><button type="button" class="delete-btn--fixture" data-remove-image data-index="'+i+'">移除</button></div>').join('');document.querySelectorAll('[data-remove-image]').forEach(e=>e.onclick=()=>{const popup=document.createElement('div');popup.className='ant-popconfirm';popup.innerHTML='确定要删除这张图片吗？<button type="button">确认</button>';popup.querySelector('button').onclick=()=>{model.images.splice(Number(e.dataset.index),1);popup.remove();photos()};document.body.append(popup)})};photos();
    document.querySelector('input[type=file]').onchange=async e=>{const file=e.target.files[0];const r=await fetch('/fixture-upload',{method:'POST',body:await file.arrayBuffer()});model.images.push((await r.json()).url);photos()};
    document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/h5/mtop.idle.pc.idleitem.${itemId ? 'edit' : 'publish'}/1.0/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...model,...platformValues,nativeCategory,source_item_id:${JSON.stringify(itemId || '')}})});const result=await r.json();document.querySelector('#form-error').textContent=result.ret[0]};
    </script>`);
}
function handleRequest(request, callback) {
  const url = new URL(request.url);
  const reply = (body, mimeType = 'text/html') => callback({ mimeType, data: Buffer.isBuffer(body) ? body : Buffer.from(body) });
  if (url.hostname === 'img.alicdn.com') { reply(fs.readFileSync(imageA), 'image/png'); return; }
  if (url.hostname !== 'www.goofish.com') { callback({ statusCode: 403, data: Buffer.from('Blocked') }); return; }
  if (url.pathname === '/personal') { reply(profilePage(url.searchParams.get('userId'))); return; }
  if (url.pathname === '/publish') { reply(publishPage(url.searchParams.get('itemId'))); return; }
  const body = Buffer.concat((request.uploadData || []).filter((part) => part.bytes).map((part) => part.bytes));
  if (url.pathname === '/fixture-upload') {
    uploads.push(body); reply(JSON.stringify({ url: 'https://img.alicdn.com/fixture/upload-' + uploads.length + '.png' }), 'application/json'); return;
  }
  if (url.pathname.startsWith('/h5/mtop.idle.pc.idleitem.')) {
    const payload = JSON.parse(body.toString('utf8')); writes.push(payload);
    if (!payload.description || !payload.price || !payload.images.length) { reply(JSON.stringify({ ret: ['FAIL_BIZ::缺少商品信息'], data: {} }), 'application/json'); return; }
    if (responseMode === 'failure') { reply(JSON.stringify({ ret: ['FAIL_BIZ::类目属性待补充'], data: {} }), 'application/json'); return; }
    const itemId = payload.source_item_id || String(++nextId);
    const row = { item_id: itemId, title: payload.description.split('\n')[0], description: payload.description, price: payload.price, images: payload.images, status: 'on_sale' };
    const previous = catalog['11112222'].findIndex((item) => item.item_id === itemId);
    if (previous < 0) catalog['11112222'].push(row); else catalog['11112222'][previous] = row;
    reply(JSON.stringify({ ret: ['SUCCESS::调用成功'], data: responseMode === 'uncertain' ? {} : { itemId } }), 'application/json'); return;
  }
  callback({ statusCode: 404, data: Buffer.from('Not found') });
}
const timeout = setTimeout(() => { console.error('Product verification timed out'); app.exit(1); }, 170000);
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.on('preload-error', (_e, file, error) => errors.push(path.basename(file) + ': ' + error.message));
  contents.on('console-message', (_e, level, value) => { if (level >= 3) errors.push(value); });
  contents.on('did-finish-load', async () => {
    if (checked || !contents.getURL().endsWith('/shell/index.html')) return;
    checked = true;
    const win = BrowserWindow.fromWebContents(contents), evaluate = (code) => contents.executeJavaScript(code);
    async function capture(name) {
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(output, name + '.png'), (await win.capturePage()).toPNG());
    }
    try {
      await pause(200);
      for (const current of [session.defaultSession, session.fromPartition('persist:xy-1'), session.fromPartition('persist:xy-2')]) {
        await current.protocol.interceptBufferProtocol('https', handleRequest);
        current.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (_details, callback) => callback({ cancel: true }));
      }
      await session.fromPartition('persist:xy-1').cookies.set({ url: 'https://www.goofish.com', name: 'unb', value: '11112222' });
      await session.fromPartition('persist:xy-2').cookies.set({ url: 'https://www.goofish.com', name: 'unb', value: '33334444' });
      const store = require(path.join(source, 'src/main/store'));
      store.addAccount('演示 · 日常经营'); store.addAccount('演示 · 另一店铺'); store.updateSettings({ autoReply: { enabled: false } }); store.persist();
      await evaluate(`(async()=>{await renderAccounts(await window.api.accounts.list());await switchView('products');document.querySelector('.breadcrumb').insertAdjacentHTML('beforeend','<span style="font-size:11px;color:#6b7075">离线演示数据 · 商品功能验收</span>')})()`);
      let result = await evaluate('window.api.products.sync(1)');
      assert.equal(result.ok, true, result.error); assert.equal(result.count, 2); assert.equal(result.complete, true);
      assert.equal(store.listProducts(1).some((item) => item.item_id === '999999999999'), false); pass('同步只读取店铺商品，排除推荐卡片');
      assert.ok(store.listProducts(1).every((item) => item.image.endsWith('/fixture/card.png')));
      await evaluate('loadProducts()');
      assert.equal(await evaluate(`Promise.all(Array.from(document.querySelectorAll('#product-list img.cell-thumb')).map(image=>image.complete ? image.naturalWidth>2 : new Promise(resolve=>{image.onload=()=>resolve(image.naturalWidth>2);image.onerror=()=>resolve(false)}))).then(values=>values.length===2&&values.every(Boolean))`), true);
      assert.equal(await evaluate('document.querySelector("#product-list").innerText.includes("本地库存")'), false);
      pass('同步跳过2×2占位图，列表实际图片加载成功且移除本地库存列');
      result = await evaluate('window.api.products.sync(2)');
      assert.equal(result.ok, true, result.error); assert.equal(store.listProducts(2).length, 1);
      assert.equal(store.listProducts(1).length, 2); pass('两家店铺商品和登录分区独立');
      catalog['11112222'][0].price = '49.90';
      catalog['11112222'].push({ item_id: '100000000003', title: '演示 · 新上架商品', price: '9.90', status: 'on_sale' });
      const preview = await evaluate('window.api.products.scanPreview(1)');
      assert.equal(preview.ok, true, preview.error); assert.equal(preview.count, 3);
      assert.equal(store.listProducts(1).length, 2);
      assert.equal(preview.products.find((item) => item.item_id === '100000000003').exists, false);
      assert.equal(preview.products.find((item) => item.item_id === '100000000001').exists, true);
      assert.equal((await evaluate(`window.api.products.syncImport(1, ${JSON.stringify(preview.scanId)}, [])`)).ok, false);
      result = await evaluate(`window.api.products.syncImport(1, ${JSON.stringify(preview.scanId)}, ['100000000003'])`);
      assert.equal(result.ok, true, result.error); assert.deepEqual([result.added, result.updated], [1, 0]);
      assert.equal(store.listProducts(1).length, 3);
      assert.equal(store.listProducts(1).find((item) => item.item_id === '100000000001').price, '29.90');
      assert.equal((await evaluate(`window.api.products.syncImport(2, ${JSON.stringify(preview.scanId)}, ['100000000001'])`)).ok, false);
      result = await evaluate(`window.api.products.syncImport(1, ${JSON.stringify(preview.scanId)}, ['100000000001'])`);
      assert.equal(result.ok, true, result.error); assert.deepEqual([result.added, result.updated], [0, 1]);
      assert.equal(store.listProducts(1).find((item) => item.item_id === '100000000001').price, '49.90');
      pass('同步先预览勾选再导入，未勾选商品不新增也不更新');
      const chosen = await evaluate('window.api.products.chooseImages()');
      assert.equal(chosen.ok, true, chosen.error); assert.equal(chosen.images.length, 2); assert.ok(chosen.images.every((image) => image.preview.startsWith('data:image/jpeg;base64,'))); pass('原生选择图片并生成本地缩略图');
      const input = { account_id: 1, title: '演示 · 桌面收纳盒', description: '奶白色桌面收纳盒\n分区整理，保持桌面整洁。此内容仅为离线测试。', price: '29.90', original_price: '39.90', stock: 8, shipping: 'fixed', shipping_fee: '6.00', images: [...chosen.images].reverse() };
      result = await evaluate(`window.api.products.drafts.save(${JSON.stringify(input)})`);
      assert.equal(result.ok, true, result.error); let draft = result.draft;
      await evaluate(`window.ProductEditor.open(${JSON.stringify(draft)})`); await capture('editor');
      assert.equal(await evaluate('document.querySelectorAll(".goods-image").length'), 2);
      assert.equal(await evaluate('document.querySelector("#goods-account").disabled'), true); pass('商品编辑器、图片预览和店铺绑定');
      assert.equal(await evaluate('document.querySelector("#goods-stock")'), null);
      await aiReady;
      const copyConfig = { baseURL: `http://127.0.0.1:${aiServer.address().port}/v1`, model: 'offline-custom-model', apiKey: 'offline-fixture-key', systemPrompt: '口语化，使用商品关键词。' };
      assert.equal(await evaluate('document.querySelector("#goods-ai-base")'), null);
      await evaluate(`document.querySelector('#goods-ai-keyword').value='桌面收纳盒';document.querySelector('#goods-ai-keyword').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#goods-ai-settings').click()`);
      for (let round = 0; round < 60 && !await evaluate('!!document.querySelector("#product-ai-base")'); round++) await pause(100);
      assert.equal(await evaluate('currentView'), 'settings'); assert.equal(await evaluate('currentSettingsTab'), 'product-ai');
      assert.equal(await evaluate('document.querySelector(".goods-editor")'), null);
      await evaluate(`document.querySelector('#product-ai-base').value=${JSON.stringify(copyConfig.baseURL)};document.querySelector('#product-ai-model').value=${JSON.stringify(copyConfig.model)};document.querySelector('#product-ai-key').value=${JSON.stringify(copyConfig.apiKey)};document.querySelector('#product-ai-prompt').value=${JSON.stringify(copyConfig.systemPrompt)};document.querySelector('#product-ai-save').click()`);
      for (let round = 0; round < 60 && !await evaluate('document.querySelector("#product-ai-feedback").innerText.includes("配置已保存")'); round++) await pause(100);
      result = await evaluate('window.api.products.ai.config()');
      assert.equal(result.ok, true, result.error); assert.equal(result.config.apiKeySet, true);
      await evaluate('document.querySelector("#product-ai-key").value').then((value) => assert.equal(value, ''));
      await capture('ai-config');
      await evaluate('document.querySelector("#product-ai-back").click()');
      for (let round = 0; round < 60 && !await evaluate('!!document.querySelector("#goods-ai-keyword")'); round++) await pause(100);
      assert.equal(await evaluate('document.querySelector("#goods-ai-keyword").value'), '桌面收纳盒');
      assert.match(await evaluate('document.querySelector("#goods-ai-config-state").textContent'), /offline-custom-model/);
      pass('设置页统一配置，跳转保存草稿，返回沿用已保存模型');
      const safeSettings = await evaluate('window.api.settings.get()');
      assert.equal(safeSettings.ai.enabled, false); assert.equal(safeSettings.productAI.apiKeyEnc, undefined);
      assert.equal(JSON.stringify(safeSettings).includes('offline-fixture-key'), false); pass('商品AI自定义配置独立保存，密钥不回传且客服保持关闭');
      await evaluate(`document.querySelector('#goods-ai-keyword').value='桌面收纳盒';document.querySelector('#goods-ai-facts').value='奶白色，分区整理。';document.querySelector('#goods-ai-generate').click()`);
      for (let round = 0; round < 80 && await evaluate('document.querySelector("#goods-ai-result").hidden'); round++) await pause(100);
      assert.equal(await evaluate('document.querySelector("#goods-ai-result").hidden'), false);
      assert.equal(await evaluate('document.querySelector("#goods-title").value'), input.title); assert.equal(writes.length, 0);
      await evaluate('document.querySelector("#goods-ai-result").scrollIntoView({block:"center"})'); await capture('ai-copy');
      await evaluate('document.querySelector("#goods-ai-apply").click()'); await pause();
      assert.equal(await evaluate('document.querySelector("#goods-title").value'), '演示 · 桌面收纳盒 分区整理');
      assert.match(aiRequests[0].messages[1].content, /桌面收纳盒/); assert.equal(writes.length, 0); pass('关键词生成SEO标题详情，先预览再采用，不自动发布');
      await evaluate(`document.querySelector('#goods-title').value=${JSON.stringify(input.title)};document.querySelector('#goods-description').value=${JSON.stringify(input.description)};document.querySelector('#goods-title').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#goods-save').click()`); await pause();
      await evaluate('document.querySelector(".goods-editor-content").scrollTop=0');
      win.setSize(1280, 720); await pause(); await capture('editor-1280');
      assert.equal(await evaluate('document.querySelector(".goods-editor").scrollWidth<=document.querySelector(".goods-editor").clientWidth'), true);
      assert.equal(await evaluate('document.querySelector("#goods-account").getBoundingClientRect().bottom<document.querySelector(".goods-editor-header").getBoundingClientRect().bottom'), true);
      win.setSize(1500, 900); pass('最小窗口下保留店铺、编辑区域与提交按钮');
      await evaluate('document.querySelector("#goods-images [data-image-action=first]").disabled').then((disabled) => assert.equal(disabled, true));
      const countBefore = writes.length;
      result = await evaluate(`window.api.products.drafts.prepare('${draft.id}')`);
      assert.equal(result.ok, true, result.error); draft = result.draft;
      assert.equal(draft.status, 'prepared'); assert.equal(writes.length, countBefore);
      assert.ok(uploads[0].equals(fs.readFileSync(imageB))); assert.ok(uploads[1].equals(fs.readFileSync(imageA))); pass('真实文件经浏览器上传，主图顺序正确，准备阶段不发布');
      const official = BrowserWindow.getAllWindows().flatMap((candidate) => candidate.getBrowserViews()).find((view) => view.webContents.getURL().includes('/publish'));
      await official.webContents.executeJavaScript('document.querySelector("button[type=submit]").click()'); await pause();
      assert.equal(writes.length, countBefore); pass('官方预览中的手动点击不会绕过确认流程');
      await evaluate('window.ProductEditor.close()'); await evaluate(`window.ProductEditor.open(${JSON.stringify(draft)})`); await capture('ready');
      result = await evaluate(`window.api.products.drafts.submit('${draft.id}')`);
      assert.equal(result.ok, true, result.error); assert.ok(result.itemId); assert.equal(result.draft.status, 'published');
      assert.equal(writes.length, countBefore + 1); assert.equal(writes.at(-1).price, '29.90'); assert.equal(writes.at(-1).shipping_fee, '6.00');
      assert.equal(store.listProducts(1).find((item) => item.item_id === result.itemId).description, input.description); pass('填写受控表单后提交，以平台商品 ID 确认成功');
      const publishedId = result.itemId;
      assert.equal((await evaluate(`window.api.products.drafts.submit('${draft.id}')`)).ok, false);
      assert.equal(writes.length, countBefore + 1); pass('已发布草稿不会重复提交');
      result = await evaluate(`window.api.products.drafts.editItem(1,'${publishedId}')`);
      assert.equal(result.ok, true, result.error); assert.equal(result.draft.source_item_id, publishedId); pass('从官方编辑页读取完整文案和多张图片');
      assert.equal(result.draft.images.length, 2); assert.ok(result.draft.images.every((image) => !image.url.includes('spinner')));
      const editInput = { ...result.draft, price: '35.00', description: '离线编辑修改后的完整文案' };
      result = await evaluate(`window.api.products.drafts.save(${JSON.stringify(editInput)})`); assert.equal(result.ok, true, result.error);
      const uploadsBeforeEdit = uploads.length;
      result = await evaluate(`window.api.products.drafts.prepare('${editInput.id}')`); assert.equal(result.ok, true, result.error);
      assert.equal(uploads.length, uploadsBeforeEdit); pass('只改文案和价格时保留平台原图，不下载或重新压缩');
      result = await evaluate(`window.api.products.drafts.submit('${editInput.id}')`); assert.equal(result.ok, true, result.error); assert.equal(result.itemId, publishedId); pass('编辑提交更新原商品，不新建重复商品');
      result = await evaluate(`window.api.products.drafts.editItem(1,'${publishedId}')`); assert.equal(result.ok, true, result.error);
      const replaceInput = { ...result.draft, images: chosen.images };
      result = await evaluate(`window.api.products.drafts.save(${JSON.stringify(replaceInput)})`); assert.equal(result.ok, true, result.error);
      result = await evaluate(`window.api.products.drafts.prepare('${replaceInput.id}')`); assert.equal(result.ok, true, result.error);
      assert.equal(uploads.length, uploadsBeforeEdit + 2); assert.ok(uploads.at(-2).equals(fs.readFileSync(imageA)));
      result = await evaluate(`window.api.products.drafts.submit('${replaceInput.id}')`); assert.equal(result.ok, true, result.error); assert.equal(result.itemId, publishedId); pass('替换图片会确认删除旧图并按新顺序上传');
      result = await evaluate(`window.api.products.drafts.save(${JSON.stringify(input)})`); const failedId = result.draft.id;
      result = await evaluate(`window.api.products.drafts.prepare('${failedId}')`); assert.equal(result.ok, true, result.error);
      responseMode = 'failure'; result = await evaluate(`window.api.products.drafts.submit('${failedId}')`);
      assert.equal(result.ok, false); assert.equal(result.uncertain, false); assert.equal(result.draft.status, 'draft'); pass('明确的平台拒绝显示失败，不误报成功');
      responseMode = 'uncertain';
      result = await evaluate(`window.api.products.drafts.prepare('${failedId}')`); assert.equal(result.ok, true, result.error);
      result = await evaluate(`window.api.products.drafts.submit('${failedId}')`); assert.equal(result.uncertain, true); assert.equal(result.draft.status, 'uncertain');
      const writeCount = writes.length;
      assert.equal((await evaluate(`window.api.products.drafts.prepare('${failedId}')`)).ok, false);
      assert.equal((await evaluate(`window.api.products.drafts.verify('${failedId}')`)).ok, false);
      assert.equal((await evaluate(`window.api.products.drafts.remove('${failedId}')`)).ok, false); assert.equal(writes.length, writeCount); pass('确认丢失时冻结重试，避免平台已发布却再次上架');
      result = await evaluate(`window.api.products.drafts.resolve('${failedId}',{itemId:'${nextId}'})`);
      assert.equal(result.ok, true, result.error); assert.equal(result.draft.status, 'published'); pass('核对商品归属后恢复为已发布');
      await evaluate('window.ProductEditor.close()'); await evaluate("loadProducts()");
      await evaluate('document.querySelector("[data-product-mode=drafts]").click()'); await pause(); await capture('drafts');
      responseMode = 'success'; skuSupported = true;
      const skuInput = {...input, sku: {enabled:true,groups:[{name:'套餐',values:['基础','进阶']},{name:'颜色',values:['黑','白']}],rows:[['基础','黑'],['基础','白'],['进阶','黑'],['进阶','白']].map((values,i)=>({values,price:String(10+i),quantity:i+1}))}};
      result = await evaluate(`window.api.products.drafts.save(${JSON.stringify(skuInput)})`); const skuId = result.draft.id;
      await evaluate(`window.ProductEditor.open(${JSON.stringify(result.draft)})`);
      assert.equal(await evaluate('document.querySelectorAll("[data-sku-row]").length'),4);
      await evaluate('document.querySelector("#goods-options").scrollIntoView({block:"start"})'); await capture('sku-editor'); pass('本地多规格编辑器显示组合及逐规格价格库存');
      result = await evaluate(`window.api.products.drafts.prepare('${skuId}')`); assert.equal(result.ok,true,result.error);
      const native = BrowserWindow.getAllWindows().flatMap(w=>w.getBrowserViews()).find(v=>v.webContents.getURL().includes('/publish'));
      assert.equal(await native.webContents.executeJavaScript('platformValues.itemSkuList.length'),4);
      assert.equal(await native.webContents.executeJavaScript('platformValues.itemSkuList[3].quantity'),4);pass('多规格实际写入官方表单并读回核验');
      await native.webContents.executeJavaScript('platformValues.itemSkuList[0].quantity=99');
      const beforeTamper=writes.length; result=await evaluate(`window.api.products.drafts.submit('${skuId}')`);
      assert.equal(result.ok,false);assert.equal(writes.length,beforeTamper);pass('官方库存被更改时阻止提交');
      result=await evaluate(`window.api.products.drafts.prepare('${skuId}')`);assert.equal(result.ok,true,result.error);
      result=await evaluate(`window.api.products.drafts.submit('${skuId}')`);assert.equal(result.ok,true,result.error);assert.equal(writes.at(-1).itemSkuList[3].price,'13');pass('多规格价格库存随官方发布一同提交');
      const attrInput={...input,platform_attributes:[{propertyId:'-10000',propertyName:'类目',optionId:'500123',label:'收纳用品',properties:'-10000##类目:500123##收纳用品'}]};
      result=await evaluate(`window.api.products.drafts.save(${JSON.stringify(attrInput)})`);const attrId=result.draft.id;
      result=await evaluate(`window.api.products.drafts.prepare('${attrId}')`);assert.equal(result.ok,true,result.error);
      const attrs=await evaluate(`window.api.products.drafts.options('${attrId}')`);assert.equal(attrs.attribute_options[0].options[0].optionId,'500123');
      result=await evaluate(`window.api.products.drafts.submit('${attrId}')`);assert.equal(result.ok,true,result.error);assert.equal(writes.at(-1).nativeCategory,'500123');pass('类目读取平台选项，触发原生选择并核验分类状态');
      skuSupported=false;result=await evaluate(`window.api.products.drafts.save(${JSON.stringify(skuInput)})`);
      const unsupportedId=result.draft.id,beforeUnsupported=writes.length;result=await evaluate(`window.api.products.drafts.prepare('${unsupportedId}')`);
      assert.equal(result.ok,false);assert.match(result.error,/未开放/);assert.equal(writes.length,beforeUnsupported);pass('账号未开放多规格时明确阻止发布');
      await evaluate('window.ProductEditor.close();switchView("settings");switchSettingsTab("remote")');await pause();assert.equal(await evaluate('!!document.querySelector("#remote-add")'),true);await capture('remote-settings');
      await evaluate('switchSettingsTab("relist")');await pause();assert.equal(await evaluate('!!document.querySelector("#relist-create")'),true);await capture('relist-settings');pass('设置页具备远程账号权限和自动续售配置入口');
      const probe = require('net').createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve)); const remotePort=probe.address().port; await new Promise(resolve=>probe.close(resolve));
      result=await evaluate(`window.api.remote.saveUser({name:'演示客服',password:'fixture-password-123',role:'editor',account_ids:[1]})`);assert.equal(result.ok,true,result.error);
      result=await evaluate(`window.api.remote.configure({enabled:true,host:'127.0.0.1',port:${remotePort}})`);assert.equal(result.ok,true,result.error);
      const remote = new BrowserWindow({show:false,width:1280,height:900,webPreferences:{partition:'remote-browser-test',sandbox:true,nodeIntegration:false,contextIsolation:true}});
      await remote.webContents.session.protocol.interceptBufferProtocol('https',handleRequest);
      const reval=code=>remote.webContents.executeJavaScript(code,true);
      await remote.loadURL('http://127.0.0.1:'+remotePort);await pause(400);
      assert.equal(await reval('!!document.querySelector("#login")'),true);fs.writeFileSync(path.join(output,'remote-login.png'),(await remote.capturePage()).toPNG());
      await reval(`document.querySelector('#username').value='演示客服';document.querySelector('#password').value='fixture-password-123';document.querySelector('#login').requestSubmit()`);
      for(let i=0;i<50&&!await reval('!!document.querySelector("#shop")');i++)await pause(100);
      assert.equal(await reval('document.querySelector("#shop").options.length'),1);assert.equal(await reval('document.querySelector("#shop").value'),'1');pass('浏览器远程登录成功，仅显示已授权店铺');
      await reval(`document.querySelector('[data-page="products"]').click()`);for(let i=0;i<50&&!await reval('!!document.querySelector("#new")');i++)await pause(100);
      await reval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await pause(100);assert.ok(await reval('document.querySelectorAll(".catalog .card").length'));fs.writeFileSync(path.join(output,'remote-products.png'),(await remote.capturePage()).toPNG());
      await reval(`document.querySelector('#new').click()`);await pause();assert.equal(await reval('!!document.querySelector("#upload")'),true);
      const remoteImages=await reval(`call('upload',{base64:${JSON.stringify(fs.readFileSync(imageA).toString('base64'))}})`);assert.equal(remoteImages.images.length,1);assert.ok(remoteImages.images[0].assetId);
      await reval(`currentDraft.images=${JSON.stringify(remoteImages.images)};document.querySelector('#title').value='远程上传演示';document.querySelector('#description').value='仅离线测试';document.querySelector('#goods-price').value='19';document.querySelector('#save').click()`);
      for(let i=0;i<50&&!await reval('!!currentDraft.id');i++)await pause(100);
      assert.ok(await reval('currentDraft.id'));assert.equal(await reval('currentDraft.images.length'),1);pass('远程图片经HTTP上传并保存为当前店铺草稿');
      await reval('document.querySelector("#prepare").click()');for(let i=0;i<160&&await reval('currentDraft.status!=="prepared"');i++)await pause(100);
      assert.equal(await reval('currentDraft.status'),'prepared');const remoteDraftId=await reval('currentDraft.id');
      const submitted=await reval(`call('submit',{id:${JSON.stringify(remoteDraftId)},confirm:true})`);assert.equal(submitted.ok,true);assert.ok(submitted.itemId);pass('远程草稿通过主机官方表单完成图片上传和确认发布');
      await reval(`document.querySelector('#logout').click()`);await pause(200);assert.equal(await reval('!!document.querySelector("#login")'),true);remote.destroy();
      result=await evaluate(`window.api.remote.configure({enabled:false,host:'127.0.0.1',port:${remotePort}})`);assert.equal(result.ok,true,result.error);
      assert.deepEqual(errors, []);
      const summary = { status: 'PASS', checks: checks.length, names: checks, uploads: uploads.length, writes: writes.length, errors,
        scope: 'offline official-form fixtures; temporary profile; no real accounts or real listings modified' };
      fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
      clearTimeout(timeout); app.isQuitting = true; app.quit();
    } catch (error) { console.error(error.stack); console.error(JSON.stringify({ checks, errors, uploads: uploads.length, writes: writes.length })); clearTimeout(timeout); app.exit(1); }
  });
});
require(path.join(source, 'src/main/index.js'));

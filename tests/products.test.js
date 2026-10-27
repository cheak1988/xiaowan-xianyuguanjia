'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, fakeElectron } = require('./helpers');

function draftsFixture(t) {
  const f = fixture(t, { electron: {} });
  f.account = f.store.addAccount('商品测试店');
  f.manager = f.load('src/main/product-drafts.js').createDraftManager({ store: f.store, directory: f.directory, nativeImage: {} });
  f.input = () => ({ account_id: f.account.id, title: '测试商品', description: '尺寸和交付说明', price: '19.90', stock: 3,
    shipping: 'free', images: [{ url: 'https://img.alicdn.com/test.jpg' }] });
  return f;
}

test('商品草稿与同步商品独立，重启后保留文案、图片顺序和发货设置', (t) => {
  const f = draftsFixture(t);
  const row = f.manager.save({ ...f.input(), shipping: 'fixed', shipping_fee: '8.50', images: [
    { url: 'https://img.alicdn.com/front.jpg' }, { url: 'https://img.alicdn.com/back.jpg' },
  ] });
  f.store.flush(); f.store.init(f.directory);
  assert.equal(f.store.listProducts(f.account.id).length, 0);
  const saved = f.manager.get(row.id);
  assert.equal(saved.description, '尺寸和交付说明'); assert.equal(saved.shipping_fee, '8.50');
  assert.ok(saved.images[0].url.endsWith('/front.jpg')); assert.equal(saved.stock, 3);
});

test('草稿绑定原店铺，拒绝把已有草稿改到其他店铺', (t) => {
  const f = draftsFixture(t), second = f.store.addAccount('另一店铺'), row = f.manager.save(f.input());
  assert.throws(() => f.manager.save({ ...f.input(), id: row.id, account_id: second.id }), /不能改到其他店铺/);
  assert.equal(f.manager.list(second.id).length, 0);
});

test('商品售价、字数和图片校验阻止无效提交，历史本地库存不影响发布', (t) => {
  const f = draftsFixture(t);
  for (const price of ['0', '-1', 'NaN', '1.234', '1e3']) {
    const row = f.manager.save({ ...f.input(), price }); assert.throws(() => f.manager.validate(row), /售价/);
  }
  const empty = f.manager.save({ ...f.input(), images: [] }); assert.throws(() => f.manager.validate(empty), /图片/);
  const stock = f.manager.save({ ...f.input(), stock: 0 }); assert.doesNotThrow(() => f.manager.validate(stock));
  assert.throws(() => f.manager.save({ ...f.input(), description: '文'.repeat(1500) }), /1500/);
  assert.throws(() => f.manager.save({ ...f.input(), images: Array.from({ length: 10 }, () => f.input().images[0]) }), /9 张/);
});

test('本地图片只按受控标识读取，禁止路径穿越和任意远程地址', (t) => {
  const f = draftsFixture(t);
  assert.throws(() => f.manager.asset('../../state'), /标识/);
  for (const url of ['file:///C:/private.png', 'https://127.0.0.1/x.jpg', 'https://alicdn.com.evil.invalid/x.jpg', 'https://user:pass@img.alicdn.com/x.jpg']) {
    assert.throws(() => f.manager.save({ ...f.input(), images: [{ url }] }), /图片地址/);
  }
});

test('修改价格、图片顺序或文案会使已准备的提交指纹失效', (t) => {
  const f = draftsFixture(t), first = f.manager.save({ ...f.input(), images: [
    { url: 'https://img.alicdn.com/a.jpg' }, { url: 'https://img.alicdn.com/b.jpg' },
  ] });
  const hash = f.manager.fingerprint(first);
  assert.notEqual(hash, f.manager.fingerprint({ ...first, price: '29.90' }));
  assert.notEqual(hash, f.manager.fingerprint({ ...first, images: [...first.images].reverse() }));
  assert.notEqual(hash, f.manager.fingerprint({ ...first, description: '不同文案' }));
});

test('提交中断后恢复为待核对，拒绝编辑和删除以避免重复发布', (t) => {
  const f = draftsFixture(t), row = f.manager.save(f.input());
  f.manager.patch(row.id, { status: 'submitting' }); f.store.flush(); f.store.init(f.directory);
  const recovered = f.load('src/main/product-drafts.js').createDraftManager({ store: f.store, directory: f.directory, nativeImage: {} });
  assert.equal(recovered.get(row.id).status, 'uncertain');
  assert.throws(() => recovered.save({ ...f.input(), id: row.id }), /核对/);
  assert.throws(() => recovered.remove(row.id), /核对/);
});

test('平台成功必须含明确 SUCCESS 与商品 ID，填写完成不能冒充发布成功', (t) => {
  const f = fixture(t, { electron: {} }), parse = f.load('src/main/product-service.js').parsePlatformResponse;
  assert.equal(parse('{"ret":["SUCCESS::调用成功"],"data":{"itemId":"123456789012"}}').ok, true);
  assert.equal(parse('mtopjsonp1({"ret":["SUCCESS::调用成功"],"data":{"itemId":"123456789012"}})').itemId, '123456789012');
  assert.equal(parse('{"ok":true,"needImage":true}').uncertain, true);
  assert.equal(parse('{"ret":["SUCCESS::成功"],"data":{}}').uncertain, true);
  const failed = parse('{"ret":["FAIL_BIZ::请补充属性"],"data":{}}');
  assert.equal(failed.ok, false); assert.equal(failed.uncertain, false); assert.match(failed.error, /补充属性/);
});

test('重新上传平台图片时取原文件，保留原始文件名和查询参数', async (t) => {
  const { EventEmitter } = require('events');
  const requested = [];
  const f = fixture(t, { electron: {}, https: { get(url, _options, callback) {
    requested.push(url);
    process.nextTick(() => {
      const response = new EventEmitter(); response.statusCode = 200;
      callback(response); response.emit('data', Buffer.from('original')); response.emit('end');
    });
    return new EventEmitter();
  } } });
  const download = f.load('src/main/product-service.js').downloadImage;
  await download('https://img.alicdn.com/bao/file.png_170x10000.jpg_.webp?version=1');
  await download('https://img.alicdn.com/bao/file.jpg_450x10000.jpg_.webp');
  await download('https://img.alicdn.com/bao/file.webp');
  assert.deepEqual(requested, ['https://img.alicdn.com/bao/file.png?version=1', 'https://img.alicdn.com/bao/file.jpg', 'https://img.alicdn.com/bao/file.webp']);
});

test('同步先预览勾选再导入，未勾选的商品保持不变', async (t) => {
  const electron = fakeElectron(), f = fixture(t, { electron: electron.electron });
  const owner = f.store.addAccount('店铺A'), other = f.store.addAccount('店铺B');
  const service = f.load('src/main/product-service.js').createProductService({ store: f.store, views: new Map(), parent: () => null });
  const view = service.ensureView(owner.id);
  view.webContents.session.cookies.get = async () => [{ name: 'unb', value: '11112222' }];
  const pendingScan = service.scanPreview(owner.id);
  await new Promise((resolve) => setImmediate(resolve));
  const sent = view.webContents.sent.at(-1);
  assert.equal(sent.payload.action, 'scan');
  electron.ipcMain.emit('product:response', { sender: view.webContents, senderFrame: view.webContents.mainFrame },
    { requestId: sent.payload.requestId, ok: true, complete: true, scope: '个人主页公开商品', products: [
      { item_id: '100000001', title: '在售商品', price: '12.00', status: 'on_sale' },
      { item_id: '200000002', title: '已售商品', price: '8.00', status: 'sold' },
    ] });
  const preview = await pendingScan;
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.count, 2); assert.equal(preview.complete, true);
  assert.deepEqual(preview.products.map((p) => p.exists), [false, false]);
  assert.equal(f.store.listProducts(owner.id).length, 0);
  assert.equal(f.store.getAccount(owner.id).seller_uid, null);
  assert.equal((await service.importSelected(other.id, preview.scanId, ['100000001'])).error, '同步预览不存在或已失效，请重新同步');
  assert.equal((await service.importSelected(owner.id, preview.scanId, [])).error, '请先勾选要导入的商品');
  assert.equal((await service.importSelected(owner.id, preview.scanId, ['999000999'])).error, '勾选的商品不在本次同步结果中，请重新同步');
  const imported = await service.importSelected(owner.id, preview.scanId, ['100000001']);
  assert.equal(imported.ok, true, imported.error);
  assert.deepEqual([imported.added, imported.updated], [1, 0]);
  assert.deepEqual([...f.store.listProducts(owner.id)].map((row) => row.item_id), ['100000001']);
  assert.equal(f.store.getAccount(owner.id).seller_uid, '11112222');
  assert.deepEqual(preview.products.map((p) => p.exists), [false, false]);
  const again = await service.importSelected(owner.id, preview.scanId, ['100000001', '200000002']);
  assert.equal(again.ok, true, again.error);
  assert.deepEqual([again.added, again.updated], [1, 1]);
  assert.equal(f.store.listProducts(owner.id).length, 2);
});

test('预览清单过期后拒绝导入，默认全量同步仍一次导入全部', async (t) => {
  const electron = fakeElectron(), f = fixture(t, { electron: electron.electron });
  const owner = f.store.addAccount('店铺');
  const service = f.load('src/main/product-service.js').createProductService({ store: f.store, views: new Map(), parent: () => null, scanTtlMs: 30 });
  const view = service.ensureView(owner.id);
  view.webContents.session.cookies.get = async () => [{ name: 'unb', value: '11112222' }];
  const respond = async (pending, products) => {
    await new Promise((resolve) => setImmediate(resolve));
    const sent = view.webContents.sent.at(-1);
    electron.ipcMain.emit('product:response', { sender: view.webContents, senderFrame: view.webContents.mainFrame },
      { requestId: sent.payload.requestId, ok: true, complete: true, products });
    return pending;
  };
  const preview = await respond(service.scanPreview(owner.id), [
    { item_id: '100000001', title: '在售商品', price: '12.00', status: 'on_sale' },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match((await service.importSelected(owner.id, preview.scanId, ['100000001'])).error, /过期/);
  const synced = await respond(service.sync(owner.id), [
    { item_id: '100000001', title: '在售商品', price: '15.00', status: 'on_sale' },
    { item_id: '200000002', title: '已售商品', price: '8.00', status: 'sold' },
  ]);
  assert.equal(synced.ok, true, synced.error);
  assert.equal(synced.count, 2);
  const rows = f.store.listProducts(owner.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.item_id === '100000001').price, '15.00');
  assert.equal(f.store.getAccount(owner.id).seller_uid, '11112222');
});

test('未读完的空扫描不能预览或覆盖本地商品', async (t) => {
  const electron = fakeElectron(), f = fixture(t, { electron: electron.electron });
  const owner = f.store.addAccount('店铺');
  f.store.upsertProduct(owner.id, { item_id: '100000001', title: '已有商品', price: '12.00', status: 'on_sale' });
  const service = f.load('src/main/product-service.js').createProductService({ store: f.store, views: new Map(), parent: () => null });
  const view = service.ensureView(owner.id);
  view.webContents.session.cookies.get = async () => [{ name: 'unb', value: '11112222' }];
  const pending = service.scanPreview(owner.id);
  await new Promise((resolve) => setImmediate(resolve));
  const { requestId } = view.webContents.sent.at(-1).payload;
  electron.ipcMain.emit('product:response', { sender: view.webContents, senderFrame: view.webContents.mainFrame },
    { requestId, ok: true, complete: false, products: [] });
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.error, /未完成读取/);
  assert.equal(result.scanId, undefined); assert.equal(f.store.listProducts(owner.id).length, 1);
});

test('商品 IPC 按请求 ID、窗口与主框架核对，其他店铺不能伪造同步结果', async (t) => {
  const electron = fakeElectron(), f = fixture(t, { electron: electron.electron });
  const a = f.store.addAccount('A'), b = f.store.addAccount('B');
  const service = f.load('src/main/product-service.js').createProductService({ store: f.store, views: new Map(), parent: () => null });
  const first = service.ensureView(a.id), second = service.ensureView(b.id);
  const promise = service.request(a.id, 'scan'); let done = false; promise.then(() => { done = true; });
  const { requestId } = first.webContents.sent[0].payload;
  electron.ipcMain.emit('product:response', { sender: second.webContents, senderFrame: second.webContents.mainFrame }, { requestId, ok: true });
  electron.ipcMain.emit('product:response', { sender: first.webContents, senderFrame: {} }, { requestId, ok: true });
  await Promise.resolve(); assert.equal(done, false);
  electron.ipcMain.emit('product:response', { sender: first.webContents, senderFrame: first.webContents.mainFrame }, { requestId, ok: true, products: [] });
  assert.equal((await promise).ok, true);
});

test('自动登录重载会重新扫描，提交操作不会因页面重载而重复发送', async (t) => {
  const electron = fakeElectron(), f = fixture(t, { electron: electron.electron });
  const owner = f.store.addAccount('店铺');
  const service = f.load('src/main/product-service.js').createProductService({ store: f.store, views: new Map(), parent: () => null });
  const view = service.ensureView(owner.id);
  const scan = service.request(owner.id, 'scan', { userId: '12345678' });
  view.webContents.emit('did-start-navigation', {}, 'https://www.goofish.com/personal', false, true);
  view.webContents.emit('did-finish-load');
  assert.equal(view.webContents.sent.length, 2);
  const original = view.webContents.sent[0].payload;
  assert.equal(view.webContents.sent[1].payload.requestId, original.requestId);
  electron.ipcMain.emit('product:response', { sender: view.webContents }, { requestId: original.requestId, ok: true, products: [] });
  await scan;
  const submission = service.request(owner.id, 'submit');
  const count = view.webContents.sent.length;
  view.webContents.emit('did-start-navigation', {}, 'https://www.goofish.com/item', false, true);
  view.webContents.emit('did-finish-load');
  assert.equal(view.webContents.sent.length, count);
  assert.equal((await submission).uncertain, true);
});

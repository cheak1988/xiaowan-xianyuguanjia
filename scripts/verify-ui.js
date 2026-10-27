'use strict';

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status === 0 ? 0 : 1);
}

const { app, BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert').strict;
const root = path.join(__dirname, '..');
const source = process.argv.includes('--packed') ? path.join(root, require('../package.json').build.directories.output, 'win-unpacked/resources/app.asar') : root;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-ui-check-'));
const output = path.join(root, '_bench', 'semi-ui');
fs.mkdirSync(output, { recursive: true });
app.setPath('appData', temporary);
app.setPath('userData', path.join(temporary, 'OpenFish'));
BrowserWindow.prototype.show = function () {};
BrowserWindow.prototype.focus = function () {};
const setTitleBarOverlay = BrowserWindow.prototype.setTitleBarOverlay;
BrowserWindow.prototype.setTitleBarOverlay = function (options) {
  this.uiTitleBarOverlay = options;
  return setTitleBarOverlay.call(this, options);
};
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
app.commandLine.appendSwitch('disable-gpu');
let checked = false;
const errors = [];
const screenshots = [];
let checks = 0;
const pause = (milliseconds = 160) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const proxyCalls=[]; const proxyServer=require('http').createServer(async (request,response)=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);proxyCalls.push({url:request.url,authorization:request.headers.authorization,body:JSON.parse(Buffer.concat(chunks))});response.setHeader('Content-Type','application/json');response.end(JSON.stringify({model:'fixture',choices:[{message:{content:'连接成功'}}]}));});
const proxyReady=new Promise(resolve=>proxyServer.listen(0,'127.0.0.1',resolve));
const timeout = setTimeout(() => { console.error('UI verification timed out'); app.exit(1); }, 55000);

function seed(store) {
  const first = store.addAccount('小丸数码店');
  const second = store.addAccount('小丸资料铺');
  const third = store.addAccount('小丸生活馆');
  const fourth = store.addAccount('备用测试店');
  store.updateAccount(first.id, { xy_user_id: 'xiaowan_digital', remark: '数码配件 · 日常接待', group_id: 1 });
  store.updateAccount(second.id, { xy_user_id: 'xiaowan_studio', remark: '学习资料 · 自动发货', group_id: 2 });
  store.updateAccount(third.id, { remark: '生活好物 · 待扫码登录', group_id: 1 });
  store.updateAccount(fourth.id, { disabled: true, remark: '暂时停用，保留登录资料' });
  store.saveShopGroup({ name: '日常经营' }); store.saveShopGroup({ name: '虚拟商品' });
  store.addStaff('小丸 · 管理员'); store.addStaff('小橙 · 客服'); store.setCurrentStaffId(1);
  const titles = ['轻量办公表格模板合集', 'Type-C 编织充电线 1.5m', '学习计划与时间管理模板', '桌面收纳盒 · 奶白色',
    '便携手机支架 · 可折叠', '读书笔记电子模板', '磨砂笔记本保护壳', '文件整理标签套装'];
  for (let index = 0; index < titles.length; index++) {
    const accountId = index % 3 + 1;
    store.upsertProduct(accountId, { item_id: 'DEMO-ITEM-' + index, title: titles[index],
      price: [19.9, 25, 12.9, 39, 16.8, 9.9, 49, 8.8][index], stock: 30 - index * 2,
      status: index === 5 ? 'sold' : index === 7 ? 'off' : 'on_sale' });
    const order = store.upsertOrder(accountId, { order_no: 'DEMO202610260' + String(index + 1).padStart(3, '0'),
      item_id: 'DEMO-ITEM-' + index, item_title: titles[index], buyer_nick: ['橙子汽水', '慢慢来', '今天也很开心', '小岛日记', '风吹麦浪', '海盐苏打', '不晚', '云间'][index],
      amount: [19.9, 25, 12.9, 39, 16.8, 9.9, 49, 8.8][index],
      status: ['待发货', '待发货', '已发货', '已发货', '交易完成', '待发货', '已发货', '已关闭'][index] });
    order.created_ts = Date.now() - index * 3600 * 1000;
    order.updated_at = order.created_ts;
    if (index === 1) store.ready().deliveries.push({ account_id: accountId, order_no: order.order_no,
      status: 'uncertain', reason: '演示：发送结果需要人工核对' });
  }
  for (let index = 0; index < 6; index++) {
    const customer = store.upsertCustomer(index % 3 + 1, { buyer_uid: 'DEMO-BUYER-' + index,
      nick: ['橙子汽水', '慢慢来', '今天也很开心', '小岛日记', '风吹麦浪', '海盐苏打'][index] });
    store.updateCustomer(customer.id, { remark: index % 2 ? '偏好电子资料，工作日联系' : '回购客户，沟通顺畅',
      tags: index % 2 ? ['电子资料'] : ['回购客户'], blacklisted: false });
  }
  store.saveRule({ accountId: first.id, name: '发货时间', keywords: ['多久发货', '什么时候发'], content: '您好，确认订单后会尽快安排，具体进度我帮您查看。' });
  store.saveRule({ accountId: first.id, name: '商品咨询', keywords: ['在吗', '还在吗'], content: '在的，商品还在，想了解哪方面呢？' });
  store.updateSettings({ autoReply: { enabled: false } });
  store.persist();
}

app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false);
  // Every test session is offline. No real site, account or transaction is contacted.
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  contents.on('preload-error', (_e, file, error) => errors.push(file + ': ' + error.message));
  contents.on('console-message', (_e, level, message) => {
    if (level >= 3 && contents.getURL().includes('/shell/')) errors.push(message);
  });
  contents.on('did-finish-load', async () => {
    if (checked || !contents.getURL().endsWith('/shell/index.html')) return;
    checked = true;
    const win = BrowserWindow.fromWebContents(contents);
    const evaluate = (code) => contents.executeJavaScript(code);
    async function capture(name, target = win) {
      await target.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await pause(120);
      fs.writeFileSync(path.join(output, name + '.png'), (await target.capturePage()).toPNG());
      screenshots.push(name + '.png');
    }
    try {
      await pause(200);
      await evaluate(`document.querySelector('.breadcrumb').insertAdjacentHTML('beforeend', '<span class="ui-demo-note" style="font-size:10px;color:#6b7075;margin-left:12px">演示数据 · 本地界面验收</span>')`);
      await capture('chat-empty');
      const store = require(path.join(source, 'src/main/store')); seed(store);
      await evaluate(`(async()=>{settings=await window.api.settings.get();statuses={1:{loggedIn:true},2:{loggedIn:true},3:{loggedIn:false}};await loadStaff();await renderAccounts(await window.api.accounts.list());await switchView('shops');})()`);
      assert.equal(await evaluate('document.querySelectorAll("#shop-list tbody tr[data-key]").length'), 4); checks++;
      await capture('shops');
      await evaluate('document.querySelector("[data-shop-status=online]").click()'); await pause();
      assert.equal(await evaluate('document.querySelectorAll("#shop-list tbody tr[data-key]").length'), 2); checks++;
      await evaluate('document.querySelectorAll("[data-shop-status]")[0].click()'); await pause();
      await evaluate('document.querySelector("#shop-list [data-row-act=more]").click()'); await pause();
      assert.equal(await evaluate('document.querySelectorAll(".action-menu [role=menuitem]").length'), 3); checks++;
      await capture('shop-menu');
      await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true}))');
      assert.equal(await evaluate('document.querySelector(".action-menu")'), null); checks++;
      await evaluate('document.querySelector("#shop-list [data-role=check]").click()');
      const selection = await evaluate(`(()=>{let count=-1;const actions=shopTable.opt.batchActions;shopTable.opt.batchActions=[{label:'验收选中行',onClick:rows=>{count=rows.length}}];shopTable._renderBatch();document.querySelector('#shop-list [data-batch="0"]').click();shopTable.opt.batchActions=actions;return count;})()`);
      assert.equal(selection, 1, 'Selected table row must be available to batch actions'); checks++;
      await evaluate('document.querySelector("#shop-list [data-role=check-all]").click()');
      assert.equal(await evaluate('shopTable.selected.size'), 4); checks++;
      await evaluate('shopTable.selected.clear();shopTable._renderBody();shopTable._renderBatch()');
      await evaluate('document.querySelector("#shop-list [data-row-act=more]").click();document.querySelector(".action-menu button").click()');
      await pause(250);
      const popup = BrowserWindow.getAllWindows().find((candidate) => candidate.id !== win.id);
      assert.ok(popup, 'Shop editing opens a native dialog'); checks++;
      await capture('shop-dialog', popup);
      const dialogLayout = await popup.webContents.executeJavaScript('({last:document.querySelector(".field:last-child").getBoundingClientRect().bottom,foot:document.querySelector("#foot").getBoundingClientRect().top,scroll:document.querySelector("#body").scrollHeight})');
      assert.ok(dialogLayout.foot > 130); checks++;
      await popup.webContents.executeJavaScript('document.querySelector("#btn-cancel").click()');
      await evaluate("switchView('orders')"); await capture('orders');
      await evaluate('document.querySelector("[data-order-status=uncertain]").click()'); await pause();
      assert.equal(await evaluate('document.querySelectorAll("#order-list tbody tr[data-key]").length'), 1); checks++;
      await evaluate('document.querySelectorAll("[data-order-status]")[0].click()'); await pause();
      await evaluate('document.querySelector("#order-list [data-row-act=more]").click()');
      assert.equal(await evaluate('document.querySelectorAll(".action-menu [role=menuitem]").length'), 4); checks++;
      await evaluate("switchView('products')"); await capture('products');
      assert.equal(await evaluate('document.querySelector("#nav .on").dataset.view'), 'products'); checks++;
      assert.equal(await evaluate('document.querySelector(".action-menu")'), null); checks++;
      await evaluate("switchView('customers')"); await capture('customers');
      await evaluate("switchView('tasks')"); await pause(); await capture('tasks');
      await evaluate("switchView('stats')"); await capture('stats');
      const chartFits = await evaluate('Array.from(document.querySelectorAll(".chart-card canvas")).every(canvas=>canvas.getBoundingClientRect().right<=canvas.parentElement.getBoundingClientRect().right)');
      assert.equal(chartFits, true); checks++;
      await evaluate("currentAccountId=1;switchView('settings')"); await pause(); await capture('settings');
      await evaluate("switchSettingsTab('ai')"); await proxyReady;
      await evaluate(`document.querySelector('#stab-ai #ai-enabled').checked=true;document.querySelector('#stab-ai #ai-base').value='http://127.0.0.1:${proxyServer.address().port}/v1';document.querySelector('#stab-ai #ai-model').value='deepseek-v4.1-flash';document.querySelector('#stab-ai #ai-key').value='fixture-private-key';document.querySelector('#stab-ai #ai-test').click()`);
      for(let i=0;i<60&&!await evaluate(`document.querySelector('#stab-ai #ai-test-result').textContent.includes('成功')`);i++) await pause(100);
      assert.match(await evaluate(`document.querySelector('#stab-ai #ai-test-result').textContent`),/成功/);assert.equal(proxyCalls[0].body.model,'deepseek-v4.1-flash');assert.equal(proxyCalls[0].authorization,'Bearer fixture-private-key');assert.equal(store.getSettings().ai.enabled,false);assert.equal(store.getAiKey(),'');assert.equal(await evaluate(`document.querySelector('#stab-ai #ai-key').value`),'fixture-private-key');checks++;
      await capture('settings-ai');

      for (const tab of ['quick', 'delivery', 'actions', 'notify', 'staff']) {
        await evaluate(`switchSettingsTab('${tab}')`); await capture('settings-' + tab);
      }
      await evaluate("currentAccountId=null;applyTheme('dark');switchView('orders')"); await capture('orders-dark');
      assert.equal(await evaluate('document.body.getAttribute("theme-mode")'), 'dark'); checks++;
      if (process.platform === 'win32') {
        assert.equal(win.uiTitleBarOverlay.symbolColor, '#f9f9f9'); checks++;
      }
      await evaluate("applyTheme('blue');switchView('shops')");
      win.setSize(1280, 720); await pause(); await capture('shops-1280');
      const pageFits = await evaluate('document.querySelector("#view-shops").scrollWidth<=document.querySelector("#view-shops").clientWidth');
      assert.equal(pageFits, true); checks++;
      win.setSize(1500, 900);
      await evaluate("(async()=>{await switchView('chat');await selectAccount(1);})()");
      await pause();
      const view = win.getBrowserViews()[0];
      const toolbar = await evaluate('document.querySelector(".chat-toolbar").getBoundingClientRect().bottom');
      assert.equal(view.getBounds().y, toolbar); checks++;
      await evaluate('document.querySelector("#btn-panel").click()'); await pause();
      await evaluate(`switchTab('ai');document.querySelector('#tab-ai #ai-enabled').checked=true;document.querySelector('#tab-ai #ai-base').value='http://127.0.0.1:${proxyServer.address().port}/v1';document.querySelector('#tab-ai #ai-model').value='deepseek-v4.1-flash';document.querySelector('#tab-ai #ai-key').value='fixture-panel-key';document.querySelector('#tab-ai #ai-test').click()`);
      for(let i=0;i<60&&!await evaluate(`document.querySelector('#tab-ai #ai-test-result').textContent.includes('成功')`);i++) await pause(100);
      assert.match(await evaluate(`document.querySelector('#tab-ai #ai-test-result').textContent`),/成功/);assert.equal(proxyCalls[1].authorization,'Bearer fixture-panel-key');assert.equal(store.getSettings().ai.enabled,false);checks++;await capture('panel-ai-test');
      const panelLeft = await evaluate('document.querySelector("#panel").getBoundingClientRect().left');
      assert.equal(view.getBounds().x + view.getBounds().width, panelLeft); checks++;
      await evaluate("switchView('shops')");
      assert.equal(win.getBrowserViews().length, 0, 'Official chat must be detached on management pages'); checks++;
      assert.deepEqual(errors, []); checks++;
      fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ status: 'PASS', checks, screenshots, errors,
        scope: 'offline fixture profile; no real accounts, messages or transactions' }, null, 2));
      console.log(JSON.stringify({ status: 'PASS', checks, screenshots, errors }));
      proxyServer.close(); clearTimeout(timeout); app.isQuitting = true; app.quit();
    } catch (error) {
      console.error(error.stack);
      console.error(JSON.stringify({ checks, errors, screenshots }));
      proxyServer.close(); clearTimeout(timeout); app.exit(1);
    }
  });
});
require(path.join(source, 'src/main/index.js'));

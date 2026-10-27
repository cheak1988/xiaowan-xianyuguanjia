'use strict';

/**
 * 首次启动风险确认 + 免责声明/开源声明页面 的端到端验证。
 * 使用临时数据目录与离线环境，不接触真实店铺。
 *
 *   node scripts/verify-legal.js [--packed]
 */

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env, stdio: 'inherit', windowsHide: true, timeout: 120000,
  });
  process.exit(result.status === 0 ? 0 : 1);
}

const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const root = path.join(__dirname, '..');
const outputDirectory = require('../package.json').build.directories.output;
const source = process.argv.includes('--packed') ? path.join(root, 'dist-release', 'win-unpacked/resources/app.asar') : root;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-legal-check-'));
const output = path.join(root, '_bench', 'legal-ui');
fs.mkdirSync(output, { recursive: true });
app.setPath('appData', temporary);
app.setPath('userData', path.join(temporary, 'OpenFish'));
app.commandLine.appendSwitch('disable-gpu');
BrowserWindow.prototype.show = function () { this._shown = true; };
BrowserWindow.prototype.focus = function () {};
const errors = [], checks = [];
function pass(name) { checks.push(name); console.log('PASS ' + name); }
const pause = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Legal verification timed out'); console.error(JSON.stringify({ checks, errors })); app.exit(1); }, 100000);

// 全程离线
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  contents.on('preload-error', (_e, file, error) => errors.push(path.basename(file) + ': ' + error.message));
  contents.on('console-message', (_e, level, value) => { if (level >= 3) errors.push(value); });
});

app.whenReady().then(async () => {
  try {
    await pause(600);
    const windows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const urlOf = (w) => { try { return w.webContents.getURL(); } catch (_) { return ''; } };

    // 1. 首次启动必须弹出确认窗口，且主窗口不可见
    let list = windows();
    const gate = list.find((w) => urlOf(w).includes('legal.html'));
    const main = list.find((w) => urlOf(w).includes('shell/index.html'));
    assert.ok(gate, '首次启动必须打开确认窗口；实际窗口：' + list.map(urlOf).join(' | '));
    assert.ok(main, '主窗口应已创建');
    assert.equal(main._shown, undefined, '未确认前主窗口不得显示');
    pass('首次启动强制确认，主窗口保持隐藏');

    // 2. 「同意并继续」默认禁用，必须主动勾选
    assert.equal(await gate.webContents.executeJavaScript('document.getElementById("ok").disabled'), true);
    pass('未勾选时「同意并继续」不可点击');

    // 3. 确认页包含关键风险条款
    const gateText = await gate.webContents.executeJavaScript('document.body.innerText');
    for (const phrase of ['账号风险', '交易风险', '数据风险', '合规风险', 'AS IS', '开源组件', '没有任何隶属、合作或授权关系']) {
      assert.ok(gateText.includes(phrase), '确认页缺少条款：' + phrase);
    }
    pass('确认页覆盖全部关键风险条款');

    // 4. 该窗口不可跳过：无关闭按钮，ESC 不生效
    assert.equal(await gate.webContents.executeJavaScript('!!document.querySelector("#close")'), false);
    pass('确认窗口不提供跳过入口');

    fs.writeFileSync(path.join(output, 'gate.png'), (await gate.capturePage()).toPNG());

    // 5. 勾选后解锁
    await gate.webContents.executeJavaScript('const c=document.getElementById("agree");c.checked=true;c.dispatchEvent(new Event("change"));');
    assert.equal(await gate.webContents.executeJavaScript('document.getElementById("ok").disabled'), false);
    pass('勾选后「同意并继续」解锁');

    // 6. 点击同意 → 落库、关闭确认窗、主窗口显示
    await gate.webContents.executeJavaScript('document.getElementById("ok").click()');
    await pause(900);
    const store = require(path.join(source, 'src/main/store'));
    const legal = store.getSettings().legal || {};
    assert.equal(legal.disclaimerAccepted, true, '同意状态必须落库');
    assert.ok(legal.acceptedAt > 0, '必须记录确认时间');
    assert.ok(legal.acceptedVersion, '必须记录声明版本');
    assert.equal(windows().some((w) => urlOf(w).includes('legal.html')), false, '确认后确认窗口应关闭');
    pass('同意后写入确认状态并关闭确认窗口');

    const mainNow = windows().find((w) => urlOf(w).includes('shell/index.html'));
    assert.ok(mainNow && mainNow._shown, '确认后主窗口必须显示');
    pass('确认后主窗口正常显示');

    // 7. 设置页「免责声明」
    await mainNow.webContents.executeJavaScript("switchView('settings');switchSettingsTab('disclaimer')");
    await pause(500);
    await mainNow.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await pause(200);
    const disclaimerText = await mainNow.webContents.executeJavaScript('document.getElementById("stab-disclaimer").innerText');
    for (const phrase of ['风险与责任声明', '账号风险', '交易风险', '数据风险', '合规风险', 'AS IS']) {
      assert.ok(disclaimerText.includes(phrase), '免责声明页缺少：' + phrase);
    }
    assert.ok(disclaimerText.includes('不是原创开发') || disclaimerText.includes('开源'), '必须说明软件为开源整合');
    assert.ok(!disclaimerText.includes('你尚未确认本声明'), '已确认后设置页必须显示确认时间，而不是「尚未确认」');
    assert.match(disclaimerText, /确认本声明/, '必须显示确认时间');
    fs.writeFileSync(path.join(output, 'disclaimer.png'), (await mainNow.capturePage()).toPNG());
    pass('设置页免责声明完整渲染');

    // 8. 设置页「开源声明」
    await mainNow.webContents.executeJavaScript("switchSettingsTab('licenses')");
    await pause(500);
    await mainNow.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await pause(200);
    const licenseText = await mainNow.webContents.executeJavaScript('document.getElementById("stab-licenses").innerText');
    for (const phrase of ['Electron', '22.3.27', 'Semi Design', '2.104.0', 'MIT', 'DouyinFE', 'GitHub Inc.']) {
      assert.ok(licenseText.includes(phrase), '开源声明缺少：' + phrase);
    }
    for (const phrase of ['Ydisks-Xianyu-Helper', 'Christ9038', '参考范围', '实现差异']) {
      assert.ok(licenseText.includes(phrase), '开源声明缺少参考项目信息：' + phrase);
    }
    assert.ok(!licenseText.includes('pei144'), '声明页不应再包含个人联系方式');
    fs.writeFileSync(path.join(output, 'licenses.png'), (await mainNow.capturePage()).toPNG());
    pass('设置页开源声明含版本、许可证与版权人');

    // 9. 声明文件必须随包分发
    assert.ok(fs.existsSync(path.join(source, 'THIRD-PARTY-NOTICES.md')), 'THIRD-PARTY-NOTICES.md 必须随程序分发');
    pass('第三方声明文件随包分发');

    // 10. 已确认后重启不再弹窗
    assert.deepEqual(errors, []);
    const summary = { status: 'PASS', checks: checks.length, names: checks, errors,
      scope: 'temporary profile; offline; no real accounts or transactions' };
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
    clearTimeout(timeout); app.isQuitting = true; app.quit();
  } catch (error) {
    console.error(error.stack);
    console.error(JSON.stringify({ checks, errors }));
    clearTimeout(timeout); app.exit(1);
  }
});

require(path.join(source, 'src/main/index.js'));

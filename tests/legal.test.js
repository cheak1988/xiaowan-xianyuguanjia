'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, fakeElectron } = require('./helpers');

function legalFixture(t) {
  const electron = fakeElectron();
  const f = fixture(t, { electron: electron.electron, app: { getVersion: () => '1.0.0' } });
  const legal = f.load('src/main/legal-window.js');
  return { f, electron, legal };
}

test('首次启动未确认：不视为已同意，且不同版本号需要重新确认', (t) => {
  const { f, legal } = legalFixture(t);
  assert.equal(legal.alreadyAccepted(f.store), false, '默认必须视为未确认');

  f.store.updateSettings({ legal: { disclaimerAccepted: true, acceptedVersion: legal.DISCLAIMER_VERSION } });
  assert.equal(legal.alreadyAccepted(f.store), true);

  // 声明内容升级（版本号变化）后必须重新确认，避免旧同意覆盖新条款
  f.store.updateSettings({ legal: { disclaimerAccepted: true, acceptedVersion: 'old-version' } });
  assert.equal(legal.alreadyAccepted(f.store), false);

  // 只有 accepted 标记但版本为空也不放行
  f.store.updateSettings({ legal: { disclaimerAccepted: true, acceptedVersion: '' } });
  assert.equal(legal.alreadyAccepted(f.store), false);
});

test('确认后写入版本与时间并持久化，重启后不再要求确认', (t) => {
  const { f, legal } = legalFixture(t);
  const before = Date.now();
  f.store.updateSettings({ legal: { disclaimerAccepted: true, acceptedAt: before, acceptedVersion: legal.DISCLAIMER_VERSION } });
  f.store.persist();
  f.store.init(f.directory);
  const saved = f.store.getSettings().legal;
  assert.equal(saved.disclaimerAccepted, true);
  assert.equal(saved.acceptedVersion, legal.DISCLAIMER_VERSION);
  assert.ok(saved.acceptedAt >= before);
  assert.equal(legal.alreadyAccepted(f.store), true);
});

test('未同意时用户选择退出，不会把同意状态写进存储', (t) => {
  const { f, legal } = legalFixture(t);
  assert.equal(legal.alreadyAccepted(f.store), false);
  assert.equal(legal.isOpen(), false, '未打开窗口时不应报告为打开');
  // 模拟用户点「退出程序」：仅关闭窗口，不写入任何 legal 设置
  legal.forceClose();
  assert.equal(f.store.getSettings().legal.disclaimerAccepted, false);
  assert.equal(legal.alreadyAccepted(f.store), false);
});

test('声明版本号是稳定标识，用于判断是否需要重新确认', (t) => {
  const { legal } = legalFixture(t);
  assert.match(legal.DISCLAIMER_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});

test('开源声明覆盖运行时实际使用的组件，并标注许可证与版权', (t) => {
  const f = fixture(t, { electron: {} });
  const notices = require('fs').readFileSync(require('path').join(__dirname, '..', 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.match(notices, /Electron/, '必须声明 Electron');
  assert.match(notices, /22\.3\.27/, '必须写明 Electron 版本');
  assert.match(notices, /Semi Design/, '必须声明 Semi Design');
  assert.match(notices, /2\.104\.0/, '必须写明 Semi 版本');
  assert.match(notices, /MIT/, '必须写明许可证类型');
  assert.match(notices, /DouyinFE/, '必须保留 Semi 版权人');
  assert.match(notices, /GitHub Inc\./, '必须保留 Electron 版权人');
  assert.match(notices, /没有任何隶属、合作或授权关系/, '必须有商标与平台关系澄清');
  assert.match(notices, /权利主张/, '必须提供权利主张渠道');
  assert.match(notices, /Ydisks-Xianyu-Helper/, '必须标注参考的开源项目');
  assert.match(notices, /Christ9038/, '参考项目必须给出可核实的地址');
  assert.match(notices, /未直接复制其源代码/, '必须说明参考范围与实现差异');
  // 打包配置必须把声明文件一起分发
  const pkg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('THIRD-PARTY-NOTICES.md'), '声明文件必须随包分发');
});

test('免责声明覆盖关键风险点，首次确认页与设置页内容一致', (t) => {
  const fs = require('fs'), path = require('path');
  const gate = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell', 'legal.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'shell', 'renderer.js'), 'utf8');
  for (const phrase of ['账号风险', '交易风险', '数据风险', '合规风险', 'AS IS', '开源组件']) {
    assert.match(gate, new RegExp(phrase), `确认页必须说明：${phrase}`);
    assert.match(renderer, new RegExp(phrase), `设置页免责声明必须说明：${phrase}`);
  }
  // 首次确认页必须提供「退出程序」出口，不能强制同意
  assert.match(gate, /退出程序/);
  // 确认按钮必须默认禁用，需要主动勾选
  assert.match(gate, /class="primary" disabled/);
});

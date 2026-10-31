'use strict';

/**
 * 数据备份导出 / 导入
 *
 * 导出内容：state.json + 消息分片 + 图片素材目录
 *   - 打包成 zip 需要依赖，这里改用「目录复制」+ 说明文件，
 *     零依赖，用户拿到一个文件夹就能拷走。
 *
 * 安全边界：
 *   - 不导出账号的 cookie / 登录态（在 Partition 目录里，单独存在，不随备份走）
 *   - 备份不包含登录态；导入后账号停用，需要重新核对并登录
 *   - 导入前自动把现有数据备份到 backups/ 目录
 */

const fs = require('fs');
const path = require('path');
const { validState } = require('./store');

const INCLUDE_DIRS = ['messages', 'product-images', 'assets'];
const INCLUDE_FILES = ['state.json'];

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyDir(src, dest);
    else if (entry.isFile()) { fs.copyFileSync(src, dest); count += 1; }
  }
  return count;
}

/**
 * 导出到指定目录。
 * @returns {{ok:boolean, path?:string, files?:number, error?:string}}
 */
function exportBackup(userDataPath, targetDir) {
  try {
    for (const name of INCLUDE_DIRS) {
      const relative = path.relative(path.resolve(userDataPath, name), path.resolve(targetDir));
      if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('备份保存位置不能放在聊天记录或素材目录内');
      }
    }
    fs.mkdirSync(targetDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(targetDir, `OpenFish-Backup-${stamp()}-`));
    let files = 0;
    for (const name of INCLUDE_FILES) {
      const src = path.join(userDataPath, name);
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, name)); files += 1; }
    }
    for (const name of INCLUDE_DIRS) {
      files += copyDir(path.join(userDataPath, name), path.join(dir, name));
    }
    fs.writeFileSync(path.join(dir, 'README.txt'), [
      '小丸闲鱼管家 数据备份',
      `导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      '',
      '包含：',
      '  state.json  账号以外的全部业务数据（店铺、规则、卡密、订单、客户、设置）',
      '  messages/   聊天记录（按店铺、按月分片）',
      '  product-images/  图片卡密与商品图片素材',
      '  assets/     兼容旧版素材（如有）',
      '',
      '不包含：账号登录态（cookie）。导入后的店铺会先停用，请核对官方登录账号后再启用。',
      '',
      '恢复方法：软件内「设置 → 数据备份 → 导入备份」，选择这个文件夹。',
    ].join('\r\n'), 'utf8');
    return { ok: true, path: dir, files };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 从备份目录导入。
 * 导入前把当前数据先备份到 <userData>/backups/pre-import-<stamp>。
 */
function importBackup(userDataPath, sourceDir) {
  const moved = [], installed = [];
  let preDir, stage;
  const owned = (name) => {
    const target = path.resolve(userDataPath, name);
    if (path.dirname(target) !== path.resolve(userDataPath)) throw new Error('备份目标路径无效');
    return target;
  };
  try {
    const stateFile = path.join(sourceDir, 'state.json');
    if (!fs.existsSync(stateFile)) {
      return { ok: false, error: '这不是有效的备份目录：缺少 state.json' };
    }
    // 校验 state.json 结构，避免导入一个坏文件把现有数据毁掉
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (_) { return { ok: false, error: '备份中的 state.json 已损坏，无法解析' }; }
    if (!validState(parsed)) {
      return { ok: false, error: '备份中的 state.json 结构不正确（缺少 accounts）' };
    }

    // 先完整复制备份到暂存目录，复制失败时当前数据完全不动。
    const backups = path.join(userDataPath, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    preDir = fs.mkdtempSync(path.join(backups, `pre-import-${stamp()}-`));
    stage = path.join(preDir, '.incoming');
    fs.mkdirSync(stage);
    // 避免备份中的数字账号 ID 复用本机其它账号的登录分区。
    parsed.accounts = parsed.accounts.map((account) => ({ ...account, disabled: true }));
    fs.writeFileSync(path.join(stage, 'state.json'), JSON.stringify(parsed));
    fs.copyFileSync(path.join(stage, 'state.json'), path.join(stage, 'state.json.bak'));
    let files = 1;
    for (const name of INCLUDE_DIRS) {
      files += copyDir(path.join(sourceDir, name), path.join(stage, name));
    }

    // 同卷移动旧数据形成保护副本；安装失败时逐项回滚。
    for (const name of ['state.json', 'state.json.bak', ...INCLUDE_DIRS]) {
      const target = owned(name);
      if (fs.existsSync(target)) {
        fs.renameSync(target, path.join(preDir, name));
        moved.push(name);
      }
      const from = path.join(stage, name);
      if (fs.existsSync(from)) {
        fs.renameSync(from, target);
        installed.push(name);
      }
    }
    fs.rmdirSync(stage);
    return { ok: true, files, backup: preDir, accountIds: parsed.accounts.map((account) => Number(account.id)) };
  } catch (error) {
    try {
      for (const name of installed.reverse()) fs.rmSync(owned(name), { recursive: true, force: true });
      for (const name of moved.reverse()) fs.renameSync(path.join(preDir, name), owned(name));
    } catch (rollbackError) {
      return { ok: false, uncertain: true, backup: preDir,
        error: `导入未完成，请停止使用并从保护副本恢复：${preDir}（${rollbackError.message}）` };
    }
    return { ok: false, error: error.message };
  }
}

/** 列出已有的自动备份 */
function listBackups(userDataPath) {
  const dir = path.join(userDataPath, 'backups');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const full = path.join(dir, entry.name);
        const stat = fs.statSync(full);
        return { name: entry.name, path: full, at: stat.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  } catch (_) { return []; }
}

module.exports = { exportBackup, importBackup, listBackups };

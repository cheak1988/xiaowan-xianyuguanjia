'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const invalidFiles = new Set();

function readJson(file, fallback, validate = () => true) {
  let primaryError;
  for (const candidate of [file, file + '.bak']) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (!validate(value)) throw new Error('数据结构不正确');
      if (candidate !== file) console.warn('[storage] 已从备份恢复：', file);
      return value;
    } catch (error) {
      if (candidate === file) {
        primaryError = error;
        if (error.code !== 'ENOENT') invalidFiles.add(file);
      }
      else if (primaryError.code === 'ENOENT' && error.code === 'ENOENT') {
        return typeof fallback === 'function' ? fallback() : fallback;
      }
    }
  }
  throw new Error(`数据文件及备份无法读取，已停止写入以保留原文件：${file}（${primaryError.message}）`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const suffix = `.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const temporary = file + suffix;
  const backupTemporary = file + '.bak' + suffix;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // 只用完整、可解析的旧文件更新备份，避免损坏文件覆盖可恢复副本。
    let old;
    try {
      old = invalidFiles.has(file) ? null : fs.readFileSync(file, 'utf8');
      if (old !== null) JSON.parse(old);
    } catch (error) {
      if (error.code && error.code !== 'ENOENT') throw error;
      old = null;
    }
    if (old !== null) {
      fs.writeFileSync(backupTemporary, old, { mode: 0o600 });
      fs.renameSync(backupTemporary, file + '.bak');
    }
    fs.renameSync(temporary, file);
    invalidFiles.delete(file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    for (const candidate of [temporary, backupTemporary]) {
      try { fs.unlinkSync(candidate); } catch (_) { /* 已重命名或尚未创建 */ }
    }
  }
}

module.exports = { readJson, writeJson };

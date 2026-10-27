'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('./atomic-json');
const { normalizeOptions, validateSku } = require('./product-options');

const MAX_IMAGES = 9;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function remoteImage(value) {
  try {
    const url = new URL(String(value).startsWith('//') ? 'https:' + value : value);
    if (url.protocol !== 'https:' || url.username || url.password || !['alicdn.com', 'goofish.com', 'taobaocdn.com'].some((host) =>
      url.hostname === host || url.hostname.endsWith('.' + host))) return '';
    return url.href;
  } catch (_) { return ''; }
}

function createDraftManager({ store, directory, nativeImage }) {
  const mediaDirectory = path.join(directory, 'product-images');
  fs.mkdirSync(mediaDirectory, { recursive: true });
  const rows = () => {
    const state = store.ready();
    if (!Array.isArray(state.productDrafts)) state.productDrafts = [];
    return state.productDrafts;
  };
  const account = (id) => {
    const result = store.getAccount(Number(id));
    if (!result) throw new Error('店铺不存在');
    return result;
  };
  const get = (id) => {
    const row = rows().find((entry) => entry.id === String(id));
    if (!row) throw new Error('商品草稿不存在');
    account(row.account_id); return row;
  };
  function asset(id) {
    if (!ASSET_ID.test(String(id))) throw new Error('图片标识无效');
    const meta = readJson(path.join(mediaDirectory, id + '.json'), () => null, (value) =>
      value && value.id === id && ['jpg', 'png', 'webp'].includes(value.extension));
    if (!meta) throw new Error('图片已丢失，请重新选择');
    const file = path.join(mediaDirectory, id + '.' + meta.extension);
    const resolved = fs.realpathSync(file);
    if (path.dirname(resolved).toLowerCase() !== fs.realpathSync(mediaDirectory).toLowerCase()) throw new Error('图片路径无效');
    return { ...meta, file: resolved };
  }
  function describe(image) {
    if (image.assetId) {
      try {
        const item = asset(image.assetId);
        const preview = nativeImage.createFromPath(item.file).resize({ width: 600 }).toJPEG(80);
        const { file, ...meta } = item;
        return { ...meta, assetId: item.id, preview: 'data:image/jpeg;base64,' + preview.toString('base64') };
      } catch (_) { return { assetId: image.assetId, missing: true, name: '图片文件丢失' }; }
    }
    return { url: image.url, preview: image.url, name: '闲鱼商品图片' };
  }
  function present(row) { return { ...row, images: row.images.map(describe) }; }
  function importFiles(files, { maximum = MAX_IMAGES } = {}) {
    if (!Array.isArray(files) || files.length > maximum) throw new Error('一次最多选择 ' + maximum + ' 张图片');
    const imported = [];
    for (const file of files) {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES || stat.size === 0) throw new Error('图片不能为空，且每张不能超过 5 MB');
      const buffer = fs.readFileSync(file);
      const extension = buffer[0] === 0xff && buffer[1] === 0xd8 ? 'jpg'
        : buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
          : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : '';
      if (!extension) throw new Error('请选择 JPG、PNG 或 WebP 图片');
      const bitmap = nativeImage.createFromBuffer(buffer);
      const { width, height } = bitmap.getSize();
      if (bitmap.isEmpty() || !width || !height || width > 20000 || height > 20000) throw new Error('图片无法读取或尺寸过大');
      const id = crypto.randomUUID();
      fs.writeFileSync(path.join(mediaDirectory, id + '.' + extension), buffer, { flag: 'wx' });
      writeJson(path.join(mediaDirectory, id + '.json'), { id, extension, name: path.basename(file), size: stat.size, width, height, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
      imported.push(describe({ assetId: id }));
    }
    return imported;
  }
  function save(input) {
    const owner = account(input.account_id ?? input.accountId);
    const existing = input.id ? get(input.id) : null;
    if (existing && existing.account_id !== owner.id) throw new Error('草稿不能改到其他店铺，请新建草稿');
    if (existing && ['preparing', 'submitting', 'uncertain', 'published'].includes(existing.status)) throw new Error('请等待当前操作或先核对发布结果；已发布商品请从列表重新编辑');
    const title = String(input.title || '').trim();
    const description = String(input.description || '').trim();
    if (title.length > 60 || [title, description].filter(Boolean).join('\n\n').length > 1500) throw new Error('标题最多 60 字，标题和描述合计最多 1500 字');
    const images = (input.images || []).map((image) => {
      if (image.assetId) { asset(String(image.assetId)); return { assetId: String(image.assetId) }; }
      const url = remoteImage(image.url); if (!url) throw new Error('商品图片地址无效'); return { url };
    });
    if (images.length > MAX_IMAGES) throw new Error('每个商品最多 9 张图片');
    const sourceItemId = String(input.source_item_id || existing?.source_item_id || '').trim();
    if (sourceItemId && !/^\d{6,24}$/.test(sourceItemId)) throw new Error('闲鱼商品 ID 无效');
    const row = existing || { id: crypto.randomUUID(), account_id: owner.id, created_at: Date.now() };
    Object.assign(row, { source_item_id: sourceItemId, title, description, price: String(input.price ?? '').trim(),
      ...normalizeOptions(input),
      original_price: String(input.original_price ?? '').trim(), stock: Number(input.stock ?? 1), images,
      shipping: ['free', 'fixed', 'distance', 'none'].includes(input.shipping) ? input.shipping : 'free',
      shipping_fee: String(input.shipping_fee ?? '').trim(), location: String(input.location || '').trim().slice(0, 80),
      ai_keyword: String(input.ai_keyword || '').trim().slice(0, 200), ai_facts: String(input.ai_facts || '').trim().slice(0, 4000),
      status: 'draft', preparation: null, error: '', updated_at: Date.now() });
    if (!existing) rows().push(row);
    store.persist(); return present(row);
  }
  function validate(row) {
    const owner = account(row.account_id);
    if (owner.disabled) throw new Error('该店铺已停用，请先启用');
    if (!row.title) throw new Error('请填写商品标题');
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(row.price) || Number(row.price) <= 0) throw new Error('请填写大于 0、最多两位小数的售价');
    if (row.original_price && (!/^\d{1,8}(\.\d{1,2})?$/.test(row.original_price) || Number(row.original_price) < Number(row.price))) throw new Error('原价不能低于售价');
    if (!row.images.length) throw new Error('请至少添加一张商品图片');
    validateSku(row.sku);
    for (const image of row.images) if (image.assetId) asset(image.assetId);
    if (row.shipping === 'fixed' && (!/^\d{1,6}(\.\d{1,2})?$/.test(row.shipping_fee) || Number(row.shipping_fee) < 0)) throw new Error('请填写有效邮费');
    return row;
  }
  function fingerprint(row) {
    const { id, account_id, source_item_id, title, description, price, original_price, images, shipping, shipping_fee, location } = row;
    return crypto.createHash('sha256').update(JSON.stringify({ id, account_id, source_item_id, title, description, price, original_price, images, shipping, shipping_fee, location, ...normalizeOptions(row) })).digest('hex');
  }
  function patch(id, changes) { const row = get(id); Object.assign(row, changes, { updated_at: Date.now() }); store.persist(); return present(row); }
  for (const row of rows()) {
    if (row.status === 'submitting') { row.status = 'uncertain'; row.error = '上次提交时程序中断，请先在闲鱼核对结果'; }
    if (['prepared', 'preparing'].includes(row.status)) { row.status = 'draft'; row.preparation = null; }
  }
  return { get, save, patch, present, validate, fingerprint, importFiles, asset,
    list(accountId) { return rows().filter((row) => !accountId || row.account_id === Number(accountId)).sort((a, b) => b.updated_at - a.updated_at).map(present); },
    remove(id) {
      const row = get(id);
      if (['preparing', 'submitting', 'uncertain'].includes(row.status)) throw new Error('请等待当前操作或先核对提交结果再删除草稿');
      store.ready().productDrafts = rows().filter((entry) => entry.id !== id); store.persist(); return true;
    },
  };
}

module.exports = { createDraftManager, remoteImage, MAX_IMAGES, MAX_IMAGE_BYTES };

'use strict';

const forbidden = new Set(['__proto__', 'constructor', 'prototype', 'key', 'price', 'quantity', 'propertyKey', 'propertyValue', 'secondPropertyKey', 'secondPropertyValue']);
const money = (value) => /^\d{1,8}(\.\d{1,2})?$/.test(String(value)) && Number(value) > 0;
function combinations(groups) { return groups.reduce((rows, group) => rows.flatMap((row) => group.values.map((value) => [...row, value])), [[]]); }
function normalizeSku(input = {}) {
  if (!input.enabled) return { enabled: false, groups: [], rows: [] };
  if (!Array.isArray(input.groups) || input.groups.length > 2) throw new Error('规格最多两组');
  const groups = input.groups.map((group) => {
    const name = String(group.name || '').trim();
    if (name.length > 30 || forbidden.has(name)) throw new Error('规格名称无效，最多30字');
    if (group.values != null && !Array.isArray(group.values)) throw new Error('规格值格式无效');
    const values = [...new Set((group.values || []).map((value) => String(value).trim()).filter(Boolean))];
    if (values.length > 50 || values.some((value) => value.length > 50)) throw new Error('每组最多50个规格值，每个最多50字');
    const image_values = (Array.isArray(group.image_values) ? group.image_values : []).filter((image) => values.includes(image.value)).map((image) => {
      const url = new URL(String(image.url).replace(/^http:/, 'https:'));
      if (url.protocol !== 'https:' || url.username || url.password || !/(^|\.)(alicdn|goofish|taobaocdn)\.com$/.test(url.hostname)) throw new Error('规格图片地址无效');
      return { value: String(image.value), url: url.href };
    });
    return { name, values, support_image: !!group.support_image, image_values };
  });
  if (groups.length && combinations(groups).length > 1500) throw new Error('规格组合最多1500个');
  const rows = (input.rows || []).slice(0, 1500).map((row) => ({ values: (row.values || []).map(String), price: String(row.price ?? '').trim(), quantity: row.quantity === '' || row.quantity == null ? '' : Number(row.quantity) }));
  return { enabled: true, groups, rows };
}
function validateSku(value) {
  const sku = normalizeSku(value);
  if (!sku.enabled) return sku;
  if (!sku.groups.length || sku.groups.some((group) => !group.name || !group.values.length)) throw new Error('请填写规格名称和规格值');
  if (new Set(sku.groups.map((group) => group.name)).size !== sku.groups.length) throw new Error('两组规格名称不能相同');
  const expected = combinations(sku.groups), nativeKeys = expected.map((values) => values.join('-'));
  if (new Set(nativeKeys).size !== nativeKeys.length) throw new Error('规格值组合存在同名，请调整规格值中的连字符');
  if (sku.rows.length !== expected.length) throw new Error('规格组合已变化，请重新生成价格库存表');
  const rows = new Map(sku.rows.map((row) => [JSON.stringify(row.values), row]));
  if (rows.size !== expected.length) throw new Error('规格组合重复');
  for (const values of expected) {
    const row = rows.get(JSON.stringify(values));
    if (!row || !money(row.price) || !Number.isInteger(row.quantity) || row.quantity < 0 || row.quantity > 9999) throw new Error('每个规格需填写有效售价和0至9999的整数库存');
  }
  if (!sku.rows.some((row) => row.quantity > 0)) throw new Error('至少一个规格需要有可售库存');
  return sku;
}
function normalizeOptions(input = {}) {
  const attributes = Array.isArray(input.platform_attributes) ? input.platform_attributes.slice(0, 50).map((value) => ({
    propertyId: String(value.propertyId || '').slice(0, 80), propertyName: String(value.propertyName || '').slice(0, 100),
    optionId: String(value.optionId || '').slice(0, 80), label: String(value.label || '').slice(0, 150), properties: String(value.properties || '').slice(0, 400),
  })) : [];
  const address = input.platform_address && typeof input.platform_address === 'object'
    ? Object.fromEntries(['prov', 'city', 'area', 'divisionId', 'gps', 'poiId', 'poiName'].map((key) => [key, String(input.platform_address[key] || '').slice(0, 200)])) : null;
  const quantity = input.platform_quantity == null || input.platform_quantity === '' ? null : Number(input.platform_quantity);
  if (quantity != null && (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999)) throw new Error('平台库存需为1至9999的整数');
  return { sku: normalizeSku(input.sku), platform_attributes: attributes, platform_address: address, platform_quantity: quantity };
}
function optionsMatch(row, current) {
  const expected = normalizeOptions(row), actual = normalizeOptions(current);
  if (expected.sku.enabled !== actual.sku.enabled) return false;
  if (expected.sku.enabled) {
    if (JSON.stringify(expected.sku.groups) !== JSON.stringify(actual.sku.groups) || expected.sku.rows.length !== actual.sku.rows.length) return false;
    const rows = new Map(actual.sku.rows.map((entry) => [JSON.stringify(entry.values), entry]));
    if (expected.sku.rows.some((entry) => { const found = rows.get(JSON.stringify(entry.values)); return !found || Number(found.price) !== Number(entry.price) || found.quantity !== entry.quantity; })) return false;
  }
  if (expected.platform_quantity != null && actual.platform_quantity !== expected.platform_quantity) return false;
  const selected = new Set(actual.platform_attributes.map((entry) => entry.properties));
  if (expected.platform_attributes.some((entry) => !selected.has(entry.properties))) return false;
  if (expected.platform_address && ['prov', 'city', 'area', 'divisionId', 'poiName'].some((key) => expected.platform_address[key] !== actual.platform_address?.[key])) return false;
  return true;
}

module.exports = { normalizeSku, validateSku, normalizeOptions, optionsMatch, combinations };

'use strict';

// Runs in the page world. Only returns product form data, never session storage.
async function platformFormBridge(action, input = {}) {
  const form = document.querySelector('form');
  let fiber = form && form[Object.keys(form).find((key) => key.startsWith('__reactFiber$'))], api;
  for (let depth = 0; fiber && depth < 45; depth++, fiber = fiber.return) {
    const candidate = fiber.memoizedProps?.form;
    if (typeof candidate?.getFieldsValue === 'function' && typeof candidate.setFieldsValue === 'function') { api = candidate; break; }
  }
  const supported = !!form && Array.from(form.querySelectorAll('label,h2,h3,h4,div,span')).some((node) => node.childElementCount === 0 && node.textContent.trim() === '商品规格');
  if (!api) {
    if (action === 'apply' && (input.sku?.enabled || input.platform_attributes?.length || input.platform_address || input.platform_quantity != null)) throw new Error('未能连接官方商品属性表单，请打开官方窗口检查');
    return { sku_supported: false, sku: { enabled: false, groups: [], rows: [] }, platform_attributes: [], attribute_options: [] };
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (action === 'apply') {
    if (input.sku?.enabled && !supported) throw new Error('该账号当前未开放网页版多规格和库存，已停止提交');
    if (supported && input.sku) {
      const groups = input.sku.enabled ? input.sku.groups : [];
      api.setFieldsValue({ itemProperties: groups.map((group) => ({ propertyName: group.name, propertyValues: group.values.map((value) => ({ propertyValue: value, ...(group.image_values?.find((image) => image.value === value) ? { propertyValueImg: { url: group.image_values.find((image) => image.value === value).url } } : {}) })), supportImage: !!group.support_image })) });
      await wait(350);
      const rows = input.sku.enabled ? input.sku.rows.map((row) => ({
        key: row.values.join('-'), propertyKey: groups[0].name, propertyValue: row.values[0],
        ...(groups[1] ? { secondPropertyKey: groups[1].name, secondPropertyValue: row.values[1] } : {}),
        ...Object.fromEntries(groups.map((group, index) => [group.name, row.values[index]])), price: String(row.price), quantity: Number(row.quantity),
      })) : [];
      api.setFieldsValue({ itemSkuList: rows }); await wait(350);
    }
    // Use the native option handler so category state outside Ant Form updates too.
    for (const attr of input.platform_attributes || []) {
      const current = api.getFieldsValue(true).itemLabelExtList || [];
      if (current.some((entry) => entry.properties === attr.properties)) continue;
      const candidates = Array.from(form.querySelectorAll('span,button,div')).filter((node) => node.childElementCount === 0 && node.textContent.trim() === attr.label && node.getBoundingClientRect().width > 0);
      if (candidates.length !== 1) throw new Error('平台属性选项已变化或有重名：' + attr.propertyName + '，请刷新属性');
      candidates[0].click(); await wait(450);
      if (!(api.getFieldsValue(true).itemLabelExtList || []).some((entry) => entry.properties === attr.properties)) throw new Error('官方页面未接受属性：' + attr.propertyName);
    }
    if (input.platform_address) { api.setFieldsValue({ itemAddrDTO: input.platform_address }); await wait(150); }
    if (input.platform_quantity != null) {
      if (!Object.prototype.hasOwnProperty.call(api.getFieldsValue(), 'quantity')) throw new Error('官方表单未开放单品库存，请使用多规格库存');
      api.setFieldsValue({ quantity: String(input.platform_quantity) });
    }
  }
  const values = api.getFieldsValue(true), properties = values.itemProperties || [], rows = values.itemSkuList || [];
  const groups = properties.map((group) => ({ name: group.propertyName, values: (group.propertyValues || []).map((value) => value.propertyValue), support_image: !!group.supportImage, image_values: (group.propertyValues || []).filter((value) => value.propertyValueImg?.url).map((value) => ({ value: value.propertyValue, url: value.propertyValueImg.url })) }));
  const cards = new Map(), seen = new Set(); let visited = 0;
  function walk(value, depth) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 7 || ++visited > 18000) return;
    seen.add(value);
    if (value.propertyId != null && value.propertyName && Array.isArray(value.valuesList)) {
      cards.set(String(value.propertyId), { propertyId: String(value.propertyId), propertyName: String(value.propertyName), options: value.valuesList.map((entry) => {
        const category = String(entry.propertyId ?? value.propertyId) === '-10000';
        const id = String((category ? entry.channelCatId : entry.valueId) ?? ''), label = String((category ? entry.catName : entry.valueName) || '');
        return { optionId: id, label, properties: `${value.propertyId}##${value.propertyName}:${id}##${label}` };
      }).filter((entry) => entry.optionId && entry.label).slice(0, 300) });
    }
    if (Array.isArray(value)) value.slice(0, 300).forEach((entry) => walk(entry, depth + 1));
    else for (const key of ['children', 'props', 'cardData', 'cardList', 'categoryData', 'valuesList']) walk(value[key], depth + 1);
  }
  for (const node of Array.from(form.querySelectorAll('*')).slice(0, 5000)) {
    const key = Object.keys(node).find((name) => name.startsWith('__reactProps$')); if (key) walk(node[key], 0);
    let item = node[Object.keys(node).find((name) => name.startsWith('__reactFiber$'))];
    for (let depth = 0; item && depth < 4; depth++, item = item.return) walk(item.memoizedProps, 0);
  }
  const address = values.itemAddrDTO;
  return {
    sku_supported: supported,
    sku: { enabled: groups.length > 0, groups, rows: rows.map((row) => ({ values: groups.map((group, index) => row[group.name] ?? (index ? row.secondPropertyValue : row.propertyValue)), price: String(row.price ?? ''), quantity: Number(row.quantity) })) },
    platform_attributes: (values.itemLabelExtList || []).filter((entry) => entry.properties).map((entry) => {
      const match = /^([^#]+)##([^:]+):([^#]+)##(.*)$/.exec(entry.properties);
      return { propertyId: match?.[1] || '', propertyName: match?.[2] || '', optionId: match?.[3] || '', label: entry.text || match?.[4] || '', properties: entry.properties };
    }),
    platform_address: address ? Object.fromEntries(['prov', 'city', 'area', 'divisionId', 'gps', 'poiId', 'poiName'].map((key) => [key, String(address[key] || '')])) : null,
    platform_quantity: values.quantity == null ? null : Number(values.quantity), attribute_options: [...cards.values()],
  };
}

module.exports = platformFormBridge;

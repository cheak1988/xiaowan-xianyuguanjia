'use strict';

const { ipcRenderer, webFrame } = require('electron');
const cardImageSources = new Map();
async function readRenderedImageSources() {
  // 懒加载时 DOM 只有占位图；读取图片组件已经渲染的 src 属性，不访问账号凭证或私有接口。
  const data = await webFrame.executeJavaScriptInIsolatedWorld(0, [{ code: `(() => {
    const rows = [];
    for (const card of document.querySelectorAll('a[class*="feeds-item-wrap"][href*="/item?"]')) {
      const container = card.querySelector('[class*="feeds-image-container"]');
      if (!container) continue;
      const key = Object.keys(container).find(name => name.startsWith('__reactProps$'));
      const children = container[key]?.children;
      for (const child of Array.isArray(children) ? children : [children]) {
        if (typeof child?.props?.src === 'string' && child.props.enableLazyLoad === true) {
          rows.push([new URL(card.href).searchParams.get('id'), child.props.src]); break;
        }
      }
    }
    return { rows: rows.slice(0, 5000) };
  })()` }]);
  const sources = data?.rows || data?.[0]?.rows || [];
  for (const [id, url] of sources) if (typeof url === 'string' && /^(https?:)?\/\//.test(url) && !/[-_]2[-_]2\.(png|gif)(?:[?#]|$)/i.test(url)) {
    const image = new URL(url, location.href); image.protocol = 'https:'; cardImageSources.set(id, image.href);
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (node) => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
const visible = (node) => { const rect = node?.getBoundingClientRect(); return !!rect && rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'; };
let managedSubmission = false, allowSubmit = false;
function managedSubmitButton(node) {
  const button = node?.closest?.('button');
  return button?.closest('form') && /^(发布|确认发布|保存修改)$/.test(text(button));
}
document.addEventListener('click', (event) => {
  if (managedSubmission && !allowSubmit && managedSubmitButton(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.addEventListener('submit', (event) => {
  if (managedSubmission && !allowSubmit) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
function loggedOut() {
  return Array.from(document.querySelectorAll('iframe[src*="mini_login"],iframe[src*="login.taobao"]')).some(visible) || location.pathname === '/login';
}
function profileIdentity(uid) {
  return location.hostname === 'www.goofish.com' && location.pathname === '/personal'
    && new URL(location.href).searchParams.get('userId') === String(uid);
}
async function waitFor(test, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = test(); if (value) return value; await pause(200); }
  return null;
}
function productCard(node, status = 'unknown') {
  const link = node.matches('a[href]') ? node : node.querySelector('a[href*="/item?"]');
  if (!link) return null;
  let url;
  try { url = new URL(link.href, location.href); } catch (_) { return null; }
  const id = url.searchParams.get('id');
  if (url.hostname !== 'www.goofish.com' || url.pathname !== '/item' || !/^\d{6,24}$/.test(id || '')) return null;
  const titleNode = node.querySelector('[class*="row1-wrap-title"],[class*="main-title"],[data-product-title]');
  const priceNode = node.querySelector('[class*="price-wrap"],[data-product-price]');
  const title = titleNode?.getAttribute('title') || text(titleNode);
  const price = text(priceNode).replace(/[,\s¥￥]/g, '').match(/^\d+(?:\.\d{1,2})?/);
  const image = cardImageSources.get(id) || Array.from(node.querySelectorAll('[class*="feeds-image-container"] img,img[data-product-image]'))
    .map((entry) => entry.getAttribute('data-src') || entry.getAttribute('src') || '')
    .find((value) => /^(https:)?\/\//.test(value) && !/[-_]2[-_]2\.(png|gif)(?:[?#]|$)/i.test(value));
  if (!title || !price) return null;
  return { item_id: id, title: title.slice(0, 120), price: price[0], image: image ? new URL(image, location.href).href : '',
    status, source_url: 'https://www.goofish.com/item?id=' + id };
}
function profileTabs() { return Array.from(document.querySelectorAll('[class*="filterTab"] [class*="tabItem"],[data-product-tab]')); }
const cards = () => {
  const selector = 'a[class*="feeds-item-wrap"][href*="/item?"],[data-owned-product]';
  let root = document.querySelector('[class*="filterTab"],[data-owned-product-list]');
  if (!root?.matches('[data-owned-product-list]')) root = root?.parentElement;
  while (root && root !== document.body) {
    if (root.querySelector(selector)) return Array.from(root.querySelectorAll(selector));
    if (root.matches('[data-owned-product-list]')) return [];
    root = root.parentElement;
  }
  return [];
};
async function scanProfile(payload) {
  if (!profileIdentity(payload.userId)) return { ok: false, code: 'WRONG_ACCOUNT', error: '当前页面不是该店铺的个人主页，已停止同步' };
  const ready = await waitFor(() => profileTabs().length && !loggedOut());
  if (loggedOut()) return { ok: false, code: 'LOGIN_REQUIRED', error: '店铺登录已失效，请在打开的闲鱼窗口扫码登录后重试' };
  if (!ready) return { ok: false, code: 'PAGE_CHANGED', error: '个人主页未加载出商品列表，请打开店铺主页检查网络或验证提示' };
  const tabs = profileTabs();
  cardImageSources.clear();
  const products = new Map();
  const deadline = Date.now() + 65000;
  let complete = true, authoritativeEmpty = true;
  const activeTab = tabs.find((tab) => /active/.test(tab.className));
  for (const [status, pattern] of [['on_sale', /^在售\s*(\d+)?$/], ['sold', /^已售出\s*(\d+)?$/]]) {
    const tab = tabs.find((candidate) => pattern.test(text(candidate)));
    if (!tab) { complete = false; authoritativeEmpty = false; continue; }
    const expected = Number((text(tab).match(pattern) || [])[1]);
    if (expected !== 0) authoritativeEmpty = false;
    const before = cards().map((node) => node.href).join('|');
    const otherPattern = status === 'on_sale' ? /^已售出\s*(\d+)$/ : /^在售\s*(\d+)$/;
    const otherCount = Number(text(tabs.find((candidate) => otherPattern.test(text(candidate)))).match(otherPattern)?.[1]);
    const sameItemsAllowed = /active/.test(tab.className) || tab.getAttribute('aria-selected') === 'true' || otherCount === 0;
    tab.click();
    const changed = await waitFor(() => {
      const nodes = cards();
      const newItems = nodes.map((node) => node.href).join('|') !== before;
      return Number.isFinite(expected) && expected <= 20 ? nodes.length === expected && (newItems || expected === 0 || sameItemsAllowed)
        : nodes.length > 0 && (newItems || sameItemsAllowed);
    }, 6000);
    if (!changed) { complete = false; continue; }
    await pause(350); window.scrollTo(0, 0);
    let stable = 0, previous = -1, captured = 0;
    for (let round = 0; round < 70 && Date.now() < deadline; round++) {
      if (!profileIdentity(payload.userId) || loggedOut()) return { ok: false, error: '同步过程中页面或登录状态发生变化，请重试' };
      await readRenderedImageSources();
      for (const node of cards()) { const product = productCard(node, status); if (product) products.set(product.item_id, product); }
      captured = Array.from(products.values()).filter((item) => item.status === status).length;
      const pendingImages = cards().filter((node) => !productCard(node, status)?.image);
      if (Number.isFinite(expected) && captured >= expected && !pendingImages.length) break;
      const progress = captured + Array.from(products.values()).filter((item) => item.status === status && item.image).length;
      stable = progress === previous ? stable + 1 : 0; previous = progress;
      if (stable >= 4) break;
      if (pendingImages.length) pendingImages[0].scrollIntoView({ block: 'center' });
      else window.scrollTo(0, document.documentElement.scrollHeight);
      await pause(450);
    }
    if (Number.isFinite(expected) && captured < expected) complete = false;
    if (Number.isFinite(expected) && captured > expected) return { ok: false, error: '商品数量与店铺筛选不一致，已停止同步以避免混入其他商品' };
  }
  if (activeTab?.isConnected) activeTab.click();
  window.scrollTo(0, 0);
  const emptyMessage = Array.from(document.querySelectorAll('[class*=empty],div,span')).some((node) => node.childElementCount === 0 && /^暂无商品$/.test(text(node)) && visible(node));
  if (!products.size && !authoritativeEmpty && !emptyMessage) return { ok: false, error: '未能确认店铺为空，未改动已有商品；请打开店铺主页核对' };
  if (!products.size && emptyMessage) complete = true;
  return { ok: true, products: Array.from(products.values()), complete,
    scope: '个人主页：在售和已售出商品；不包含平台隐藏的下架商品' };
}

function form() { return document.querySelector('form'); }
function field(label) {
  return form()?.querySelector(`label[for="${label}"]`)?.closest('.ant-form-item')?.querySelector('input:not([type=hidden]),textarea');
}
function editor() { return form()?.querySelector('[contenteditable=true][data-placeholder],[contenteditable=true][data-product-description]'); }
function imageItems() {
  const root = form()?.querySelector('label[for="imageInfoDOList"]')?.closest('.ant-form-item') || form();
  const previews = root?.querySelectorAll('[class*="preview-container--"]');
  return Array.from(previews?.length ? previews : root?.querySelectorAll('[class*="imgItem--"],[data-uploaded-image]') || []);
}
function imageUrls() {
  return imageItems().map((node) => Array.from(node.querySelectorAll('img')).find((image) => {
    const rect = image.getBoundingClientRect();
    return visible(image) && rect.width >= 40 && rect.height >= 40;
  })?.src || '').filter((url) => /^https:\/\//.test(url));
}
function formErrors() { return Array.from(document.querySelectorAll('.ant-form-item-explain-error,[role=alert]')).filter(visible).map(text).filter(Boolean); }
let platformSnapshot = { sku: { enabled: false, groups: [], rows: [] }, platform_attributes: [] };
async function platformOptions(action = 'read', input = {}) {
  const result = await webFrame.executeJavaScriptInIsolatedWorld(0, [{ code: '(' + platformFormBridge.toString() + ')(' + JSON.stringify(action) + ',' + JSON.stringify(input) + ')' }]);
  platformSnapshot = result;
  return result;
}
function readForm() {
  const desc = editor();
  return { ok: !!desc && !!field('itemPriceDTO_priceInCent'), loggedOut: loggedOut(),
    description: desc?.innerText || '', price: field('itemPriceDTO_priceInCent')?.value || '',
    original_price: field('itemPriceDTO_origPriceInCent')?.value || '', images: imageUrls(), imageCount: imageItems().length,
    shipping: ['free', 'distance', 'fixed', 'none'][Number(form()?.querySelector('input[type=radio]:checked')?.value || 0)],
    shipping_fee: field('itemPostFeeDTO_postPriceInCent')?.value || '', errors: formErrors(), ...platformSnapshot };
}
function setField(node, value) {
  if (!node) return false;
  const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, String(value));
  node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
  node.dispatchEvent(new Event('blur', { bubbles: true })); return true;
}
function checkPublishUrl(payload) {
  const url = new URL(location.href);
  return url.hostname === 'www.goofish.com' && url.pathname === '/publish'
    && (url.searchParams.get('itemId') || '') === (payload.source_item_id || '');
}
async function waitForForm() {
  const editing = !!new URL(location.href).searchParams.get('itemId');
  const ready = await waitFor(() => editor() && field('itemPriceDTO_priceInCent')
    && (!editing || field('itemPriceDTO_priceInCent').value.trim()));
  if (!ready) throw new Error('官方商品信息尚未加载完成，请检查登录或验证提示后重新准备');
  await pause(200);
  if (!(await waitFor(() => imageItems().length === imageUrls().length, 8000))) {
    throw new Error('原商品图片尚未加载完成，请检查网络后重试');
  }
}
async function fillForm(payload) {
  if (!checkPublishUrl(payload)) return { ok: false, error: '当前不是目标商品的发布页面' };
  await waitForForm();
  if (loggedOut()) return { ok: false, code: 'LOGIN_REQUIRED', error: '请先在闲鱼窗口登录该店铺' };
  const desc = editor();
  if (!desc || !field('itemPriceDTO_priceInCent')) return { ok: false, error: '该商品类型暂不支持网页版编辑，或页面需要先完成验证；请查看官方窗口' };
  managedSubmission = true;
  if (!document.getElementById('xy-managed-product-notice')) {
    const notice = document.createElement('div'); notice.id = 'xy-managed-product-notice';
    notice.textContent = '此页面由小丸闲鱼管家填写。请核对属性、规格和所在地，然后返回管家确认发布。';
    notice.style.cssText = 'padding:14px 20px;background:#eaf5ff;color:#0064fa;font-size:14px;line-height:1.7';
    form().prepend(notice);
  }
  desc.focus(); desc.innerText = payload.content;
  desc.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload.content }));
  desc.dispatchEvent(new Event('blur', { bubbles: true }));
  setField(field('itemPriceDTO_priceInCent'), payload.price);
  setField(field('itemPriceDTO_origPriceInCent'), payload.original_price || '');
  const shippingValue = { free: '0', distance: '1', fixed: '2', none: '3' }[payload.shipping];
  const radio = form().querySelector(`input[type=radio][value="${shippingValue}"]`);
  if (!radio) return { ok: false, error: '无法识别发货方式，请在官方页面确认' };
  radio.click(); await pause(200);
  if (payload.shipping === 'fixed') setField(field('itemPostFeeDTO_postPriceInCent'), payload.shipping_fee);
  return readForm();
}
async function clearImages() {
  for (let round = 0; round < 12 && imageItems().length; round++) {
    const count = imageItems().length;
    const item = imageItems()[0];
    item.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: document.body }));
    const button = await waitFor(() => item.querySelector('[class*="delete-btn"],[data-remove-image]'), 1500);
    if (!button) return { ok: false, error: '无法清理官方页面的旧图片，请在官方页面处理' };
    button.click(); await pause(150);
    const confirmation = Array.from(document.querySelectorAll('.ant-popconfirm,[class*="del-popconfirm"]')).find((node) => visible(node) && /删除这张图片/.test(text(node)));
    if (confirmation) {
      const confirm = Array.from(confirmation.querySelectorAll('button')).find((node) => /^(确定|确认)$/.test(text(node)));
      if (!confirm) return { ok: false, error: '未找到图片删除确认按钮，请在官方窗口处理' };
      confirm.click();
    }
    if (!(await waitFor(() => imageItems().length < count, 2500))) return { ok: false, error: '图片删除尚未确认，请在官方窗口检查' };
  }
  return { ok: imageItems().length === 0 };
}
async function waitImage(payload) {
  const done = await waitFor(() => imageUrls().length >= payload.count || formErrors().some((message) => /图片|上传/.test(message)), 25000);
  const current = readForm();
  return { ...current, ok: !!done && current.imageCount === payload.count && current.images.length === payload.count,
    error: current.imageCount === payload.count && current.images.length === payload.count ? '' : '图片未完成上传，请检查网络或官方窗口中的提示' };
}
async function submit(payload, requestId) {
  if (!checkPublishUrl(payload)) return { ok: false, clicked: false, error: '发布页面已改变，请重新准备' };
  await platformOptions();
  const current = readForm();
  if (payload.expectedOptions && JSON.stringify(platformSnapshot) !== payload.expectedOptions) return { ok: false, clicked: false, error: '官方属性或规格已改变，请重新核验' };
  if (!current.ok || loggedOut() || current.description.replace(/\s+/g, ' ').trim() !== payload.content.replace(/\s+/g, ' ').trim()
      || Number(current.price) !== Number(payload.price) || Number(current.original_price) !== Number(payload.original_price)
      || current.imageCount !== payload.imageCount
      || current.images.some((image, index) => image !== payload.images[index]) || current.shipping !== payload.shipping
      || (payload.shipping === 'fixed' && Number(current.shipping_fee) !== Number(payload.shipping_fee))) {
    return { ok: false, clicked: false, error: '官方页面的文案、价格、图片或发货方式发生变化，请重新核验' };
  }
  const buttons = Array.from(form().querySelectorAll('button')).filter((button) => visible(button) && /^(发布|确认发布|保存修改)$/.test(text(button)));
  if (buttons.length !== 1 || buttons[0].disabled) return { ok: false, clicked: false, error: '官方页面还不能提交，请补全属性或处理验证提示' };
  if (!(await ipcRenderer.invoke('product:can-submit', requestId))) return { ok: false, clicked: false, error: '提交授权已失效' };
  allowSubmit = true;
  try { buttons[0].click(); } finally { allowSubmit = false; }
  return { ok: true, clicked: true };
}
const activeRequests = new Set(), completedRequests = new Map();
ipcRenderer.on('product:command', async (_event, { requestId, action, payload = {} }) => {
  if (activeRequests.has(requestId)) return;
  if (completedRequests.has(requestId)) { ipcRenderer.send('product:response', completedRequests.get(requestId)); return; }
  activeRequests.add(requestId);
  let result;
  try {
    if (action === 'scan') result = await scanProfile(payload);
    else if (action === 'fill') result = await fillForm(payload);
    else if (action === 'read-form') { await waitForForm(); await platformOptions(); result = readForm(); }
    else if (action === 'apply-options') { await waitForForm(); await platformOptions('apply', payload); result = readForm(); }
    else if (action === 'clear-images') result = await clearImages();
    else if (action === 'wait-image') result = await waitImage(payload);
    else if (action === 'submit') result = await submit(payload, requestId);
    else result = { ok: false, error: '未知商品操作' };
  } catch (error) { result = { ok: false, error: error.message }; }
  const response = { requestId, ...result };
  activeRequests.delete(requestId); completedRequests.set(requestId, response);
  if (completedRequests.size > 16) completedRequests.delete(completedRequests.keys().next().value);
  ipcRenderer.send('product:response', response);
});

'use strict';

function officialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['goofish.com', 'taobao.com'].some((host) =>
      url.hostname === host || url.hostname.endsWith('.' + host));
  } catch (_) { return false; }
}

function secureRemoteView(view, shell) {
  const contents = view.webContents;
  const external = (value) => {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') shell.openExternal(url.href).catch(() => {});
    } catch (_) { /* 不允许 file/javascript/自定义协议 */ }
  };
  contents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  for (const name of ['will-navigate', 'will-redirect']) {
    contents.on(name, (event, url) => {
      if (!officialUrl(url)) { event.preventDefault(); if (name === 'will-navigate') external(url); }
    });
  }
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}

module.exports = { secureRemoteView, officialUrl };

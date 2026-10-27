'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dlgApi', {
  onInit: (cb) => ipcRenderer.on('dlg:init', (_e, cfg) => cb(cfg)),
  result: (ok, values) => ipcRenderer.send('dlg:result', { ok, values }),
  close: () => ipcRenderer.send('dlg:close'),
});

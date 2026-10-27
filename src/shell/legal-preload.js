'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('legalApi', {
  onInit: (cb) => ipcRenderer.on('legal:init', (_event, payload) => cb(payload)),
  result: (payload) => ipcRenderer.send('legal:result', payload),
});

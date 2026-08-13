'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = Object.freeze({
  ready: 'attention-popup:ready',
  resize: 'attention-popup:resize',
  decide: 'attention-popup:decide',
  dismiss: 'attention-popup:dismiss',
  openMain: 'attention-popup:open-main',
  request: 'attention-popup:request',
  error: 'attention-popup:error',
});

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Popup listener must be a function.');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const popupApi = Object.freeze({
  ready: hasTextInput => ipcRenderer.invoke(CHANNELS.ready, { hasTextInput: hasTextInput === true }),
  resize: payload => ipcRenderer.invoke(CHANNELS.resize, {
    height: Number(payload && payload.height),
    hasTextInput: Boolean(payload && payload.hasTextInput),
  }),
  decide: decision => ipcRenderer.invoke(CHANNELS.decide, decision),
  dismiss: () => ipcRenderer.invoke(CHANNELS.dismiss),
  openMain: () => ipcRenderer.invoke(CHANNELS.openMain),
  onRequest: callback => subscribe(CHANNELS.request, callback),
  onError: callback => subscribe(CHANNELS.error, callback),
});

contextBridge.exposeInMainWorld('attentionPopup', popupApi);

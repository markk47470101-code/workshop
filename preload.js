'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Подписка на событие из main-процесса; возвращает функцию отписки.
function on(channel, cb) {
  const handler = (_event, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  pickClaude: () => ipcRenderer.invoke('dialog:claude'),

  send: (opts) => ipcRenderer.invoke('claude:send', opts),
  stop: () => ipcRenderer.invoke('claude:stop'),
  onEvent: (cb) => on('claude:event', cb),
  onDone: (cb) => on('claude:done', cb),

  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),

  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: () => ipcRenderer.invoke('auth:login'),
  onAuthLog: (cb) => on('auth:log', cb),

  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
});

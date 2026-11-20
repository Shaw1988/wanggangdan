'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 小助手
  onCharState: (cb) => ipcRenderer.on('char:state', (_e, state) => cb(state)),
  onCharMode: (cb) => ipcRenderer.on('char:mode', (_e, mode) => cb(mode)),
  dragStart: () => ipcRenderer.send('char:drag-start'),
  dragEnd: () => ipcRenderer.send('char:drag-end'),

  // 待办面板
  onPanelAnimate: (cb) => ipcRenderer.on('panel:animate', (_e, dir) => cb(dir)),
  inputFocus: (focused) => ipcRenderer.send('panel:input-focus', focused),
  closePanel: () => ipcRenderer.send('panel:close'),
  onTodos: (cb) => ipcRenderer.on('todos:updated', (_e, list) => cb(list)),
  addTodo: (text) => ipcRenderer.invoke('todos:add', text),
  updateTodo: (id, text) => ipcRenderer.invoke('todos:update', id, text),
  toggleTodo: (id) => ipcRenderer.invoke('todos:toggle', id),
  deleteTodo: (id) => ipcRenderer.invoke('todos:delete', id)
});

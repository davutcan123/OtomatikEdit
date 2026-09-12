'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('terminalView', {
  read: afterId => ipcRenderer.invoke('desktop:read-logs', afterId),
  copy: text => ipcRenderer.invoke('desktop:copy-logs', text),
  onChange: callback => {
    const listener = () => callback();
    ipcRenderer.on('desktop:logs-changed', listener);
    return () => ipcRenderer.removeListener('desktop:logs-changed', listener);
  },
});

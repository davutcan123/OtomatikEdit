'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  saveRecovery: snapshot => ipcRenderer.invoke('desktop:save-recovery', snapshot),
  loadRecovery: () => ipcRenderer.invoke('desktop:load-recovery'),
  openRelease: () => ipcRenderer.invoke('desktop:open-release'),
  getStorageInfo: () => ipcRenderer.invoke('desktop:storage-info'),
  openProjectsFolder: () => ipcRenderer.invoke('desktop:open-projects-folder'),
  saveOutput: relativeURL => ipcRenderer.invoke('desktop:save-output', relativeURL),
  onBeforeClose: callback => {
    const listener = (_event, attempt) => callback(attempt);
    ipcRenderer.on('desktop:before-close', listener);
    return () => ipcRenderer.removeListener('desktop:before-close', listener);
  },
  onCloseCancelled: callback => {
    const listener = (_event, attempt) => callback(attempt);
    ipcRenderer.on('desktop:close-cancelled', listener);
    return () => ipcRenderer.removeListener('desktop:close-cancelled', listener);
  },
  readyToClose: attempt => ipcRenderer.send('desktop:ready-to-close', attempt),
});

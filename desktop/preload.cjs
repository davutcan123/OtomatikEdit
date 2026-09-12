'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  saveRecovery: snapshot => ipcRenderer.invoke('desktop:save-recovery', snapshot),
  loadRecovery: () => ipcRenderer.invoke('desktop:load-recovery'),
  openRelease: () => ipcRenderer.invoke('desktop:open-release'),
  getUpdateState: () => ipcRenderer.invoke('desktop:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  onUpdateState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:update-state', listener);
    return () => ipcRenderer.removeListener('desktop:update-state', listener);
  },
  onPrepareUpdate: callback => {
    const listener = (_event, attempt) => callback(attempt);
    ipcRenderer.on('desktop:prepare-update', listener);
    return () => ipcRenderer.removeListener('desktop:prepare-update', listener);
  },
  onUpdateCancelled: callback => {
    const listener = (_event, attempt) => callback(attempt);
    ipcRenderer.on('desktop:update-cancelled', listener);
    return () => ipcRenderer.removeListener('desktop:update-cancelled', listener);
  },
  readyForUpdate: (attempt, error, busy = false) => ipcRenderer.send('desktop:ready-for-update', attempt, error, busy),
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

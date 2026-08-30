const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('get-app-version'),
  onUpdateAvailable: (cb) => {
    ipcRenderer.on('update-available', (_event, info) => cb(info));
  },
  onUpdateReady: (cb) => {
    ipcRenderer.on('update-ready', () => cb());
  },
  startPowerSaveBlocker: () => ipcRenderer.invoke('power-save-blocker-start'),
  stopPowerSaveBlocker: () => ipcRenderer.invoke('power-save-blocker-stop'),
  getPlatformInfo: () => ipcRenderer.invoke('get-platform-info'),
  consumeFirstLaunch: () => ipcRenderer.invoke('consume-first-launch')
});

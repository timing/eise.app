const { contextBridge, ipcRenderer } = require('electron');

// Injected by the main process via webPreferences.additionalArguments. Exposed
// synchronously (not over invoke()) because beacon.js reads it while building
// the very first event body.
const INSTALL_ID_PREFIX = '--eise-install-id=';
const installIdArg = process.argv.find(arg => arg.startsWith(INSTALL_ID_PREFIX));
const installId = installIdArg ? installIdArg.slice(INSTALL_ID_PREFIX.length) : null;

contextBridge.exposeInMainWorld('electronAPI', {
  installId,
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

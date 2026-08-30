const { app, BrowserWindow, session, shell, ipcMain, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerScheme, registerHandler } = require('./protocol');
const { applyPendingUpdate, startUpdateChecker } = require('./updater');

// Enable WebGPU
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan');

// Register custom protocol scheme — must happen before app ready
registerScheme();

/**
 * Resolve which directory to serve static files from.
 * Prefers userData/app-files/ (updated version) over bundled resources/app-files/.
 */
function getAppFilesDir() {
  const updated = path.join(app.getPath('userData'), 'app-files');
  if (fs.existsSync(path.join(updated, 'index.html'))) {
    return updated;
  }
  // Bundled copy inside packaged app
  const bundled = path.join(process.resourcesPath || path.join(__dirname, '..'), 'app-files');
  if (fs.existsSync(path.join(bundled, 'index.html'))) {
    return bundled;
  }
  // Dev mode: use dist/ directly
  return path.join(__dirname, '..', 'dist');
}

function createWindow(appFilesDir) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for WebWorker GPU access
      backgroundThrottling: false // keep stacking running when minimized/hidden
    }
  });

  // Inject COOP/COEP headers for SharedArrayBuffer support
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Embedder-Policy': ['require-corp'],
        'Cross-Origin-Opener-Policy': ['same-origin']
      }
    });
  });

  // Open external links in system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Also intercept navigation to external URLs
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Register protocol file handler
  registerHandler(appFilesDir);

  // Load the app
  win.loadURL('app://eise/index.html');

  return win;
}

function readAppVersion() {
  try {
    const pkg = require('../package.json');
    return pkg.version || 'dev';
  } catch {
    return 'dev';
  }
}

// IPC handlers
ipcMain.handle('get-app-version', () => readAppVersion());

ipcMain.handle('get-platform-info', () => ({
  platform: process.platform,
  arch: process.arch,
  app_version: readAppVersion(),
  electron_version: process.versions.electron,
  chrome_version: process.versions.chrome,
}));

// Returns true the very first time it's called for this install, false forever
// after. State is persisted to a small JSON file in userData so it survives app
// updates but not a full uninstall/reinstall (which is what we want — a reinstall
// should count as a fresh first launch).
ipcMain.handle('consume-first-launch', () => {
  try {
    const marker = path.join(app.getPath('userData'), 'first-launch.json');
    if (fs.existsSync(marker)) return false;
    fs.writeFileSync(marker, JSON.stringify({ ts: Date.now(), version: readAppVersion() }));
    return true;
  } catch (e) {
    console.warn('consume-first-launch failed:', e);
    return false;
  }
});

let powerSaveBlockerId = null;
ipcMain.handle('power-save-blocker-start', () => {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    return powerSaveBlockerId;
  }
  powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  return powerSaveBlockerId;
});
ipcMain.handle('power-save-blocker-stop', () => {
  if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }
  powerSaveBlockerId = null;
});

app.whenReady().then(() => {
  // Apply any pending update before creating the window
  applyPendingUpdate();

  const appFilesDir = getAppFilesDir();
  console.log('Serving app from:', appFilesDir);

  const win = createWindow(appFilesDir);

  // Start background update checker after a short delay
  setTimeout(() => startUpdateChecker(win, appFilesDir), 10_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(appFilesDir);
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

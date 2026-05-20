const { app, BrowserWindow, session, shell, ipcMain } = require('electron');
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
      sandbox: false // needed for WebWorker GPU access
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

// IPC handlers
ipcMain.handle('get-app-version', () => {
  try {
    const pkg = require('../package.json');
    return pkg.version || 'dev';
  } catch {
    return 'dev';
  }
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

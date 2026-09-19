const { app, BrowserWindow, Menu, session, shell, ipcMain, powerSaveBlocker } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerScheme, registerHandler } = require('./protocol');
const { applyPendingUpdate, startUpdateChecker } = require('./updater');

// The packaged package.json still carries the Nuxt scaffold name, which Electron
// would otherwise use for the macOS app menu ("About nuxt-app", "Quit nuxt-app").
const APP_NAME = 'Eise';
const LEGACY_APP_NAME = 'nuxt-app';
app.setName(APP_NAME);
useExistingProfileIfPresent();

/**
 * Electron derives the userData directory name from the app name, so renaming the
 * app would point existing installs at an empty directory and strand the profile
 * they already have under the old name: the downloaded app-files, a staged update,
 * localStorage and the first-launch marker. Keep using that directory when it is
 * already there rather than moving anything — nothing on disk changes either way.
 * Fresh installs get a directory named after the app. An explicit --user-data-dir
 * always wins and short-circuits this entirely, so a test build can be launched
 * against a throwaway profile without reading the real one.
 */
function useExistingProfileIfPresent() {
  if (process.argv.some(arg => arg.startsWith('--user-data-dir'))) return;
  try {
    const existing = path.join(app.getPath('appData'), LEGACY_APP_NAME);
    const hasProfile = fs.existsSync(path.join(existing, 'app-files')) ||
      fs.existsSync(path.join(existing, 'first-launch.json'));
    if (hasProfile) app.setPath('userData', existing);
  } catch (err) {
    console.error('Could not resolve the existing profile, using the default:', err.message);
  }
}

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

/**
 * Manifest of the web bundle currently being served. The shell self-updates from
 * https://eise.app, so this moves independently of the installer version and is
 * the only thing that says which UI you are actually looking at.
 */
function readContentManifest(appFilesDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appFilesDir, 'version.json'), 'utf8'));
  } catch {
    return null;
  }
}

// "2026-09-19T18:57:43.687Z" -> "2026-09-19 18:57 UTC"
function formatManifestDate(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso || '');
  return m ? `${m[1]} ${m[2]} UTC` : (iso || 'unknown');
}

function describeWebRelease(appFilesDir) {
  const manifest = readContentManifest(appFilesDir);
  if (!manifest) return 'bundled with installer';
  const commit = manifest.commit ? ` (${manifest.commit})` : '';
  return `${formatManifestDate(manifest.version)}${commit}`;
}

/**
 * About panel showing both versions: the installer this machine downloaded, and
 * the web release the auto-updater has since swapped in.
 */
function configureAboutPanel(appFilesDir) {
  const appVersion = readAppVersion();
  const webRelease = describeWebRelease(appFilesDir);

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    // Windows and Linux render only applicationName/applicationVersion/copyright,
    // so both versions have to fit on this single line there.
    applicationVersion: `${appVersion} · web release ${webRelease}`,
    version: webRelease, // macOS shows this in parentheses after the version
    credits: `Installed build ${appVersion}\nWeb release ${webRelease}\nhttps://eise.app`,
    copyright: 'Copyright (c) 2026 eise.app'
  });
}

/**
 * macOS builds a correct default menu once app.setName() has run. Windows and
 * Linux have no About entry in the default menu at all, so give them one.
 */
function buildMenu() {
  if (process.platform === 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: `About ${APP_NAME}`, role: 'about' }] }
  ]));
}

// IPC handlers
ipcMain.handle('get-app-version', () => readAppVersion());

ipcMain.handle('get-platform-info', () => {
  const manifest = readContentManifest(getAppFilesDir());
  return {
    platform: process.platform,
    arch: process.arch,
    app_version: readAppVersion(),
    // app_version is frozen at whatever installer was downloaded; these two track
    // the web bundle the shell actually runs after a self-update.
    content_version: manifest?.version || null,
    content_commit: manifest?.commit || null,
    electron_version: process.versions.electron,
    chrome_version: process.versions.chrome,
  };
});

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

  // Read after applyPendingUpdate() so both reflect what is actually running.
  configureAboutPanel(appFilesDir);
  buildMenu();

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

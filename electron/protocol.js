const { protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Register app:// as a privileged scheme. Must be called BEFORE app.whenReady().
 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: false,
      allowServiceWorkers: true
    }
  }]);
}

/**
 * Register the file handler for app:// after app is ready.
 * @param {string} appFilesDir - Absolute path to the directory serving static files
 */
function registerHandler(appFilesDir) {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    // Strip query params (cache-bust ?v=xxx) — just use pathname
    let pathname = decodeURIComponent(url.pathname);
    // Remove leading slash for path.join
    if (pathname.startsWith('/')) pathname = pathname.slice(1);

    let filePath = path.join(appFilesDir, pathname);

    // SPA fallback: if no extension and file doesn't exist, serve index.html
    if (!path.extname(filePath)) {
      // Try with /index.html appended first (for route directories)
      const withIndex = path.join(filePath, 'index.html');
      if (fs.existsSync(withIndex)) {
        filePath = withIndex;
      } else {
        // Fall back to root index.html for SPA routing
        filePath = path.join(appFilesDir, 'index.html');
      }
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

module.exports = { registerScheme, registerHandler };

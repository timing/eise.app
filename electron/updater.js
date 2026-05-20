const { app } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const UPDATE_URL = 'https://eise.app/version.json';
const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
const FETCH_TIMEOUT = 15_000;
const MAX_CONCURRENT_DOWNLOADS = 4;

function getUpdatePaths() {
  const userData = app.getPath('userData');
  return {
    appFiles: path.join(userData, 'app-files'),
    staging: path.join(userData, 'update-staging'),
    backup: path.join(userData, 'app-files-backup'),
    readyMarker: path.join(userData, 'update-staging', '.ready')
  };
}

/**
 * Apply a pending update atomically. Called on app launch BEFORE creating the window.
 */
function applyPendingUpdate() {
  const { appFiles, staging, backup, readyMarker } = getUpdatePaths();

  // Clean up incomplete staging (no .ready marker)
  if (fs.existsSync(staging) && !fs.existsSync(readyMarker)) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    return;
  }

  if (!fs.existsSync(readyMarker)) return;

  console.log('Applying pending update...');
  try {
    // Remove old backup if present
    if (fs.existsSync(backup)) {
      fs.rmSync(backup, { recursive: true, force: true });
    }
    // Move current to backup
    if (fs.existsSync(appFiles)) {
      fs.renameSync(appFiles, backup);
    }
    // Promote staging to current
    fs.renameSync(staging, appFiles);
    // Clean up backup
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
    console.log('Update applied successfully');
  } catch (err) {
    console.error('Update swap failed, rolling back:', err.message);
    // Rollback: restore backup if app-files is missing
    if (!fs.existsSync(appFiles) && fs.existsSync(backup)) {
      try { fs.renameSync(backup, appFiles); } catch {}
    }
    // Clean up failed staging
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Read the local version.json from the current app files directory.
 */
async function readLocalManifest(appFilesDir) {
  try {
    const data = await fsp.readFile(path.join(appFilesDir, 'version.json'), 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Fetch the remote version.json.
 */
async function fetchRemoteManifest() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(UPDATE_URL, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Compute SHA-256 of a buffer.
 */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Download a single file and verify its hash.
 * @returns {Buffer|null} File contents if hash matches, null on failure.
 */
async function downloadFile(relativePath, expectedHash) {
  const url = `https://eise.app/${relativePath}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (sha256(buffer) !== expectedHash) {
      console.error(`Hash mismatch for ${relativePath}`);
      return null;
    }
    return buffer;
  } catch {
    return null;
  }
}

/**
 * Run async tasks with a concurrency limit.
 */
async function pooled(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/**
 * Copy a directory recursively, skipping version.json.
 */
async function copyDir(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath);
    } else {
      await fsp.copyFile(srcPath, dstPath);
    }
  }
}

/**
 * Check for updates and download if available.
 */
async function checkAndDownload(win, appFilesDir) {
  const remote = await fetchRemoteManifest();
  if (!remote) return;

  const local = await readLocalManifest(appFilesDir);
  if (local && local.version === remote.version) return;

  console.log(`Update available: ${local?.version || 'none'} → ${remote.version}`);

  // Diff files
  const localFiles = local?.files || {};
  const changedFiles = [];
  for (const [filePath, hash] of Object.entries(remote.files)) {
    if (localFiles[filePath] !== hash) {
      changedFiles.push({ path: filePath, hash });
    }
  }
  // Files removed in remote
  const removedFiles = Object.keys(localFiles).filter(f => !(f in remote.files));

  if (changedFiles.length === 0 && removedFiles.length === 0) {
    // Only version timestamp changed, no actual file changes
    return;
  }

  console.log(`Downloading ${changedFiles.length} changed files, removing ${removedFiles.length}`);

  const { staging, readyMarker } = getUpdatePaths();

  // Clean up any previous incomplete staging
  try { await fsp.rm(staging, { recursive: true, force: true }); } catch {}

  // Copy current app files to staging as base
  if (fs.existsSync(appFilesDir)) {
    await copyDir(appFilesDir, staging);
  } else {
    await fsp.mkdir(staging, { recursive: true });
  }

  // Download changed files
  const tasks = changedFiles.map(({ path: filePath, hash }) => async () => {
    const buffer = await downloadFile(filePath, hash);
    if (!buffer) return false;
    const destPath = path.join(staging, filePath);
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.writeFile(destPath, buffer);
    return true;
  });

  const results = await pooled(tasks, MAX_CONCURRENT_DOWNLOADS);

  // If any download failed, abort
  if (results.some(r => r === false)) {
    console.error('Some downloads failed, aborting update');
    try { await fsp.rm(staging, { recursive: true, force: true }); } catch {}
    return;
  }

  // Remove files that no longer exist in remote
  for (const filePath of removedFiles) {
    try { await fsp.rm(path.join(staging, filePath), { force: true }); } catch {}
  }

  // Write updated version.json to staging
  await fsp.writeFile(
    path.join(staging, 'version.json'),
    JSON.stringify(remote, null, 2)
  );

  // Mark staging as ready
  await fsp.writeFile(readyMarker, remote.version);

  console.log('Update downloaded and staged. Will apply on next launch.');

  // Notify renderer
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-ready');
  }
}

/**
 * Start the background update checker.
 */
function startUpdateChecker(win, appFilesDir) {
  // Initial check
  checkAndDownload(win, appFilesDir).catch(err => {
    console.error('Update check failed:', err.message);
  });

  // Periodic checks
  setInterval(() => {
    checkAndDownload(win, appFilesDir).catch(err => {
      console.error('Update check failed:', err.message);
    });
  }, CHECK_INTERVAL);
}

module.exports = { applyPendingUpdate, startUpdateChecker };

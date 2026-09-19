import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, posix } from 'node:path';

const outputDir = join(process.cwd(), 'dist');

async function hashFile(filePath) {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

const IGNORE = new Set(['.DS_Store', 'Thumbs.db']);

// Cloudflare Pages consumes these at deploy time and never serves them (they 404
// on eise.app). Listing them in the manifest makes the Electron updater try to
// download them, fail the hash check and abort every update. Keep them out.
const CF_ONLY = new Set(['_headers', '_redirects', '_routes.json']);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

const allFiles = await walk(outputDir);
const files = {};

for (const filePath of allFiles) {
  const rel = posix.join(...relative(outputDir, filePath).split(/[\\/]/));
  if (CF_ONLY.has(rel)) continue;
  files[rel] = await hashFile(filePath);
}

// Cloudflare Pages exposes the deployed commit; the desktop About panel shows it
// next to the release date so a running install can be tied back to a build.
const commit = (process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || '').slice(0, 7) || null;

const manifest = {
  version: new Date().toISOString(),
  commit,
  files
};

const outPath = join(outputDir, 'version.json');
await writeFile(outPath, JSON.stringify(manifest, null, 2));
console.log(`version.json written with ${Object.keys(files).length} files (commit ${commit || 'unknown'})`);

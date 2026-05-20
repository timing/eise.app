import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, posix } from 'node:path';

const outputDir = join(process.cwd(), 'dist');

async function hashFile(filePath) {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

const IGNORE = new Set(['.DS_Store', 'Thumbs.db']);

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
  files[rel] = await hashFile(filePath);
}

const manifest = {
  version: new Date().toISOString(),
  files
};

const outPath = join(outputDir, 'version.json');
await writeFile(outPath, JSON.stringify(manifest, null, 2));
console.log(`version.json written with ${Object.keys(files).length} files`);

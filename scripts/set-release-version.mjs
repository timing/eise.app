// Stamp the desktop release version into every place that has to agree on it.
//
// The version is CalVer (YYYY.MM.DD) and lives in package.json because that is
// the only place electron-builder reads an app version from. It then reaches
// three surfaces that are easy to let drift apart:
//
//   1. package.json "version"      - artifact filenames, Info.plist, deb control
//   2. download.vue RELEASE_VERSION - the version shown on the page + the git tag
//   3. download.vue FILE_VERSION    - the version inside the asset filenames
//
// (2) and (3) differ because electron-builder normalises the version through
// semver, which drops leading zeros: 2026.09.26 is displayed, 2026.9.26 is what
// the files are called. That asymmetry is exactly the kind of thing nobody
// remembers by hand, which is why this is a script and not a checklist.
//
// Usage:
//   node scripts/set-release-version.mjs            # today's date
//   node scripts/set-release-version.mjs 2026.09.26 # explicit override
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function todayCalVer() {
  // Local date, not UTC: the version should match the day the person building
  // it thinks it is, and a UTC rollover would name an evening build tomorrow.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

const arg = process.argv[2];
if (arg && !/^\d{4}\.\d{2}\.\d{2}$/.test(arg)) {
  console.error(`Version must look like YYYY.MM.DD, got "${arg}"`);
  process.exit(1);
}
const displayVersion = arg || todayCalVer();
// How electron-builder will name the artifacts once semver has had it.
const fileVersion = displayVersion.split('.').map(Number).join('.');

function patch(relPath, edits) {
  const path = join(root, relPath);
  let src = readFileSync(path, 'utf8');
  for (const [pattern, replacement] of edits) {
    const matches = src.match(pattern);
    if (!matches) throw new Error(`No match for ${pattern} in ${relPath}`);
    src = src.replace(pattern, replacement);
  }
  writeFileSync(path, src);
}

patch('package.json', [
  [/"version":\s*"[^"]+"/, `"version": "${displayVersion}"`],
]);

patch('pages/download.vue', [
  [/const RELEASE_VERSION = '[^']+';/, `const RELEASE_VERSION = '${displayVersion}';`],
  [/const FILE_VERSION = '[^']+';/, `const FILE_VERSION = '${fileVersion}';`],
]);

console.log(`Release version set to ${displayVersion} (artifacts will be named Eise-${fileVersion}-*)`);
console.log(`  package.json        version = ${displayVersion}`);
console.log(`  pages/download.vue  RELEASE_VERSION = ${displayVersion}, FILE_VERSION = ${fileVersion}`);
console.log(`\nThe download page now points at release tag v${displayVersion}, which does not`);
console.log(`exist until you publish it. Tag and upload the artifacts before deploying the site.`);

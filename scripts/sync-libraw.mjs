// Copies libraw-wasm's runtime files into public/libraw/ so the browser loads
// them as plain static files instead of letting Vite bundle them.
//
// Why not bundle: libraw-wasm's Emscripten pthreads build (dist/libraw.js)
// contains `new Worker(new URL("libraw.js", import.meta.url), {type:"module"})`
// — a reference to ITSELF. Vite resolves `new Worker(new URL())` statically and
// spawns a nested Rollup build for each occurrence, so a self-reference recurses
// without bound and the build dies with "JavaScript heap out of memory". That is
// what broke the 2026-09-20 Cloudflare deploy. `optimizeDeps.exclude` does not
// help: it only governs dev pre-bundling, not the production worker pass.
//
// Why public/ and not nitro.publicAssets pointed at node_modules: Nitro's
// public-asset handler short-circuits before both routeRules and server
// middleware, so those files get no COEP header in dev, and a require-corp page
// then refuses to start the decoder worker (verified: the worker never replies).
// public/ is served by the Vite dev server, which applies the COEP headers from
// nuxt.config.ts, so dev and production behave the same.
//
// public/libraw/ is generated, not committed — see .gitignore. This runs from
// both `postinstall` and `pregenerate`, so a fresh clone and a CI build both
// get it, and it always matches the installed libraw-wasm version.
import { mkdirSync, copyFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Resolve through node_modules rather than hardcoding a path, so hoisted and
// pnpm-style layouts both work.
let src;
try {
	src = dirname(createRequire(import.meta.url).resolve('libraw-wasm'));
} catch {
	console.error('sync-libraw: cannot resolve libraw-wasm. Run npm install first.');
	process.exit(1);
}

// The whole runtime graph: index.js spawns worker.js, worker.js spawns
// libraw.js as its pthread workers, and libraw.js fetches libraw.wasm.
// Deliberately excludes the ~490KB of .map files and index.d.ts, which are
// build-time artefacts with no business in a deployed bundle.
const FILES = ['index.js', 'worker.js', 'libraw.js', 'libraw.wasm'];

const missing = FILES.filter((f) => !existsSync(join(src, f)));
if (missing.length) {
	console.error(`sync-libraw: libraw-wasm is missing ${missing.join(', ')}. Did its dist layout change?`);
	process.exit(1);
}

const dest = join(root, 'public', 'libraw');
// Clear first so a file dropped upstream does not linger in the output.
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const f of FILES) copyFileSync(join(src, f), join(dest, f));

const { version } = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8'));
console.log(`sync-libraw: libraw-wasm@${version} → public/libraw/ (${FILES.join(', ')})`);

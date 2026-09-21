// Runtime smoke test for the LibRaw serving setup.
//
// The 2026-09-20 deploy failed because libraw-wasm was bundled by Vite; the fix
// serves it from public/libraw/ instead (see composables/libRawLoader.js). That
// fix is entirely about *how the files are fetched*, so a build that merely
// compiles proves nothing. This boots a real browser against a built site under
// the same COOP/COEP headers production uses and checks the whole chain:
//
//   /libraw/index.js loads → spawns /libraw/worker.js → worker instantiates
//   /libraw/libraw.wasm → a call round-trips back to the page.
//
// Feeding open() deliberate garbage is the point: a LibRaw *decode* error means
// the wasm ran, whereas a worker/404/COEP failure means the plumbing is broken.
// Those two outcomes are what this distinguishes.
//
// Usage: node scripts/libraw-smoke.mjs [path-to-built-output]   (default .output/public)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = process.argv[2] || '.output/public';
const TYPES = {
	'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
	'.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
};

// Apply the REAL _headers the build emitted, not blanket headers. The whole
// point of this check is whether config/cloudflare_headers.txt actually covers
// the LibRaw files, so inventing permissive headers here would test nothing.
// Cloudflare Pages _headers format: a path pattern on its own line, followed by
// indented or plain `Name: value` lines until the next pattern or blank group.
async function loadHeaderRules() {
	let text;
	try { text = await readFile(join(ROOT, '_headers'), 'utf8'); }
	catch { return null; }
	const rules = [];
	let current = null;
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		if (line.startsWith('/')) { current = { pattern: line, headers: {} }; rules.push(current); continue; }
		const i = line.indexOf(':');
		if (current && i > 0) current.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return rules;
}

const rules = await loadHeaderRules();
if (!rules) { console.error(`No _headers in ${ROOT}. Run the full \`npm run generate\` — postgenerate emits it.`); process.exit(1); }

// `*` in a Pages pattern matches across path segments.
const matches = (pattern, path) =>
	new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(path);

function headersFor(path) {
	const out = {};
	// Later rules win, matching Cloudflare's last-match-wins behaviour.
	for (const r of rules) if (matches(r.pattern, path)) Object.assign(out, r.headers);
	return out;
}

const server = createServer(async (req, res) => {
	const path = normalize(decodeURIComponent(req.url.split('?')[0]));
	if (path.includes('..')) { res.writeHead(403).end(); return; }
	const file = join(ROOT, path.endsWith('/') ? path + 'index.html' : path);
	try {
		const body = await readFile(file);
		res.writeHead(200, {
			'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
			...headersFor(path),
		});
		res.end(body);
	} catch { res.writeHead(404).end('not found'); }
});

await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const failed = [];
const fetched = [];
// Only same-origin failures matter. The analytics beacon points at the
// gallery-api dev port, which is not running here and is not what we test.
page.on('requestfailed', (r) => {
	if (!r.url().startsWith(base)) return;
	const u = r.url().replace(base, '');
	if (u.startsWith('/a/')) return;
	failed.push(`${u} — ${r.failure()?.errorText}`);
});
page.on('response', (r) => {
	const u = r.url().replace(base, '');
	if (u.startsWith('/libraw/')) fetched.push(`${u} → ${r.status()}`);
	// /a/event is the analytics beacon; it has no backend here and is not our concern.
	if (r.status() >= 400 && !u.startsWith('/a/')) failed.push(`${u} — HTTP ${r.status()}`);
});

await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

const result = await page.evaluate(async () => {
	const out = { crossOriginIsolated: globalThis.crossOriginIsolated };
	try {
		const mod = await import('/libraw/index.js');
		out.moduleLoaded = true;
		out.hasCtor = typeof mod.default === 'function';
		const raw = new mod.default();
		// Garbage in. Either outcome is fine on its own terms; what matters is
		// that the call round-trips through the worker at all, and that the
		// wasm fetch below actually happened.
		try {
			await raw.open(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {});
			out.openResolved = true;
		} catch (e) {
			out.openRejectedWith = String(e?.message || e);
		}
		// metadata() forces a second round-trip and reads real wasm memory, so a
		// structured reply here means the module is genuinely running.
		try {
			const md = await raw.metadata(false);
			out.metadataType = md === undefined ? 'undefined' : typeof md;
			out.metadataKeys = md && typeof md === 'object' ? Object.keys(md).length : 0;
		} catch (e) {
			out.metadataRejectedWith = String(e?.message || e);
		}
		raw.dispose?.();
	} catch (e) {
		out.loadError = String(e?.message || e);
	}
	return out;
});

await browser.close();
server.close();

console.log(JSON.stringify(result, null, 2));
console.log('\n/libraw/ requests:\n  ' + (fetched.join('\n  ') || '(none — the chain never started)'));
console.log('\nHeaders applied from the emitted _headers:');
for (const f of ['/libraw/index.js', '/libraw/worker.js', '/libraw/libraw.wasm']) {
	const h = headersFor(f);
	console.log(`  ${f} → ${Object.keys(h).length ? JSON.stringify(h) : 'NO MATCHING RULE'}`);
}
if (failed.length) console.log('\nFailed requests:\n  ' + failed.join('\n  '));

// Every link must be observable, not inferred:
//   - the page is cross-origin isolated (COOP/COEP correct for shared memory)
//   - index.js, worker.js and libraw.wasm were each served 200
//   - a call round-tripped through the worker and came back
const served = (name) => fetched.some((f) => f.startsWith(`/libraw/${name} → 200`));
const checks = {
	crossOriginIsolated: result.crossOriginIsolated === true,
	moduleLoaded: result.moduleLoaded === true && result.hasCtor === true,
	'index.js served': served('index.js'),
	'worker.js served': served('worker.js'),
	'libraw.wasm served': served('libraw.wasm'),
	'call round-tripped': result.openResolved === true || typeof result.openRejectedWith === 'string',
	'no failed requests': failed.length === 0,
};

console.log('');
for (const [name, pass] of Object.entries(checks)) console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`);

const ok = Object.values(checks).every(Boolean);
console.log(`\n${ok ? 'PASS' : 'FAIL'}: libraw load chain`);
process.exit(ok ? 0 : 1);

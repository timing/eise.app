// Scans pages/ and writes public/sitemap.xml with every public route.
// Run whenever new pages are added. Wired into `pregenerate` so `nuxt generate`
// always produces a fresh sitemap.
//
// Usage:
//   node scripts/generate-sitemap.mjs
//
// A route is omitted when any of these hold:
//   1. its page (or a parent route file, e.g. pages/admin.vue for /admin/ab/)
//      declares `noindex`
//   2. robots.txt disallows it
//   3. it is listed in EXCLUDE below
//
// (1) and (2) are derived from the source, not from a hand-maintained list, so
// a new internal page cannot leak into the sitemap by someone forgetting to
// update this file. The script then re-verifies every emitted URL against both
// rules and exits non-zero on a violation, which fails `nuxt generate`.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(repoRoot, 'pages');
const OUT_PATH = path.join(repoRoot, 'public', 'sitemap.xml');
const ROBOTS_PATH = path.join(repoRoot, 'public', 'robots.txt');

const BASE_URL = 'https://eise.app';

// Routes to exclude that are NOT already covered by noindex or robots.txt.
// Prefer adding `noindex` to the page itself over adding an entry here.
const EXCLUDE = new Set([]);

// Collect { route, file } pairs. `file` is relative to pages/.
async function walk(dir, prefix = '') {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const found = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...(await walk(full, prefix + '/' + entry.name)));
		} else if (entry.isFile() && entry.name.endsWith('.vue')) {
			const base = entry.name.replace(/\.vue$/, '');
			if (base.startsWith('[') || base.startsWith('_')) continue; // dynamic / private
			const route = base === 'index' ? prefix + '/' : prefix + '/' + base + '/';
			found.push({
				route: route.replace(/\/+/g, '/'),
				file: path.relative(PAGES_DIR, full),
			});
		}
	}
	return found;
}

// Nuxt treats pages/admin.vue as the parent route of pages/admin/*, so a
// noindex declared there applies to every child. Walk the ancestor chain.
function ancestorRouteFiles(file) {
	const segments = file.replace(/\.vue$/, '').split(path.sep);
	const ancestors = [];
	for (let i = 1; i < segments.length; i++) {
		ancestors.push(segments.slice(0, i).join(path.sep) + '.vue');
	}
	return ancestors;
}

const robotsTxt = await fs.readFile(ROBOTS_PATH, 'utf8');
const disallowed = robotsTxt
	.split('\n')
	.map(line => line.match(/^\s*Disallow:\s*(\S+)/i)?.[1])
	.filter(Boolean);

function isDisallowed(route) {
	return disallowed.some(rule => route.startsWith(rule));
}

const sourceCache = new Map();
async function declaresNoindex(file) {
	if (!sourceCache.has(file)) {
		sourceCache.set(file, await fs.readFile(path.join(PAGES_DIR, file), 'utf8').catch(() => ''));
	}
	return /noindex/.test(sourceCache.get(file));
}

async function reasonToSkip({ route, file }) {
	if (EXCLUDE.has(route.replace(/\/$/, ''))) return 'EXCLUDE list';
	// noindex first: it is the more informative reason when both apply.
	for (const candidate of [file, ...ancestorRouteFiles(file)]) {
		if (await declaresNoindex(candidate)) return `noindex in pages/${candidate}`;
	}
	if (isDisallowed(route)) return 'robots.txt Disallow';
	return null;
}

const pages = await walk(PAGES_DIR);
const included = [];
const skipped = [];
for (const page of pages) {
	const reason = await reasonToSkip(page);
	if (reason) skipped.push({ ...page, reason });
	else included.push(page.route);
}

// pages/admin.vue and pages/admin/index.vue both resolve to /admin/, so the
// route list needs deduping before it becomes XML.
const routes = [...new Set(included)].sort();

// Belt and braces: re-check the final list rather than trusting the filter
// above to have stayed correct through future edits.
const violations = [];
for (const route of routes) {
	if (isDisallowed(route)) violations.push(`${route} is disallowed in robots.txt`);
	const page = pages.find(p => p.route === route);
	if (!page) continue;
	for (const candidate of [page.file, ...ancestorRouteFiles(page.file)]) {
		if (await declaresNoindex(candidate)) violations.push(`${route} is noindex (pages/${candidate})`);
	}
}
if (violations.length) {
	console.error('Refusing to write sitemap, non-indexable routes present:');
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}

// Gallery images, attached to /gallery/ as <image:image> entries so Google
// Images can discover them without crawling and rendering the page first.
//
// Deliberately fail-soft: a sitemap missing its image block is a minor SEO
// loss, while a failed build over a third-party fetch is an outage. If the API
// is unreachable we warn loudly and emit the plain sitemap.
//
// Google caps this at 1,000 images per URL. We are well under; revisit if the
// gallery ever approaches it, and note that per-image pages (see
// GALLERY_SEO_PLAN.md item 3) would move these entries to their own URLs.
const GALLERY_API = 'https://gallery.eise.app/submissions?limit=200';

function xmlEscape(s) {
	return String(s).replace(/[<>&'"]/g, (ch) => (
		{ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]
	));
}

async function galleryImages() {
	try {
		const res = await fetch(GALLERY_API, { signal: AbortSignal.timeout(15000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = await res.json();
		return (body.items || []).filter((i) => i.image_url);
	} catch (err) {
		console.warn(`\nWARNING: gallery images omitted from sitemap (${err.message}).`);
		console.warn('The sitemap is still valid; re-run the build once the API is reachable.');
		return [];
	}
}

const images = await galleryImages();
const imageBlock = images
	.map((i) => {
		const title = i.title ? `${i.title} by ${i.name}` : `Planetary stack by ${i.name}`;
		return `\t\t<image:image>\n` +
			`\t\t\t<image:loc>${xmlEscape(i.image_url)}</image:loc>\n` +
			`\t\t\t<image:title>${xmlEscape(title)}</image:title>\n` +
			`\t\t</image:image>`;
	})
	.join('\n');

const xml =
	`<?xml version="1.0" encoding="UTF-8"?>\n` +
	`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
	`        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
	routes.map((r) => {
		const extra = r === '/gallery/' && imageBlock ? `\n${imageBlock}` : '';
		return `\t<url>\n\t\t<loc>${BASE_URL}${r}</loc>${extra}\n\t</url>`;
	}).join('\n') +
	`\n</urlset>\n`;

await fs.writeFile(OUT_PATH, xml);
console.log(`Wrote ${routes.length} routes to ${path.relative(repoRoot, OUT_PATH)}`);
for (const r of routes) console.log(`  ${r}`);
if (skipped.length) {
	console.log(`\nSkipped ${skipped.length}:`);
	for (const s of skipped.sort((a, b) => a.route.localeCompare(b.route))) {
		console.log(`  ${s.route}  (${s.reason})`);
	}
}

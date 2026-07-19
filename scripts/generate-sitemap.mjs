// Scans pages/ and writes public/sitemap.xml with every public route.
// Run whenever new pages are added. Wired into `pregenerate` so `nuxt generate`
// always produces a fresh sitemap.
//
// Usage:
//   node scripts/generate-sitemap.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(repoRoot, 'pages');
const OUT_PATH = path.join(repoRoot, 'public', 'sitemap.xml');

const BASE_URL = 'https://eise.app';

// Routes to exclude from the public sitemap (dev-only, internal, etc.)
const EXCLUDE = new Set([
	'/design-system', // internal design reference
]);

async function walk(dir, prefix = '') {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const routes = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			routes.push(...(await walk(full, prefix + '/' + entry.name)));
		} else if (entry.isFile() && entry.name.endsWith('.vue')) {
			const base = entry.name.replace(/\.vue$/, '');
			if (base.startsWith('[') || base.startsWith('_')) continue; // dynamic / private
			const route = base === 'index' ? prefix + '/' : prefix + '/' + base + '/';
			routes.push(route.replace(/\/+/g, '/'));
		}
	}
	return routes;
}

const routes = (await walk(PAGES_DIR))
	.filter((r) => !EXCLUDE.has(r.replace(/\/$/, '')))
	.map((r) => (r === '/' ? '/' : r))
	.sort();

const xml =
	`<?xml version="1.0" encoding="UTF-8"?>\n` +
	`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
	routes.map((r) => `\t<url>\n\t\t<loc>${BASE_URL}${r}</loc>\n\t</url>`).join('\n') +
	`\n</urlset>\n`;

await fs.writeFile(OUT_PATH, xml);
console.log(`Wrote ${routes.length} routes to ${path.relative(repoRoot, OUT_PATH)}`);
for (const r of routes) console.log(`  ${r}`);

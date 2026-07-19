// Screenshots a set of eise.app pages at desktop + mobile widths for visual review.
// The dev server (npm run dev on :3000) must be running.
//
// Usage:
//   node scripts/screenshot-pages.mjs [outputDir]
//
// Default outputDir: screenshots/YYYY-MM-DD-HH-mm

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const PAGES = [
	'/',
	'/download/',
	'/about/',
	'/about/help/',
	'/about/architecture/',
	'/about/planetary-stacking-software-comparison/',
	'/tools/',
	'/post-processor/',
];

const VIEWPORTS = [
	{ label: 'desktop', width: 1280, height: 900 },
	{ label: 'mobile', width: 390, height: 844 },
];

const BASE = process.env.EISE_BASE_URL || 'http://localhost:3000';

function slug(urlPath) {
	return urlPath === '/' ? 'home' : urlPath.replace(/^\/|\/$/g, '').replace(/\//g, '_');
}

const outDir = path.resolve(repoRoot, process.argv[2] || `screenshots/${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`);
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
try {
	for (const vp of VIEWPORTS) {
		const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
		const page = await context.newPage();
		for (const p of PAGES) {
			try {
				await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle', timeout: 15000 });
			} catch {
				await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
			}
			await page.waitForTimeout(500);
			const outPath = path.join(outDir, `${slug(p)}-${vp.label}.png`);
			await page.screenshot({ path: outPath, fullPage: true });
			console.log(`  ${path.relative(repoRoot, outPath)}`);
		}
		await context.close();
	}
} finally {
	await browser.close();
}

console.log(`\nWrote ${VIEWPORTS.length * PAGES.length} screenshots to ${path.relative(repoRoot, outDir)}`);

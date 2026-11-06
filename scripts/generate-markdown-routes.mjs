// Writes a Markdown twin of every public page into the build output, so AI
// agents and assistants can fetch /about/help.md instead of parsing ~70 KB of
// HTML to find ~3 KB of prose.
//
// Usage:
//   node scripts/generate-markdown-routes.mjs [distDir]
//
// Wired into `postgenerate`, AFTER config/cloudflare_headers.txt is copied to
// dist/_headers (this script merges Link/Content-Type rules into that file).
//
// The Markdown is derived from the prerendered HTML on every build, so it can
// never drift from the page. Never hand-edit the .md files; they are build
// output and are not in git. To change what an agent reads, change the page.
//
// Route list comes from dist/sitemap.xml, which generate-sitemap.mjs already
// filters down to indexable pages. That keeps /admin/ and /design-system/ out
// without a second exclusion list to forget about.
//
// Three things are emitted per route (the "advertise it two ways" advice from
// evilmartians.com/chronicles/how-to-make-your-website-visible-to-llms):
//   1. dist/<route>.md                            the payload
//   2. <link rel="alternate"> in the page <head>  for DOM-parsing crawlers
//   3. Link: header in dist/_headers              for headless agents
//
// Content negotiation on `Accept: text/markdown` is NOT done here; that needs a
// Cloudflare Pages Function. These static files are the prerequisite for it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWindow } from '@mixmark-io/domino';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'dist'));

const BASE_URL = 'https://eise.app';

// Stripped before conversion: either invisible to a reader, or UI chrome that
// converts into meaningless bullet soup.
const DROP_SELECTORS = [
	'script',
	'style',
	'noscript',
	'template',
	'svg',
	'canvas',
	'iframe',
	'input',
	'select',
	'textarea',
	'[aria-hidden="true"]',
	'[hidden]',
	// Vue renders v-show="false" as an inline display:none, which is how the
	// Bayer picker, the quality selector and the stacking progress panel sit in
	// the prerendered home page. A reader never sees them, so neither should a
	// Markdown client.
	'[style*="display:none"]',
	'[style*="display: none"]',
];

// Below this many characters of body text a page is a pure app surface (the
// post processor, for instance) with no prose worth serving. It gets no .md
// file and no <link>, because advertising an empty Markdown twin is worse than
// advertising none.
const MIN_BODY_CHARS = 200;

const turndown = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced',
	bulletListMarker: '-',
	emDelimiter: '*',
});
turndown.use(gfm);

// A <button> is an action, not prose. Keep the label as plain text so a reader
// can still tell what the page offers, but drop the markup around it.
turndown.addRule('buttonLabel', {
	filter: ['button'],
	replacement: (content) => (content.trim() ? `${content.trim()} ` : ''),
});

// Sibling <span>s and <label>s are laid out as blocks by CSS but are inline in
// the markup, so without this they concatenate into "Drop files hereor browse".
// tidy() collapses the double spaces this leaves mid-sentence.
turndown.addRule('spacedInline', {
	filter: ['span', 'label'],
	replacement: (content) => (content.trim() ? `${content.trim()} ` : ''),
});

// Images carry alt text worth keeping, but the src is a hashed asset URL that
// is pure token cost for a text client. Keep alt, drop the link.
turndown.addRule('imageAltOnly', {
	filter: 'img',
	replacement: (_content, node) => {
		const alt = (node.getAttribute('alt') || '').trim();
		return alt ? `(image: ${alt})` : '';
	},
});

function routeToMarkdownPath(route) {
	// '/' -> '/index.md', '/about/help/' -> '/about/help.md'
	return route === '/' ? '/index.md' : `${route.replace(/\/$/, '')}.md`;
}

function extractMain(document, route) {
	const main = document.querySelector('main.app-content') || document.querySelector('.app-content');
	if (!main) {
		throw new Error(
			`No <main class="app-content"> in ${route}. layouts/default.vue must wrap <slot /> in it.`,
		);
	}
	for (const selector of DROP_SELECTORS) {
		// domino's NodeList is array-like but not iterable, hence Array.from.
		for (const node of Array.from(main.querySelectorAll(selector))) node.remove();
	}
	// A client that fetched only the Markdown has no base URL to resolve
	// /about/ against, so site-relative links become absolute.
	for (const link of Array.from(main.querySelectorAll('a[href^="/"]'))) {
		link.setAttribute('href', BASE_URL + link.getAttribute('href'));
	}
	return main;
}

function tidy(markdown) {
	return markdown
		.replace(/ /g, ' ')
		// Mid-line runs only: leading spaces carry list and code-block indentation.
		.replace(/(\S) {2,}/g, '$1 ')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

async function convertRoute(route) {
	const htmlPath = path.join(distDir, route, 'index.html');
	// A sitemap route with no prerendered HTML means Nuxt's crawler never
	// reached it. Worth shouting about, but not worth failing a deploy over.
	const html = await fs.readFile(htmlPath, 'utf8').catch(() => null);
	if (html === null) return { route, skipped: 'not prerendered, no index.html' };
	const document = createWindow(html).document;

	const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
	const body = tidy(turndown.turndown(extractMain(document, route).innerHTML));

	if (body.length < MIN_BODY_CHARS) return { route, skipped: `only ${body.length} chars of prose` };

	// Attribution first, so a client that only has this file knows where it
	// came from. No instructions to the model here: an .md route is a
	// prompt-injection surface and is kept to plain content.
	const markdown = [
		`*Markdown version of <${BASE_URL}${route}>*`,
		...(description ? [`> ${description}`] : []),
		body,
		'',
	].join('\n\n');

	const mdRoute = routeToMarkdownPath(route);
	await fs.writeFile(path.join(distDir, mdRoute), markdown.replace(/\n{3,}/g, '\n\n'));

	await injectAlternateLink(htmlPath, html, mdRoute);
	return { route, mdRoute, bytes: Buffer.byteLength(markdown), htmlBytes: Buffer.byteLength(html) };
}

// <link rel="alternate" type="text/markdown"> in the page itself, for crawlers
// that parse the DOM but do not send an Accept header.
async function injectAlternateLink(htmlPath, html, mdRoute) {
	const tag = `<link rel="alternate" type="text/markdown" href="${mdRoute}">`;
	if (html.includes(`type="text/markdown" href="${mdRoute}"`)) return;
	if (!html.includes('</head>')) throw new Error(`No </head> in ${htmlPath}`);
	await fs.writeFile(htmlPath, html.replace('</head>', `${tag}</head>`));
}

// Merge rules into dist/_headers without disturbing what is already there.
// Appending a second block for an existing path (notably `/`, which carries the
// COEP header the whole app depends on) would be ambiguous, so headers for a
// path that already has a block are inserted into that block instead.
function mergeHeaders(existing, rules) {
	const lines = existing.replace(/\n+$/, '').split('\n');
	// In this file both path lines and header lines sit at column 0, so a path
	// line is identified by its leading slash, not by indentation.
	const isPathLine = (line) => line.startsWith('/') || line.startsWith('http');

	for (const [rulePath, headers] of rules) {
		let start = lines.findIndex((line) => line.trim() === rulePath);
		if (start === -1) {
			lines.push('', rulePath);
			start = lines.length - 1;
		}
		let end = start + 1;
		while (end < lines.length && !isPathLine(lines[end])) end++;

		const block = lines.slice(start + 1, end);
		const missing = headers.filter((h) => !block.some((line) => line.trim() === h));
		// Land after the block's last header, not after the blank line that
		// separates it from the next block.
		let insertAt = end;
		while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
		lines.splice(insertAt, 0, ...missing);
	}
	return `${lines.join('\n')}\n`;
}

const sitemap = await fs.readFile(path.join(distDir, 'sitemap.xml'), 'utf8');
const routes = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
	.map((m) => m[1].replace(BASE_URL, ''))
	.filter((route) => route.startsWith('/'));

if (!routes.length) {
	console.error('No routes in sitemap.xml, refusing to continue.');
	process.exit(1);
}

const all = [];
for (const route of routes) {
	all.push(await convertRoute(route));
}
const results = all.filter((r) => !r.skipped);
const skipped = all.filter((r) => r.skipped);

const rules = [];
for (const { route, mdRoute } of results) {
	rules.push([route, [`Link: <${mdRoute}>; rel="alternate"; type="text/markdown"`]]);
	rules.push([
		mdRoute,
		[
			// Cloudflare Pages maps .md to text/markdown itself, but x-content-type-options
			// is nosniff site-wide, so this is stated rather than assumed.
			'Content-Type: text/markdown; charset=utf-8',
			`Link: <${route}>; rel="alternate"; type="text/html"`,
			'Cache-Control: public, max-age=0, must-revalidate',
		],
	]);
}

const headersPath = path.join(distDir, '_headers');
const headers = await fs.readFile(headersPath, 'utf8');
await fs.writeFile(headersPath, mergeHeaders(headers, rules));

const htmlTotal = results.reduce((sum, r) => sum + r.htmlBytes, 0);
const mdTotal = results.reduce((sum, r) => sum + r.bytes, 0);
console.log(`Wrote ${results.length} Markdown routes to ${path.relative(repoRoot, distDir) || distDir}`);
for (const r of results.sort((a, b) => a.mdRoute.localeCompare(b.mdRoute))) {
	console.log(`  ${r.mdRoute.padEnd(44)} ${String(Math.round(r.bytes / 1024)).padStart(3)} KB  (html ${Math.round(r.htmlBytes / 1024)} KB)`);
}
console.log(`Total ${Math.round(mdTotal / 1024)} KB of Markdown vs ${Math.round(htmlTotal / 1024)} KB of HTML`);
if (skipped.length) {
	console.log(`\nSkipped ${skipped.length} (no Markdown twin, no <link>, no Link: header):`);
	for (const s of skipped) console.log(`  ${s.route.padEnd(44)} ${s.skipped}`);
}

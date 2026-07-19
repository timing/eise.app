// Classifies GSC queries by likely language using simple heuristics:
// - non-Latin script (CJK, Cyrillic, Arabic, etc.) → strong signal
// - characteristic stop-words in Latin-script languages
// The goal is a rough breakdown of non-English demand, not exact classification.
//
// Usage:
//   node scripts/gsc-query-languages.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SEO_DIR = path.join(repoRoot, 'seo-data');

const files = fs.readdirSync(SEO_DIR).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
const agg = new Map();
for (const f of files) {
	const m = JSON.parse(fs.readFileSync(path.join(SEO_DIR, f), 'utf8'));
	for (const day of Object.values(m.days ?? {})) {
		for (const r of day.byQuery ?? []) {
			const cur = agg.get(r.query) || { clicks: 0, impressions: 0 };
			cur.clicks += r.clicks;
			cur.impressions += r.impressions;
			agg.set(r.query, cur);
		}
	}
}

// High-signal stopwords only — words that are unlikely to false-match English text.
// (e.g. "astrophoto" is French but also English, so it's dropped.)
const STOPWORDS = {
	pt: [' com ', ' no ', ' na ', ' uma ', ' um ', 'como ', 'melhor', 'não', 'está', 'grátis', 'imagem', 'astrofotografia', 'planeta '],
	es: [' que ', ' con ', ' para ', ' una ', ' mejor ', 'cómo', 'gratis', 'imagen', 'astrofotografía', 'planeta '],
	fr: [' pour ', ' avec ', ' sans ', ' comment ', ' meilleur ', 'gratuit', 'traitement d’image', 'lune'],
	de: [' und ', ' für ', ' mit ', ' ohne ', 'kostenlos', 'beste ', 'bilder', 'mondbilder'],
	it: [' per ', ' migliore ', 'astrofotografia', 'immagine', 'sovrapposizione'],
	nl: [' voor ', ' met ', ' zonder ', 'beste ', 'gratis '],
	pl: [' dla ', ' bez ', 'najlepszy', 'darmowy'],
	tr: [' için ', ' ile ', 'ücretsiz', 'astrofotoğraf'],
	id: [' yang ', ' dan ', ' untuk ', ' cara ', ' gratis '],
};

const RE_CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
const RE_CYRILLIC = /[Ѐ-ӿ]/;
const RE_ARABIC = /[؀-ۿ]/;
const RE_DEVANAGARI = /[ऀ-ॿ]/;
const RE_THAI = /[฀-๿]/;

function classify(q) {
	if (RE_CJK.test(q)) return 'CJK (JP/CN/KR)';
	if (RE_CYRILLIC.test(q)) return 'Cyrillic (RU/UA/BG)';
	if (RE_ARABIC.test(q)) return 'Arabic';
	if (RE_DEVANAGARI.test(q)) return 'Devanagari (HI/MR)';
	if (RE_THAI.test(q)) return 'Thai';
	// Diacritics as a weak signal
	const q2 = ' ' + q.toLowerCase() + ' ';
	for (const [lang, sw] of Object.entries(STOPWORDS)) {
		for (const w of sw) if (q2.includes(w)) return lang;
	}
	if (/[ãõáéíóúâêîôû]/i.test(q)) return 'Latin-diacritic (PT/ES/IT/FR)';
	if (/[äöüß]/.test(q)) return 'de';
	if (/[ąęłńśźż]/.test(q)) return 'pl';
	return 'en/unknown';
}

const buckets = new Map();
for (const [query, stats] of agg) {
	const lang = classify(query);
	const b = buckets.get(lang) || { clicks: 0, impressions: 0, queries: [] };
	b.clicks += stats.clicks;
	b.impressions += stats.impressions;
	b.queries.push({ query, ...stats });
	buckets.set(lang, b);
}

const sorted = [...buckets.entries()].sort((a, b) => b[1].impressions - a[1].impressions);
console.log('Query language classification (60 days of GSC data):');
console.log('=========================================================');
for (const [lang, b] of sorted) {
	console.log(`\n${lang.padEnd(30)} impressions: ${b.impressions.toString().padStart(6)}   clicks: ${b.clicks.toString().padStart(4)}   unique queries: ${b.queries.length}`);
	if (lang !== 'en/unknown') {
		b.queries.sort((a, c) => c.impressions - a.impressions);
		for (const q of b.queries.slice(0, 8)) {
			console.log(`   "${q.query}" — imp:${q.impressions} clicks:${q.clicks}`);
		}
	}
}

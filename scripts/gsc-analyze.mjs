// Reads all seo-data/YYYY-MM.json snapshots and prints aggregated periods
// (last 7d vs prev 7d, last 28d vs prev 28d) plus top winners/losers and
// opportunity-keyword buckets. Consumed by the /seo-report skill.
//
// Usage:
//   node scripts/gsc-analyze.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SEO_DIR = path.join(repoRoot, 'seo-data');

const files = fs.readdirSync(SEO_DIR).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
if (files.length === 0) {
	console.error('No data in seo-data/. Run scripts/gsc-fetch.mjs first.');
	process.exit(1);
}

const allDays = {};
for (const f of files) {
	const m = JSON.parse(fs.readFileSync(path.join(SEO_DIR, f), 'utf8'));
	Object.assign(allDays, m.days);
}

const sortedDates = Object.keys(allDays).sort();
const latest = sortedDates[sortedDates.length - 1];
const earliest = sortedDates[0];

function addDaysStr(s, n) {
	const d = new Date(s + 'T00:00:00Z');
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

function periodDays(endStr, n) {
	const days = [];
	for (let i = 0; i < n; i++) days.push(addDaysStr(endStr, -i));
	return days.reverse();
}

function aggPeriod(dayList) {
	let clicks = 0, impressions = 0, posNum = 0;
	const byQuery = {};
	const byPage = {};
	for (const d of dayList) {
		const day = allDays[d];
		if (!day) continue;
		clicks += day.totals.clicks;
		impressions += day.totals.impressions;
		posNum += day.totals.position * day.totals.impressions;
		for (const r of day.byQuery) {
			(byQuery[r.query] ||= { clicks: 0, impressions: 0, posNum: 0 });
			byQuery[r.query].clicks += r.clicks;
			byQuery[r.query].impressions += r.impressions;
			byQuery[r.query].posNum += r.position * r.impressions;
		}
		for (const r of day.byPage) {
			(byPage[r.page] ||= { clicks: 0, impressions: 0, posNum: 0 });
			byPage[r.page].clicks += r.clicks;
			byPage[r.page].impressions += r.impressions;
			byPage[r.page].posNum += r.position * r.impressions;
		}
	}
	const finalize = (m, keyName) => Object.entries(m).map(([k, v]) => ({
		[keyName]: k,
		clicks: v.clicks,
		impressions: v.impressions,
		ctr: v.impressions ? v.clicks / v.impressions : 0,
		position: v.impressions ? v.posNum / v.impressions : 0,
	}));
	return {
		days: dayList.length,
		totals: {
			clicks,
			impressions,
			ctr: impressions ? clicks / impressions : 0,
			position: impressions ? posNum / impressions : 0,
		},
		byQuery: finalize(byQuery, 'query'),
		byPage: finalize(byPage, 'page'),
	};
}

const enoughFor28 = new Date(latest) - new Date(earliest) >= 55 * 86400 * 1000;

const last7 = aggPeriod(periodDays(latest, 7));
const prev7 = aggPeriod(periodDays(addDaysStr(latest, -7), 7));
const last28 = enoughFor28 ? aggPeriod(periodDays(latest, 28)) : null;
const prev28 = enoughFor28 ? aggPeriod(periodDays(addDaysStr(latest, -28), 28)) : null;

// Diff query-level between last7 and prev7
const p7q = Object.fromEntries(prev7.byQuery.map((r) => [r.query, r]));
const seen = new Set();
const queryDiffs = last7.byQuery.map((r) => {
	seen.add(r.query);
	const prev = p7q[r.query] || { clicks: 0, impressions: 0, position: r.position, ctr: 0 };
	return {
		query: r.query,
		clicksDelta: r.clicks - prev.clicks,
		curClicks: r.clicks,
		prevClicks: prev.clicks,
		curImp: r.impressions,
		curPos: r.position,
		prevPos: prev.position,
		curCtr: r.ctr,
	};
});
for (const r of prev7.byQuery) {
	if (!seen.has(r.query)) {
		queryDiffs.push({
			query: r.query,
			clicksDelta: 0 - r.clicks,
			curClicks: 0,
			prevClicks: r.clicks,
			curImp: 0,
			curPos: 0,
			prevPos: r.position,
			curCtr: 0,
		});
	}
}
queryDiffs.sort((a, b) => b.clicksDelta - a.clicksDelta);

// Opportunity buckets in last 28d (fallback to last 7d if 28 not available)
const opWindow = last28 || last7;
const opLabel = last28 ? 'last 28d' : 'last 7d';
const oppLowCtr = opWindow.byQuery
	.filter((r) => r.impressions > 100 && r.ctr < 0.02)
	.sort((a, b) => b.impressions - a.impressions);
const oppPositionBump = opWindow.byQuery
	.filter((r) => r.position >= 4 && r.position <= 15 && r.impressions > 50)
	.sort((a, b) => b.impressions - a.impressions);

// Query -> page mapping in the opportunity window (best page per query by clicks then impressions)
function bestPagesForQuery(qList) {
	// We need per-query per-page split; re-scan days in the opportunity window.
	const rangeStart = opWindow === last28 ? addDaysStr(latest, -27) : addDaysStr(latest, -6);
	const pageForQuery = {};
	// We don't have per-query per-page in per-day structures, but pages that rank for a query
	// can be approximated via the query's top pages in the raw byPage list — skip if not present.
	// The GSC "byQueryAndPage" dimension isn't stored per-day (fetcher only stores byQuery and byPage per day).
	// Report the best-guess page = the top page for the site in that window.
	// (If we need exact query->page attribution, extend the fetcher.)
	return pageForQuery;
}

const topPages28 = (opWindow.byPage || []).slice().sort((a, b) => b.impressions - a.impressions);

// Sitemap + URL inspection summary — pull from the most recent monthly file that has them
let sitemapSummary = null;
let inspectionSummary = null;
for (let i = files.length - 1; i >= 0; i--) {
	const m = JSON.parse(fs.readFileSync(path.join(SEO_DIR, files[i]), 'utf8'));
	if (!sitemapSummary && m.sitemaps) {
		const s = Array.isArray(m.sitemaps) ? { entries: m.sitemaps } : m.sitemaps;
		sitemapSummary = { fetchedAt: s.fetchedAt ?? null, entries: s.entries ?? [] };
	}
	if (!inspectionSummary && m.urlInspections) {
		inspectionSummary = m.urlInspections.map((i) => ({
			url: i.url,
			verdict: i.result?.indexStatusResult?.verdict ?? null,
			coverageState: i.result?.indexStatusResult?.coverageState ?? null,
			robotsTxtState: i.result?.indexStatusResult?.robotsTxtState ?? null,
			indexingState: i.result?.indexStatusResult?.indexingState ?? null,
			error: i.error ?? null,
		}));
	}
	if (sitemapSummary && inspectionSummary) break;
}

const report = {
	dataRange: { earliest, latest, days: sortedDates.length },
	last7: last7.totals,
	prev7: prev7.totals,
	last28: last28?.totals ?? null,
	prev28: prev28?.totals ?? null,
	topQueryWinners: queryDiffs.filter((d) => d.clicksDelta > 0).slice(0, 10),
	topQueryLosers: queryDiffs.filter((d) => d.clicksDelta < 0).slice(-10).reverse(),
	opportunityLowCtr: oppLowCtr.slice(0, 20),
	opportunityPositionBump: oppPositionBump.slice(0, 20),
	opportunityWindow: opLabel,
	topPages: topPages28.slice(0, 15),
	sitemap: sitemapSummary,
	urlInspections: inspectionSummary,
};

console.log(JSON.stringify(report, null, 2));

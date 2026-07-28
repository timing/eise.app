// Fetches Google Search Console data for eise.app and stores it as per-month
// files in seo-data/YYYY-MM.json. On each run it detects which days are still
// missing (accounting for the ~2 day GSC lag) and fetches only those.
//
// Usage:
//   node scripts/gsc-fetch.mjs
//
// Env overrides:
//   GSC_KEY_PATH        service account JSON path  (default: config/eise-app-6c61a2c13464.json)
//   GSC_SITE_URL        GSC property identifier    (default: sc-domain:eise.app)
//                       Use 'https://eise.app/' for a URL-prefix property.
//   GSC_BACKFILL_DAYS   first-run lookback         (default: 60)

import { google } from 'googleapis';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const KEY_PATH = path.resolve(repoRoot, process.env.GSC_KEY_PATH || 'config/eise-app-6c61a2c13464.json');
const SITE_URL = process.env.GSC_SITE_URL || 'sc-domain:eise.app';
const INITIAL_BACKFILL_DAYS = parseInt(process.env.GSC_BACKFILL_DAYS || '60', 10);
const SEO_DIR = path.join(repoRoot, 'seo-data');

const auth = new google.auth.GoogleAuth({
	keyFile: KEY_PATH,
	scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});
const webmasters = google.webmasters({ version: 'v3', auth });
const searchconsole = google.searchconsole({ version: 'v1', auth });

const fmt = (d) => d.toISOString().slice(0, 10);
const monthKey = (dOrStr) => (typeof dOrStr === 'string' ? dOrStr : fmt(dOrStr)).slice(0, 7);
const parseDate = (s) => new Date(s + 'T00:00:00Z');
const addDays = (d, n) => { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; };

async function loadMonth(month) {
	const p = path.join(SEO_DIR, `${month}.json`);
	try {
		return JSON.parse(await fs.readFile(p, 'utf8'));
	} catch {
		return { month, days: {}, lastFetchedAt: null };
	}
}

async function saveMonth(month, data) {
	await fs.mkdir(SEO_DIR, { recursive: true });
	const p = path.join(SEO_DIR, `${month}.json`);
	await fs.writeFile(p, JSON.stringify(data, null, 2));
	return p;
}

// Find every day in [oldest we care about, endDate] that isn't in any monthly file yet.
async function findMissingDays(endDate) {
	const files = (await fs.readdir(SEO_DIR).catch(() => []))
		.filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
		.sort();

	const covered = new Set();
	let latestCovered = null;
	for (const f of files) {
		const m = await loadMonth(f.replace('.json', ''));
		for (const d of Object.keys(m.days)) {
			covered.add(d);
			if (!latestCovered || d > latestCovered) latestCovered = d;
		}
	}

	// Start point: day after latest covered, or backfill window on first run
	const startFrom = latestCovered
		? addDays(parseDate(latestCovered), 1)
		: addDays(endDate, -(INITIAL_BACKFILL_DAYS - 1));

	const missing = [];
	for (let cur = new Date(startFrom); fmt(cur) <= fmt(endDate); cur = addDays(cur, 1)) {
		const s = fmt(cur);
		if (!covered.has(s)) missing.push(s);
	}
	return missing;
}

async function saQuery(startDate, endDate, dimensions, rowLimit = 25000) {
	const res = await webmasters.searchanalytics.query({
		siteUrl: SITE_URL,
		requestBody: { startDate, endDate, dimensions, rowLimit },
	});
	return res.data.rows || [];
}

async function fetchAndStoreRange(startDateStr, endDateStr, missingSet) {
	const [byDateRows, byDateQuery, byDatePage] = await Promise.all([
		saQuery(startDateStr, endDateStr, ['date']),
		saQuery(startDateStr, endDateStr, ['date', 'query']),
		saQuery(startDateStr, endDateStr, ['date', 'page']),
	]);

	const dayEntries = {};
	for (const d of missingSet) dayEntries[d] = { totals: null, byQuery: [], byPage: [] };

	for (const r of byDateRows) {
		const d = r.keys[0];
		if (!dayEntries[d]) continue;
		dayEntries[d].totals = { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position };
	}
	for (const r of byDateQuery) {
		const [d, q] = r.keys;
		if (!dayEntries[d]) continue;
		dayEntries[d].byQuery.push({ query: q, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
	}
	for (const r of byDatePage) {
		const [d, p] = r.keys;
		if (!dayEntries[d]) continue;
		dayEntries[d].byPage.push({ page: p, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
	}

	// A day with no rows is ambiguous: either GSC hasn't finalized it yet
	// (very recent day) or the site genuinely got zero traffic (extremely
	// unlikely for a live site). Assume "not finalized" for days within the
	// recent-days threshold — skip storing them so the next fetch retries.
	// For older days, fill with zero totals (real zero-traffic day).
	const NOT_FINALIZED_DAYS = 5;
	const today = new Date();
	for (const d of Object.keys(dayEntries)) {
		if (dayEntries[d].totals) continue;
		const daysAgo = Math.round((today - parseDate(d)) / 86400000);
		if (daysAgo <= NOT_FINALIZED_DAYS) {
			console.log(`  Skipping ${d} — GSC returned no rows (probably not finalized). Will retry next fetch.`);
			delete dayEntries[d];
		} else {
			dayEntries[d].totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
		}
	}

	// Group by month
	const byMonth = {};
	for (const [d, entry] of Object.entries(dayEntries)) {
		const m = monthKey(d);
		(byMonth[m] ||= {})[d] = entry;
	}

	// Merge & write
	const now = new Date().toISOString();
	for (const m of Object.keys(byMonth).sort()) {
		const existing = await loadMonth(m);
		existing.month = m;
		existing.days = { ...existing.days, ...byMonth[m] };
		existing.lastFetchedAt = now;
		const p = await saveMonth(m, existing);
		console.log(`  Updated ${path.relative(repoRoot, p)} (+${Object.keys(byMonth[m]).length} day(s))`);
	}
}

// Refresh sitemap status + URL inspection for top-10 pages of last 28 days.
// Stored on the current month's file since it's a "latest snapshot" of state.
async function refreshMetaForCurrentMonth(endDate) {
	const currentMonth = monthKey(endDate);
	const current = await loadMonth(currentMonth);

	try {
		const res = await webmasters.sitemaps.list({ siteUrl: SITE_URL });
		current.sitemaps = { fetchedAt: new Date().toISOString(), entries: res.data.sitemap || [] };
	} catch (err) {
		current.sitemaps = { error: err.message };
	}

	try {
		const start28 = fmt(addDays(endDate, -27));
		const topPages = await saQuery(start28, fmt(endDate), ['page'], 100);
		topPages.sort((a, b) => b.impressions - a.impressions);
		const inspections = [];
		for (const p of topPages.slice(0, 10)) {
			const url = p.keys[0];
			try {
				const res = await searchconsole.urlInspection.index.inspect({
					requestBody: { siteUrl: SITE_URL, inspectionUrl: url },
				});
				inspections.push({ url, inspectedAt: new Date().toISOString(), result: res.data.inspectionResult });
			} catch (err) {
				inspections.push({ url, error: err.message });
			}
		}
		current.urlInspections = inspections;
	} catch (err) {
		current.urlInspections = { error: err.message };
	}

	// Country + device rollups (last 90 days). These aren't per-day because the
	// breakdown is only useful in aggregate for market/localization decisions.
	try {
		const start90 = fmt(addDays(endDate, -89));
		const [countryRows, deviceRows] = await Promise.all([
			saQuery(start90, fmt(endDate), ['country'], 500),
			saQuery(start90, fmt(endDate), ['device'], 20),
		]);
		current.countryRollup90d = {
			fetchedAt: new Date().toISOString(),
			startDate: start90,
			endDate: fmt(endDate),
			rows: countryRows.map((r) => ({
				country: r.keys[0],
				clicks: r.clicks,
				impressions: r.impressions,
				ctr: r.ctr,
				position: r.position,
			})),
		};
		current.deviceRollup90d = {
			fetchedAt: new Date().toISOString(),
			startDate: start90,
			endDate: fmt(endDate),
			rows: deviceRows.map((r) => ({
				device: r.keys[0],
				clicks: r.clicks,
				impressions: r.impressions,
				ctr: r.ctr,
				position: r.position,
			})),
		};
	} catch (err) {
		current.countryRollup90d = { error: err.message };
	}

	await saveMonth(currentMonth, current);
	console.log(`  Refreshed sitemap + URL inspection + country/device rollups on ${currentMonth}`);
}

async function main() {
	// GSC lag is usually 2 days but sometimes today-1 is already available.
	// Try today-1 first: probe by requesting a single-day totals query; if it
	// returns rows, use it. Otherwise fall back to today-2.
	let endDate = addDays(new Date(), -1);
	try {
		const probe = await webmasters.searchanalytics.query({
			siteUrl: SITE_URL,
			requestBody: { startDate: fmt(endDate), endDate: fmt(endDate), rowLimit: 1 },
		});
		if (!probe.data.rows || probe.data.rows.length === 0) {
			endDate = addDays(new Date(), -2);
		}
	} catch {
		endDate = addDays(new Date(), -2);
	}

	const endDateStr = fmt(endDate);
	console.log(`Fetching GSC data for ${SITE_URL} up to ${endDateStr}`);

	const missing = await findMissingDays(endDate);
	if (missing.length === 0) {
		console.log('All days up to the GSC cutoff are already stored. Refreshing metadata only.');
	} else {
		const startDateStr = missing[0];
		console.log(`Filling ${missing.length} missing day(s): ${startDateStr} -> ${endDateStr}`);
		await fetchAndStoreRange(startDateStr, endDateStr, new Set(missing));
	}

	await refreshMetaForCurrentMonth(endDate);
	console.log('Done.');
}

main().catch((err) => {
	console.error('GSC fetch failed:', err.message);
	if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
	process.exit(1);
});

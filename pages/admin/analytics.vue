<template>
	<div>
		<div class="controls">
			<div class="control">
				<label>Site</label>
				<select v-model="siteId" @change="fetchAll">
					<option v-for="s in sites" :key="s.site_id" :value="s.site_id">
						{{ s.site_id }} ({{ s.events }})
					</option>
				</select>
			</div>
			<div class="control">
				<label>Range</label>
				<div class="range-buttons">
					<button v-for="r in ranges" :key="r.key"
						:class="{ active: rangeKey === r.key }"
						@click="setRange(r.key)">
						{{ r.label }}
					</button>
				</div>
			</div>
			<div v-if="rangeKey === 'custom'" class="control">
				<label>From – To</label>
				<div class="date-inputs">
					<input type="date" v-model="customFrom" :max="customTo || todayISO" @change="fetchAll" />
					<span>–</span>
					<input type="date" v-model="customTo" :min="customFrom" :max="todayISO" @change="fetchAll" />
				</div>
			</div>
			<div class="control">
				<label>
					<input type="checkbox" v-model="includeAdmin" @change="fetchAll" />
					Include admin traffic
				</label>
			</div>
			<button class="btn-refresh" @click="fetchAll" :disabled="loading">
				{{ loading ? 'Loading…' : 'Refresh' }}
			</button>
		</div>

		<div v-if="error" class="admin-msg error">{{ error }}</div>

		<div v-if="summary" class="totals">
			<div class="stat">
				<div class="stat-label">Pageviews</div>
				<div class="stat-value">{{ summary.totals.pageviews || 0 }}</div>
			</div>
			<div class="stat">
				<div class="stat-label">Sessions</div>
				<div class="stat-value">{{ summary.totals.sessions || 0 }}</div>
			</div>
			<div class="stat" v-if="includeAdmin">
				<div class="stat-label">Admin pageviews</div>
				<div class="stat-value">{{ summary.totals.admin_pageviews || 0 }}</div>
			</div>
		</div>

		<section v-if="summary && summary.days.length">
			<h3>By day</h3>
			<table class="stats-table">
				<thead>
					<tr>
						<th>Day</th>
						<th>Pageviews</th>
						<th>Sessions</th>
						<th>Daily uniques</th>
						<th v-if="includeAdmin">Admin</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="d in summary.days" :key="d.day">
						<td>{{ d.day }}</td>
						<td>{{ d.pageviews }}</td>
						<td>{{ d.sessions }}</td>
						<td>{{ d.daily_uniques }}</td>
						<td v-if="includeAdmin">{{ d.admin_pageviews || 0 }}</td>
					</tr>
				</tbody>
			</table>
		</section>

		<section v-if="hasBreakdowns">
			<h3>Visitors by</h3>
			<div class="breakdown-grid">
				<div v-for="dim in ['country', 'device', 'browser', 'os']" :key="dim" class="breakdown-cell">
					<h4>{{ dim }}</h4>
					<table v-if="breakdowns[dim].length" class="stats-table">
						<thead>
							<tr><th>{{ dim }}</th><th>Sessions</th><th>Pageviews</th></tr>
						</thead>
						<tbody>
							<tr v-for="row in breakdowns[dim]" :key="row.value">
								<td>{{ row.value }}</td>
								<td>{{ row.sessions }}</td>
								<td>{{ row.pageviews }}</td>
							</tr>
						</tbody>
					</table>
					<div v-else class="breakdown-empty">no data</div>
				</div>
			</div>
		</section>

		<section v-if="pages.length">
			<h3>Top pages</h3>
			<table class="stats-table">
				<thead>
					<tr><th>Path</th><th>Pageviews</th><th>Sessions</th></tr>
				</thead>
				<tbody>
					<tr v-for="p in pages" :key="p.path">
						<td class="mono">{{ p.path }}</td>
						<td>{{ p.pageviews }}</td>
						<td>{{ p.sessions }}</td>
					</tr>
				</tbody>
			</table>
		</section>

		<section v-if="referrers.length">
			<h3>Top referrers</h3>
			<table class="stats-table">
				<thead>
					<tr>
						<th></th>
						<th>Host</th>
						<th>Pageviews</th>
						<th>Sessions</th>
						<th>Distinct URLs</th>
					</tr>
				</thead>
				<tbody>
					<template v-for="r in referrers" :key="r.referrer_host">
						<tr>
							<td class="expand-cell">
								<button v-if="r.distinct_urls > 1" class="expand-btn"
									@click="toggleRefUrls(r.referrer_host)">
									{{ refUrls[r.referrer_host] ? '−' : '+' }}
								</button>
							</td>
							<td class="mono">{{ r.referrer_host }}</td>
							<td>{{ r.pageviews }}</td>
							<td>{{ r.sessions }}</td>
							<td>{{ r.distinct_urls }}</td>
						</tr>
						<tr v-if="refUrls[r.referrer_host]" class="expanded-row">
							<td></td>
							<td colspan="4">
								<table class="stats-table sub">
									<thead>
										<tr><th>URL</th><th>Pageviews</th><th>Sessions</th></tr>
									</thead>
									<tbody>
										<tr v-for="u in refUrls[r.referrer_host]" :key="u.referrer_url">
											<td class="mono url-cell">
												<a :href="u.referrer_url" target="_blank" rel="noopener">
													{{ u.referrer_url }}
												</a>
											</td>
											<td>{{ u.pageviews }}</td>
											<td>{{ u.sessions }}</td>
										</tr>
									</tbody>
								</table>
							</td>
						</tr>
					</template>
				</tbody>
			</table>
		</section>

		<section v-if="events.length">
			<h3>Custom events</h3>
			<table class="stats-table">
				<thead>
					<tr><th>Event</th><th>Occurrences</th><th>Sessions</th></tr>
				</thead>
				<tbody>
					<tr v-for="e in events" :key="e.event_name">
						<td class="mono">{{ e.event_name }}</td>
						<td>{{ e.occurrences }}</td>
						<td>{{ e.sessions }}</td>
					</tr>
				</tbody>
			</table>
		</section>

		<div v-if="!loading && summary && !summary.days.length && !pages.length && !referrers.length && !events.length"
			class="admin-msg">
			No analytics data in this range yet.
		</div>
	</div>
</template>

<script setup>
import { ref, inject, onMounted, computed } from 'vue';

const { apiBase, authHeader, logout } = inject('adminAuth');

const ranges = [
	{ key: 'today', label: 'Today' },
	{ key: '24h',   label: 'Last 24h' },
	{ key: '7d',    label: 'Last 7 days' },
	{ key: '30d',   label: 'Last 30 days' },
	{ key: 'all',   label: 'All time' },
	{ key: 'custom', label: 'Custom' },
];

function isoDate(d) {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}
const todayISO = isoDate(new Date());
const customFrom = ref(todayISO);
const customTo = ref(todayISO);

const sites = ref([]);
const siteId = ref('');
const rangeKey = ref('7d');
const includeAdmin = ref(false);

const summary = ref(null);
const pages = ref([]);
const referrers = ref([]);
const events = ref([]);
const refUrls = ref({}); // { host: [{referrer_url, pageviews, sessions}] }
const breakdowns = ref({ country: [], device: [], os: [], browser: [] });

const loading = ref(false);
const error = ref('');

const hasBreakdowns = computed(() =>
	['country', 'device', 'browser', 'os'].some(k => breakdowns.value[k]?.length)
);

function currentRangeMs() {
	const now = Date.now();
	switch (rangeKey.value) {
		case 'today': {
			const d = new Date();
			d.setHours(0, 0, 0, 0);
			return { from: d.getTime(), to: now };
		}
		case '24h': return { from: now - 24 * 3600 * 1000, to: now };
		case '7d':  return { from: now - 7 * 24 * 3600 * 1000, to: now };
		case '30d': return { from: now - 30 * 24 * 3600 * 1000, to: now };
		case 'all': return { from: null, to: null };
		case 'custom': {
			if (!customFrom.value || !customTo.value) return { from: null, to: null };
			const from = new Date(customFrom.value + 'T00:00:00').getTime();
			const to = new Date(customTo.value + 'T23:59:59.999').getTime();
			return { from, to };
		}
	}
	return { from: null, to: null };
}

onMounted(async () => {
	await fetchSites();
	if (sites.value.length) {
		siteId.value = sites.value[0].site_id;
		await fetchAll();
	}
});

function setRange(k) {
	rangeKey.value = k;
	fetchAll();
}

function commonParams() {
	const { from, to } = currentRangeMs();
	const params = new URLSearchParams();
	params.set('site_id', siteId.value);
	params.set('include_admin', includeAdmin.value ? '1' : '0');
	if (from != null && to != null) {
		params.set('from', String(from));
		params.set('to', String(to));
	}
	return params;
}

async function apiGet(path, extraParams) {
	const params = commonParams();
	if (extraParams) for (const [k, v] of Object.entries(extraParams)) params.set(k, v);
	const res = await fetch(`${apiBase}${path}?${params.toString()}`, {
		headers: { Authorization: authHeader.value },
		credentials: 'include',
	});
	if (res.status === 401) { logout(); throw new Error('unauthorized'); }
	if (!res.ok) throw new Error(`${path} failed (${res.status})`);
	return res.json();
}

async function fetchSites() {
	loading.value = true;
	error.value = '';
	try {
		const res = await fetch(`${apiBase}/admin/analytics/sites`, {
			headers: { Authorization: authHeader.value },
			credentials: 'include',
		});
		if (res.status === 401) return logout();
		if (!res.ok) throw new Error(`sites failed (${res.status})`);
		const body = await res.json();
		sites.value = body.items || [];
	} catch (e) {
		error.value = e.message;
	} finally {
		loading.value = false;
	}
}

async function fetchAll() {
	if (!siteId.value) return;
	loading.value = true;
	error.value = '';
	refUrls.value = {};
	try {
		const d = await apiGet('/admin/analytics/dashboard', { limit: '50' });
		summary.value = { range: d.range, include_admin: d.include_admin, totals: d.totals, days: d.days };
		pages.value = d.pages || [];
		referrers.value = d.referrers || [];
		events.value = d.events || [];
		breakdowns.value = d.breakdowns || { country: [], device: [], os: [], browser: [] };
	} catch (err) {
		error.value = err.message;
	} finally {
		loading.value = false;
	}
}

async function toggleRefUrls(host) {
	if (refUrls.value[host]) {
		refUrls.value = { ...refUrls.value, [host]: null };
		return;
	}
	try {
		const body = await apiGet('/admin/analytics/referrers/urls', { host, limit: '25' });
		refUrls.value = { ...refUrls.value, [host]: body.items || [] };
	} catch (err) {
		error.value = err.message;
	}
}
</script>

<style scoped>
.controls {
	display: flex; align-items: flex-end; flex-wrap: wrap;
	gap: 1.5rem; margin: 0 0 1.5rem;
	padding-bottom: 1rem; border-bottom: 1px solid #eee;
}
.control { display: flex; flex-direction: column; gap: 4px; }
.control label { font-size: 12px; font-weight: bold; color: #555; text-transform: uppercase; }
.control select {
	padding: 6px 10px; font-size: 13px; border: 1px solid #ccc; border-radius: 4px;
	background: white; min-width: 160px;
}
.range-buttons { display: flex; gap: 4px; flex-wrap: wrap; }
.range-buttons button {
	padding: 6px 12px; background: #f0f0f0; border: 1px solid #ddd;
	border-radius: 4px; cursor: pointer; font-size: 13px;
}
.range-buttons button.active {
	background: #8CCF7E; color: #111; font-weight: bold; border-color: #7ABF6E;
}
.date-inputs { display: flex; align-items: center; gap: 6px; }
.date-inputs input[type="date"] {
	padding: 6px 8px; font-size: 13px; border: 1px solid #ccc; border-radius: 4px;
	background: white;
}
.date-inputs span { color: #888; }
.btn-refresh {
	padding: 8px 16px; background: #eee; color: #333; border: none;
	border-radius: 5px; font-size: 13px; cursor: pointer;
}
.btn-refresh:disabled { opacity: 0.5; cursor: not-allowed; }

.totals { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
.stat {
	background: #f7f7f7; padding: 12px 20px; border-radius: 6px;
	min-width: 120px;
}
.stat-label { font-size: 11px; text-transform: uppercase; color: #666; margin-bottom: 2px; }
.stat-value { font-size: 22px; font-weight: bold; color: #111; }

section { margin-bottom: 2rem; }
section h3 { font-size: 15px; margin-bottom: 8px; color: #333; }

.stats-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.stats-table th, .stats-table td {
	padding: 8px 10px; text-align: left; border-bottom: 1px solid #eee;
}
.stats-table th {
	background: #f7f7f7; font-weight: bold; font-size: 11px;
	text-transform: uppercase; color: #555;
}
.stats-table td { vertical-align: top; }
.stats-table td.mono, .stats-table td.url-cell {
	font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	font-size: 12px; word-break: break-all;
}
.stats-table.sub { margin: 4px 0 8px; background: #fafafa; }
.stats-table.sub th { background: #efefef; }
.expand-cell { width: 32px; }
.expand-btn {
	width: 24px; height: 24px; border: 1px solid #ccc; background: white;
	border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 14px;
	line-height: 1;
}
.expand-btn:hover { background: #f0f0f0; }
.expanded-row td { padding: 0; background: #fafafa; }
.url-cell a { color: #1a5a99; text-decoration: none; }
.url-cell a:hover { text-decoration: underline; }

.admin-msg { text-align: center; padding: 2rem 1rem; color: #666; }
.admin-msg.error { color: #a33; }

.breakdown-grid {
	display: grid; gap: 1rem;
	grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}
.breakdown-cell { background: #fafafa; padding: 12px; border-radius: 6px; }
.breakdown-cell h4 {
	margin: 0 0 8px; font-size: 12px; text-transform: uppercase;
	color: #555; font-weight: bold;
}
.breakdown-empty { color: #999; font-size: 12px; padding: 6px 0; }
</style>

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
			<div class="control">
				<label>
					<input type="checkbox" v-model="includeBots" @change="fetchAll" />
					Include bots
				</label>
			</div>
			<button class="btn-refresh" @click="fetchAll" :disabled="loading">
				{{ loading ? 'Loading…' : 'Refresh' }}
			</button>
		</div>

		<div v-if="error" class="admin-msg error">{{ error }}</div>

		<div v-if="summary" class="totals">
			<button type="button" class="stat" :class="{ active: chartMetric === 'pageviews' }"
				@click="pickChartMetric('pageviews')">
				<div class="stat-label">Pageviews</div>
				<div class="stat-value">{{ summary.totals.pageviews || 0 }}</div>
			</button>
			<button type="button" class="stat" :class="{ active: chartMetric === 'sessions' }"
				@click="pickChartMetric('sessions')">
				<div class="stat-label">
					Sessions
					<span class="info-icon" @click.stop>?<span class="info-tooltip">
						Distinct browsers, identified by a persistent cookie (13-month lifetime).
						Same browser returning any time in the range counts as 1.
						Cookie-blocking visitors get a fresh session on each pageview, inflating this count.
					</span></span>
				</div>
				<div class="stat-value">{{ summary.totals.sessions || 0 }}</div>
			</button>
			<button type="button" class="stat" :class="{ active: chartMetric === 'uniques' }"
				@click="pickChartMetric('uniques')">
				<div class="stat-label">
					Daily uniques
					<span class="info-icon" @click.stop>?<span class="info-tooltip">
						Distinct visitors per day, identified by a daily-rotating hash of IP + user-agent
						(works without cookies). Summed across days, so a person visiting on 3 different days
						counts as 3. Visitors sharing an IP + browser (e.g. behind NAT) collapse into 1.
					</span></span>
				</div>
				<div class="stat-value">{{ totalDailyUniques }}</div>
			</button>
			<button type="button" class="stat" :class="{ active: chartMetric === 'event:stack_finished' }"
				@click="pickChartMetric('event:stack_finished')">
				<div class="stat-label">Stack finished</div>
				<div class="stat-value">{{ stackFinishedCount }}</div>
			</button>
			<button type="button" class="stat" :class="{ active: chartMetric === 'stack_conversion' }"
				@click="pickChartMetric('stack_conversion')">
				<div class="stat-label">
					Stack conversion
					<span class="info-icon" @click.stop>?<span class="info-tooltip">
						stack_finished ÷ stack_start, as a percentage. Measures how often a
						started stack runs to completion in the range.
					</span></span>
				</div>
				<div class="stat-value">{{ stackConversionLabel }}</div>
			</button>
			<div class="stat" v-if="includeAdmin">
				<div class="stat-label">Admin pageviews</div>
				<div class="stat-value">{{ summary.totals.admin_pageviews || 0 }}</div>
			</div>
		</div>

		<section v-if="summary" class="chart-section" ref="chartSectionEl">
			<div class="chart-controls">
				<div class="control">
					<label>Show</label>
					<select v-model="chartMetric" @change="fetchChart">
						<option value="pageviews">Pageviews</option>
						<option value="sessions">Sessions</option>
						<option value="uniques">Unique visitors</option>
						<option value="stack_conversion">Stack conversion rate</option>
						<optgroup v-if="events.length" label="Events">
							<option v-for="e in events" :key="e.event_name" :value="'event:' + e.event_name">
								{{ e.event_name }}
							</option>
						</optgroup>
					</select>
				</div>
				<div class="control">
					<label>Bucket</label>
					<div class="range-buttons">
						<button :class="{ active: chartBucket === 'day' }" @click="setChartBucket('day')">Daily</button>
						<button :class="{ active: chartBucket === 'hour' }" @click="setChartBucket('hour')">Hourly</button>
					</div>
				</div>
				<div class="chart-total">
					<div class="stat-label">Total</div>
					<div class="stat-value">{{ chartTotal }}</div>
				</div>
			</div>
			<div class="chart-container" ref="chartEl"
				@mousemove="onChartMove" @mouseleave="chartHover = null">
				<svg :width="chartW" :height="chartH" class="chart-svg">
					<line v-for="(t, i) in yTicks" :key="'g'+i"
						:x1="pad.left" :x2="chartW - pad.right"
						:y1="t.y" :y2="t.y"
						class="chart-grid" />
					<text v-for="(t, i) in yTicks" :key="'yl'+i"
						:x="pad.left - 6" :y="t.y + 4"
						class="chart-axis-label" text-anchor="end">
						{{ t.label }}
					</text>
					<text v-for="(t, i) in xTicks" :key="'xl'+i"
						:x="t.x" :y="chartH - pad.bottom + 16"
						class="chart-axis-label" text-anchor="middle">
						{{ t.label }}
					</text>
					<path v-if="chartArea" :d="chartArea" class="chart-area" />
					<path v-if="chartPath" :d="chartPath" class="chart-line" />
					<circle v-if="chartHover"
						:cx="chartHover.x" :cy="chartHover.y" r="4"
						class="chart-dot" />
					<line v-if="chartHover"
						:x1="chartHover.x" :x2="chartHover.x"
						:y1="pad.top" :y2="chartH - pad.bottom"
						class="chart-cursor" />
				</svg>
				<div v-if="chartHover" class="chart-tooltip" :style="tooltipStyle">
					<div class="tooltip-time">{{ chartHover.label }}</div>
					<div class="tooltip-value">
						<strong>{{ formatChartValue(chartHover.value) }}</strong>
						{{ chartValueUnit }}
					</div>
					<div v-if="chartHover.detail" class="tooltip-detail">{{ chartHover.detail }}</div>
				</div>
				<div v-if="!chartValues.length && !chartLoading" class="chart-empty">
					No data in range.
				</div>
				<div v-if="chartLoading" class="chart-loading">Loading…</div>
			</div>
		</section>

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
					<tr><th></th><th>Event</th><th>Occurrences</th><th>Sessions</th><th></th></tr>
				</thead>
				<tbody>
					<template v-for="e in events" :key="e.event_name">
						<tr>
							<td class="expand-cell">
								<button class="expand-btn" @click="toggleEvent(e.event_name)">
									{{ expandedEvent === e.event_name ? '−' : '+' }}
								</button>
							</td>
							<td class="mono">{{ e.event_name }}</td>
							<td>{{ e.occurrences }}</td>
							<td>{{ e.sessions }}</td>
							<td class="chart-cell">
								<button class="chart-btn"
									:class="{ active: chartMetric === 'event:' + e.event_name }"
									@click="chartEvent(e.event_name)"
									title="Plot this event on the chart">
									📈
								</button>
							</td>
						</tr>
						<tr v-if="expandedEvent === e.event_name" class="expanded-row">
							<td></td>
							<td colspan="4">
								<div v-if="eventDetailLoading" class="admin-msg">Loading…</div>
								<div v-else-if="eventDetailError" class="admin-msg error">{{ eventDetailError }}</div>
								<div v-else-if="!eventDetail.length" class="admin-msg">No events in range.</div>
								<table v-else class="stats-table sub">
									<thead>
										<tr><th>When</th><th>Path</th><th>Details</th></tr>
									</thead>
									<tbody>
										<tr v-for="(row, i) in eventDetail" :key="i">
											<td class="mono">{{ formatTs(row.ts) }}</td>
											<td class="mono url-cell">{{ row.path || '—' }}</td>
											<td class="mono url-cell">
												<a v-if="propsUrl(row.props_json)" :href="propsUrl(row.props_json)" target="_blank" rel="noopener">
													{{ propsUrl(row.props_json) }}
												</a>
												<span v-else>{{ row.props_json || '—' }}</span>
											</td>
										</tr>
									</tbody>
								</table>
							</td>
						</tr>
					</template>
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
import { ref, inject, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue';

const { apiBase, authHeader, logout } = inject('adminAuth');

const RANGE_STORAGE_KEY = 'eise-admin-analytics-range';
const SITE_STORAGE_KEY = 'eise-admin-analytics-site';
const CHART_STORAGE_KEY = 'eise-admin-analytics-chart';

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
const includeBots = ref(false);

const summary = ref(null);
const pages = ref([]);
const referrers = ref([]);
const events = ref([]);
const expandedEvent = ref(null);
const eventDetail = ref([]);
const eventDetailLoading = ref(false);
const eventDetailError = ref('');
const refUrls = ref({});
const breakdowns = ref({ country: [], device: [], os: [], browser: [] });

const loading = ref(false);
const error = ref('');

const chartMetric = ref('pageviews');
const chartBucket = ref('day');
const chartData = ref([]);
const chartData2 = ref([]);
const chartLoading = ref(false);
const chartHover = ref(null);
const chartEl = ref(null);
const chartSectionEl = ref(null);
const chartW = ref(800);
const chartH = 240;
const pad = { top: 12, right: 16, bottom: 32, left: 44 };
let chartResizeObserver = null;

const hasBreakdowns = computed(() =>
	['country', 'device', 'browser', 'os'].some(k => breakdowns.value[k]?.length)
);

const totalDailyUniques = computed(() => {
	if (!summary.value?.days) return 0;
	return summary.value.days.reduce((s, d) => s + (Number(d.daily_uniques) || 0), 0);
});

function eventCount(name) {
	const e = events.value.find(x => x.event_name === name);
	return e ? Number(e.occurrences) || 0 : 0;
}

const stackFinishedCount = computed(() => eventCount('stack_finished'));

const stackConversionLabel = computed(() => {
	const starts = eventCount('stack_start');
	if (!starts) return '—';
	const pct = (stackFinishedCount.value / starts) * 100;
	return `${pct.toFixed(1)}%`;
});

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
	try {
		const saved = JSON.parse(localStorage.getItem(RANGE_STORAGE_KEY) || 'null');
		if (saved && ranges.some(r => r.key === saved.rangeKey)) {
			rangeKey.value = saved.rangeKey;
			if (saved.customFrom) customFrom.value = saved.customFrom;
			if (saved.customTo) customTo.value = saved.customTo;
		}
	} catch {}
	try {
		const savedChart = JSON.parse(localStorage.getItem(CHART_STORAGE_KEY) || 'null');
		if (savedChart) {
			if (typeof savedChart.metric === 'string') chartMetric.value = savedChart.metric;
			if (savedChart.bucket === 'hour' || savedChart.bucket === 'day') chartBucket.value = savedChart.bucket;
		}
	} catch {}

	watch([rangeKey, customFrom, customTo], () => {
		try {
			localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify({
				rangeKey: rangeKey.value,
				customFrom: customFrom.value,
				customTo: customTo.value,
			}));
		} catch {}
	});

	watch([chartMetric, chartBucket], () => {
		try {
			localStorage.setItem(CHART_STORAGE_KEY, JSON.stringify({
				metric: chartMetric.value,
				bucket: chartBucket.value,
			}));
		} catch {}
	});

	await fetchSites();
	if (sites.value.length) {
		let savedSite = null;
		try { savedSite = localStorage.getItem(SITE_STORAGE_KEY); } catch {}
		siteId.value = (savedSite && sites.value.some(s => s.site_id === savedSite))
			? savedSite
			: sites.value[0].site_id;
		await fetchAll();
	}

	watch(siteId, v => {
		try { if (v) localStorage.setItem(SITE_STORAGE_KEY, v); } catch {}
	});

	await nextTick();
	measureChart();
	if (typeof ResizeObserver !== 'undefined' && chartEl.value) {
		chartResizeObserver = new ResizeObserver(() => measureChart());
		chartResizeObserver.observe(chartEl.value);
	} else {
		window.addEventListener('resize', measureChart);
	}
});

onBeforeUnmount(() => {
	if (chartResizeObserver) chartResizeObserver.disconnect();
	window.removeEventListener('resize', measureChart);
});

function measureChart() {
	if (chartEl.value) {
		const w = chartEl.value.clientWidth;
		if (w > 0) chartW.value = w;
	}
}

function setRange(k) {
	rangeKey.value = k;
	fetchAll();
}

function setChartBucket(b) {
	chartBucket.value = b;
	fetchChart();
}

function commonParams() {
	const { from, to } = currentRangeMs();
	const params = new URLSearchParams();
	params.set('site_id', siteId.value);
	params.set('include_admin', includeAdmin.value ? '1' : '0');
	params.set('include_bots', includeBots.value ? '1' : '0');
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
	expandedEvent.value = null;
	eventDetail.value = [];
	eventDetailError.value = '';
	try {
		const d = await apiGet('/admin/analytics/dashboard', { limit: '50' });
		summary.value = { range: d.range, include_admin: d.include_admin, totals: d.totals, days: d.days };
		pages.value = d.pages || [];
		referrers.value = d.referrers || [];
		events.value = d.events || [];
		breakdowns.value = d.breakdowns || { country: [], device: [], os: [], browser: [] };

		if (chartMetric.value.startsWith('event:')) {
			const wanted = chartMetric.value.slice(6);
			if (!events.value.some(e => e.event_name === wanted)) {
				chartMetric.value = 'pageviews';
			}
		}
		await fetchChart();
		await nextTick();
		measureChart();
	} catch (err) {
		error.value = err.message;
	} finally {
		loading.value = false;
	}
}

async function fetchChart() {
	if (!siteId.value) return;
	chartLoading.value = true;
	chartHover.value = null;
	try {
		if (chartMetric.value === 'stack_conversion') {
			const [starts, finishes] = await Promise.all([
				apiGet('/admin/analytics/timeseries', { bucket: chartBucket.value, event_name: 'stack_start' }),
				apiGet('/admin/analytics/timeseries', { bucket: chartBucket.value, event_name: 'stack_finished' }),
			]);
			chartData.value = starts.items || [];
			chartData2.value = finishes.items || [];
		} else {
			const params = { bucket: chartBucket.value };
			if (chartMetric.value.startsWith('event:')) {
				params.event_name = chartMetric.value.slice(6);
			} else {
				params.event_name = 'pageview';
			}
			const data = await apiGet('/admin/analytics/timeseries', params);
			chartData.value = data.items || [];
			chartData2.value = [];
		}
	} catch (err) {
		error.value = err.message;
	} finally {
		chartLoading.value = false;
	}
}

function chartEvent(name) {
	chartMetric.value = 'event:' + name;
	fetchChart();
	nextTick(() => {
		chartSectionEl.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	});
}

function pickChartMetric(metric) {
	chartMetric.value = metric;
	fetchChart();
}

async function toggleEvent(name) {
	if (expandedEvent.value === name) {
		expandedEvent.value = null;
		return;
	}
	expandedEvent.value = name;
	eventDetail.value = [];
	eventDetailError.value = '';
	eventDetailLoading.value = true;
	try {
		const body = await apiGet('/admin/analytics/event-detail', { event_name: name, limit: '100' });
		eventDetail.value = body.items || [];
	} catch (err) {
		eventDetailError.value = err.message;
	} finally {
		eventDetailLoading.value = false;
	}
}

function formatTs(ts) {
	if (!ts) return '';
	const d = new Date(Number(ts));
	return d.toLocaleString();
}

function propsUrl(propsJson) {
	if (!propsJson) return null;
	try {
		const p = typeof propsJson === 'string' ? JSON.parse(propsJson) : propsJson;
		return typeof p.url === 'string' ? p.url : null;
	} catch { return null; }
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

// ---- Chart computations ----

const chartSeries = computed(() => {
	const isConversion = chartMetric.value === 'stack_conversion';
	const primary = chartData.value;
	const secondary = chartData2.value;
	if (!primary.length && !secondary.length) return [];
	const bucketMs = chartBucket.value === 'hour' ? 3600000 : 86400000;
	const map = new Map();
	for (const row of primary) map.set(Number(row.bucket_ts), row);
	const map2 = new Map();
	for (const row of secondary) map2.set(Number(row.bucket_ts), row);

	const allBuckets = [
		...primary.map(r => Number(r.bucket_ts)),
		...secondary.map(r => Number(r.bucket_ts)),
	];
	const dataStart = Math.min(...allBuckets);
	const dataEnd = Math.max(...allBuckets);

	const { from, to } = currentRangeMs();
	let start = from != null ? Math.floor(from / bucketMs) * bucketMs : dataStart;
	let end   = to   != null ? Math.floor(to   / bucketMs) * bucketMs : dataEnd;

	if (from == null) start = dataStart;
	if (to == null) end = dataEnd;

	const maxBuckets = 500;
	if ((end - start) / bucketMs > maxBuckets) {
		start = end - maxBuckets * bucketMs;
	}

	const out = [];
	for (let t = start; t <= end; t += bucketMs) {
		const row = map.get(t);
		const row2 = map2.get(t);
		const count = row ? Number(row.count) || 0 : 0;
		const count2 = row2 ? Number(row2.count) || 0 : 0;
		const rate = isConversion && count > 0 ? (count2 / count) * 100 : 0;
		out.push({
			bucket_ts: t,
			count,
			sessions: row ? Number(row.sessions) || 0 : 0,
			uniques: row ? Number(row.uniques) || 0 : 0,
			count2,
			rate,
		});
	}
	return out;
});

const chartValues = computed(() => {
	if (chartMetric.value === 'stack_conversion') {
		return chartSeries.value.map(r => r.rate);
	}
	const field = chartMetric.value === 'sessions' ? 'sessions'
		: chartMetric.value === 'uniques' ? 'uniques'
		: 'count';
	return chartSeries.value.map(r => r[field]);
});

const chartTotal = computed(() => {
	if (chartMetric.value === 'stack_conversion') {
		const starts = chartSeries.value.reduce((s, r) => s + r.count, 0);
		const finishes = chartSeries.value.reduce((s, r) => s + r.count2, 0);
		if (!starts) return '—';
		return `${((finishes / starts) * 100).toFixed(1)}%`;
	}
	return chartValues.value.reduce((s, v) => s + v, 0);
});

const chartValueUnit = computed(() => {
	if (chartMetric.value === 'pageviews') return 'pageviews';
	if (chartMetric.value === 'sessions') return 'sessions';
	if (chartMetric.value === 'uniques') return chartBucket.value === 'day' ? 'daily uniques' : 'unique visitors';
	if (chartMetric.value === 'stack_conversion') return '%';
	if (chartMetric.value.startsWith('event:')) return chartMetric.value.slice(6);
	return '';
});

function niceMax(n) {
	if (n <= 0) return 1;
	const pow = Math.pow(10, Math.floor(Math.log10(n)));
	const rel = n / pow;
	let nice = 10;
	if (rel <= 1) nice = 1;
	else if (rel <= 2) nice = 2;
	else if (rel <= 5) nice = 5;
	return nice * pow;
}

const chartMax = computed(() => niceMax(Math.max(0, ...chartValues.value)));

const chartPoints = computed(() => {
	const n = chartValues.value.length;
	if (!n) return [];
	const max = chartMax.value;
	const plotW = chartW.value - pad.left - pad.right;
	const plotH = chartH - pad.top - pad.bottom;
	const step = n > 1 ? plotW / (n - 1) : 0;
	const isConversion = chartMetric.value === 'stack_conversion';
	return chartValues.value.map((v, i) => {
		const row = chartSeries.value[i];
		return {
			x: pad.left + i * step,
			y: pad.top + plotH * (1 - v / max),
			v,
			ts: row.bucket_ts,
			detail: isConversion ? `${row.count2} / ${row.count} stack_start` : null,
		};
	});
});

const chartPath = computed(() => {
	const pts = chartPoints.value;
	if (!pts.length) return '';
	return pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
});

const chartArea = computed(() => {
	const pts = chartPoints.value;
	if (!pts.length) return '';
	const baseY = pad.top + (chartH - pad.top - pad.bottom);
	const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
	return `${line} L${pts[pts.length-1].x.toFixed(1)},${baseY} L${pts[0].x.toFixed(1)},${baseY} Z`;
});

const yTicks = computed(() => {
	const max = chartMax.value;
	const plotH = chartH - pad.top - pad.bottom;
	const isConversion = chartMetric.value === 'stack_conversion';
	return [0, 0.25, 0.5, 0.75, 1].map(f => {
		const v = max * f;
		return {
			y: pad.top + plotH * (1 - f),
			label: isConversion ? `${v.toFixed(v < 10 ? 1 : 0)}%` : Math.round(v),
		};
	});
});

function formatChartValue(v) {
	if (chartMetric.value === 'stack_conversion') {
		return (Number(v) || 0).toFixed(1);
	}
	return v;
}

const xTicks = computed(() => {
	const pts = chartPoints.value;
	if (!pts.length) return [];
	const targetCount = Math.max(2, Math.min(8, Math.floor(chartW.value / 90)));
	const step = Math.max(1, Math.floor((pts.length - 1) / targetCount));
	const ticks = [];
	for (let i = 0; i < pts.length; i += step) {
		ticks.push({ x: pts[i].x, label: formatBucketShort(pts[i].ts) });
	}
	const lastIdx = pts.length - 1;
	if (ticks.length && ticks[ticks.length - 1].x !== pts[lastIdx].x) {
		ticks.push({ x: pts[lastIdx].x, label: formatBucketShort(pts[lastIdx].ts) });
	}
	return ticks;
});

function formatBucketShort(ts) {
	const d = new Date(Number(ts));
	if (chartBucket.value === 'hour') {
		return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' });
	}
	return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatBucketFull(ts) {
	const d = new Date(Number(ts));
	if (chartBucket.value === 'hour') {
		return d.toLocaleString([], {
			weekday: 'short', month: 'short', day: 'numeric',
			hour: '2-digit', minute: '2-digit',
		});
	}
	return d.toLocaleDateString([], {
		weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
	});
}

function onChartMove(e) {
	const pts = chartPoints.value;
	if (!pts.length || !chartEl.value) return;
	const rect = chartEl.value.getBoundingClientRect();
	const scaleX = chartW.value / rect.width;
	const x = (e.clientX - rect.left) * scaleX;
	let nearest = pts[0], minDist = Infinity;
	for (const p of pts) {
		const d = Math.abs(p.x - x);
		if (d < minDist) { minDist = d; nearest = p; }
	}
	chartHover.value = {
		x: nearest.x,
		y: nearest.y,
		value: nearest.v,
		label: formatBucketFull(nearest.ts),
		detail: nearest.detail,
	};
}

const tooltipStyle = computed(() => {
	if (!chartHover.value) return {};
	const plotW = chartW.value;
	const pct = chartHover.value.x / plotW;
	const alignRight = pct > 0.7;
	const scale = chartEl.value ? (chartEl.value.clientWidth / chartW.value) : 1;
	const leftPx = chartHover.value.x * scale;
	const topPx = chartHover.value.y * scale;
	return {
		left: `${leftPx}px`,
		top: `${topPx}px`,
		transform: alignRight ? 'translate(-100%, -100%) translate(-8px, -8px)' : 'translate(0, -100%) translate(8px, -8px)',
	};
});
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
	text-align: left;
	font: inherit; color: inherit;
	border: 2px solid transparent;
}
button.stat {
	cursor: pointer;
	transition: background 0.15s, border-color 0.15s;
}
button.stat:hover { background: #eee; }
button.stat.active {
	background: #eaf5e5; border-color: #8CCF7E;
}
.stat-label {
	font-size: 11px; text-transform: uppercase; color: #666; margin-bottom: 2px;
	display: flex; align-items: center; gap: 4px;
}
.stat-value { font-size: 22px; font-weight: bold; color: #111; }

.info-icon {
	display: inline-flex; align-items: center; justify-content: center;
	width: 14px; height: 14px; border-radius: 50%;
	background: #ddd; color: #555; font-size: 10px; font-weight: bold;
	cursor: help; position: relative;
}
.info-icon:hover { background: #8CCF7E; color: #111; }
.info-tooltip {
	position: absolute; bottom: calc(100% + 6px); left: 50%;
	transform: translateX(-50%);
	background: #333; color: #fff;
	padding: 8px 10px; border-radius: 5px;
	font-size: 12px; font-weight: normal; line-height: 1.4;
	text-transform: none; letter-spacing: normal;
	width: 240px; text-align: left;
	opacity: 0; pointer-events: none;
	transition: opacity 0.15s;
	z-index: 20;
	box-shadow: 0 2px 10px rgba(0,0,0,0.2);
}
.info-tooltip::after {
	content: ''; position: absolute; top: 100%; left: 50%;
	transform: translateX(-50%);
	border: 5px solid transparent; border-top-color: #333;
}
.info-icon:hover .info-tooltip { opacity: 1; }

section { margin-bottom: 2rem; }
section h3 { font-size: 15px; margin-bottom: 8px; color: #333; }

.chart-section {
	background: #fafafa; padding: 16px; border-radius: 6px;
	margin-bottom: 2rem;
}
.chart-controls {
	display: flex; align-items: flex-end; gap: 1.5rem;
	margin-bottom: 12px; flex-wrap: wrap;
}
.chart-total { margin-left: auto; text-align: right; }
.chart-container {
	position: relative; width: 100%; min-height: 240px;
}
.chart-svg { display: block; height: 240px; }
.chart-grid { stroke: #e5e5e5; stroke-width: 1; }
.chart-area { fill: rgba(140, 207, 126, 0.25); }
.chart-line { fill: none; stroke: #7ABF6E; stroke-width: 2; stroke-linejoin: round; }
.chart-dot { fill: #7ABF6E; stroke: white; stroke-width: 2; }
.chart-cursor { stroke: #999; stroke-width: 1; stroke-dasharray: 3 3; }
.chart-axis-label {
	fill: #666; font-size: 11px;
	font-family: ui-sans-serif, system-ui, sans-serif;
}
.chart-tooltip {
	position: absolute;
	background: #333; color: white;
	padding: 6px 10px; border-radius: 5px;
	font-size: 12px; pointer-events: none;
	box-shadow: 0 2px 10px rgba(0,0,0,0.2);
	white-space: nowrap;
	z-index: 5;
}
.chart-tooltip .tooltip-time { color: #ccc; font-size: 11px; margin-bottom: 2px; }
.chart-tooltip .tooltip-value { font-size: 13px; color: #fff; font-weight: 500; }
.chart-tooltip .tooltip-value strong { font-size: 15px; color: #fff; font-weight: 700; }
.chart-tooltip .tooltip-detail { color: #ccc; font-size: 11px; margin-top: 2px; }
.chart-empty, .chart-loading {
	position: absolute; inset: 0;
	display: flex; align-items: center; justify-content: center;
	color: #999; font-size: 13px;
	pointer-events: none;
}

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
.expand-cell {
	width: 22px; padding: 6px 2px 6px 4px; text-align: center;
}
.chart-cell { width: 40px; text-align: right; }
.expand-btn {
	width: 18px; height: 18px; border: 1px solid #ddd; background: #fff;
	border-radius: 50%; cursor: pointer; font-weight: bold; font-size: 11px;
	color: #666; line-height: 1; padding: 0;
	display: inline-flex; align-items: center; justify-content: center;
	transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.expand-btn:hover { background: #f0f0f0; border-color: #bbb; color: #333; }
@media (max-width: 640px) {
	.expand-cell { padding: 4px 0 4px 2px; width: 20px; }
	.expand-btn { width: 16px; height: 16px; font-size: 10px; }
}
.chart-btn {
	width: 28px; height: 24px; border: 1px solid #ccc; background: white;
	border-radius: 4px; cursor: pointer; font-size: 12px;
	line-height: 1; padding: 0;
}
.chart-btn:hover { background: #f0f0f0; }
.chart-btn.active {
	background: #8CCF7E; border-color: #7ABF6E;
}
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

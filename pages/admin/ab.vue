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
				<label>Experiment</label>
				<select v-model="experimentName" @change="fetchAll" class="exp-input">
					<option v-for="e in experiments" :key="e.name" :value="e.name">
						{{ e.name }} ({{ e.sessions }})
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

		<div v-if="filterLabel" class="filter-callout">
			<strong>Filtered population:</strong> {{ filterLabel }}
		</div>

		<section v-if="variants.length">
			<table class="stats-table">
				<thead>
					<tr>
						<th>Variant</th>
						<th title="Distinct sessions bucketed into this variant">People in test</th>
						<th title="Sessions that fired human_interaction">Engaged</th>
						<th title="Sessions that stacked their own footage (stack_start without try_sample)">Own stack_start</th>
						<th title="Own stack_start ÷ engaged">Conversion</th>
						<th title="Relative lift vs variant A">Lift</th>
						<th title="Two-proportion z-test p-value vs variant A">p-value</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="row in variantRows" :key="row.variant">
						<td class="mono"><strong>{{ row.variant }}</strong></td>
						<td>{{ row.participants.toLocaleString() }}</td>
						<td>{{ row.interacted.toLocaleString() }}</td>
						<td>{{ row.own_stack_start.toLocaleString() }}</td>
						<td>{{ formatRate(row.rate) }}</td>
						<td :class="liftClass(row.lift)">{{ row.lift == null ? '—' : formatLift(row.lift) }}</td>
						<td>{{ row.pValue == null ? '—' : row.pValue.toFixed(3) }}</td>
					</tr>
				</tbody>
			</table>
			<p class="footnote">
				Conversion = sessions that fired <code>human_interaction</code> <em>and</em> a <code>stack_start</code> without a preceding <code>try_sample</code>, divided by sessions that fired <code>human_interaction</code>. Sample-triggered stacks are excluded from the numerator.
			</p>
		</section>

		<div v-else-if="!loading && fetched" class="admin-msg">
			No data yet for experiment <code>{{ experimentName }}</code> in this range.
		</div>
	</div>
</template>

<script setup>
import { ref, inject, onMounted, computed, watch } from 'vue';

const { apiBase, authHeader, logout } = inject('adminAuth');

const RANGE_STORAGE_KEY = 'eise-admin-ab-range';
const EXP_STORAGE_KEY = 'eise-admin-ab-experiment';

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
const experimentName = ref('homepage');
const experiments = ref([]);  // [{ name, sessions, last_ts }]

const variants = ref([]);
const filterLabel = ref('');
const loading = ref(false);
const fetched = ref(false);
const error = ref('');

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

// Standard normal CDF via Abramowitz & Stegun approximation. Used for p-values.
function normalCdf(z) {
	const t = 1 / (1 + 0.2316419 * Math.abs(z));
	const d = 0.3989422804 * Math.exp(-z * z / 2);
	const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
	return z > 0 ? 1 - p : p;
}

function twoProportionPValue(c1, n1, c2, n2) {
	if (!n1 || !n2) return null;
	const p1 = c1 / n1;
	const p2 = c2 / n2;
	const p = (c1 + c2) / (n1 + n2);
	const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
	if (!isFinite(se) || se === 0) return null;
	const z = (p2 - p1) / se;
	return 2 * (1 - normalCdf(Math.abs(z)));
}

const variantRows = computed(() => {
	const baseline = variants.value.find(v => v.variant === 'A');
	return variants.value.map(v => {
		const rate = v.interacted ? v.own_stack_start / v.interacted : 0;
		let lift = null;
		let pValue = null;
		if (baseline && baseline.variant !== v.variant && baseline.interacted > 0) {
			const baseRate = baseline.own_stack_start / baseline.interacted;
			if (baseRate > 0) lift = (rate - baseRate) / baseRate;
			pValue = twoProportionPValue(
				baseline.own_stack_start, baseline.interacted,
				v.own_stack_start, v.interacted,
			);
		}
		return { ...v, rate, lift, pValue };
	});
});

function formatRate(r) {
	if (!isFinite(r)) return '—';
	return (r * 100).toFixed(2) + '%';
}
function formatLift(l) {
	const sign = l > 0 ? '+' : '';
	return sign + (l * 100).toFixed(1) + '%';
}
function liftClass(l) {
	if (l == null) return '';
	if (l > 0) return 'lift-positive';
	if (l < 0) return 'lift-negative';
	return '';
}

function setRange(k) {
	rangeKey.value = k;
	fetchAll();
}

async function fetchExperiments() {
	if (!siteId.value) return;
	try {
		const res = await fetch(`${apiBase}/admin/analytics/ab-experiments?site_id=${encodeURIComponent(siteId.value)}`, {
			headers: { Authorization: authHeader.value },
			credentials: 'include',
		});
		if (res.status === 401) return logout();
		if (!res.ok) return;
		const body = await res.json();
		experiments.value = body.items || [];
		// If the saved experiment isn't in the list anymore, still show it so
		// old A/Bs remain analyzable; drop only if the list is fresh and non-empty.
		if (experimentName.value && !experiments.value.some(e => e.name === experimentName.value)) {
			experiments.value = [{ name: experimentName.value, sessions: 0, last_ts: 0 }, ...experiments.value];
		}
	} catch {}
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
	if (!siteId.value || !experimentName.value) return;
	loading.value = true;
	error.value = '';
	try {
		const { from, to } = currentRangeMs();
		const params = new URLSearchParams();
		params.set('site_id', siteId.value);
		params.set('name', experimentName.value);
		params.set('include_admin', includeAdmin.value ? '1' : '0');
		params.set('include_bots', includeBots.value ? '1' : '0');
		if (from != null && to != null) {
			params.set('from', String(from));
			params.set('to', String(to));
		}
		const res = await fetch(`${apiBase}/admin/analytics/ab?${params.toString()}`, {
			headers: { Authorization: authHeader.value },
			credentials: 'include',
		});
		if (res.status === 401) { logout(); return; }
		if (!res.ok) throw new Error(`ab failed (${res.status})`);
		const body = await res.json();
		variants.value = body.variants || [];
		filterLabel.value = body.filter?.label || '';
		fetched.value = true;
	} catch (e) {
		error.value = e.message;
	} finally {
		loading.value = false;
	}
}

onMounted(async () => {
	try {
		const saved = JSON.parse(localStorage.getItem(RANGE_STORAGE_KEY) || 'null');
		if (saved && ranges.some(r => r.key === saved.rangeKey)) {
			rangeKey.value = saved.rangeKey;
			if (saved.customFrom) customFrom.value = saved.customFrom;
			if (saved.customTo) customTo.value = saved.customTo;
		}
		const savedExp = localStorage.getItem(EXP_STORAGE_KEY);
		if (savedExp) experimentName.value = savedExp;
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
	watch(experimentName, v => {
		try { localStorage.setItem(EXP_STORAGE_KEY, v); } catch {}
	});

	await fetchSites();
	if (sites.value.length) {
		siteId.value = sites.value[0].site_id;
		await fetchExperiments();
		await fetchAll();
	}
});
watch(siteId, async () => { await fetchExperiments(); });
</script>

<style scoped>
.controls {
	display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap;
	margin-bottom: 20px;
}
.filter-callout {
	background: #f7f7f7; border-left: 3px solid #8CCF7E; padding: 10px 14px;
	border-radius: 4px; font-size: 13px; color: #333; margin-bottom: 16px;
	line-height: 1.5;
}
.filter-callout strong { color: #1a1a1a; }
.control { display: flex; flex-direction: column; gap: 4px; }
.control label { font-size: 12px; color: #666; font-weight: bold; }
.control select, .exp-input {
	padding: 6px 10px; border: 1px solid #ccc; border-radius: 5px; font-size: 13px;
}
.exp-input { width: 180px; }
.range-buttons { display: flex; gap: 4px; flex-wrap: wrap; }
.range-buttons button {
	padding: 6px 12px; border: 1px solid #ccc; background: #fefefe; border-radius: 5px;
	font-size: 13px; cursor: pointer;
}
.range-buttons button.active {
	background: #8CCF7E; color: #111; font-weight: bold; border-color: #7ABF6E;
}
.date-inputs { display: flex; align-items: center; gap: 6px; }
.date-inputs input[type="date"] {
	padding: 5px 8px; border: 1px solid #ccc; border-radius: 5px; font-size: 13px;
}
.date-inputs span { color: #888; }
.btn-refresh {
	padding: 8px 16px; border: 1px solid #ccc; background: #fefefe; border-radius: 5px;
	font-size: 13px; cursor: pointer;
}
.admin-msg {
	background: #f5f5f5; padding: 12px 16px; border-radius: 6px;
	color: #555; margin-top: 16px;
}
.admin-msg.error { background: #fee; color: #a33; }
.stats-table {
	width: 100%; border-collapse: collapse; margin-top: 8px;
}
.stats-table th, .stats-table td {
	text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee;
	font-size: 13px;
}
.stats-table th {
	background: #f7f7f7; font-weight: bold; font-size: 11px;
	text-transform: uppercase; color: #555;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.lift-positive { color: #2a7a2a; font-weight: bold; }
.lift-negative { color: #a33; font-weight: bold; }
.footnote { color: #666; font-size: 12px; margin-top: 12px; }
.footnote code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
</style>

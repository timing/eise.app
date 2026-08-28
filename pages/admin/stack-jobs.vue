<template>
	<div>
		<div class="controls">
			<div class="control">
				<label>Site</label>
				<select v-model="siteId" @change="fetchJobs">
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
			<div class="control">
				<label>Outcome</label>
				<select v-model="outcome" @change="fetchJobs">
					<option value="">All</option>
					<option value="finished">Finished</option>
					<option value="failed">Failed</option>
					<option value="cancelled">Cancelled</option>
					<option value="silent">Silent (no terminal)</option>
					<option value="pending">Pending / no start</option>
				</select>
			</div>
			<div class="control">
				<label>
					<input type="checkbox" v-model="includeAdmin" @change="fetchJobs" />
					Include admin traffic
				</label>
			</div>
			<div class="control">
				<label>
					<input type="checkbox" v-model="includeBots" @change="fetchJobs" />
					Include bots
				</label>
			</div>
			<button class="btn-refresh" @click="fetchJobs" :disabled="loading">
				{{ loading ? 'Loading…' : 'Refresh' }}
			</button>
		</div>

		<div v-if="error" class="admin-msg error">{{ error }}</div>

		<div class="split">
			<section class="list-pane">
				<table v-if="jobs.length" class="admin-table">
					<thead>
						<tr>
							<th>When</th>
							<th>Job</th>
							<th>Outcome</th>
							<th>Reader</th>
							<th>File</th>
							<th>GPU</th>
							<th class="num">Steps</th>
							<th class="num">Pings</th>
							<th class="num">Errs</th>
							<th class="num">Mem MB</th>
							<th class="num">Dur</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="j in jobs" :key="j.job_id"
							:class="{ selected: selectedJobId === j.job_id, ['row-' + j.outcome]: true }"
							@click="selectJob(j.job_id)">
							<td class="ts">{{ formatTs(j.last_ts) }}</td>
							<td class="mono">{{ j.job_id }}</td>
							<td><span :class="'badge badge-' + j.outcome">{{ j.outcome }}</span></td>
							<td>{{ j.reader || '—' }}</td>
							<td>{{ j.file_type || '—' }}</td>
							<td>{{ j.gpu_enabled == null ? '—' : (j.gpu_enabled ? 'yes' : 'no') }}</td>
							<td class="num">{{ j.steps }}</td>
							<td class="num">{{ j.pings }}</td>
							<td class="num" :class="{ 'val-warn': j.max_errors > 0 }">{{ j.max_errors || 0 }}</td>
							<td class="num">{{ j.max_mem_mb || '—' }}</td>
							<td class="num">{{ formatDur(j.last_ts - j.first_ts) }}</td>
						</tr>
					</tbody>
				</table>
				<div v-else-if="!loading" class="admin-msg">No jobs in this range.</div>
			</section>

			<section class="detail-pane">
				<div v-if="!selectedJobId" class="admin-msg">Select a job to see its timeline.</div>
				<div v-else-if="detailLoading" class="admin-msg">Loading job…</div>
				<div v-else-if="detailError" class="admin-msg error">{{ detailError }}</div>
				<template v-else-if="detail">
					<div class="detail-head">
						<div>
							<strong class="mono">{{ detail.job_id }}</strong>
							<span :class="'badge badge-' + detail.outcome">{{ detail.outcome }}</span>
						</div>
						<div class="detail-meta">
							{{ detail.reader || '?' }} · {{ detail.file_type || '?' }} ·
							GPU {{ detail.gpu_enabled == null ? '?' : (detail.gpu_enabled ? 'on' : 'off') }} ·
							{{ formatDur(detail.duration_ms) }}
						</div>
					</div>

					<div v-if="detail.gaps.length" class="admin-msg warn">
						{{ detail.gaps.length }} log gap{{ detail.gaps.length === 1 ? '' : 's' }}
						(dropped pings or over-cap bursts).
					</div>

					<div class="terminal">
						<div v-for="(line, i) in detail.lines" :key="i"
							:class="['line', 'line-' + line.kind]">
							<span class="line-ts">{{ line.rel != null ? formatRel(line.rel) : '' }}</span>
							<span class="line-body">{{ line.text }}</span>
						</div>
					</div>
				</template>
			</section>
		</div>
	</div>
</template>

<script setup>
import { ref, inject, onMounted, computed } from 'vue';

const { apiBase, authHeader, logout } = inject('adminAuth');

const RANGE_STORAGE_KEY = 'eise-admin-stack-jobs-range';
const SITE_STORAGE_KEY = 'eise-admin-stack-jobs-site';

const ranges = [
	{ key: 'today', label: 'Today' },
	{ key: '24h', label: 'Last 24h' },
	{ key: '7d', label: 'Last 7 days' },
	{ key: '30d', label: 'Last 30 days' },
];

const sites = ref([]);
const siteId = ref('');
const rangeKey = ref('24h');
const outcome = ref('');
const includeAdmin = ref(false);
const includeBots = ref(false);

const jobs = ref([]);
const loading = ref(false);
const error = ref('');

const selectedJobId = ref('');
const detail = ref(null);
const detailLoading = ref(false);
const detailError = ref('');

onMounted(async () => {
	const storedRange = localStorage.getItem(RANGE_STORAGE_KEY);
	if (storedRange && ranges.find(r => r.key === storedRange)) rangeKey.value = storedRange;
	const storedSite = localStorage.getItem(SITE_STORAGE_KEY);
	await fetchSites();
	if (storedSite && sites.value.find(s => s.site_id === storedSite)) siteId.value = storedSite;
	if (!siteId.value && sites.value.length) siteId.value = sites.value[0].site_id;
	if (siteId.value) fetchJobs();
});

function setRange(key) {
	rangeKey.value = key;
	localStorage.setItem(RANGE_STORAGE_KEY, key);
	fetchJobs();
}

function currentRangeMs() {
	const now = Date.now();
	switch (rangeKey.value) {
		case 'today': {
			const d = new Date(); d.setHours(0, 0, 0, 0);
			return { from: d.getTime(), to: now };
		}
		case '24h': return { from: now - 24 * 3600 * 1000, to: now };
		case '7d': return { from: now - 7 * 24 * 3600 * 1000, to: now };
		case '30d': return { from: now - 30 * 24 * 3600 * 1000, to: now };
	}
	return { from: now - 24 * 3600 * 1000, to: now };
}

async function apiFetch(path) {
	const res = await fetch(`${apiBase}${path}`, {
		headers: { Authorization: authHeader.value },
		credentials: 'include',
	});
	if (res.status === 401) { logout(); throw new Error('unauthorized'); }
	if (!res.ok) throw new Error(`Failed (${res.status})`);
	return res.json();
}

async function fetchSites() {
	try {
		const body = await apiFetch('/admin/analytics/sites');
		sites.value = body.items || [];
	} catch (e) { error.value = e.message; }
}

async function fetchJobs() {
	if (!siteId.value) return;
	localStorage.setItem(SITE_STORAGE_KEY, siteId.value);
	loading.value = true;
	error.value = '';
	try {
		const { from, to } = currentRangeMs();
		const p = new URLSearchParams({
			site_id: siteId.value,
			from: String(from), to: String(to),
			include_admin: includeAdmin.value ? '1' : '0',
			include_bots: includeBots.value ? '1' : '0',
			limit: '200',
		});
		if (outcome.value) p.set('outcome', outcome.value);
		const body = await apiFetch(`/admin/analytics/stack-jobs?${p.toString()}`);
		jobs.value = body.items || [];
	} catch (e) { error.value = e.message; }
	finally { loading.value = false; }
}

async function selectJob(jobId) {
	selectedJobId.value = jobId;
	detail.value = null;
	detailLoading.value = true;
	detailError.value = '';
	try {
		const body = await apiFetch(`/admin/analytics/stack-jobs/${encodeURIComponent(jobId)}?site_id=${encodeURIComponent(siteId.value)}`);
		detail.value = buildDetail(body);
	} catch (e) { detailError.value = e.message; }
	finally { detailLoading.value = false; }
}

// Turn the raw event stream into a flat list of log lines the terminal renders.
// Each line: { kind, text, rel } — kind picks the color, rel is ms since job start.
//
// Ping log deltas are already deduped by design (each ping ships only lines
// after the previous cursor). We flag any cursor mismatch as a gap so the user
// sees when a ping was lost or truncated by MAX_LOGS_PER_PING. On stack_failed
// we top up with logs_tail entries that weren't in any ping delta.
function buildDetail(body) {
	const events = body.items || [];
	if (!events.length) return { job_id: body.job_id, outcome: 'pending', lines: [], gaps: [], duration_ms: 0 };

	const firstTs = events[0].ts;
	const lastTs = events[events.length - 1].ts;
	const lines = [];
	const gaps = [];
	// -1 means "not seen a ping yet"; first ping sets it to that ping's
	// log_cursor so pre-run logs aren't counted as a gap.
	let logCursor = -1;
	let firstOutcome = 'silent';
	const meta = { reader: null, file_type: null, gpu_enabled: null };
	let pingIdx = 0;

	for (const ev of events) {
		const rel = ev.ts - firstTs;
		const p = ev.props || {};
		if (!meta.reader && p.reader) meta.reader = p.reader;
		if (!meta.file_type && p.file_type) meta.file_type = p.file_type;
		if (meta.gpu_enabled == null && p.gpu_enabled != null) meta.gpu_enabled = p.gpu_enabled;

		if (ev.event_name === 'stack_start') {
			lines.push({ kind: 'start', rel, text: `stack_start — reader=${p.reader || '?'} file=${p.file_type || '?'} gpu=${p.gpu_enabled ? 'on' : 'off'}` });
		} else if (ev.event_name === 'stack_step') {
			lines.push({ kind: 'step', rel, text: `stack_step — ${p.step || '(no step)'}` });
		} else if (ev.event_name === 'stack_ping') {
			pingIdx++;
			const memPart = p.mem_used_mb != null ? ` · mem ${p.mem_used_mb}/${p.mem_limit_mb || '?'} MB` : '';
			const visPart = p.visibility && p.visibility !== 'visible' ? ` · ${p.visibility}` : '';
			const stepPart = p.last_step && p.last_step !== 'none' ? ` · @${p.last_step}` : '';
			// pass-2 stall diagnostics: shows exactly which of the four awaits is stuck
			let pass2Part = '';
			if (p.pass2_packets != null || p.pass2_frames != null) {
				const q = p.pass2_queue != null ? `q${p.pass2_queue}` : '';
				const since = p.pass2_ms_since_frame != null ? `${(p.pass2_ms_since_frame / 1000).toFixed(1)}s-since-frame` : '';
				const parts = [
					`pkt ${p.pass2_packets || 0}`,
					`frm ${p.pass2_frames || 0}`,
					`bat ${p.pass2_batches || 0}`,
					q, since,
				].filter(Boolean);
				pass2Part = ` · ${parts.join(' ')}`;
			}
			lines.push({
				kind: 'ping', rel,
				text: `─── ping #${pingIdx}${stepPart}${memPart}${visPart}${pass2Part} ───`,
			});
			if (logCursor === -1) {
				// First ping seen: adopt its cursor as trail start; skipped pre-run logs aren't a gap.
				logCursor = typeof p.log_cursor === 'number' ? p.log_cursor : 0;
			} else if (typeof p.log_cursor === 'number' && p.log_cursor !== logCursor) {
				const missing = p.log_cursor - logCursor;
				if (missing > 0) {
					lines.push({ kind: 'gap', rel: null, text: `⋯ ${missing} log line${missing === 1 ? '' : 's'} missing (dropped ping or over-cap burst) ⋯` });
					gaps.push({ at_ping: pingIdx, missing });
				}
			}
			if (typeof p.log_dropped === 'number' && p.log_dropped > 0) {
				lines.push({ kind: 'gap', rel: null, text: `⋯ ${p.log_dropped} oldest lines in this ping's burst dropped at cap ⋯` });
				gaps.push({ at_ping: pingIdx, missing: p.log_dropped });
			}
			if (Array.isArray(p.logs)) {
				for (const l of p.logs) lines.push({ kind: 'log', rel: null, text: l });
				logCursor = (p.log_cursor || 0) + p.logs.length;
			}
			if (p.last_error) {
				lines.push({ kind: 'err', rel: null, text: `⚠ ${p.last_error}` });
			}
		} else if (ev.event_name === 'stack_failed') {
			// Fill in any lines the tail knows about that the pings didn't ship.
			if (Array.isArray(p.logs_tail) && typeof p.log_total === 'number') {
				const baseline = logCursor === -1 ? 0 : logCursor;
				const missingCount = Math.max(0, p.log_total - baseline);
				if (missingCount > 0) {
					const take = p.logs_tail.slice(-missingCount);
					if (missingCount > take.length) {
						lines.push({ kind: 'gap', rel: null, text: `⋯ ${missingCount - take.length} log line${missingCount - take.length === 1 ? '' : 's'} missing before failure ⋯` });
					}
					for (const l of take) lines.push({ kind: 'log', rel: null, text: l });
					logCursor = p.log_total;
				}
			}
			if (p.last_error) {
				lines.push({ kind: 'err', rel, text: `⚠ ${p.last_error}` });
			}
			lines.push({
				kind: 'fail', rel,
				text: `stack_failed — ${p.reason || 'unknown'} (in ${p.failed_in || '?'})`,
			});
			if (firstOutcome === 'silent') firstOutcome = 'failed';
		} else if (ev.event_name === 'stack_finished') {
			lines.push({ kind: 'ok', rel, text: 'stack_finished' });
			if (firstOutcome === 'silent') firstOutcome = 'finished';
		} else if (ev.event_name === 'stack_cancelled') {
			lines.push({ kind: 'cancel', rel, text: 'stack_cancelled' });
			if (firstOutcome === 'silent') firstOutcome = 'cancelled';
		} else if (ev.event_name === 'stack_reader_fallback') {
			lines.push({ kind: 'step', rel, text: `stack_reader_fallback → ${p.to || '?'} (from ${p.from || '?'})` });
		} else {
			lines.push({ kind: 'other', rel, text: `${ev.event_name} ${JSON.stringify(p).slice(0, 120)}` });
		}
	}

	return {
		job_id: body.job_id,
		outcome: firstOutcome,
		reader: meta.reader,
		file_type: meta.file_type,
		gpu_enabled: meta.gpu_enabled,
		duration_ms: lastTs - firstTs,
		lines,
		gaps,
	};
}

function formatTs(ts) {
	if (!ts) return '';
	return new Date(Number(ts)).toLocaleString();
}
function formatDur(ms) {
	if (ms == null || ms < 0) return '—';
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	return `${m}m${s}s`;
}
function formatRel(ms) {
	if (ms == null) return '';
	if (ms < 1000) return `+${ms}ms`;
	return `+${(ms / 1000).toFixed(1)}s`;
}
</script>

<style scoped>
.controls {
	display: flex; flex-wrap: wrap; align-items: end; gap: 12px;
	margin: 0 0 1rem; padding: 12px; background: #f7f7f7;
	border-radius: 6px; border: 1px solid #e5e5e5;
}
.control { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #555; }
.control label { font-weight: bold; text-transform: uppercase; }
.control select, .control input[type="text"] {
	padding: 5px 8px; border: 1px solid #ccc; border-radius: 4px;
	background: #fff; font-size: 13px;
}
.range-buttons { display: flex; gap: 4px; }
.range-buttons button {
	padding: 5px 10px; background: #fff; border: 1px solid #ccc;
	border-radius: 4px; cursor: pointer; font-size: 12px;
}
.range-buttons button.active { background: #8CCF7E; border-color: #7ABF6E; font-weight: bold; }
.btn-refresh {
	padding: 6px 14px; background: #8CCF7E; border: 1px solid #7ABF6E;
	border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: bold;
}
.btn-refresh:disabled { opacity: 0.6; cursor: not-allowed; }

.admin-msg { text-align: center; padding: 1.5rem 1rem; color: #666; }
.admin-msg.error { color: #a33; }
.admin-msg.warn { color: #7a5a00; background: #fff4d6; border-radius: 4px; padding: 8px 12px; margin: 0 0 8px; text-align: left; }

.split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 1rem; }
@media (max-width: 1200px) { .split { grid-template-columns: 1fr; } }

.list-pane { overflow: auto; max-height: 78vh; }
.admin-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.admin-table th, .admin-table td {
	padding: 6px 8px; text-align: left; border-bottom: 1px solid #eee; vertical-align: top;
}
.admin-table th {
	background: #f7f7f7; position: sticky; top: 0; z-index: 1;
	font-weight: bold; font-size: 11px; text-transform: uppercase; color: #555;
}
.admin-table td.num, .admin-table th.num { text-align: right; }
.admin-table tbody tr { cursor: pointer; }
.admin-table tbody tr:hover { background: #f9f9f9; }
.admin-table tbody tr.selected { background: #eef7ea; }
.admin-table tbody tr.row-failed { background: #fff5f5; }
.admin-table tbody tr.row-failed.selected { background: #fbe4e4; }
.admin-table tbody tr.row-silent { background: #fff9e6; }
.admin-table tbody tr.row-silent.selected { background: #f5eabf; }
.admin-table tbody tr.row-cancelled { background: #fff9e6; }
.admin-table tbody tr.row-cancelled.selected { background: #f5eabf; }
.mono { font-family: 'SFMono-Regular', Menlo, Consolas, monospace; }
.ts { white-space: nowrap; color: #555; }
.val-warn { color: #a33; font-weight: bold; }

.badge {
	display: inline-block; padding: 2px 8px; border-radius: 999px;
	font-size: 11px; font-weight: bold; text-transform: capitalize;
}
.badge-finished  { background: #d6f0d6; color: #2a5a2a; }
.badge-failed    { background: #f0d6d6; color: #7a2a2a; }
.badge-cancelled { background: #fff4d6; color: #7a5a00; }
.badge-silent    { background: #fff4d6; color: #7a5a00; }
.badge-pending   { background: #e5e5e5; color: #444; }

.detail-pane {
	background: #fff; border: 1px solid #e5e5e5; border-radius: 6px;
	padding: 12px; max-height: 78vh; overflow: auto;
}
.detail-head { display: flex; justify-content: space-between; align-items: center; margin: 0 0 10px; gap: 8px; flex-wrap: wrap; }
.detail-head .badge { margin-left: 8px; }
.detail-meta { color: #666; font-size: 12px; }

.terminal {
	background: #0f0f0f; color: #d8d8d8; border-radius: 4px;
	padding: 10px 12px; font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
	font-size: 12px; line-height: 1.55;
	overflow: auto; max-height: 65vh;
}
.line { display: flex; gap: 10px; white-space: pre-wrap; word-break: break-word; }
.line-ts { flex: 0 0 60px; color: #6a6a6a; text-align: right; user-select: none; }
.line-body { flex: 1; min-width: 0; }
.line-log .line-body { color: #d8d8d8; }
.line-start .line-body { color: #7ee87e; font-weight: bold; }
.line-step .line-body { color: #a0c8ff; }
.line-ping .line-body { color: #7ee87e; }
.line-err .line-body { color: #ff9090; }
.line-fail .line-body { color: #ff5c5c; font-weight: bold; }
.line-ok .line-body { color: #7ee87e; font-weight: bold; }
.line-cancel .line-body { color: #d8b070; }
.line-gap .line-body { color: #d8b070; font-style: italic; }
.line-other .line-body { color: #b0b0b0; }
</style>

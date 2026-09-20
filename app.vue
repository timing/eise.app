<template>
	<NuxtLayout>
		<NuxtPage />
	</NuxtLayout>
</template>

<script setup>
import { ref, computed, provide, defineAsyncComponent, watch } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useStacker, WebGPUUnavailableError } from '@/composables/useStacker';
import { useTracking } from '@/composables/useTracking';
import { useProcessingState, getPass2Counters } from '@/composables/useProcessingState';
import { reportError } from '@/composables/useSentryReporting';
import { useLiteMode } from '@/composables/useLiteMode';
import { useContinuousStacking } from '@/composables/useContinuousStacking';
import { useStackLogTelemetry } from '@/composables/useStackLogTelemetry';

const { on, emit: eventBusEmit, addLog } = useEventBus();
const { stackFramesLocally } = useStacker();
const {
	runContinuousStacking,
	cancel: cancelContinuous,
	results: continuousResults,
	isProcessing: isContinuousProcessing,
	currentPercentage: continuousPercentage
} = useContinuousStacking();

const { track, trackHumanInteraction } = useTracking();
const {
	getTrackingContext,
	getStackJobProps,
	getInputFilename,
	getSelectedFileContext,
	markStackStart,
	markStackStep,
	markStackStop,
} = useProcessingState();
const { resetLogCursor, getLogDelta, handleDeltaAckFailure, getLogTail } = useStackLogTelemetry();

// Device baseline: iOS has no performance.memory, so mem_used_mb on stack_ping is
// null there. navigator.deviceMemory (GB, rounded) and hardwareConcurrency give a
// static device-class signal we can bucket iOS silents against. Read once at start
// and ship on stack_start; per-ping updates aren't useful (values never change).
function deviceBaselineProps() {
	if (typeof navigator === 'undefined') return {};
	const out = {};
	if (typeof navigator.deviceMemory === 'number') out.device_memory_gb = navigator.deviceMemory;
	if (typeof navigator.hardwareConcurrency === 'number') out.hardware_concurrency = navigator.hardwareConcurrency;
	return out;
}

function stackStartProps() {
	const filename = getInputFilename();
	return {
		...getTrackingContext(),
		filename: filename ? String(filename).slice(0, 200) : undefined,
		...deviceBaselineProps(),
	};
}
const router = useRouter();

// Processing state
const frames = ref([]);
const currentFrame = ref(null);
const selectedFile = ref(null);
const stackedFloat32Data = ref(null);
const stackedImageDimensions = ref(null);
const isProcessing = ref(false);
const isSelectingColorProfile = ref(false);
const isSelectingQuality = ref(false);
const isShowingContinuousResults = ref(false);
const qualityFrames = ref([]);
const qualityWorkers = ref(null);
const qualityUseWebGPU = ref(false);
const qualityFrameReReader = ref(null);
const qualityDrizzleScale = ref(1.5);
const qualitySurfaceMode = ref(false);
const croppedSerData = ref(null);

// Batch processing state
const batchResults = ref([]);
const isBatchProcessing = ref(false);

// WebGPU state
const showWebGPUChoice = ref(false);
const webGPUChoiceData = ref(null);
const webGPUSupported = ref(null);
// Reason WebGPU isn't usable, so error messages can be specific:
//   'available'   — adapter obtained
//   'no_adapter'  — navigator.gpu present but requestAdapter() returned null
//                   (usually: browser hardware acceleration is off, or the
//                   GPU/driver is on Chrome's WebGPU blocklist, or remote desktop)
//   'error'       — requestAdapter() threw
//   'unsupported' — navigator.gpu missing (Safari, older browsers, Firefox
//                   without dom.webgpu.enabled)
const webGPUStatus = ref(null);
const detectedBrowser = ref('Detecting...');
const forceLiteMode = ref(false);
const isMounted = ref(false);

// Computed
const isMobile = computed(() => {
	if (typeof navigator === 'undefined') return false;
	return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
});

// Lite mode: only for mobile devices (memory constrained) or manual override
// Desktop without WebGPU uses CPU mode with full features
const liteMode = computed(() => forceLiteMode.value || isMobile.value);
const useGPU = computed(() => webGPUSupported.value === true);

// Sync liteMode to shared state so composables can access it
const { setLiteMode } = useLiteMode();
watch(liteMode, (newValue) => {
	setLiteMode(newValue);
}, { immediate: true });

// Provide state to pages
provide('frames', frames);
provide('currentFrame', currentFrame);
provide('selectedFile', selectedFile);
provide('stackedFloat32Data', stackedFloat32Data);
provide('stackedImageDimensions', stackedImageDimensions);
provide('isProcessing', isProcessing);
provide('isSelectingColorProfile', isSelectingColorProfile);
provide('isSelectingQuality', isSelectingQuality);
provide('isShowingContinuousResults', isShowingContinuousResults);
provide('continuousResults', continuousResults);
provide('isContinuousProcessing', isContinuousProcessing);
provide('continuousPercentage', continuousPercentage);
provide('qualityFrames', qualityFrames);
provide('qualityFrameReReader', qualityFrameReReader);
provide('qualityDrizzleScale', qualityDrizzleScale);
provide('qualitySurfaceMode', qualitySurfaceMode);
provide('qualityUseWebGPU', qualityUseWebGPU);
provide('showWebGPUChoice', showWebGPUChoice);
provide('croppedSerData', croppedSerData);
provide('batchResults', batchResults);
provide('isBatchProcessing', isBatchProcessing);

provide('liteMode', liteMode);
provide('useGPU', useGPU);
provide('isMobile', isMobile);
provide('webGPUSupported', webGPUSupported);
provide('webGPUStatus', webGPUStatus);
provide('detectedBrowser', detectedBrowser);
provide('forceLiteMode', forceLiteMode);
provide('isMounted', isMounted);

// Provide handlers
provide('handlePostProcessing', handlePostProcessing);
provide('handleProcessingStarted', handleProcessingStarted);
provide('handleThresholdSelected', handleThresholdSelected);
provide('handleWebGPUContinueCPU', handleWebGPUContinueCPU);
provide('handleWebGPUCancel', handleWebGPUCancel);
provide('handleContinuousSelected', handleContinuousSelected);
provide('handleCancelContinuous', handleCancelContinuous);
provide('handleAbortContinuous', handleAbortContinuous);

// Browser detection
function detectBrowser() {
	const ua = navigator.userAgent;
	let browser = 'Unknown browser';

	if (/CriOS/.test(ua)) {
		const match = ua.match(/CriOS\/(\d+)/);
		browser = `Chrome on iOS ${match ? match[1] : ''}`;
	} else if (/FxiOS/.test(ua)) {
		const match = ua.match(/FxiOS\/(\d+)/);
		browser = `Firefox on iOS ${match ? match[1] : ''}`;
	} else if (/EdgiOS/.test(ua)) {
		const match = ua.match(/EdgiOS\/(\d+)/);
		browser = `Edge on iOS ${match ? match[1] : ''}`;
	} else if (/Edg\//.test(ua)) {
		const match = ua.match(/Edg\/(\d+)/);
		browser = `Edge ${match ? match[1] : ''}`;
	} else if (/Firefox\//.test(ua)) {
		const match = ua.match(/Firefox\/(\d+)/);
		browser = `Firefox ${match ? match[1] : ''}`;
	} else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) {
		const match = ua.match(/Chrome\/(\d+)/);
		browser = `Chrome ${match ? match[1] : ''}`;
	} else if (/Safari\//.test(ua) && /Version\//.test(ua)) {
		const match = ua.match(/Version\/(\d+)/);
		browser = `Safari ${match ? match[1] : ''}`;
	}

	if (/Android/.test(ua)) {
		const androidMatch = ua.match(/Android (\d+)/);
		browser += ` on Android ${androidMatch ? androidMatch[1] : ''}`;
	} else if (/iPhone|iPad|iPod/.test(ua)) {
		const iosMatch = ua.match(/OS (\d+)/);
		browser += ` on iOS ${iosMatch ? iosMatch[1] : ''}`;
	} else if (/Mac OS X/.test(ua)) {
		browser += ' on macOS';
	} else if (/Windows/.test(ua)) {
		browser += ' on Windows';
	} else if (/Linux/.test(ua)) {
		browser += ' on Linux';
	}

	return browser;
}

// Watchdog: promotes silent hangs during processing into stack_failed events
// so "stack_step then silence" sessions (see video_reader A/B analysis) stop
// looking like abandonment. Fires at most once per run.
//
// stackInFlight is a dedicated flag driven by explicit stack lifecycle events
// (start / finished / failed / cancelled) so cancel-then-hang doesn't emit a
// bogus stack_failed for the cancelled run. isProcessing.value would work most
// of the time, but a few code paths leave it true after cancel.
let stackInFlight = false;
let lastStackStep = null;
let lastStackStepTs = 0;
// One-shot guard for the pagehide/visibilitychange abandoned beacon (see the
// pagehide handler below). Reset on each stack start.
let stackAbandonedFired = false;

// stack_ping: 2s heartbeat emitted while a stack is in flight. Fills the
// blind spot between stack_step checkpoints — half the silent-death bucket
// in the mediabunny funnel lives in a >2min gap after `crop_detected` with
// no telemetry (section 11.15+ of MEDIABUNNY_RELIABILITY.md). The heartbeat
// carries: last stack_step reached, time since that step, time since start,
// tab visibility (a hidden tab may be throttled and look "silent"), heap
// usage where the browser exposes it, and the running counts / last message
// of any unhandled errors or rejections caught by the watchdog.
const STACK_PING_INTERVAL_MS = 2000;
const STACK_PING_MAX = 300;  // Safety: cap at 10 minutes to prevent runaway.
// Log delta / tail helpers live in useStackLogTelemetry so cancel sites in
// FileUploader / VideoFrameProcessor can attach `logs_tail` to their terminal
// events without plumbing through the bus.
let stackPingTimer = null;
let stackPingCount = 0;
let stackStartTs = 0;
let unhandledErrorCount = 0;
let lastUnhandledError = null;

function stackPingSnapshot() {
	const now = Date.now();
	const snap = {
		...getTrackingContext(),
		ping_seq: stackPingCount,
		last_step: lastStackStep || 'none',
		ms_since_step: lastStackStepTs ? now - lastStackStepTs : null,
		ms_since_start: stackStartTs ? now - stackStartTs : null,
		visibility: typeof document !== 'undefined' ? document.visibilityState : null,
		errors: unhandledErrorCount,
	};
	if (lastUnhandledError) snap.last_error = String(lastUnhandledError).slice(0, 150);
	// performance.memory is Chrome-only; noop elsewhere.
	if (typeof performance !== 'undefined' && performance.memory) {
		snap.mem_used_mb = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
		snap.mem_limit_mb = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024);
	}
	// Pass-2 telemetry: only include when we've reached a mediabunny step
	// AND at least one counter has moved. Lets us pin the exact stall point
	// (iterator vs decoder output vs backpressure vs batch) instantly.
	if (lastStackStep && lastStackStep.startsWith('mediabunny_')) {
		const c = getPass2Counters();
		if (c.packet_count || c.frame_index || c.batch_count || c.decode_queue_size != null) {
			snap.pass2_packets = c.packet_count;
			snap.pass2_frames = c.frame_index;
			snap.pass2_batches = c.batch_count;
			if (c.decode_queue_size != null) snap.pass2_queue = c.decode_queue_size;
			if (c.last_frame_ts) snap.pass2_ms_since_frame = now - c.last_frame_ts;
		}
	}
	return snap;
}

function emitStackPing() {
	const snap = stackPingSnapshot();
	const delta = getLogDelta();
	if (delta) Object.assign(snap, delta);
	// track() returns Promise<boolean> from the eise beacon. On failure, push
	// this ping's log lines back into the retry buffer so the next successful
	// ping prepends them. Silent failures (network hiccup, throttled hidden tab)
	// used to lose those lines because getLogDelta advanced the cursor eagerly.
	track('stack_ping', snap).then((ok) => {
		if (!ok && delta) handleDeltaAckFailure(delta);
	});
	stackPingCount++;
}

// Warm the post-processor chunks in the background while the stack runs. The
// stack takes seconds-to-minutes, so by the time we navigate on success the
// chunks are already cached against the currently-running bundle's hashes.
// Without this, a deploy that happens mid-stack invalidates the CDN hashes
// the running tab is about to request, defineAsyncComponent's import() at
// pages/post-processor.vue:17-18 gets undefined back, Vue reads `.default`
// on it, and the user sees "Cannot read properties of undefined (reading
// 'default')" right after their successful stack. Fire-and-forget: browser
// caches the module, navigation-time import reuses the cached response.
// Both components preloaded because batch mode can arrive at the same page.
function preloadPostProcessor() {
	if (typeof window === 'undefined') return;
	import('@/components/PostProcessor.vue').catch(() => {});
	import('@/components/BatchPostProcessor.vue').catch(() => {});
}

function startStackPing() {
	if (stackPingTimer) return;  // Already running.
	stackStartTs = Date.now();
	lastStackStepTs = 0;
	stackPingCount = 0;
	unhandledErrorCount = 0;
	lastUnhandledError = null;
	stackAbandonedFired = false;  // Fresh job: allow one abandoned event again.
	resetLogCursor();  // Only ship logs from this run onward; drain the retry buffer too.
	// Sync trace state so terminal fires in other components (FileUploader
	// cancel, VideoFrameProcessor cancel) can pick up ms_since_start / last_step
	// via getStackJobProps() without plumbing.
	markStackStart();
	// Fire once immediately so we can tell "processing started" from
	// "processing entered and instantly died" (first ping vs no ping).
	emitStackPing();
	stackPingTimer = setInterval(() => {
		if (stackPingCount >= STACK_PING_MAX) { stopStackPing(); return; }
		emitStackPing();
	}, STACK_PING_INTERVAL_MS);
}

function stopStackPing() {
	if (!stackPingTimer) return;
	clearInterval(stackPingTimer);
	stackPingTimer = null;
	markStackStop();
}

function trackWatchdogFailure(kind, message) {
	if (!stackInFlight) return;
	if (isBatchProcessing.value) return;  // Batch mode owns its own error tracking.
	stackInFlight = false;
	// Snapshot BEFORE stopping pings so we ship the same mem/visibility/timing
	// context the pings were carrying, plus the fresh error the listener set.
	const snap = stackPingSnapshot();
	const tail = getLogTail();  // Guaranteed pre-death log tail even if pings dropped.
	stopStackPing();
	// snap already carries getTrackingContext() via stackPingSnapshot(), plus
	// live last_step/ms_since_step/mem — no need to add getStackJobProps here.
	track('stack_failed', {
		...snap,
		...(tail || {}),
		reason: `unhandled:${kind}:${String(message || '').slice(0, 150)}`,
		failed_in: 'watchdog',
	});
}

// Coarse buckets for file_rejected. The raw message is kept too, but messages
// are long, interpolated with filenames/dimensions, and get reworded — grouping
// the analytics on a stable category is what makes the report readable.
// Order matters: first match wins, so put the specific patterns first.
const REJECT_CATEGORIES = [
	[/mixed with|Multiple non-SER/i, 'bad_combination'],
	[/not supported|unsupported|already demosaiced|use SER or AVI/i, 'unsupported_format'],
	[/too large|exceeds|downscale below|ran out of memory|allocation failed/i, 'too_large'],
	// Must match the real copy in gpuRequiredError() (FileUploader.vue:1238): the
	// no-adapter card says "can't access the GPU", the CPU-toggle variant says
	// "needs GPU processing". Neither contains the literal "WebGPU", so the old
	// patterns never fired and every GPU block landed in `other`.
	[/access the GPU|needs GPU processing|GPU is required|requires GPU|WebGPU|Processing back to GPU/i, 'gpu_required'],
	[/corrupt|could not be read|failed to parse|no video frames|may be corrupted/i, 'unreadable'],
	[/couldn't open this image|failed to load any images|failed to load/i, 'decode_failed'],
];

let lastRejectKey = '';
// Pre-start rejection. Deliberately NOT a stack_* event: there is no job, so it
// must not join to stack_job_id or it would pollute the stack funnel. Deduped
// on category+ext because several sites emit twice for one user action.
function trackFileRejected(source, message) {
	const msg = String(message || '').slice(0, 200);
	const category = (REJECT_CATEGORIES.find(([re]) => re.test(msg)) || [null, 'other'])[1];
	const fileCtx = getSelectedFileContext() || {};
	// Signature includes the selection itself, so re-picking a different file
	// and hitting the same category still reports (only true double-emits for
	// one user action are suppressed).
	const key = `${category}|${fileCtx.file_ext || '?'}|${fileCtx.file_count || 0}|${fileCtx.file_mb || 0}`;
	if (key === lastRejectKey) return;
	lastRejectKey = key;
	// gpu_enabled comes from setTrackingContext(), which only runs once a reader
	// has been picked — i.e. always AFTER this point, so it is null on every
	// rejection. Ship the pre-start GPU facts instead: capability + the reason
	// it is unusable, which is exactly what the gpu_required category needs.
	track('file_rejected', {
		...fileCtx,
		category,
		source,
		reason: msg,
		gpu_enabled: getTrackingContext()?.gpu_enabled ?? null,
		gpu_available: webGPUSupported.value,
		gpu_status: webGPUStatus.value,
		lite_mode: liteMode.value,
	});
}

onMounted(async () => {
	isMounted.value = true;
	trackHumanInteraction();

	// Electron: emit launch + first-launch events with platform/arch/version so
	// we can slice DAU and installs by desktop build. No-op in the browser.
	if (typeof window !== 'undefined' && window.electronAPI?.getPlatformInfo) {
		try {
			const info = await window.electronAPI.getPlatformInfo();
			track('electron_launch', info);
			const isFirst = await window.electronAPI.consumeFirstLaunch();
			if (isFirst) track('electron_first_launch', info);
		} catch (e) {
			console.warn('electron launch tracking failed:', e);
		}
	}

	const urlParams = new URLSearchParams(window.location.search);
	if (urlParams.get('lite') === '1' || urlParams.get('lite') === 'true') {
		forceLiteMode.value = true;
	}

	detectedBrowser.value = detectBrowser();

	if (navigator.gpu) {
		try {
			const adapter = await navigator.gpu.requestAdapter();
			webGPUSupported.value = !!adapter;
			webGPUStatus.value = adapter ? 'available' : 'no_adapter';
		} catch (e) {
			webGPUSupported.value = false;
			webGPUStatus.value = 'error';
		}
	} else {
		webGPUSupported.value = false;
		webGPUStatus.value = 'unsupported';
	}

	on('postProcessing', handlePostProcessing);
	on('stacked-image-ready', handleStackedImageReady);
	on('batch-started', handleBatchStarted);
	on('batch-complete', handleBatchComplete);
	// Prevent OS from suspending the Electron app while a stack is in progress
	if (typeof window !== 'undefined' && window.electronAPI?.startPowerSaveBlocker) {
		on('stacking-started', () => { window.electronAPI.startPowerSaveBlocker(); });
		on('stacked-image-ready', () => { window.electronAPI.stopPowerSaveBlocker(); });
		on('upload-error', () => { window.electronAPI.stopPowerSaveBlocker(); });
	}
	on('show-color-profile-selector', () => {
		isSelectingColorProfile.value = true;
	});
	on('color-profile-selected', () => {
		isSelectingColorProfile.value = false;
		isProcessing.value = true;
		stackInFlight = true;
		lastStackStep = null;
		// Emit start-loading immediately so VideoFrameProcessor shows loading state
		eventBusEmit('start-loading', 'Preparing to analyze...');
		track('stack_start', stackStartProps());
		preloadPostProcessor();
		startStackPing();
	});
	on('debayer-processing-started', () => {
		// For SER files where color profile selector was skipped (e.g., forced pattern)
		isProcessing.value = true;
		stackInFlight = true;
		lastStackStep = null;
		eventBusEmit('start-loading', 'Preparing to analyze...');
		track('stack_start', stackStartProps());
		preloadPostProcessor();
		startStackPing();
	});
	on('quality-selection-ready', handleQualitySelectionReady);
	on('cropped-ser-ready', (data) => {
		croppedSerData.value = data;
	});
	on('stack-step', (step, props) => {
		// Mid-pipeline funnel checkpoint. Carries reader/gpu/job_id so we can
		// see how far each attempt gets before dropping to cancel/fail.
		// Optional second arg carries step-specific detail (the NCC dispatch
		// steps use it to ship AP count, search radius and dispatch timings).
		// Tracking context goes last so a step can never shadow reader/job id.
		lastStackStep = step;
		lastStackStepTs = Date.now();
		markStackStep(step);  // Mirror to shared trace so other components' terminals see it.
		track('stack_step', { step, ...(props || {}), ...getTrackingContext() });
	});
	on('stack-failed', (data) => {
		// In batch mode, batch processing handles individual failures
		if (isBatchProcessing.value) {
			return;
		}
		stackInFlight = false;  // Explicit failure, watchdog stays quiet.
		const snap = stackPingSnapshot();
		const tail = getLogTail();
		stopStackPing();
		// snap carries base context + live trace; no need to re-add getStackJobProps.
		track('stack_failed', {
			...snap,
			...(tail || {}),
			reason: String(data?.reason || 'unknown').slice(0, 150),
			component: String(data?.component || 'unknown').slice(0, 60),
			failed_in: 'event',
		});
		isProcessing.value = false;
		const error = data?.error || new Error(`Stacking failed: ${data?.reason || 'unknown reason'}`);
		reportError(error, {
			component: data?.component || 'unknown',
			action: 'stacking'
		});
	});
	on('cancel-processing', () => { stackInFlight = false; stopStackPing(); });

	// Every `upload-error` bus emit paints a red banner in FileUploader.vue
	// (~15 catch-all failure sites, from FFmpeg OOM to worker-caught GPU faults).
	// Without this hook those never reach the analytics beacon — the user sees
	// the failure, we don't. Route them through the enriched stack_failed path.
	// Payload may be a plain string OR `{ message, alternatives }` (actionable
	// card variant) — unwrap so analytics doesn't log `[object Object]`.
	// When no stack is in flight the same emit means we turned the user away
	// BEFORE they ever got a job: unsupported format, bad file combination,
	// header parse failure, GPU required. Those used to return early here and
	// vanish, which is why the interacted -> stack_start funnel has a blind
	// 50%. Fire file_rejected instead so the pre-start drop-off is diagnosable.
	on('upload-error', (payload) => {
		const message = typeof payload === 'string' ? payload : (payload?.message || 'unknown');
		if (!stackInFlight) { trackFileRejected('upload_error', message); return; }
		trackWatchdogFailure('upload_error', message);
	});

	// Analytics-only channel for reject paths that never touch upload-error
	// (alert() + clearSelection sites). Paints no UI.
	on('file-rejected', (payload) => {
		trackFileRejected(payload?.source || 'unknown', payload?.message || 'unknown');
	});

	// Watchdog: catch unhandled rejections/errors during processing so the
	// "stack_step then silence" pattern we saw in the video_reader A/B test
	// surfaces as stack_failed instead of looking like abandonment. Only fires
	// while a stack is in flight (isProcessing) and only once per run.
	// Also increments the counters that ride along on stack_ping so we can
	// see WHEN in the ping timeline an error appeared, not just that one did.
	window.addEventListener('unhandledrejection', (ev) => {
		const msg = ev.reason?.message || String(ev.reason || '');
		if (stackInFlight) { unhandledErrorCount++; lastUnhandledError = `rejection:${msg}`; }
		trackWatchdogFailure('rejection', msg);
	});
	window.addEventListener('error', (ev) => {
		const msg = ev.message || 'error';
		if (stackInFlight) { unhandledErrorCount++; lastUnhandledError = `error:${msg}`; }
		trackWatchdogFailure('error', msg);
	});

	// Tab-close / navigation beacon. Silent jobs are dominated by "≤1 ping ever"
	// (60-90% per bucket) with ~50% of them showing the session was still alive
	// afterwards — meaning the ping stream broke, not the JS. On iOS Safari
	// specifically, keepalive:true fetches often don't survive real pagehide.
	// navigator.sendBeacon is the browser-guaranteed delivery for that exact
	// moment. One-shot per job: guarded by stackAbandonedFired so hidden->
	// visible->hidden doesn't double-fire.
	window.addEventListener('pagehide', () => fireStackAbandoned('pagehide'));
	// Plan-B: iOS Safari can freeze a hidden tab and kill it later without ever
	// running pagehide. Fire on hidden too — better to have an early snapshot
	// than nothing. If the user comes back visibility=visible we don't undo it,
	// but the guard keeps us from re-firing on the next hide.
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') fireStackAbandoned('hidden');
	});
});

function fireStackAbandoned(at) {
	if (!stackInFlight || stackAbandonedFired) return;
	if (typeof window === 'undefined' || !window.eise || typeof window.eise.sendBeacon !== 'function') return;
	stackAbandonedFired = true;
	const snap = stackPingSnapshot();
	const tail = getLogTail();
	// Fire-and-forget — sendBeacon queues the request even as the tab dies.
	window.eise.sendBeacon('stack_abandoned', {
		...snap,
		...(tail || {}),
		abandoned_at: at,  // 'pagehide' | 'hidden' — disambiguates silence-cause in analytics.
	});
}

const { getStackingMode, setContinuousResults } = useProcessingState();

function handleQualitySelectionReady(data) {
	qualityFrames.value = data.frames;
	qualityWorkers.value = data.workers;
	qualityUseWebGPU.value = data.useWebGPU || false;
	qualityFrameReReader.value = data.frameReReader || null;
	qualityDrizzleScale.value = data.drizzleScale || 1.5;
	qualitySurfaceMode.value = data.surfaceMode || false;

	// Reset results when starting new selection
	setContinuousResults([]);

	if (getStackingMode() === 'continuous') {
		isShowingContinuousResults.value = true;
	} else {
		isSelectingQuality.value = true;
	}
	eventBusEmit('stop-loading');
}

// Watcher for starting continuous stacking process
watch(isShowingContinuousResults, (newValue) => {
	if (newValue && continuousResults.value.length === 0 && !isContinuousProcessing.value) {
		runContinuousStacking(qualityFrames.value, {
			drizzleScale: qualityDrizzleScale.value,
			useWebGPU: qualityUseWebGPU.value,
			frameReReader: qualityFrameReReader.value,
			surfaceMode: qualitySurfaceMode.value
		});
	}
});

// Auto-navigate when complete
watch(isContinuousProcessing, (isNowProcessing) => {
    if (!isNowProcessing && isShowingContinuousResults.value && continuousResults.value.length > 0) {
        addLog('Continuous Stacking: Complete, transitioning to post-processor');
        
        // Find the result closest to 50%
        let targetResult = continuousResults.value[0];
        let minDiff = Math.abs(targetResult.percentage - 50);
        
        for (const res of continuousResults.value) {
            const diff = Math.abs(res.percentage - 50);
            if (diff < minDiff) {
                minDiff = diff;
                targetResult = res;
            }
        }
        
        addLog(`Continuous Stacking: Defaulting to ${targetResult.percentage}% stack`);
        handleContinuousSelected(targetResult);
    }
});

function handleContinuousSelected(result) {
	isShowingContinuousResults.value = false;
    
    // Transform all results into the format used by the Batch Post Processor
    // Match the { id, name, result: { blob, float32Data, width, height } } structure
    const formattedResults = continuousResults.value.map(res => ({
        id: `continuous-${res.percentage}`,
        name: `${res.percentage}% Stack`,
        sharpness: res.combined,
        tenengrad: res.tenengrad,
        laplacian: res.laplacian,
        frameCount: res.frameCount,
        result: {
            blob: res.blob,
            float32Data: res.float32Data,
            width: res.width,
            height: res.height
        }
    }));

    // Sort by percentage so they appear in order in the selector
    formattedResults.sort((a, b) => {
        const pctA = parseInt(a.name);
        const pctB = parseInt(b.name);
        return pctA - pctB;
    });

    batchResults.value = formattedResults;
    isBatchProcessing.value = true;
    
    // Find the index of the clicked result to start there
    const selectedIndex = formattedResults.findIndex(r => r.id === `continuous-${result.percentage}`);
    const { setBatchStartIndex } = useProcessingState();
    setBatchStartIndex(selectedIndex >= 0 ? selectedIndex : 0);
    
    // Also set the current 'primary' file to the one the user clicked on
    stackedFloat32Data.value = result.float32Data || null;
    stackedImageDimensions.value = { width: result.width, height: result.height };
    
	navigateTo('/post-processor/');
}

function handleCancelContinuous() {
	isShowingContinuousResults.value = false;
	isProcessing.value = false;
	// Go back to main menu
	router.push('/');
}

function handleAbortContinuous() {
    addLog('Continuous Stacking: User requested abort');
    cancelContinuous();
}


async function handleThresholdSelected(data) {
	isSelectingQuality.value = false;

	const hasValidWorkers = qualityWorkers.value && qualityWorkers.value.length > 0;
	const isTwoPassMode = qualityFrameReReader.value !== null;
	const canStack = qualityUseWebGPU.value || hasValidWorkers;

	if (data.frames && data.frames.length > 0 && canStack) {
		eventBusEmit('start-loading', 'Stacking selected frames...');
		addLog(`Stacking ${data.frames.length} frames (${Math.round(data.percentage * 100)}% threshold)${isTwoPassMode ? ' (two-pass mode)' : ''}`);

		// In two-pass mode, frames are re-read from file during stacking, so we can free the buffers now
		if (isTwoPassMode) {
			for (const frame of qualityFrames.value) {
				delete frame.uint8Buffer;
				delete frame.blob;
			}
		}

		const stackingWorker = hasValidWorkers ? qualityWorkers.value[0] : null;

		try {
			const stackResult = await stackFramesLocally(data.frames, stackingWorker, qualityDrizzleScale.value, qualityUseWebGPU.value, qualityFrameReReader.value);

			if (hasValidWorkers) {
				qualityWorkers.value.forEach(worker => worker.terminate());
			}
			qualityWorkers.value = null;
			qualityFrameReReader.value = null;

			if (stackResult && stackResult.blob) {
				addLog('Client-side stacking complete');
				eventBusEmit('stacked-image-ready', {
					blob: stackResult.blob,
					float32Data: stackResult.float32Data,
					width: stackResult.width,
					height: stackResult.height
				});
			} else {
				addLog('Client-side stacking failed - no valid frames');
				eventBusEmit('stop-loading');
				isProcessing.value = false;
			}
		} catch (error) {
			if (error instanceof WebGPUUnavailableError) {
				addLog(`WebGPU not available: ${error.message}`);
				eventBusEmit('stop-loading');
				webGPUChoiceData.value = {
					frames: data.frames,
					stackingWorker,
					hasValidWorkers,
					drizzleScale: qualityDrizzleScale.value,
					frameReReader: qualityFrameReReader.value
				};
				showWebGPUChoice.value = true;
			} else {
				addLog(`Stacking error: ${error.message}`);
				eventBusEmit('stop-loading');
				isProcessing.value = false;
				if (hasValidWorkers) {
					qualityWorkers.value.forEach(worker => worker.terminate());
				}
				qualityWorkers.value = null;
				qualityFrameReReader.value = null;
				reportError(error);
			}
		}
	} else {
		addLog('No frames selected for stacking');
		isProcessing.value = false;
	}
}

async function handleWebGPUContinueCPU() {
	showWebGPUChoice.value = false;
	const data = webGPUChoiceData.value;
	webGPUChoiceData.value = null;

	if (!data) return;

	addLog('Continuing with CPU stacking (slower but compatible)...');
	eventBusEmit('start-loading', 'Stacking with CPU...');

	try {
		const stackResult = await stackFramesLocally(
			data.frames,
			data.stackingWorker,
			data.drizzleScale,
			false,
			data.frameReReader
		);

		if (data.hasValidWorkers) {
			qualityWorkers.value?.forEach(worker => worker.terminate());
		}
		qualityWorkers.value = null;
		qualityFrameReReader.value = null;

		if (stackResult && stackResult.blob) {
			addLog('CPU stacking complete');
			eventBusEmit('stacked-image-ready', {
				blob: stackResult.blob,
				float32Data: stackResult.float32Data,
				width: stackResult.width,
				height: stackResult.height
			});
		} else {
			addLog('CPU stacking failed - no valid frames');
			eventBusEmit('stop-loading');
			isProcessing.value = false;
		}
	} catch (error) {
		addLog(`CPU stacking error: ${error.message}`);
		eventBusEmit('stop-loading');
		isProcessing.value = false;
		if (data.hasValidWorkers) {
			qualityWorkers.value?.forEach(worker => worker.terminate());
		}
		qualityWorkers.value = null;
		qualityFrameReReader.value = null;
		reportError(error);
	}
}

function handleWebGPUCancel() {
	showWebGPUChoice.value = false;
	const data = webGPUChoiceData.value;
	webGPUChoiceData.value = null;

	addLog('Stacking cancelled by user');
	eventBusEmit('cancel-processing');

	if (data?.hasValidWorkers) {
		qualityWorkers.value?.forEach(worker => worker.terminate());
	}
	qualityWorkers.value = null;
	qualityFrameReReader.value = null;
	isProcessing.value = false;
}

async function handleStackedImageReady(data) {
	// Skip if batch processing or continuous stacking is active
	if (isBatchProcessing.value || isShowingContinuousResults.value) {
		return;
	}

	selectedFile.value = data.blob;
	stackedFloat32Data.value = data.float32Data || null;
	stackedImageDimensions.value = (data.width && data.height) ? { width: data.width, height: data.height } : null;
	isProcessing.value = false;
	stackInFlight = false;
	stopStackPing();
	// getStackJobProps ships last_step + ms_since_start, so we can tell a fast
	// crop_detected→finished from a long finalization tail. getLogTail() ships
	// the last ~50 log lines so the admin viewer can back-fill any lines added
	// between the last ping and the terminal (finished used to ship no logs).
	const tail = getLogTail();
	track('stack_finished', { ...getStackJobProps(), ...(tail || {}) });
	navigateTo('/post-processor/');
}

// Batch processing handlers
function handleBatchStarted() {
	isBatchProcessing.value = true;
}

function handleBatchComplete(data) {
	isBatchProcessing.value = false;
	batchResults.value = data.results || [];
	isProcessing.value = false;
	track('batch_stack_finished', {
		...getTrackingContext(),
		file_count: data.totalCount,
		success_count: data.successCount
	});
	navigateTo('/post-processor/');
}

function handleProcessingStarted() {
	isProcessing.value = true;
	stackInFlight = true;
	lastStackStep = null;
	track('stack_start', stackStartProps());
	preloadPostProcessor();
	startStackPing();
}

async function handlePostProcessing(data) {
	if (isShowingContinuousResults.value) {
		return;
	}
	selectedFile.value = data;
	isProcessing.value = false;
	// Mirror handleStackedImageReady's terminal handling — but only when a
	// stack was actually in flight. `postProcessing` is also emitted from
	// FileUploader for the single-image "straight to post-processor" flow
	// (no stacking); in that case there's no stack_start to pair with, so
	// firing stack_finished would create a phantom terminal. When we DID
	// stack: clear stackInFlight so the watchdog stops classifying downstream
	// navigation errors as stack_failed (the stale-bundle chunk-load
	// "Cannot read properties of undefined (reading 'default')" hit us this
	// way right after a fresh deploy), and emit stack_finished so the
	// video-path terminal-outcome analytics reflect what actually happened
	// (the "0/74 mediabunny mobile finished" stat was an artifact of this
	// handler never emitting the completion event).
	if (stackInFlight) {
		stackInFlight = false;
		stopStackPing();
		const tail = getLogTail();
		track('stack_finished', { ...getStackJobProps(), ...(tail || {}) });
	}
	navigateTo('/post-processor/');
}
</script>

<style>
html {
	/* Header palette, hoisted so all components can reference the same tokens.
	   Body/nav text, testimonials, footer, etc. all pull from --eise-on-dark
	   (or its rgb-triplet variant for translucent rgba use). */
	--eise-teal-900: #093442;
	--eise-teal-800: #0f4356;
	--eise-teal-600: #2b7a95;
	--eise-gilt:     #d9a94a;
	--eise-gilt-lt:  #eec36c;
	--eise-ink:      #14232a;
	--eise-on-dark:  #c2d6db;
	--eise-on-dark-rgb: 194, 214, 219;
	--eise-muted:    #7e9aa2;
	/* Panel surface (stack page + post processor settings column). */
	--eise-panel:        #11323f;
	--eise-panel-border: rgba(255, 255, 255, 0.14);
	--eise-panel-line:   rgba(255, 255, 255, 0.08);
	--eise-label:        #68808f;
	--eise-muted-2:      #97b1b8;
	--eise-body:         #bdd2d8;
	--eise-bright:       #eef5f7;
	--eise-link:         #8fcfe0;
	--eise-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
html,body {
	padding: 0;
	margin: 0;
	font-family: -apple-system,\.SFNSText-Regular,San Francisco,Roboto,Segoe UI,Helvetica Neue,Lucida Grande,sans-serif;
	font-size: 13px;
	-moz-osx-font-smoothing: grayscale;
	-webkit-font-smoothing: antialiased;
	-webkit-min-device-pixel-ratio: 1.5;
	color: var(--eise-on-dark);
	min-height: 100%;
}
html {
	/* Page ground, straight from the design: a teal top-right glow over a
	   vertical teal ramp. Values are the --eise-teal-* tokens above. */
	background-color: var(--eise-teal-900);
	background-image:
		radial-gradient(1200px 600px at 78% -10%, var(--eise-teal-600) 0%, rgba(43, 122, 149, 0) 60%),
		linear-gradient(180deg, var(--eise-teal-800) 0%, var(--eise-teal-900) 100%);
}
.content a:not(.btn-primary):not(.btn-secondary):not(.btn-danger),
.content a:visited:not(.btn-primary):not(.btn-secondary):not(.btn-danger) {
	color: inherit;
}
body {
	padding-bottom: 80px;
}
.clearb {
	clear: both;
}
/* Section headings on the dark app chrome go pure white for contrast.
   Overridden by the ink-on-white rule under .content-card, which uses
   higher specificity so paper-style pages keep their dark headings. */
h2 {
	color: #ffffff;
}
button, a.button {
	background-color: #fefefe;
	border: none;
	color: #333;
	padding: 10px 20px;
	cursor: pointer;
	transition: background-color 0.3s;
	border-radius: 5px;
	text-decoration: none;
	font-size: 13px;
}
button:hover, a.button:hover {
	background-color: #70f1ec;
}
.page-layout {
	display: flex;
	flex-direction: column;
	padding: 20px;
	gap: 20px;
	max-width: 900px;
	margin: 0 auto;
	/* Keeps the footer pushed toward the bottom when the page content shrinks
	   (e.g. during stacking when the welcome copy is hidden). Reserves rough
	   space for header (~60px) + footer + Logger sticky. */
	min-height: calc(100vh - 200px);
}
.page-layout.page-layout-wide {
	max-width: none;
}
.page-layout.page-layout-wide .content {
	max-width: none;
}
.page-layout .card {
	width: auto;
	max-width: 100%;
}
.page-layout .content {
	width: 100%;
}
@media (min-width: 640px) {
	.page-layout {
		flex-direction: row;
		align-items: flex-start;
		flex-wrap: nowrap;
		gap: 40px;
	}
	.page-layout .card {
		width: 272px;
	}
	.page-layout .content {
		width: auto;
		min-width: 0;
	}
}
/* Two-column app layout: sticky settings panel + work area. Used by the stack
   page (.stack-layout) and the post processor (.pp-layout); they differ only
   in how wide the panel column is allowed to get. */
.page-layout.stack-layout,
.page-layout.pp-layout {
	display: grid;
	grid-template-columns: minmax(340px, 400px) minmax(0, 1fr);
	align-items: start;
	gap: 40px;
	width: 100%;
	max-width: 1560px;
	margin: 0 auto;
	padding: 32px 28px 96px;
	box-sizing: border-box;
}
.page-layout.pp-layout {
	grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
}
/* Inline in the page, not sticky: the panel sits at the top of its column,
   expands to its full height, and scrolls away with the rest of the page. */
.stack-layout > .panel,
.pp-layout > .panel {
	align-self: start;
}
.stack-layout > .content,
.pp-layout > .content {
	width: auto;
	min-width: 0;
	padding: 0;
}
.stack-layout > .content {
	max-width: 780px;
}
/* 1120 is the design's "md" breakpoint (where the header starts dropping
   items); the panel narrows there and only stacks once two columns stop
   working at all, at 760. */
@media (max-width: 1120px) {
	.page-layout.stack-layout,
	.page-layout.pp-layout {
		grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
		gap: 28px;
		padding: 28px 20px 80px;
	}
}
@media (max-width: 760px) {
	.page-layout.stack-layout,
	.page-layout.pp-layout {
		grid-template-columns: minmax(0, 1fr);
		gap: 28px;
		padding: 20px 16px 64px;
	}
	.stack-layout > .panel,
	.pp-layout > .panel {
		position: static;
		/* Stacked above the content: keep the panel a panel, not a banner. */
		width: 100%;
		max-width: 420px;
		max-height: none;
		overflow-y: visible;
	}
}
.content {
	max-width: 500px;
	padding: 5px;
	line-height: 1.5;
	flex: 1;
}
/* Content-card: a white paper for text-heavy pages (about/*, download, comparison).
   Opt in by adding the `content-card` class to the inner .content div. */

/* Kill the flex layout on the parent when a content-card is present, so the card
   can center normally with margin: auto and its own max-width. Parent padding
   guarantees breathing room on the sides at all viewport widths. */
.page-layout:has(> .content.content-card) {
	display: block;
	padding: 0 12px;
	max-width: none;
	margin: 0;
}

.page-layout .content.content-card {
	background: #fefefe;
	color: #222;
	box-sizing: border-box;
	width: 100%;
	max-width: 820px;
	padding: 56px 72px;
	margin: 24px auto 48px;
	border-radius: 12px;
	box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18);
	line-height: 1.7;
	font-size: 16px;
	flex: initial;
}
/* Dashboard variant: full-width, slim padding, no text-child cap. Use on
   pages like /admin where the card contains tables/forms, not prose. */
.page-layout .content.content-card.content-card-dashboard {
	max-width: none;
	padding: 24px 32px;
}
@media (max-width: 640px) {
	.page-layout .content.content-card.content-card-dashboard {
		padding: 16px 12px;
	}
}
.page-layout .content.content-card.content-card-dashboard > :is(h2, h3, h4, p, ul, ol, dl, blockquote) {
	max-width: none;
}
.page-layout .content.content-card h2 {
	font-size: 30px;
	color: #1a1a1a;
	margin: 0 0 20px;
	line-height: 1.2;
	letter-spacing: -0.01em;
	font-weight: 700;
}
.page-layout .content.content-card > h2 + .page-subtitle {
	margin: -12px 0 32px;
	font-size: 18px;
	line-height: 1.4;
	color: #555;
	font-weight: 400;
}
.page-layout .content.content-card h3 {
	font-size: 22px;
	color: #1a1a1a;
	margin: 40px 0 12px;
	line-height: 1.3;
	font-weight: 600;
}
.page-layout .content.content-card h4 {
	font-size: 17px;
	color: #1a1a1a;
	margin: 28px 0 8px;
	font-weight: 600;
}
.page-layout .content.content-card p {
	color: #333;
	margin: 0 0 16px;
}
.page-layout .content.content-card ul,
.page-layout .content.content-card ol {
	color: #333;
	margin: 0 0 16px;
	padding-left: 24px;
}
.page-layout .content.content-card li {
	margin-bottom: 8px;
}
.page-layout .content.content-card a:not(.btn-primary):not(.btn-secondary):not(.btn-danger):not(.button):not(.download-btn):not(.submit-btn):not(.cta-secondary):not(.bmc-btn),
.page-layout .content.content-card a:visited:not(.btn-primary):not(.btn-secondary):not(.btn-danger):not(.button):not(.download-btn):not(.submit-btn):not(.cta-secondary):not(.bmc-btn) {
	color: #1a5a99;
	text-decoration: none;
	border-bottom: 1px solid rgba(26, 90, 153, 0.3);
}
.page-layout .content.content-card a:hover:not(.btn-primary):not(.btn-secondary):not(.btn-danger):not(.button):not(.download-btn):not(.submit-btn):not(.cta-secondary):not(.bmc-btn) {
	color: #0d3d6e;
	border-bottom-color: #0d3d6e;
}
.page-layout .content.content-card code {
	background: #f4f4f4;
	color: #222;
	padding: 2px 6px;
	border-radius: 3px;
	font-size: 0.9em;
}
.page-layout .content.content-card strong {
	color: #1a1a1a;
}
@media (max-width: 700px) {
	.page-layout .content.content-card {
		padding: 28px 20px;
		margin: 12px auto 24px;
		border-radius: 10px;
		font-size: 15px;
	}
	.page-layout .content.content-card h2 { font-size: 24px; }
	.page-layout .content.content-card h3 { font-size: 19px; margin-top: 32px; }
	.page-layout .content.content-card h4 { font-size: 16px; }
}
canvas {
	display: block;
	width: auto;
	height: auto;
}
.card {
	background-color: #fefefe;
	color: #333;
	border: 1px solid #ddd;
	border-radius: 10px;
	padding: 10px 20px 20px 20px;
	width: 272px;
	margin: 50px;
	flex-shrink: 0;
}
.page-layout .card {
	margin: 0;
}
.separator {
	border-top: 1px solid #ddd;
	margin: 10px 0;
}
.card .separator {
	margin-left: -20px;
	margin-right: -20px;
}
.card h4 {
	margin-bottom: 0;
}
/* Unified number input - replaces .percentage-input, .small-number-input, .inline-number, .repeats-input */
.number-input {
	width: 55px;
	padding: 4px 6px;
	border: 1px solid #ccc;
	border-radius: 4px;
	text-align: center;
}
.number-input:disabled {
	background: #eee;
	color: #999;
}

/* ============================================================
   Panel: the dark settings surface used by the stack page and
   the post processor (replaces the white `.card` on those two).
   Every control inside a .panel picks up the dark treatment
   automatically, so components only need structural classes.
   ============================================================ */
.panel {
	background: var(--eise-panel);
	color: var(--eise-body);
	border: 1px solid var(--eise-panel-border);
	border-radius: 12px;
	box-shadow: 0 8px 28px rgba(3, 11, 20, 0.32);
	box-sizing: border-box;
}
.panel-section {
	padding: 20px 22px;
}
/* Hairline BETWEEN sections only. Deliberately not `:first-child` + border-top:
   a non-section sibling (the absolutely positioned processing spinner) would
   then push the first section out of :first-child mid-render, popping a border
   in and shifting the whole panel by a pixel. */
.panel-section + .panel-section {
	border-top: 1px solid var(--eise-panel-line);
}
/* Content that continues the section above it (e.g. expanded Advanced). */
.panel-section.panel-section-flush,
.panel-section + .panel-section.panel-section-flush {
	border-top: none;
	padding-top: 4px;
}
/* Section caption. Also used on h3/h4 so the heading outline survives. */
.panel-label {
	display: flex;
	align-items: center;
	gap: 7px;
	margin: 0 0 12px;
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--eise-label);
}
.panel-title {
	margin: 0 0 3px;
	font-size: 14px;
	font-weight: 600;
	letter-spacing: -0.005em;
	color: var(--eise-bright);
}
.panel-sub {
	margin: 0 0 16px;
	font-size: 12.5px;
	line-height: 1.5;
	color: var(--eise-muted-2);
}
.panel-note {
	font-size: 12.5px;
	line-height: 1.5;
	color: var(--eise-muted-2);
}
.panel-mono {
	font-family: var(--eise-mono);
	font-size: 10.5px;
	letter-spacing: 0.05em;
	color: var(--eise-muted-2);
}

/* Option rows: radio/checkbox choices rendered as selectable tiles. */
.opt-group {
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.opt-row {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 9px 11px;
	border-radius: 7px;
	border: 1px solid rgba(255, 255, 255, 0.09);
	background: rgba(255, 255, 255, 0.04);
	color: var(--eise-body);
	font-size: 13.5px;
	line-height: 1.35;
	cursor: pointer;
	transition: background 110ms ease, border-color 110ms ease;
}
.opt-row:hover {
	background: rgba(255, 255, 255, 0.07);
}
.opt-row:has(input:checked) {
	border-color: rgba(217, 169, 74, 0.45);
	background: rgba(217, 169, 74, 0.14);
	color: #f4fafb;
}
/* Pill badge for "new", "beta" markers inside option rows. */
.opt-badge {
	display: inline-block;
	margin-left: 8px;
	padding: 1px 7px;
	border-radius: 999px;
	background: rgba(255, 255, 255, 0.08);
	border: 1px solid var(--eise-panel-border);
	font-family: var(--eise-mono);
	font-size: 10px;
	font-weight: normal;
	letter-spacing: 0.04em;
	color: #9ab3ba;
	vertical-align: middle;
}
.opt-badge.gilt {
	background: rgba(217, 169, 74, 0.14);
	border-color: rgba(217, 169, 74, 0.3);
	color: var(--eise-gilt-lt);
}

/* Form controls inside a panel. */
.panel input[type="radio"] {
	appearance: none;
	-webkit-appearance: none;
	flex: 0 0 auto;
	width: 13px;
	height: 13px;
	margin: 0;
	box-sizing: border-box;
	border: 1.5px solid rgba(255, 255, 255, 0.3);
	border-radius: 50%;
	background: transparent;
	cursor: pointer;
}
.panel input[type="radio"]:checked {
	border: 4px solid var(--eise-gilt);
	background: var(--eise-panel);
}
.panel input[type="checkbox"] {
	flex: 0 0 auto;
	width: 15px;
	height: 15px;
	margin: 0;
	accent-color: var(--eise-gilt);
	cursor: pointer;
}
.panel input[type="range"] {
	width: 100%;
	height: 4px;
	accent-color: var(--eise-gilt);
	cursor: pointer;
}
.panel input[type="number"],
.panel input[type="text"],
.panel .number-input {
	width: 66px;
	padding: 4px 7px;
	background: rgba(255, 255, 255, 0.05);
	border: 1px solid var(--eise-panel-border);
	border-radius: 5px;
	color: var(--eise-bright);
	font-family: var(--eise-mono);
	font-size: 12px;
	text-align: right;
}
.panel input[type="number"]:disabled,
.panel .number-input:disabled {
	background: rgba(255, 255, 255, 0.02);
	color: var(--eise-label);
}
.panel label {
	cursor: pointer;
}
/* Checkbox/label line that is not a full option tile. */
.panel-check {
	display: flex;
	align-items: center;
	gap: 10px;
	font-size: 13.5px;
	color: var(--eise-body);
	cursor: pointer;
}
/* label | control | value readout */
.slider-row {
	display: grid;
	grid-template-columns: 74px 1fr 42px;
	align-items: center;
	gap: 10px 12px;
}
.slider-row > label,
.slider-row > .slider-label {
	font-size: 13px;
	color: var(--eise-body);
}
.panel-value {
	font-family: var(--eise-mono);
	font-size: 12px;
	color: var(--eise-bright);
	text-align: right;
}

/* Neutral button on the dark panel. */
.panel-btn {
	padding: 9px 12px;
	border-radius: 7px;
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid var(--eise-panel-border);
	color: #dfeaed;
	font: inherit;
	font-size: 13px;
	cursor: pointer;
	transition: background 120ms ease;
}
.panel-btn:hover {
	background: rgba(255, 255, 255, 0.11);
	color: #ffffff;
}
.panel-btn.gilt {
	background: var(--eise-gilt);
	border-color: transparent;
	color: var(--eise-ink);
	font-weight: 600;
}
.panel-btn.gilt:hover {
	background: #f3d290;
	color: var(--eise-ink);
}

/* Segmented control (sharpening method picker). */
.seg-group {
	display: flex;
	gap: 4px;
	padding: 3px;
	border-radius: 8px;
	background: rgba(0, 0, 0, 0.2);
	border: 1px solid rgba(255, 255, 255, 0.09);
}
.seg-btn {
	flex: 1 1 auto;
	padding: 7px 10px;
	border: none;
	border-radius: 6px;
	background: transparent;
	color: var(--eise-body);
	font: inherit;
	font-size: 13px;
	cursor: pointer;
}
.seg-btn:hover {
	background: rgba(255, 255, 255, 0.07);
	color: #ffffff;
}
.seg-btn.active,
.seg-btn.active:hover {
	background: var(--eise-gilt);
	color: var(--eise-ink);
	font-weight: 600;
}

/* Dashed file drop target. */
.drop-zone {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	text-align: center;
	padding: 28px 18px;
	border-radius: 8px;
	border: 1px dashed rgba(255, 255, 255, 0.22);
	background: rgba(0, 0, 0, 0.16);
	cursor: pointer;
	transition: background 120ms ease, border-color 120ms ease;
}
.drop-zone:hover,
.drop-zone.is-hover {
	border-color: var(--eise-gilt);
	background: rgba(217, 169, 74, 0.1);
}

/* Inline help text revealed by the ⓘ icons. */
.panel .info-icon {
	color: var(--eise-label);
}
.panel .info-icon:hover {
	color: var(--eise-on-dark);
}
.panel .info-text {
	margin-top: 10px;
	padding: 10px 12px;
	border-radius: 6px;
	background: rgba(0, 0, 0, 0.2);
	border: 1px solid var(--eise-panel-line);
	font-size: 12.5px;
	line-height: 1.55;
	color: var(--eise-muted-2);
}
.panel .info-text strong {
	color: var(--eise-body);
}

/* Primary action button (green) */
.btn-primary {
	display: inline-block;
	background-color: #8CCF7E;
	color: #111;
	padding: 10px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-weight: bold;
	text-decoration: none;
}
.btn-primary:hover {
	background-color: #7ABF6E;
	color: #111;
	text-decoration: none;
}
.btn-primary:disabled {
	background-color: #ccc;
	cursor: not-allowed;
}
/* Danger/cancel button (red) */
.btn-danger {
	background-color: #D9534F;
	color: white;
	padding: 10px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-weight: bold;
}
.btn-danger:hover {
	background-color: #C9302C;
}
/* Secondary button (gray) */
.btn-secondary {
	background-color: #888;
	color: white;
	padding: 10px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
}
.btn-secondary:hover {
	background-color: #666;
}
/* File input */
.file-input-wrapper {
	position: relative;
	margin-bottom: 10px;
}
.file-input-wrapper input[type="file"] {
	position: absolute;
	opacity: 0;
	width: 100%;
	height: 100%;
	cursor: pointer;
	z-index: 2;
}
.file-label {
	display: block;
	padding: 10px 15px;
	background: #f5f5f5;
	border: 2px dashed #ccc;
	border-radius: 5px;
	text-align: center;
	cursor: pointer;
	transition: all 0.2s;
	color: #666;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.file-label:hover,
.file-input-wrapper:hover .file-label {
	border-color: #8CCF7E;
	background: #f0fff0;
}
/* Enhanced drop zone styling */
.file-input-wrapper:not(.has-files) .file-label {
	padding: 25px 15px;
	white-space: normal;
}
.drop-zone-content {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 8px;
}
.drop-icon {
	font-size: 28px;
	line-height: 1;
}
.drop-text {
	font-size: 14px;
	color: #666;
}
.drop-button {
	display: inline-block;
	background-color: #8CCF7E;
	color: #111;
	padding: 8px 20px;
	border-radius: 5px;
	font-weight: bold;
	font-size: 14px;
	margin: 4px 0;
}
.file-input-wrapper:hover .drop-button {
	background-color: #7ABF6E;
}
.drop-formats {
	font-size: 12px;
	color: #888;
}
.drop-privacy {
	font-size: 11px;
	color: #999;
	font-style: italic;
}
.supported-formats {
	font-size: 12px;
	color: #888;
	margin-top: 5px;
}
#sentry-feedback {
	--inset: auto 0 80px auto;
}
/* Ensure Sentry feedback dialog appears above export popup */
[data-sentry-feedback] {
	z-index: 10000 !important;
}
.compat-table {
	border-collapse: collapse;
	margin: 10px 0;
	font-size: 0.95em;
}
.compat-table th, .compat-table td {
	border: 1px solid rgba(255,255,255,0.2);
	padding: 6px 12px;
	text-align: left;
}
.compat-table th {
	background: rgba(255,255,255,0.1);
}
.compat-status {
	margin: 15px 0;
	padding: 10px 15px;
	border-radius: 5px;
}
.compat-status.compatible {
	background: rgba(140, 207, 126, 0.2);
	border: 1px solid #8CCF7E;
}
.compat-status.incompatible {
	background: rgba(255, 193, 7, 0.2);
	border: 1px solid #ffc107;
}
.compat-status.checking {
	background: rgba(200, 200, 200, 0.2);
	border: 1px solid #999;
}
.lite-mode-banner {
	background: rgba(255, 193, 7, 0.2);
	border: 1px solid #ffc107;
	color: #fff;
	padding: 10px 15px;
	margin: 10px 20px 0px 20px;
	border-radius: 5px;
	font-size: 13px;
}
.home-testimonial {
	margin: 20px 0;
	padding: 14px 20px;
	background: rgba(255, 255, 255, 0.04);
	border-left: 3px solid #8CCF7E;
	border-radius: 4px;
	color: var(--eise-on-dark);
}
.home-testimonial-quote {
	margin: 0 0 6px;
	font-style: italic;
	font-size: 14px;
	line-height: 1.5;
}
.home-testimonial-cite {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 12px;
	margin: 0;
	font-size: 12px;
	color: rgba(var(--eise-on-dark-rgb), 0.65);
	flex-wrap: wrap;
}
.home-testimonial-cite a {
	color: #8CCF7E;
	text-decoration: none;
	white-space: nowrap;
}
.home-testimonial-cite a:hover {
	text-decoration: underline;
}
.comparison-images {
	display: flex;
	align-items: center;
	justify-content: flex-start;
	gap: 20px;
	margin: 30px 0;
	flex-wrap: nowrap;
}
.comparison-images.vertical {
	flex-direction: column;
	flex-shrink: 0;
	width: 314px;
}
.comparison-images img {
	max-width: 150px;
	height: auto;
	border-radius: 8px;
	box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.comparison-images .arrow {
	font-size: 24px;
}
.comparison-figure {
	margin: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 8px;
}
.comparison-figure figcaption {
	font-size: 12px;
	color: rgba(var(--eise-on-dark-rgb), 0.75);
	text-align: center;
}
.content.content-card .comparison-figure figcaption {
	color: #555;
}
.webgpu-dialog-overlay {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background: rgba(0, 0, 0, 0.7);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 1000;
}
.webgpu-dialog {
	background: #fefefe;
	color: #333;
	border-radius: 10px;
	padding: 25px 30px;
	max-width: 450px;
	margin: 20px;
	box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
.webgpu-dialog h3 {
	margin: 0 0 15px 0;
	color: #d9534f;
}
.webgpu-dialog p {
	margin: 10px 0;
	line-height: 1.5;
}
.webgpu-dialog .browser-tip {
	font-size: 12px;
	color: #666;
	background: #f5f5f5;
	padding: 10px;
	border-radius: 5px;
	margin-top: 15px;
}
.webgpu-dialog-buttons {
	display: flex;
	gap: 10px;
	margin-top: 20px;
	flex-wrap: wrap;
}
.webgpu-dialog-buttons .continue-button {
	background-color: #8CCF7E;
	color: #111;
	font-weight: bold;
	flex: 1;
}
.webgpu-dialog-buttons .continue-button:hover {
	background-color: #7ABF6E;
}
</style>

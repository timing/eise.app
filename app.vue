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
import { useProcessingState } from '@/composables/useProcessingState';
import { reportError } from '@/composables/useSentryReporting';
import { useLiteMode } from '@/composables/useLiteMode';
import { useContinuousStacking } from '@/composables/useContinuousStacking';

const { on, emit: eventBusEmit, addLog, logs } = useEventBus();
const { stackFramesLocally } = useStacker();
const {
	runContinuousStacking,
	cancel: cancelContinuous,
	results: continuousResults,
	isProcessing: isContinuousProcessing,
	currentPercentage: continuousPercentage
} = useContinuousStacking();

const { track, trackHumanInteraction } = useTracking();
const { getTrackingContext, getInputFilename } = useProcessingState();

function stackStartProps() {
	const filename = getInputFilename();
	return {
		...getTrackingContext(),
		filename: filename ? String(filename).slice(0, 200) : undefined,
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
const MAX_LOGS_PER_PING = 20;      // Cap per-ping log burst; overflow tracked via log_dropped.
const MAX_LOG_LINE_CHARS = 200;    // Per-line truncation — no unbounded strings on the wire.
const MAX_LOGS_ON_FAILURE = 50;    // Guaranteed tail on stack_failed regardless of ping delivery.
let stackPingTimer = null;
let stackPingCount = 0;
let stackStartTs = 0;
let unhandledErrorCount = 0;
let lastUnhandledError = null;
let lastLogCursor = 0;  // Index into logs.value already shipped; ping ships delta from here.

// Returns new log lines since the last ping (capped, truncated) plus accounting
// fields. Advances the cursor. Null if nothing new. Attached to stack_ping so
// silent mediabunny deaths surface WHY, not just where, in the ping trail.
function getLogDelta() {
	const cursor = lastLogCursor;
	const total = logs.value.length;
	if (total <= cursor) return null;
	let sliceStart = cursor;
	if (total - cursor > MAX_LOGS_PER_PING) {
		sliceStart = total - MAX_LOGS_PER_PING;  // Keep the freshest lines when burst > cap.
	}
	const lines = logs.value.slice(sliceStart).map(l => String(l).slice(0, MAX_LOG_LINE_CHARS));
	lastLogCursor = total;
	return {
		logs: lines,
		log_cursor: cursor,
		log_total: total,
		log_dropped: sliceStart - cursor,
	};
}

// Returns the last N log lines, truncated. Used on stack_failed as a
// belt-and-suspenders context payload — even if some pings never reached the
// beacon (network flakiness), the terminal event carries the pre-death tail.
function getLogTail(n = MAX_LOGS_ON_FAILURE) {
	const total = logs.value.length;
	if (!total) return null;
	return {
		logs_tail: logs.value.slice(-n).map(l => String(l).slice(0, MAX_LOG_LINE_CHARS)),
		log_total: total,
	};
}

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
	return snap;
}

function emitStackPing() {
	const snap = stackPingSnapshot();
	const delta = getLogDelta();
	if (delta) Object.assign(snap, delta);
	track('stack_ping', snap);
	stackPingCount++;
}

function startStackPing() {
	if (stackPingTimer) return;  // Already running.
	stackStartTs = Date.now();
	lastStackStepTs = 0;
	stackPingCount = 0;
	unhandledErrorCount = 0;
	lastUnhandledError = null;
	lastLogCursor = logs.value.length;  // Only ship logs from this run onward.
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
	track('stack_failed', {
		...snap,
		...(tail || {}),
		reason: `unhandled:${kind}:${String(message || '').slice(0, 150)}`,
		failed_in: 'watchdog',
	});
}

onMounted(async () => {
	isMounted.value = true;
	trackHumanInteraction();

	const urlParams = new URLSearchParams(window.location.search);
	if (urlParams.get('lite') === '1' || urlParams.get('lite') === 'true') {
		forceLiteMode.value = true;
	}

	detectedBrowser.value = detectBrowser();

	if (navigator.gpu) {
		try {
			const adapter = await navigator.gpu.requestAdapter();
			webGPUSupported.value = !!adapter;
		} catch (e) {
			webGPUSupported.value = false;
		}
	} else {
		webGPUSupported.value = false;
	}

	on('postProcessing', handlePostProcessing);
	on('stacked-image-ready', handleStackedImageReady);
	on('batch-started', handleBatchStarted);
	on('batch-complete', handleBatchComplete);
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
		startStackPing();
	});
	on('debayer-processing-started', () => {
		// For SER files where color profile selector was skipped (e.g., forced pattern)
		isProcessing.value = true;
		stackInFlight = true;
		lastStackStep = null;
		eventBusEmit('start-loading', 'Preparing to analyze...');
		track('stack_start', stackStartProps());
		startStackPing();
	});
	on('quality-selection-ready', handleQualitySelectionReady);
	on('cropped-ser-ready', (data) => {
		croppedSerData.value = data;
	});
	on('stack-step', (step) => {
		// Mid-pipeline funnel checkpoint. Carries reader/gpu/job_id so we can
		// see how far each attempt gets before dropping to cancel/fail.
		lastStackStep = step;
		lastStackStepTs = Date.now();
		track('stack_step', { step, ...getTrackingContext() });
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
	on('upload-error', (message) => {
		if (!stackInFlight) return;
		trackWatchdogFailure('upload_error', message);
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
});

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
	track('stack_finished', getTrackingContext());
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
	startStackPing();
}

async function handlePostProcessing(data) {
	if (isShowingContinuousResults.value) {
		return;
	}
	selectedFile.value = data;
	isProcessing.value = false;
	navigateTo('/post-processor/');
}
</script>

<style>
html,body {
	padding: 0;
	margin: 0;
	font-family: -apple-system,\.SFNSText-Regular,San Francisco,Roboto,Segoe UI,Helvetica Neue,Lucida Grande,sans-serif;
	font-size: 13px;
	-moz-osx-font-smoothing: grayscale;
	-webkit-font-smoothing: antialiased;
	-webkit-min-device-pixel-ratio: 1.5;
	color: #c6fffd;
	min-height: 100%;
}
html {
	background: radial-gradient(circle at bottom, #27587c, #0A2940);
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
.top-bar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	flex-wrap: wrap;
	padding: 0 10px;
}
header {
	padding: 0;
}
header h1 {
	margin: 0;
	font-size: 18px;
	line-height: 50px;
	color: white;
}
header .subtitle {
	font-size: 12px;
	font-weight: normal;
}
header a {
	color: #8CCF7E;
	text-decoration: none;
}
.tabs {
	border-radius: 5px;
	margin: 10px 0;
}
@media (max-width: 700px) {
	.top-bar {
		flex-direction: column;
		align-items: stretch;
		padding: 0 20px;
	}
	header {
		text-align: center;
	}
	header h1 {
		line-height: 1.4;
		padding: 10px 0 5px 0;
	}
	.tabs {
		display: flex;
		margin: 0;
	}
	.tabs a {
		flex: 1;
		text-align: center;
		padding: 8px 5px;
		font-size: 11px;
		white-space: nowrap;
	}
}
button, a.button, .tabs a {
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
.tabs button, .tabs a, .tabs a.button {
	border-radius: 0;
	border-right: 1px solid #ccc;
	font-weight:bold;
	display: inline-block;
}
button:hover, a.button:hover, .tabs a:hover {
	background-color: #70f1ec;
}
.tabs button.active, .tabs a.button.active, .tabs a.active {
	background-color: #8CCF7E;
	color: #111;
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
/* Direct-child text blocks stay narrower than the card so line-length is readable
   (~65-70ch is the sweet spot). Tables, images, and code blocks stay full-width. */
.page-layout .content.content-card > h2,
.page-layout .content.content-card > h3,
.page-layout .content.content-card > h4,
.page-layout .content.content-card > p,
.page-layout .content.content-card > ul,
.page-layout .content.content-card > ol,
.page-layout .content.content-card > dl,
.page-layout .content.content-card > blockquote {
	max-width: 68ch;
}
.page-layout .content.content-card h2 {
	font-size: 30px;
	color: #1a1a1a;
	margin: 0 0 20px;
	line-height: 1.2;
	letter-spacing: -0.01em;
	font-weight: 700;
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
	color: #c6fffd;
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
	color: rgba(198, 255, 253, 0.65);
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
	color: rgba(198, 255, 253, 0.75);
	text-align: center;
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

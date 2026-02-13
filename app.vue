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
import { reportError } from '@/composables/useSentryReporting';
import { useLiteMode } from '@/composables/useLiteMode';

const { on, emit: eventBusEmit, addLog } = useEventBus();
const { stackFramesLocally } = useStacker();
const { track, trackHumanInteraction } = useTracking();
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
const qualityFrames = ref([]);
const qualityWorkers = ref(null);
const qualityNoiseRobust = ref(false);
const qualityUseWebGPU = ref(false);
const qualityFrameReReader = ref(null);
const qualityDrizzleScale = ref(1.5);
const croppedSerData = ref(null);

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
provide('qualityFrames', qualityFrames);
provide('showWebGPUChoice', showWebGPUChoice);
provide('croppedSerData', croppedSerData);

provide('liteMode', liteMode);
provide('useGPU', useGPU);
provide('isMobile', isMobile);
provide('webGPUSupported', webGPUSupported);
provide('detectedBrowser', detectedBrowser);
provide('forceLiteMode', forceLiteMode);
provide('isMounted', isMounted);

// Provide handlers
provide('handleFrames', handleFrames);
provide('handlePostProcessing', handlePostProcessing);
provide('handleProcessingStarted', handleProcessingStarted);
provide('handleThresholdSelected', handleThresholdSelected);
provide('handleWebGPUContinueCPU', handleWebGPUContinueCPU);
provide('handleWebGPUCancel', handleWebGPUCancel);

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

onMounted(async () => {
	isMounted.value = true;
	track('page_view');
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
	on('show-color-profile-selector', () => {
		isSelectingColorProfile.value = true;
	});
	on('color-profile-selected', () => {
		isSelectingColorProfile.value = false;
	});
	on('quality-selection-ready', handleQualitySelectionReady);
	on('cropped-ser-ready', (data) => {
		croppedSerData.value = data;
	});
	on('stack-failed', (data) => {
		track('stack_failed');
		isProcessing.value = false;
		const error = data?.error || new Error(`Stacking failed: ${data?.reason || 'unknown reason'}`);
		reportError(error, {
			component: data?.component || 'unknown',
			action: 'stacking'
		});
	});
});

function handleQualitySelectionReady(data) {
	qualityFrames.value = data.frames;
	qualityWorkers.value = data.workers;
	qualityNoiseRobust.value = data.noiseRobustAlignment || false;
	qualityUseWebGPU.value = data.useWebGPU || false;
	qualityFrameReReader.value = data.frameReReader || null;
	qualityDrizzleScale.value = data.drizzleScale || 1.0;
	isSelectingQuality.value = true;
	eventBusEmit('stop-loading');
}

async function handleThresholdSelected(data) {
	isSelectingQuality.value = false;

	const hasValidWorkers = qualityWorkers.value && qualityWorkers.value.length > 0;
	const hasFrameReReader = qualityFrameReReader.value !== null;
	const canStack = qualityUseWebGPU.value || hasValidWorkers;

	if (data.frames && data.frames.length > 0 && canStack) {
		eventBusEmit('start-loading', 'Stacking selected frames...');
		addLog(`Stacking ${data.frames.length} frames (${Math.round(data.percentage * 100)}% threshold)${hasFrameReReader ? ' (two-pass mode)' : ''}`);

		for (const frame of qualityFrames.value) {
			delete frame.uint8Buffer;
			delete frame.blob;
		}

		const stackingWorker = hasValidWorkers ? qualityWorkers.value[0] : null;

		try {
			const stackResult = await stackFramesLocally(data.frames, stackingWorker, qualityDrizzleScale.value, qualityNoiseRobust.value, qualityUseWebGPU.value, qualityFrameReReader.value);

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
					noiseRobust: qualityNoiseRobust.value,
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
			data.noiseRobust,
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

	if (data?.hasValidWorkers) {
		qualityWorkers.value?.forEach(worker => worker.terminate());
	}
	qualityWorkers.value = null;
	qualityFrameReReader.value = null;
	isProcessing.value = false;
}

async function handleStackedImageReady(data) {
	selectedFile.value = data.blob;
	stackedFloat32Data.value = data.float32Data || null;
	stackedImageDimensions.value = (data.width && data.height) ? { width: data.width, height: data.height } : null;
	isProcessing.value = false;
	track('stack_finished');
	navigateTo('/post-processor/');
}

async function handleFrames(data) {
	frames.value = data;
}

function handleProcessingStarted() {
	isProcessing.value = true;
	track('stack_start');
}

async function handlePostProcessing(data) {
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
.content a, .content a:visited {
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
	overflow: hidden;
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
	background-color: #eee;
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
}
.page-layout.page-layout-wide {
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
.webgpu-dialog-buttons .cancel-button {
	background-color: #eee;
	color: #333;
}
.webgpu-dialog-buttons .cancel-button:hover {
	background-color: #ddd;
}
</style>

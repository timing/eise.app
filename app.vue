<template>
	<div>	
		<nav class="tabs">
			<button :class="{ active: currentTab === 'FileUploader' }" @click="handleStackProcessClick">✨ &nbsp; Stack & Process</button>
			<button :class="{ active: currentTab === 'Tools' }" @click="currentTab = 'Tools'">🛠️ &nbsp; Tools</button>
			<button :class="{ active: currentTab === 'About' }" style="float:right;" @click="currentTab = 'About'">ℹ️  &nbsp; About</button>
		</nav>

		<header>
			<h1><a href="/">eise.app</a> <span class="subtitle">- Easy (planetary) Image Stacker Engine</span></h1>
		</header>

		<div v-show="currentTab === 'About'" class="page-layout">
			<div class="comparison-images vertical">
				<img src="/jupiter-stacked.png" alt="Stacked result" />
				<span class="arrow">&uarr;</span>
				<img src="/jupiter-singleframe.png" alt="Single frame" />
			</div>
			<div class="content">
			<h2>About eise.app - Image Stacker for Planets, Moon & Sun</h2>
			<h3>100% browser-based - no uploads, no installs</h3>
			<p>eise.app is the first fully browser-based planetary image stacking tool.
			Everything runs locally on your machine using WebAssembly and Web Workers - your data never leaves your computer.
			</p>
			<p>
			The name is an ode to <a href="https://en.wikipedia.org/wiki/Eise_Eisinga" target="_blank">Eise Eisinga</a>, a Frisian amateur astronomer who built a planetarium in his living room.
			The project started from frustrations getting existing software running on ARM-based Macs - AutoStakkert4! didn't work in Wine, PSS had dependency issues, Lynkeos crashed continuously.
			</p>

			<h3>How it works</h3>
			<ul>
				<li><strong>File support:</strong> SER files (recommended), AVI (uncompressed), or any video format via FFmpeg.js</li>
				<li><strong>Frame ranking:</strong> Laplacian variance calculates sharpness for each frame. Manual threshold selection with quality graph.</li>
				<li><strong>Auto-crop:</strong> Detects and centers the target in each frame. For planets, rejects cut-off frames.</li>
				<li><strong>Surface mode:</strong> For Moon/Sun closeups with drift tracking to handle larger frame-to-frame motion</li>
				<li><strong>Local alignment:</strong> Alignment Points (APs) track motion across the frame using OpenCV's matchTemplate</li>
				<li><strong>De-warping:</strong> Displacement maps correct atmospheric wobble using inverse distance weighted interpolation</li>
				<li><strong>Drizzle:</strong> 1.5x output resolution using sub-pixel frame offsets</li>
				<li><strong>Stacking:</strong> Quality-weighted averaging with brightness normalization</li>
				<li><strong>Post-processing:</strong> Wavelet sharpening, deconvolution, RGB alignment (auto-detect + sub-pixel), rotation, crop</li>
			</ul>

			<h3>Acknowledgments</h3>
			<p>
			This project draws inspiration from <a target="_blank" href="https://github.com/Rolf-Hempel/PlanetarySystemStacker">Planetary System Stacker</a> by Rolf Hempel.
			The alignment point approach, local de-warping, and quality-weighted stacking concepts are based on PSS's implementation.
			Thank you Rolf for making PSS open source and documenting the algorithms.
			</p>

			<h3>Technology</h3>
			<p>Built with Nuxt/Vue, OpenCV.js (WebAssembly), Web Workers for parallel processing, and FFmpeg.js for video decoding.
			All processing happens in your browser - works on any OS without installation.</p>

			<h3>Browser Requirements (WebGPU)</h3>
			<p>eise.app uses WebGPU for fast GPU-accelerated processing. Minimum requirements:</p>
			<table class="compat-table">
				<tr><th>Platform</th><th>Minimum Version</th></tr>
				<tr><td>Chrome</td><td>113+ (Android: 121+)</td></tr>
				<tr><td>Edge</td><td>113+</td></tr>
				<tr><td>Safari</td><td>18+ (macOS Sequoia / iOS 18)</td></tr>
				<tr><td>Firefox</td><td>141+ (Windows only for now)</td></tr>
				<tr><td>Android</td><td>Chrome 121+ with Android 12+</td></tr>
				<tr><td>iOS</td><td>Safari 18+ (iOS 18+)</td></tr>
			</table>
			<div class="compat-status" :class="{ compatible: webGPUSupported === true, incompatible: webGPUSupported === false, checking: webGPUSupported === null }">
				<strong>Your browser:</strong> {{ detectedBrowser }}<br/>
				<span v-if="webGPUSupported === null">Checking WebGPU support...</span>
				<span v-else-if="webGPUSupported">WebGPU is supported - you're good to go!</span>
				<span v-else>WebGPU not available - processing will be slower. Try updating your browser or using Chrome/Edge/Safari.</span>
			</div>

			<h3>Alternative software</h3>
			<p>eise.app works well for quick results without installing anything. For more advanced features you might want to try:</p>
			<ul>
				<li><a href="https://www.autostakkert.com/" target="_blank">AutoStakkert!</a> - Popular planetary stacking software (Windows)</li>
				<li><a href="https://github.com/Rolf-Hempel/PlanetarySystemStacker" target="_blank">Planetary System Stacker</a> - Open-source stacker (Python, cross-platform)</li>
				<li><a href="https://www.astronomie.be/registax/" target="_blank">Registax</a> - Stacking software with wavelet sharpening (Windows)</li>
				<li><a href="https://lynkeos.sourceforge.io/" target="_blank">Lynkeos</a> - Native macOS stacking application</li>
				<li><a href="https://siril.org/" target="_blank">Siril</a> - Astrophotography suite (cross-platform)</li>
			</ul>

			<h3>Bugs or feature requests?</h3>
			<p>Head over to <a href="https://github.com/timing/eise.app" target="_blank">eise.app on GitHub</a> for suggestions or bug reports.</p>
			<p>Or <a href="#" @click.prevent="openFeedback()">send me feedback directly</a> - I'd love to hear about your experience!</p>

			<p>Happy Stacking,<br/> Tijmen</p>
			</div>
		</div>
	
		<Tools v-if="currentTab === 'Tools'" />

		<ClientOnly>
			<div v-if="liteMode && currentTab === 'FileUploader'" class="lite-mode-banner">
				<strong>Lite Mode</strong><span v-if="forceLiteMode"> (forced)</span><span v-else-if="isMobile"> ({{ useGPU ? 'GPU' : 'CPU' }})</span><span v-else> (no WebGPU)</span> · Frame limit auto-adjusted for memory.
			</div>
		</ClientOnly>

		<FileUploader v-show="currentTab === 'FileUploader' && !isProcessing && !isSelectingQuality" @frames="handleFrames" @postProcessing="handlePostProcessing" @processing-started="handleProcessingStarted" @showAbout="currentTab = 'About'" />
		<ColorProfileSelector v-show="currentTab === 'FileUploader' && isSelectingColorProfile" />
		<QualitySelector v-show="currentTab === 'FileUploader' && isSelectingQuality" :frames="qualityFrames" @threshold-selected="handleThresholdSelected" />
		<VideoFrameProcessor ref="videoProcessorRef" v-show="currentTab === 'FileUploader' && isProcessing && !isSelectingColorProfile && !isSelectingQuality"
			:currentFrame="currentFrame" :frames="frames" @postProcessing="handlePostProcessing" />
		<PostProcessor v-if="currentTab === 'PostProcessor'" :file="selectedFile" :float32Data="stackedFloat32Data" :imageDimensions="stackedImageDimensions" :croppedSerData="croppedSerData" :croppedAviData="croppedAviData" />

		<div class="clearb"></div>

		<!-- WebGPU Unavailable Choice Dialog -->
		<div v-if="showWebGPUChoice" class="webgpu-dialog-overlay">
			<div class="webgpu-dialog">
				<h3>GPU Acceleration Unavailable</h3>
				<p>Your browser doesn't support WebGPU, which is needed for fast GPU-accelerated stacking.</p>
				<p>You can continue with <strong>CPU processing</strong>, which will work but is slower. This may still work fine for smaller files.</p>
				<p class="browser-tip">For faster processing, try using a recent version of Chrome, Edge, or Safari 18+.</p>
				<div class="webgpu-dialog-buttons">
					<button class="continue-button" @click="handleWebGPUContinueCPU">Continue with CPU (slower)</button>
					<button class="cancel-button" @click="handleWebGPUCancel">Cancel</button>
				</div>
			</div>
		</div>

		<Logger />

		<img v-if="loadPixel" src="https://analytics.tijmentiming.workers.dev/pixel.gif"/>
	</div>
</template>

<script setup>
import FileUploader from '~/components/FileUploader.vue';
import VideoFrameProcessor from './components/VideoFrameProcessor.vue';
// Lazy-load Tools to reduce initial bundle size
const Tools = defineAsyncComponent(() => import('./components/Tools.vue'));
import Logger from './components/Logger.vue';
import ColorProfileSelector from './components/ColorProfileSelector.vue';
import QualitySelector from './components/QualitySelector.vue';
import { ref, watch, computed, provide, defineAsyncComponent } from 'vue';

// Lazy-load PostProcessor to reduce initial bundle size
const PostProcessor = defineAsyncComponent(() => import('./components/PostProcessor.vue'));
import { useEventBus } from '@/composables/eventBus';
import { useStacker, WebGPUUnavailableError } from '@/composables/useStacker';
import { useTracking } from '@/composables/useTracking';
import { useFeedback } from '@/composables/useFeedback';
import { reportError } from '@/composables/useSentryReporting';

const { on, emit: eventBusEmit, addLog, logs } = useEventBus();
const { stackFramesLocally } = useStacker();
const { track, trackHumanInteraction } = useTracking();
const { openFeedback } = useFeedback();

const frames = ref([]);
const currentFrame = ref(null);
const selectedFile = ref(null);
const stackedFloat32Data = ref(null);  // 16-bit stacking data
const stackedImageDimensions = ref(null);  // { width, height }
const currentTab = ref('FileUploader');
const videoProcessorRef = ref(null);
const isProcessing = ref(false);
const isSelectingColorProfile = ref(false);
const isSelectingQuality = ref(false);
const qualityFrames = ref([]);
const qualityWorkers = ref(null);
const qualityNoiseRobust = ref(false);
const qualityUseWebGPU = ref(false);
const qualityFrameReReader = ref(null); // Two-pass mode: re-read frames on demand
const croppedSerData = ref(null);
const croppedAviData = ref(null);

// WebGPU unavailable dialog state
const showWebGPUChoice = ref(false);
const webGPUChoiceData = ref(null); // Stores data needed to retry stacking

const loadPixel = ref(false)
const webGPUSupported = ref(null); // null = not yet checked, true/false = result
const detectedBrowser = ref('Detecting...');
const forceLiteMode = ref(false); // ?lite=1 URL param for testing

// Detect mobile devices via user agent
const isMobile = computed(() => {
	if (typeof navigator === 'undefined') return false;
	return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
});

// Lite mode: auto-enabled on mobile OR when WebGPU unavailable OR forced via ?lite=1
// Limitations: max 100 frames, no drizzle, 8-bit output, limited UI
const liteMode = computed(() => forceLiteMode.value || isMobile.value || webGPUSupported.value === false);
provide('liteMode', liteMode);

// GPU mode: use GPU when available (even in lite mode on mobile)
// Only falls back to CPU when WebGPU is not available
const useGPU = computed(() => webGPUSupported.value === true);
provide('useGPU', useGPU);
provide('isMobile', isMobile);
provide('webGPUSupported', webGPUSupported);

// Detect browser and version
function detectBrowser() {
	const ua = navigator.userAgent;
	let browser = 'Unknown browser';

	// Order matters - check more specific patterns first
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

	// Add platform info
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
	loadPixel.value = true;
	track('page_view');
	trackHumanInteraction();

	// Check for ?lite=1 URL param to force lite mode for testing
	const urlParams = new URLSearchParams(window.location.search);
	if (urlParams.get('lite') === '1' || urlParams.get('lite') === 'true') {
		forceLiteMode.value = true;
	}

	// Detect browser
	detectedBrowser.value = detectBrowser();

	// Check WebGPU support
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
	on('cropped-avi-ready', (data) => {
		croppedAviData.value = data;
	});
	on('stack-failed', (data) => {
		track('stack_failed');
		isProcessing.value = false;
		// Create synthetic error if none provided, so we always get a stack trace
		const error = data?.error || new Error(`Stacking failed: ${data?.reason || 'unknown reason'}`);
		reportError(error, {
			component: data?.component || 'unknown',
			action: 'stacking'
		});
	});
});

watch(currentTab, (newTab) => {
	if (newTab === 'About') {
		track('about');
	} else if (newTab === 'Tools') {
		track('tools');
	}
});

function handleQualitySelectionReady(data) {
	qualityFrames.value = data.frames;
	qualityWorkers.value = data.workers;
	qualityNoiseRobust.value = data.noiseRobustAlignment || false;
	qualityUseWebGPU.value = data.useWebGPU || false;
	qualityFrameReReader.value = data.frameReReader || null; // Two-pass mode
	isSelectingQuality.value = true;
	eventBusEmit('stop-loading');
}

async function handleThresholdSelected(data) {
	isSelectingQuality.value = false;

	// Stack the selected frames
	// In GPU mode, stackFramesLocally creates its own workers (qualityWorkers is empty)
	// In CPU mode, we need existing workers from the analysis phase
	// Two-pass mode: frameReReader allows on-demand frame loading for memory efficiency
	const hasValidWorkers = qualityWorkers.value && qualityWorkers.value.length > 0;
	const hasFrameReReader = qualityFrameReReader.value !== null;
	const canStack = qualityUseWebGPU.value || hasValidWorkers;

	if (data.frames && data.frames.length > 0 && canStack) {
		eventBusEmit('start-loading', 'Stacking selected frames...');
		addLog(`Stacking ${data.frames.length} frames (${Math.round(data.percentage * 100)}% threshold)${hasFrameReReader ? ' (two-pass mode)' : ''}`);

		// Free 8-bit preview buffers before stacking to save memory
		// (stacking will re-read frames in 16-bit from frameReReader)
		for (const frame of qualityFrames.value) {
			delete frame.uint8Buffer;
			delete frame.blob;
		}

		const stackingWorker = hasValidWorkers ? qualityWorkers.value[0] : null;

		try {
			const stackResult = await stackFramesLocally(data.frames, stackingWorker, 1.5, qualityNoiseRobust.value, qualityUseWebGPU.value, qualityFrameReReader.value);

			// Terminate workers after stacking (CPU mode only)
			if (hasValidWorkers) {
				qualityWorkers.value.forEach(worker => worker.terminate());
			}
			qualityWorkers.value = null;
			qualityFrameReReader.value = null; // Clear frameReReader after stacking

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
				// Show choice dialog - user can choose CPU fallback or cancel
				addLog(`WebGPU not available: ${error.message}`);
				eventBusEmit('stop-loading');
				webGPUChoiceData.value = {
					frames: data.frames,
					stackingWorker,
					hasValidWorkers,
					drizzleScale: 1.5,
					noiseRobust: qualityNoiseRobust.value,
					frameReReader: qualityFrameReReader.value
				};
				showWebGPUChoice.value = true;
			} else {
				// Other errors - log and stop
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

// Handle user choice to continue with CPU when WebGPU is unavailable
async function handleWebGPUContinueCPU() {
	showWebGPUChoice.value = false;
	const data = webGPUChoiceData.value;
	webGPUChoiceData.value = null;

	if (!data) return;

	addLog('Continuing with CPU stacking (slower but compatible)...');
	eventBusEmit('start-loading', 'Stacking with CPU...');

	try {
		// Call stackFramesLocally with useWebGPU=false to force CPU path
		const stackResult = await stackFramesLocally(
			data.frames,
			data.stackingWorker,
			data.drizzleScale,
			data.noiseRobust,
			false, // useWebGPU = false
			data.frameReReader
		);

		// Cleanup workers
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

// Handle user choice to cancel when WebGPU is unavailable
function handleWebGPUCancel() {
	showWebGPUChoice.value = false;
	const data = webGPUChoiceData.value;
	webGPUChoiceData.value = null;

	addLog('Stacking cancelled by user');

	// Cleanup
	if (data?.hasValidWorkers) {
		qualityWorkers.value?.forEach(worker => worker.terminate());
	}
	qualityWorkers.value = null;
	qualityFrameReReader.value = null;
	isProcessing.value = false;
}

async function handleStackedImageReady(data) {
	// Convert blob to format expected by PostProcessor
	currentTab.value = 'PostProcessor';
	selectedFile.value = data.blob;
	// Store 16-bit data for high-quality post-processing
	stackedFloat32Data.value = data.float32Data || null;
	stackedImageDimensions.value = (data.width && data.height) ? { width: data.width, height: data.height } : null;
	isProcessing.value = false;
	track('post_process');
}

async function handleFrames(data) {
	frames.value = data;
	// isProcessing is already true from processing-started
	// This will now trigger the watcher in VideoFrameProcessor
}

function handleProcessingStarted() {
	isProcessing.value = true;
	track('stack_start');
}

async function handlePostProcessing(data) {
	currentTab.value = 'PostProcessor';
	selectedFile.value = data;
	isProcessing.value = false;
}

function handleStackProcessClick() {
	if (currentTab.value === 'PostProcessor') {
		if (confirm('Leave post processing and start a new stack?')) {
			// Reset state
			selectedFile.value = null;
			isProcessing.value = false;
			isSelectingQuality.value = false;
			isSelectingColorProfile.value = false;
			croppedSerData.value = null;
			croppedAviData.value = null;
			currentTab.value = 'FileUploader';
		}
	} else {
		currentTab.value = 'FileUploader';
	}
}

useHead({
  title: 'eise.app - Easy (planetary) Image Stacker in your browser for your Astrophotography',
  // Overview Effect
  meta: [
    { name: 'description', content: 'Easy (planetary) Image Stacker Engine, made to work in your browser. Turn your blurry videos of planets into sharp images. Perfect for beginners in Astrophotography. Using Planetary System Stacker under the hood.' },
  ],
});

</script>

<style>
html,body {
	padding: 0;
	margin: 0;
	font-family: -apple-system,\.SFNSText-Regular,San Francisco,Roboto,Segoe UI,Helvetica Neue,Lucida Grande,sans-serif;
	/*font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;*/
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
header {
	padding: 0 10px;
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
header .info {
	float: right;
	color: #8CCF7E;
	line-height: 50px;
	padding-right: 10px;
}
header a {
	color: #8CCF7E;
	text-decoration: none;
}
.tabs {
	float: right;
	border-radius: 5px;
	margin: 10px 10px 0 0;
	overflow: hidden;
}
button, a.button {
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
.tabs button, .tabs a.button {
	border-radius: 0;
	border-right: 1px solid #ccc;
	font-weight:bold;
}
button:hover, a.button:hover {
	background-color: #70f1ec; 
}
.tabs button.active, .tabs a.button.active {
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
/* Move Sentry feedback button up to avoid blocking expand log button */
#sentry-feedback {
	--inset: auto 0 80px auto;
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
	margin: 10px 50px;
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
	width: 314px; /* Match .card total width: 272px + 40px padding + 2px border */
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
/* WebGPU Unavailable Dialog */
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

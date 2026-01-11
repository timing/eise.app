<template>
	<div>	
		<nav class="tabs">
			<button :class="{ active: currentTab === 'FileUploader' }" @click="currentTab = 'FileUploader'">✨ &nbsp; Stack & Process</button>
			<button :class="{ active: currentTab === 'About' }" style="float:right;" @click="currentTab = 'About'">ℹ️  &nbsp; About</button>
		</nav>

		<header>
			<h1><a href="/">eise.app</a> <span class="subtitle">- Easy (planetary) Image Stacker Engine</span></h1>
		</header>

		<div v-show="currentTab === 'About'">
			<div class="card">
				<img src="/public/EiseApp-NoCopyright-L.webp" width="260" />
			</div>
			<div class="content">
			<h2>About eise.app - Planetary Image Stacker</h2>
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
				<li><strong>Frame ranking:</strong> Laplacian variance calculates sharpness for each frame</li>
				<li><strong>Auto-crop:</strong> Detects and centers the planet in each frame</li>
				<li><strong>Local alignment:</strong> Alignment Points (APs) track motion across the frame using OpenCV's matchTemplate (normalized cross-correlation)</li>
				<li><strong>De-warping:</strong> Displacement maps correct atmospheric wobble using inverse distance weighted interpolation and cv.remap()</li>
				<li><strong>Stacking:</strong> Quality-weighted averaging of the best 30% of frames</li>
				<li><strong>Post-processing:</strong> Wavelet sharpening (from a <a href="https://github.com/mrossini-ethz/gimp-wavelet-sharpen/blob/master/src/wavelet.c" target="_blank">GIMP plugin</a>), noise reduction, and color alignment</li>
			</ul>

			<h3>Acknowledgments</h3>
			<p>
			This project draws heavy inspiration from <a target="_blank" href="https://github.com/Rolf-Hempel/PlanetarySystemStacker">Planetary System Stacker</a> by Rolf Hempel.
			The alignment point approach, local de-warping, and quality-weighted stacking concepts are all inspired by PSS's excellent implementation.
			Thank you Rolf for making PSS open source and documenting the algorithms so well.
			</p>

			<h3>Technology</h3>
			<p>Built with Nuxt/Vue, OpenCV.js (WebAssembly), Web Workers for parallel processing, and FFmpeg.js for video decoding.
			All processing happens in your browser - works on any OS without installation.</p>

			<h3>Alternative software</h3>
			<p>eise.app is great for quick results without installing anything, but for more advanced features you might want to try:</p>
			<ul>
				<li><a href="https://www.autostakkert.com/" target="_blank">AutoStakkert!</a> - The gold standard for planetary stacking (Windows)</li>
				<li><a href="https://github.com/Rolf-Hempel/PlanetarySystemStacker" target="_blank">Planetary System Stacker</a> - Excellent open-source alternative (Python, cross-platform)</li>
				<li><a href="https://www.astronomie.be/registax/" target="_blank">Registax</a> - Classic stacking software with great wavelet sharpening (Windows)</li>
				<li><a href="https://lynkeos.sourceforge.io/" target="_blank">Lynkeos</a> - Native macOS stacking application</li>
				<li><a href="https://siril.org/" target="_blank">Siril</a> - Full-featured astrophotography suite (cross-platform)</li>
			</ul>

			<h3>Bugs or feature requests?</h3>
			<p>Head over to <a href="https://github.com/timing/eise.app" target="_blank">eise.app on GitHub</a> for suggestions or bug reports.</p>

			<p>Happy Stacking,<br/> Tijmen</p>
			</div>
		</div>
	
		<FileUploader v-show="currentTab === 'FileUploader' && !isProcessing && !isSelectingQuality" @frames="handleFrames" @postProcessing="handlePostProcessing" @processing-started="handleProcessingStarted" @showAbout="currentTab = 'About'" />
		<ColorProfileSelector v-show="currentTab === 'FileUploader' && isSelectingColorProfile" />
		<QualitySelector v-show="currentTab === 'FileUploader' && isSelectingQuality" :frames="qualityFrames" @threshold-selected="handleThresholdSelected" />
		<VideoFrameProcessor ref="videoProcessorRef" v-show="currentTab === 'FileUploader' && isProcessing && !isSelectingColorProfile && !isSelectingQuality"
			:currentFrame="currentFrame" :frames="frames" @postProcessing="handlePostProcessing" />
		<PostProcessor v-show="currentTab === 'PostProcessor'" :file="selectedFile" :croppedSerData="croppedSerData" />

		<Logger />

		<img v-if="loadPixel" src="https://analytics.tijmentiming.workers.dev/pixel.gif"/>
	</div>
</template>

<script setup>
import FileUploader from '~/components/FileUploader.vue';
import VideoFrameProcessor from './components/VideoFrameProcessor.vue';
import PostProcessor from './components/PostProcessor.vue';
import Logger from './components/Logger.vue';
import ColorProfileSelector from './components/ColorProfileSelector.vue';
import QualitySelector from './components/QualitySelector.vue';
import { ref, watch } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useStacker } from '@/composables/useStacker';
import { useTracking } from '@/composables/useTracking';

const { on, emit: eventBusEmit, addLog } = useEventBus();
const { stackFramesLocally } = useStacker();
const { track } = useTracking();

const frames = ref([]);
const currentFrame = ref(null);
const selectedFile = ref(null);
const currentTab = ref('FileUploader');
const videoProcessorRef = ref(null);
const isProcessing = ref(false);
const isSelectingColorProfile = ref(false);
const isSelectingQuality = ref(false);
const qualityFrames = ref([]);
const qualityWorkers = ref(null);
const croppedSerData = ref(null);

const loadPixel = ref(false)

onMounted(() => {
	loadPixel.value = true;
	track('page_view');
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
});

watch(currentTab, (newTab) => {
	if (newTab === 'About') {
		track('about');
	}
});

function handleQualitySelectionReady(data) {
	console.log('handleQualitySelectionReady', data);
	qualityFrames.value = data.frames;
	qualityWorkers.value = data.workers;
	isSelectingQuality.value = true;
	eventBusEmit('stop-loading');
}

async function handleThresholdSelected(data) {
	console.log('handleThresholdSelected', data);
	isSelectingQuality.value = false;

	// Stack the selected frames
	if (data.frames && data.frames.length > 0 && qualityWorkers.value && qualityWorkers.value.length > 0) {
		eventBusEmit('start-loading', 'Stacking selected frames...');
		addLog(`Stacking ${data.frames.length} frames (${Math.round(data.percentage * 100)}% threshold)`);

		const stackingWorker = qualityWorkers.value[0];
		const stackedBlob = await stackFramesLocally(data.frames, stackingWorker);

		// Terminate workers after stacking
		qualityWorkers.value.forEach(worker => worker.terminate());
		qualityWorkers.value = null;

		if (stackedBlob) {
			addLog('Client-side stacking complete');
			eventBusEmit('stacked-image-ready', { blob: stackedBlob });
		} else {
			addLog('Client-side stacking failed - no valid frames');
			eventBusEmit('stop-loading');
			isProcessing.value = false;
		}
	} else {
		addLog('No frames selected for stacking');
		isProcessing.value = false;
	}
}

async function handleStackedImageReady(data) {
	console.log('handleStackedImageReady', data);
	// Convert blob to format expected by PostProcessor
	currentTab.value = 'PostProcessor';
	selectedFile.value = data.blob;
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
	console.log('handlePostProcessing', data);
	currentTab.value = 'PostProcessor';
	selectedFile.value = data; 
	isProcessing.value = false;
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
.content {
	max-width: 500px;
	padding: 5px 5px 5px 50px;
	line-height: 1.5;
	clear:both;
}
@media (min-width: 728px) {
	.content {
		clear: none;
		margin-left: 370px;
		padding-top: 50px;
	}
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
	margin: 50px;
	padding: 10px 20px 20px 20px;
	width: 272px;
	min-height: 340px;
	float: left;
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
</style>

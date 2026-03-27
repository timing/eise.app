<template>
<!-- Hidden file input always available for "Load another image" -->
<input
	type="file"
	ref="directFileInput"
	accept="image/*"
	@change="handleDirectFileSelect"
	style="display: none;"
/>

<div class="page-layout" :class="{ 'page-layout-wide': imageLoaded }">
	<div class="card" :class="{ 'controls-disabled': !imageLoaded }">
		<!-- Controls always visible, but disabled when no image -->
		<div class="controls">
			<div class="processing-indicator" v-if="isProcessing">
				<div class="spinner"></div>
			</div>

			<!-- Pipeline order: RGB Alignment → Color Balance → Auto Stretch → Sharpening → Color Adjustments → Crop → Rotation -->

			<div class="color-alignment">
				<h4>RGB Alignment <a href="#" class="manual-link" @click.prevent="showManualRgbControls = !showManualRgbControls">{{ showManualRgbControls ? 'hide manual' : 'manual' }}</a></h4>
				<label class="checkbox-label">
					<input type="checkbox" v-model="rgbAlignmentIsAuto" @change="onAutoAlignCheckboxChange" :disabled="isAutoAligning" />
					{{ isAutoAligning ? 'Detecting...' : 'Auto' }}
				</label>

				<div v-if="showManualRgbControls" class="manual-rgb-controls">
					<h5 style="color:blue;">Blue</h5>
					<button @click="processChromaticAberration('blue', 'y', -0.5)">↑ {{ fixedAberration.blue?.y < 0 ? Math.abs(fixedAberration.blue.y) : '' }}</button>
					<button @click="processChromaticAberration('blue', 'y', 0.5)">↓ {{ fixedAberration.blue?.y > 0 ? fixedAberration.blue.y : '' }}</button>
					<button @click="processChromaticAberration('blue', 'x', -0.5)">← {{ fixedAberration.blue?.x < 0 ? Math.abs(fixedAberration.blue.x) : '' }}</button>
					<button @click="processChromaticAberration('blue', 'x', 0.5)">→ {{ fixedAberration.blue?.x > 0 ? fixedAberration.blue.x : '' }}</button>

					<h5 style="color:red;">Red</h5>
					<button @click="processChromaticAberration('red', 'y', -0.5)">↑ {{ fixedAberration.red?.y < 0 ? Math.abs(fixedAberration.red.y) : '' }}</button>
					<button @click="processChromaticAberration('red', 'y', 0.5)">↓ {{ fixedAberration.red?.y > 0 ? fixedAberration.red.y : '' }}</button>
					<button @click="processChromaticAberration('red', 'x', -0.5)">← {{ fixedAberration.red?.x < 0 ? Math.abs(fixedAberration.red.x) : '' }}</button>
					<button @click="processChromaticAberration('red', 'x', 0.5)">→ {{ fixedAberration.red?.x > 0 ? fixedAberration.red.x : '' }}</button>
				</div>
			</div>

			<div class="color-balance-section">
				<h4>Color Balance</h4>
				<label class="checkbox-label">
					<input type="checkbox" v-model="autoColorBalance" @change="applyProcessing" />
					Auto colors (gray world)
				</label>
				<label class="checkbox-label">
					<input type="checkbox" v-model="autoStretch" @change="applyProcessing" />
					Auto levels (stretch)
				</label>
			</div>

			<fieldset class="sharpening-frame">
				<legend>Sharpening <span class="info-icon" @click="showSharpeningInfo = !showSharpeningInfo">ⓘ</span></legend>
				<div v-if="showSharpeningInfo" class="info-text">
					Luminance-only sharpening reduces color noise but may slightly desaturate the image. Increase saturation/vibrance to compensate.
				</div>
				<div class="sharpening-tabs">
					<button :class="{ active: sharpeningMethod === 'wavelets' }" @click="setSharpeningMethod('wavelets')">Wavelets</button>
					<button :class="{ active: sharpeningMethod === 'usm' }" @click="setSharpeningMethod('usm')">Unsharp Mask</button>
					<button :class="{ active: sharpeningMethod === 'none' }" @click="setSharpeningMethod('none')" title="None">⊘</button>
				</div>

				<label v-if="sharpeningMethod === 'wavelets' || sharpeningMethod === 'usm'" class="checkbox-label luminance-only-option">
					<input type="checkbox" v-model="sharpenLuminanceOnly" @change="applyProcessing" />
					Luminance only (reduces color noise)
				</label>

				<div class="sharpening-content" v-if="sharpeningMethod === 'usm'">
					<div>
						<label>Radius:</label>
						<input type="range" min="0.5" max="10" step="0.1" v-model="usmRadius" @input="applyProcessing"/>
						<span>{{ usmRadius }}</span>
					</div>
					<div>
						<label>Amount:</label>
						<input type="range" min="0" max="20" step="0.1" v-model="usmAmount" @input="applyProcessing"/>
						<span>{{ usmAmount }}</span>
					</div>
					<div>
						<label>Threshold:</label>
						<input type="range" min="0" max="50" step="1" v-model="usmThreshold" @input="applyProcessing"/>
						<span>{{ usmThreshold }}</span>
					</div>
				</div>

				<div class="sharpening-content" v-if="sharpeningMethod === 'wavelets'">
					<div>
						<label>Radius:</label>
						<input type="range" min="0" max="5" step="0.1" v-model="waveletsRadius" @input="applyProcessing"/>
						<span>{{ waveletsRadius }}</span>
					</div>
					<div>
						<label>Amount:</label>
						<input type="range" min="0" max="50" step="0.1" v-model="waveletsAmount" @input="applyProcessing"/>
						<span>{{ waveletsAmount }}</span>
					</div>
					<div>
						<label>Denoise:</label>
						<input type="range" min="0" max="50" step="1" v-model="postNoiseReduction" @input="applyProcessing"/>
						<span>{{ postNoiseReduction > 0 ? postNoiseReduction : 'Off' }}</span>
					</div>
				</div>

			</fieldset>

			<h4>Color Adjustments</h4>
			<div>
				<label>Gain:</label>
				<input type="range" min="0.5" max="3" step="0.01" v-model="gain" @input="applyProcessing"/>
				<span>{{ gain }}</span>
			</div>
			<div>
				<label>Gamma:</label>
				<input type="range" min="0.3" max="3" step="0.01" v-model="gamma" @input="applyProcessing"/>
				<span>{{ gamma }}</span>
			</div>
			<div>
				<label>Contrast:</label>
				<input type="range" min="0.5" max="2" step="0.01" v-model="contrast" @input="applyProcessing"/>
				<span>{{ contrast }}</span>
			</div>
			<div>
				<label>Vibrance:</label>
				<input type="range" min="-1" max="2" step="0.01" v-model="vibrance" @input="applyProcessing"/>
				<span>{{ vibrance }}</span>
			</div>
			<div>
				<label>Saturation:</label>
				<input type="range" min="0" max="2" step="0.01" v-model="saturation" @input="applyProcessing"/>
				<span>{{ saturation }}</span>
			</div>
			<div>
				<label>Saturation repeats:</label>
				<input type="number" min="1" max="10" v-model.number="saturationRepeats" @input="applyProcessing" class="number-input"/>
			</div>

			<h4>Crop</h4>
			<div class="crop-controls">
				<button v-if="!cropMode" @click="startCropMode">Select crop area</button>
				<button v-if="!cropMode && canUndoCrop" class="undo-crop" @click="undoCrop">Undo crop</button>
				<template v-if="cropMode">
					<span class="crop-hint">Click and drag on the image to select area</span>
					<button class="btn-primary" @click="applyCrop" :disabled="!cropSelection">Apply crop</button>
					<button class="cancel-crop" @click="cancelCrop">Cancel</button>
				</template>
			</div>

			<h4>Rotation</h4>
			<div>
				<input type="range" min="-180" max="180" step="0.1" v-model.number="rotation" @input="previewRotation" @change="applyRotation" />
				<span>{{ rotation }}°</span>
				<button v-if="rotation !== 0 || hasAppliedRotation" class="reset-rotation" @click="resetRotation">Reset</button>
			</div>

			<h4>Edge Mask</h4>
			<div class="edge-mask-controls">
				<button v-if="!edgeMaskMode && !edgeMaskEnabled" @click="startEdgeMaskMode">Add edge mask</button>
				<button v-if="!edgeMaskMode && edgeMaskEnabled" @click="startEdgeMaskMode">Edit edge mask</button>
				<button v-if="!edgeMaskMode && edgeMaskEnabled" class="remove-mask" @click="removeEdgeMask">Remove</button>
				<template v-if="edgeMaskMode">
					<span class="edge-mask-hint">Drag circle to move, drag edge to resize</span>
					<button class="btn-primary" @click="applyEdgeMask">Apply</button>
					<button class="cancel-mask" @click="cancelEdgeMask">Cancel</button>
				</template>
			</div>

		</div>
	</div>
	<div class="content">
		<!-- Intro with file select when no image loaded -->
		<div v-if="!imageLoaded" class="intro-content">
			<div class="file-input-wrapper">
				<input
					type="file"
					accept="image/*"
					id="post-processor-file-input"
					@change="handleDirectFileSelect"
				/>
				<label for="post-processor-file-input" class="file-label btn-primary">
					Select image to process...
				</label>
				<p class="supported-formats">PNG, TIFF, JPEG</p>
			</div>

			<h2>Post processor</h2>
			<h3>Sharpen your planetary images</h3>
			<p>The post-processor helps you bring out detail in your astrophotography. Works great on stacked planetary images, but you can also load any image directly. All processing runs locally in your browser.</p>

			<h4>Features</h4>
			<p v-for="feature in features" :key="feature.title"><strong>{{ feature.title }}</strong><br/>{{ feature.desc }}</p>
		</div>
		<!-- Canvas when image loaded -->
		<template v-else>
			<ZoomableCanvas ref="zoomableCanvasRef" id="postProcessCanvas" @canvasReady="handleCanvasReady" :disableDrag="cropMode || edgeMaskMode" :previewRotation="previewRotationAngle">
				<template #overlay>
					<span v-if="isLoadingImage" class="loading-inline">
						<span class="spinner"></span> Loading image...
					</span>
				</template>
				<template #toolbar>
					<div class="toolbar-actions">
						<button class="btn-primary" @click="openExportPopup">
							⬇ Export
						</button>
						<div class="kebab-menu">
							<button class="kebab-btn" @click="showKebabMenu = !showKebabMenu" title="More options">
								⋮
							</button>
							<div v-if="showKebabMenu" class="kebab-backdrop" @click="showKebabMenu = false"></div>
							<div v-if="showKebabMenu" class="kebab-dropdown">
								<button @click="loadAnotherImage">Load another image</button>
								<button @click="startNewStack">Start new stack</button>
								<button @click="closePostProcessor">Close Post Processor</button>
								<button @click="showHelpPopup = true; showKebabMenu = false">Help</button>
							</div>
						</div>
					</div>
				</template>
			</ZoomableCanvas>
		</template>
	</div>

	<!-- Export Popup -->
	<div v-if="showExportPopup" class="export-popup-overlay" @click.self="showExportPopup = false">
		<div class="export-popup">
			<h3>Export</h3>

			<div class="export-filename">
				<label>Filename:</label>
				<input type="text" v-model="exportFilename" @keydown.enter="downloadCanvasAsPNG" />
			</div>

			<div class="export-buttons">
				<button class="export-option" @click="downloadCanvasAsPNG">
					⬇ Processed PNG (8-bit)
				</button>
				<button v-if="sharpenedImage16" class="export-option" @click="download16BitProcessedPNG">
					⬇ Processed PNG (16-bit)
				</button>
				<button class="export-option" @click="downloadUnprocessedPNG">
					⬇ Unprocessed PNG (16-bit)
				</button>
				<button v-if="props.croppedSerData" class="export-option secondary" @click="downloadCroppedSer">
					⬇ Cropped SER ({{ props.croppedSerData.cropSize }}x{{ props.croppedSerData.cropSize }})
				</button>
				<button
					class="export-option video"
					@click="downloadComparisonVideo"
					:disabled="!canExport() || isExportingVideo"
					:title="!canExport() ? 'Only available after running the full stack pipeline' : ''">
					{{ isExportingVideo ? exportProgress : '⬇ Comparison Video (mp4)' }}
				</button>
			</div>

			<p class="share-note">If you share this image, a mention of Eise.app is appreciated!</p>

			<div class="export-popup-footer">
				<a href="https://github.com/timing/eise.app/issues" target="_blank" class="btn-primary" @click="handleFeedbackClick">
					💬 How was your result? Send feedback!
				</a>
				<button class="close-btn" @click="showExportPopup = false">Close</button>
			</div>
		</div>
	</div>

	<!-- Help Popup -->
	<div v-if="showHelpPopup" class="help-popup-overlay" @click.self="showHelpPopup = false">
		<div class="help-popup">
			<h3>Post Processor Help</h3>
			<p>The post-processor helps you bring out detail in your astrophotography. Works great on stacked planetary images, but you can also load any image directly.</p>
			<h4>Features</h4>
			<p v-for="feature in features" :key="feature.title"><strong>{{ feature.title }}</strong><br/>{{ feature.desc }}</p>
			<div class="help-popup-footer">
				<button class="close-btn" @click="showHelpPopup = false">Close</button>
			</div>
		</div>
	</div>

</div>
</template>

<script setup>
import { ref, onMounted, watch, defineProps, reactive, onUnmounted, computed, nextTick, inject } from 'vue';
import debounce from 'lodash/debounce';
import { adjustGain, adjustGainMultiply, cvMatToImageData } from '@/utils/sobel.js'
import { deconvolveWebGL, deconvolveWebGL16, disposeDeconvWebGL } from '@/utils/webglDeconv.js'
import { Image16 } from '@/utils/Image16.js'
import { initWebGL2, processWithWebGL2, isWebGL2Available, disposeWebGL2, blurWithWebGL2 } from '@/utils/webgl2Processor.js'
import { download16BitPNG, decodePNG } from '@/utils/png16Encoder.js'
import { decodeTIFF } from '@/utils/tiffDecoder.js'
import ZoomableCanvas from '@/components/ZoomableCanvas.vue';
import { useTracking } from '@/composables/useTracking';
import { useProcessingState } from '@/composables/useProcessingState';
import { useComparisonExport } from '@/composables/useComparisonExport';
import { useFeedback } from '@/composables/useFeedback';
import { useWorkerUrl } from '@/composables/useWorkerUrl';

// Lite mode: deconvolution disabled (too slow on CPU)
const liteMode = inject('liteMode', ref(false));

// For direct image loading when arriving on this page without a file
const selectedFile = inject('selectedFile', ref(null));
const directFileInput = ref(null);

const { track } = useTracking();
const { openFeedback, openFeedbackAfterDownload } = useFeedback();
const { inputFilename, getOutputFilename } = useProcessingState();
const { workerUrl } = useWorkerUrl();
const { captureProcessedImage, canExport, generateComparisonVideo, getExportStatus } = useComparisonExport();

// Comparison video export state
const isExportingVideo = ref(false);
const exportProgress = ref('');

// Export popup state
const showExportPopup = ref(false);
const exportFilename = ref('');
const sentryAvailable = ref(false);
const showKebabMenu = ref(false);
const showHelpPopup = ref(false);

// Features list - shared between main page and help popup
const features = [
	{ title: 'Wavelet sharpening', desc: 'Sharpening that brings out surface details. Includes denoise to reduce noise (by blurring again, weird!). Works on luminance only to avoid color noise.' },
	{ title: 'Unsharp mask', desc: 'Another sharpening option. Sometimes works better than wavelets, sometimes worse. Try both!' },
	{ title: 'Color adjustments', desc: 'Tweak brightness, contrast, gamma, and saturation. Vibrance is like saturation but gentler on already-colorful areas.' },
	{ title: 'RGB alignment', desc: 'Fixes the colored fringes you get from atmospheric dispersion. Auto-detect usually works, or nudge the channels manually.' },
	{ title: 'Auto levels', desc: 'Automatically adjusts black and white points to use the full brightness range. Great starting point before manual tweaking.' },
	{ title: 'Rotation and crop', desc: 'Straighten things up and cut off the messy edges.' },
	{ title: 'Edge mask', desc: 'Removes chromatic aberration fringes around planets by masking everything outside a circle with the true background color.' },
	{ title: '16-bit processing', desc: 'Every image is processed in 16-bit, so adjustments are more precise and you won\'t lose detail.' }
];

// Direct file loading for when user arrives on this page without a file
function triggerDirectFileSelect() {
	directFileInput.value?.click();
}

async function handleDirectFileSelect(event) {
	const file = event.target.files?.[0];
	if (!file) return;

	// Set the filename for output naming
	const { setInputFilename } = useProcessingState();
	setInputFilename(file.name);

	// Load the image as a blob and set it as selectedFile
	selectedFile.value = file;
}

function goBackToStart() {
	navigateTo('/');
}

// Kebab menu actions
function loadAnotherImage() {
	showKebabMenu.value = false;
	directFileInput.value?.click();
}

function startNewStack() {
	showKebabMenu.value = false;
	navigateTo('/');
}

function closePostProcessor() {
	showKebabMenu.value = false;
	// Reset state to show landing page
	imageLoaded.value = false;
	selectedFile.value = null;
	// Clear canvas and image data
	if (ctx) {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
	}
	image16 = null;
	sharpenedImage16 = null;
}

function openExportPopup() {
	// Prefill filename with base name (without extension)
	exportFilename.value = inputFilename.value || 'eise_app';
	showExportPopup.value = true;
}

function handleFeedbackClick(event) {
	if (sentryAvailable.value) {
		event.preventDefault();
		openFeedback();
	}
	// Otherwise, let the <a href> work normally (opens GitHub)
}


const { $ffmpeg, $loadFFmpeg } = useNuxtApp();

const zoomableCanvasRef = ref(null);
let canvas;
let useWebGL2 = false;

// 16-bit processing state (all processing is 16-bit, display is 8-bit)
let image16 = null; // Image16 container for source data
let sharpenedImage16 = null; // Processed result in 16-bit

const handleCanvasReady = (canvasRef) => {
	// canvasRef is the direct ref to the canvas element
	console.log('Canvas is ready:', canvasRef);
	canvas = canvasRef;
	// You can now use canvasRef.value to access the canvas element directly
};

const downloadCanvasAsPNG = () => {
	if (!canvas) return;

	track('download', { type: 'processed', format: 'png', bit_depth: 8 });
	const dataURL = canvas.value.toDataURL('image/png');
	const link = document.createElement('a');
	const filename = exportFilename.value || inputFilename.value || 'eise_app';
	link.download = `${filename}_processed.png`;
	link.href = dataURL;
	document.body.appendChild(link); // Required for Firefox
	link.click();
	document.body.removeChild(link);
	showExportPopup.value = false;
	openFeedbackAfterDownload();
};

const downloadUnprocessedPNG = async () => {
	if (!image16) return;

	track('download', { type: 'unprocessed', format: 'png', bit_depth: 16 });
	try {
		const filename = exportFilename.value || inputFilename.value || 'eise_app';
		await download16BitPNG(
			image16.data,
			image16.width,
			image16.height,
			`${filename}_unprocessed.png`
		);
		showExportPopup.value = false;
		openFeedbackAfterDownload();
	} catch (e) {
		console.error('16-bit unprocessed PNG export error:', e);
	}
};

const downloadComparisonVideo = async () => {
	if (!canExport() || isExportingVideo.value) return;

	isExportingVideo.value = true;
	exportProgress.value = 'Preparing...';

	try {
		// Capture current processed image from canvas
		if (canvas && canvas.value) {
			const processedBlob = await new Promise(resolve =>
				canvas.value.toBlob(resolve, 'image/png')
			);
			captureProcessedImage(processedBlob);
		}

		track('download', { type: 'comparison_video', format: 'mp4', bit_depth: null });

		const videoBlob = await generateComparisonVideo($ffmpeg, $loadFFmpeg, (status) => {
			exportProgress.value = status;
		});

		// Download the video
		const url = URL.createObjectURL(videoBlob);
		const link = document.createElement('a');
		const filename = exportFilename.value || inputFilename.value || 'eise_app';
		link.download = `${filename}_comparison.mp4`;
		link.href = url;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
		showExportPopup.value = false;
		openFeedbackAfterDownload();

	} catch (error) {
		console.error('Comparison video export failed:', error);
		alert('Failed to generate comparison video: ' + error.message);
	} finally {
		isExportingVideo.value = false;
		exportProgress.value = '';
	}
};

const downloadCroppedSer = () => {
	if (!props.croppedSerData) return;

	track('download', { type: 'cropped_ser', format: 'ser', bit_depth: null });
	const url = URL.createObjectURL(props.croppedSerData.blob);
	const a = document.createElement('a');
	a.href = url;
	const filename = exportFilename.value || inputFilename.value || 'eise_app';
	a.download = `${filename}_cropped.ser`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
	showExportPopup.value = false;
	openFeedbackAfterDownload();
};

const download16BitProcessedPNG = async () => {
	if (!sharpenedImage16) return;

	track('download', { type: 'processed', format: 'png', bit_depth: 16 });
	try {
		const filename = exportFilename.value || inputFilename.value || 'eise_app';
		await download16BitPNG(
			sharpenedImage16.data,
			sharpenedImage16.width,
			sharpenedImage16.height,
			`${filename}_processed_16bit.png`
		);
		showExportPopup.value = false;
		openFeedbackAfterDownload();
	} catch (e) {
		console.error('16-bit PNG export error:', e);
	}
};

let waveletWorkers = null;
let usmWorker = null;
let workersInitialized = false;


function initializeWorkers() {
	if (workersInitialized) return;
	workersInitialized = true;

	console.log('Lazy-loading sharpening workers for post-processing');
	waveletWorkers = new Array(8);
	for (let i = 0; i < waveletWorkers.length; i++) {
		waveletWorkers[i] = new Worker(workerUrl('/wavelet_worker.js'));
		waveletWorkers[i].onerror = (e) => { console.error(e); };
	}

	usmWorker = new Worker(workerUrl('/usm_worker.js'));
	usmWorker.onerror = (e) => { console.error('USM worker error:', e); };
}


const props = defineProps({
	file: Object,
	float32Data: Object,  // Float32Array from 16-bit stacking (RGBA, 0.0-1.0 range)
	imageDimensions: Object,  // { width, height } for float32Data
	croppedSerData: Object
});

const gain = ref(1);
const contrast = ref(1);
const gamma = ref(1);
const saturation = ref(1);
const saturationRepeats = ref(1);
const vibrance = ref(0);
const autoColorBalance = ref(false);
const autoStretch = ref(false);
const preNoiseReduction = ref(0);
const waveletsRadius = ref(0);
const waveletsAmount = ref(0);
const deconvRadius = ref(0);
const deconvIterations = ref(0);
const usmRadius = ref(1.5);
const usmAmount = ref(1);
const usmThreshold = ref(0);
const bilateralFraction = ref(0.5);
const bilateralRange = ref(50);
const postNoiseReduction = ref(0);
const blueDown = ref(0);
const isProcessing = ref(false);
const isLoadingImage = ref(false);
const imageLoaded = ref(false);
const sharpeningMethod = ref('wavelets'); // 'usm', 'wavelets', or 'none'
const sharpenLuminanceOnly = ref(false); // Sharpen only luminance channel to reduce color noise
const rotation = ref(0); // degrees (slider value)
const previewRotationAngle = ref(0); // CSS preview rotation while dragging
const hasAppliedRotation = ref(false);
let preRotationImage16 = null; // Backup of original 16-bit image before rotation
let appliedRotation = 0; // Track what rotation has been applied to pixels
const isAutoAligning = ref(false);
const rgbAlignmentIsAuto = ref(false); // Track if alignment was set via Auto (to re-run after crop/rotation)
const showManualRgbControls = ref(false); // Toggle visibility of manual RGB adjustment buttons
const showSharpeningInfo = ref(false); // Toggle visibility of sharpening info

// Edge mask state
const edgeMaskMode = ref(false); // Whether we're editing the edge mask
const edgeMaskEnabled = ref(false); // Whether to apply the edge mask during processing
const edgeMaskCenterX = ref(0); // Circle center X (in image coords)
const edgeMaskCenterY = ref(0); // Circle center Y (in image coords)
const edgeMaskRadius = ref(100); // Circle radius (in image coords)
const edgeMaskBackgroundColor = ref([0, 0, 0]); // Sampled background color [r, g, b] in 0-1 range
let edgeMaskDragging = false;
let edgeMaskResizing = false;
let edgeMaskDragStart = { x: 0, y: 0 };
let edgeMaskOriginalCenter = { x: 0, y: 0 };
let edgeMaskOriginalRadius = 0;

// Check if any RGB alignment offset has been applied
const hasAlignmentOffset = computed(() => {
	return (fixedAberration.red?.x || fixedAberration.red?.y ||
	        fixedAberration.blue?.x || fixedAberration.blue?.y);
});

// Format offset for display
function formatOffset(channelOffset) {
	if (!channelOffset) return '';
	const parts = [];
	if (channelOffset.x) parts.push(`x:${channelOffset.x > 0 ? '+' : ''}${channelOffset.x}`);
	if (channelOffset.y) parts.push(`y:${channelOffset.y > 0 ? '+' : ''}${channelOffset.y}`);
	return parts.join(' ');
}

function setSharpeningMethod(method) {
	sharpeningMethod.value = method;
	// Cancel any pending debounced call and run immediately
	applyProcessing.cancel();
	applyProcessingInternal();
}

// Crop state
const cropMode = ref(false);
const cropSelection = ref(null); // { x, y, width, height }
let cropStart = null;
let preCropImageData = null; // Store 8-bit image before crop for undo
let preCropImage16 = null; // Store 16-bit image before crop for undo
let preCropRotationState = null; // Store rotation state before crop for undo
const canUndoCrop = ref(false);

onMounted(() => {
	if (props.file) {
		loadImage(props.file);
	}

	// Check Sentry feedback availability (getFeedback() returns null if not configured)
	import('@sentry/vue').then((Sentry) => {
		sentryAvailable.value = !!(Sentry.getFeedback && Sentry.getFeedback());
	}).catch(() => {
		sentryAvailable.value = false;
	});
});

onUnmounted(() => {
	disposeWebGL();
	disposeWebGL2();
	disposeDeconvWebGL();
});

watch(() => props.file, (newVal) => {
	if (newVal) {
		// If we already have a canvas and float32Data, just update the image data
		// This is the fast path for batch mode - no loading states needed
		if (ctx && props.float32Data && props.imageDimensions?.width) {
			updateImageData();
		} else {
			loadImage(newVal);
		}
	}
});

// Fast path for batch mode: update image data without full reload
function updateImageData() {
	const width = props.imageDimensions.width;
	const height = props.imageDimensions.height;

	// Update image16 with new data
	image16 = Image16.fromFloat32Array(props.float32Data, width, height);
	sharpenedImage16 = null;

	// Store dimensions in case canvas needs resizing
	pendingCanvasDimensions = { width, height };

	// Re-apply processing with current settings
	applyProcessing.cancel();
	applyProcessingInternal();
}

let workingMat;
let initCanvas;
let initCanvasImageData;
let gainedImageData;
let preNoiseReducedImageData;
let sharpenedImageData;
let ctx = null;
let pendingCanvasDimensions = null; // Store dimensions to apply right before rendering

let prevGain;

let prevValues = {}

function valueIsChanged(prop, value){
	if( prevValues[prop] === undefined ){
		prevValues[prop] = value;
		return true;
	}

	let isChanged = prevValues[prop] != value;
	prevValues[prop] = value;

	return isChanged;
}

async function loadImage(file) {
	isLoadingImage.value = true;
	imageLoaded.value = true; // Show canvas immediately so it's available for loading

	// Wait for Vue to render the canvas
	await nextTick();

	// Lazy-load workers when first image is loaded
	initializeWorkers();

	console.log(file);

	// Check if we have 16-bit float32 data from stacking
	const hasFloat32Data = props.float32Data && props.imageDimensions &&
		props.imageDimensions.width && props.imageDimensions.height;

	// Try to decode 16-bit images directly (before browser clamps to 8-bit)
	let decoded16Bit = null;
	if (!hasFloat32Data) {
		const fileName = file.name?.toLowerCase() || '';
		const isPNG = file.type === 'image/png' || fileName.endsWith('.png');
		const isTIFF = file.type === 'image/tiff' || fileName.endsWith('.tif') || fileName.endsWith('.tiff');

		if (isPNG) {
			try {
				const buffer = await file.arrayBuffer();
				const decoded = await decodePNG(buffer);
				if (decoded.depth === 16 && decoded.float32Data) {
					decoded16Bit = {
						data: decoded.float32Data,
						width: decoded.width,
						height: decoded.height
					};
				}
			} catch (err) {
				console.warn('Failed to decode PNG:', err);
			}
		} else if (isTIFF) {
			try {
				const buffer = await file.arrayBuffer();
				const decoded = await decodeTIFF(buffer);
				// decodeTIFF always returns float32Data (even for 8-bit source)
				decoded16Bit = {
					data: decoded.float32Data,
					width: decoded.width,
					height: decoded.height
				};
				console.log(`TIFF decoded: ${decoded.width}x${decoded.height}, ${decoded.depth}-bit source`);
			} catch (err) {
				console.warn('Failed to decode TIFF:', err);
			}
		}
	}

	// Helper to finalize image loading
	function finalizeImageLoad(width, height, imageDataForCanvas) {
		// Don't resize canvas yet - store dimensions to apply right before rendering
		// This prevents the canvas from going blank while processing
		pendingCanvasDimensions = { width, height };

		// Only get context if canvas needs to be initialized
		if (!ctx) {
			ctx = canvas.value.getContext('2d', { willReadFrequently: true });
		}

		initCanvas = canvas;
		// Copy imageDataForCanvas directly instead of reading from canvas
		initCanvasImageData = new ImageData(
			new Uint8ClampedArray(imageDataForCanvas.data),
			width,
			height
		);
		gainedImageData = new ImageData(width, height);
		preNoiseReducedImageData = new ImageData(width, height);
		sharpenedImageData = new ImageData(width, height);

		// Initialize 16-bit image container
		if (hasFloat32Data) {
			image16 = Image16.fromFloat32Array(props.float32Data, props.imageDimensions.width, props.imageDimensions.height);
			console.log('16-bit image initialized from stacking data:', props.imageDimensions.width, 'x', props.imageDimensions.height);
		} else if (decoded16Bit) {
			image16 = Image16.fromFloat32Array(decoded16Bit.data, decoded16Bit.width, decoded16Bit.height);
			console.log('16-bit image initialized from decoded file:', decoded16Bit.width, 'x', decoded16Bit.height);
		} else {
			image16 = Image16.fromImageData(initCanvasImageData);
			console.log('8-bit image loaded:', width, 'x', height);
		}
		sharpenedImage16 = null;

		// Initialize WebGL2 for GPU-accelerated color adjustments
		useWebGL2 = initWebGL2(width, height);

		isLoadingImage.value = false;

		// Center the canvas in its container
		nextTick(() => {
			zoomableCanvasRef.value?.centerCanvas();
		});

		// Run processing immediately (skip debounce) so the processed image appears quickly
		applyProcessing.cancel();
		applyProcessingInternal();
	}

	// If we decoded the image ourselves (TIFF or 16-bit PNG), create canvas from decoded data
	// This handles browsers that don't support TIFF natively (Chrome, Firefox)
	if (decoded16Bit) {
		const { data, width, height } = decoded16Bit;
		const imageData = new ImageData(width, height);
		const pixels = imageData.data;

		// Convert Float32 (0-1) to Uint8 (0-255) for canvas display
		for (let i = 0; i < width * height; i++) {
			pixels[i * 4] = Math.round(Math.min(1, Math.max(0, data[i * 4])) * 255);
			pixels[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, data[i * 4 + 1])) * 255);
			pixels[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, data[i * 4 + 2])) * 255);
			pixels[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, data[i * 4 + 3])) * 255);
		}

		finalizeImageLoad(width, height, imageData);
		return;
	}

	// For other formats, use browser's native image decoding
	const img = new Image();
	img.onload = function() {
		canvas.value.width = img.width;
		canvas.value.height = img.height;
		ctx = canvas.value.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(img, 0, 0);
		const imageData = ctx.getImageData(0, 0, img.width, img.height);

		finalizeImageLoad(img.width, img.height, imageData);
	};
	img.onerror = function() {
		console.error('Browser failed to load image:', file.name);
		isLoadingImage.value = false;
	};
	img.src = URL.createObjectURL(file);
}

// Apply color adjustments in 16-bit (Float32Array, 0.0-1.0 range)
function applyColorAdjustments16(data, width, height, gainVal, contrastVal, gammaVal, saturationVal, vibranceVal, saturationRepeatsVal = 1) {
	const newData = new Float32Array(data.length);
	const invGamma = 1 / gammaVal;
	const pixelCount = width * height;

	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		let r = data[idx];
		let g = data[idx + 1];
		let b = data[idx + 2];

		// Apply gain
		r *= gainVal;
		g *= gainVal;
		b *= gainVal;

		// Clamp before gamma (need positive values for pow)
		r = Math.max(0, r);
		g = Math.max(0, g);
		b = Math.max(0, b);

		// Apply gamma
		r = Math.pow(r, invGamma);
		g = Math.pow(g, invGamma);
		b = Math.pow(b, invGamma);

		// Apply contrast: (value - 0.5) * contrast + 0.5
		r = (r - 0.5) * contrastVal + 0.5;
		g = (g - 0.5) * contrastVal + 0.5;
		b = (b - 0.5) * contrastVal + 0.5;

		// Apply vibrance (saturation that affects less-saturated colors more)
		if (vibranceVal !== 0) {
			const maxC = Math.max(r, g, b);
			const minC = Math.min(r, g, b);
			const currentSat = maxC > 0 ? (maxC - minC) / maxC : 0;
			const vibranceAmount = vibranceVal * (1 - currentSat);
			const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			r = r + (r - lum) * vibranceAmount;
			g = g + (g - lum) * vibranceAmount;
			b = b + (b - lum) * vibranceAmount;
		}

		// Apply saturation (repeated for smoother boosting)
		for (let rep = 0; rep < saturationRepeatsVal; rep++) {
			const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			r = lum + saturationVal * (r - lum);
			g = lum + saturationVal * (g - lum);
			b = lum + saturationVal * (b - lum);
		}

		// Final clamp to 0-1
		newData[idx] = Math.max(0, Math.min(1, r));
		newData[idx + 1] = Math.max(0, Math.min(1, g));
		newData[idx + 2] = Math.max(0, Math.min(1, b));
		newData[idx + 3] = data[idx + 3]; // Alpha unchanged
	}

	return newData;
}

// Apply circular edge mask - pixels outside the circle become the background color
// With anti-aliased edge: 1px outside = 50% blend, 2px outside = 20% blend, beyond = 0%
function applyEdgeMaskToData(data, width, height) {
	const newData = new Float32Array(data.length);
	const cx = edgeMaskCenterX.value;
	const cy = edgeMaskCenterY.value;
	const r = edgeMaskRadius.value;
	const [bgR, bgG, bgB] = edgeMaskBackgroundColor.value;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = (y * width + x) * 4;
			const dx = x - cx;
			const dy = y - cy;
			const dist = Math.sqrt(dx * dx + dy * dy);

			let blend; // 1 = full original, 0 = full background
			if (dist <= r) {
				blend = 1;
			} else if (dist <= r + 1) {
				blend = 0.8;
			} else if (dist <= r + 2) {
				blend = 0.5;
			} else if (dist <= r + 3) {
				blend = 0.2;
			} else {
				blend = 0;
			}

			newData[idx] = data[idx] * blend + bgR * (1 - blend);
			newData[idx + 1] = data[idx + 1] * blend + bgG * (1 - blend);
			newData[idx + 2] = data[idx + 2] * blend + bgB * (1 - blend);
			newData[idx + 3] = data[idx + 3];
		}
	}

	return newData;
}

// Debounced processing - waits for user to stop dragging before heavy processing
const applyProcessingInternal = async() => {
	if (!image16) {
		console.warn('No image16 data available');
		return;
	}

	// Use pending dimensions if available (new image loading), otherwise current canvas size
	const width = pendingCanvasDimensions?.width ?? canvas?.value?.width;
	const height = pendingCanvasDimensions?.height ?? canvas?.value?.height;

	if (!width || !height) {
		console.warn('Canvas not available for processing');
		return;
	}

	isProcessing.value = true;

	let workingData = new Float32Array(image16.data); // Copy for processing

	// STEP 0: Chromatic aberration correction (FIRST - before any other processing)
	// This fixes spatial misalignment of color channels before sharpening amplifies artifacts
	workingData = applyChromaticAberrationCorrection16(
		workingData,
		width,
		height,
		fixedAberration.red,
		fixedAberration.blue
	);

	// STEP 0.5: Auto color balance (gray world)
	// Corrects color cast before sharpening amplifies color differences
	if (autoColorBalance.value) {
		workingData = applyAutoColorBalance16(workingData, width, height);
	}

	// STEP 0.6: Auto stretch (levels)
	// Stretches black/white points to full range before sharpening
	if (autoStretch.value) {
		workingData = applyAutoStretch16(workingData, width, height);
	}

	// STEP 1: Sharpening (based on selected method)
	if (sharpeningMethod.value === 'usm' && usmAmount.value > 0) {
		try {
			workingData = await usmSharpenInWorker16(
				workingData,
				width,
				height,
				parseFloat(usmRadius.value),
				parseFloat(usmAmount.value),
				parseFloat(usmThreshold.value),
				sharpenLuminanceOnly.value
			);
		} catch (e) {
			console.log('USM rejected (newer task running)');
			isProcessing.value = false;
			return;
		}
	} else if (sharpeningMethod.value === 'wavelets' && waveletsAmount.value > 0) {
		try {
			workingData = await waveletSharpenInWorker16(
				workingData,
				width,
				height,
				parseFloat(waveletsAmount.value),
				parseFloat(waveletsRadius.value),
				sharpenLuminanceOnly.value
			);
		} catch (e) {
			console.log('Wavelet sharpening rejected (newer task running)');
			isProcessing.value = false;
			return;
		}
	}

	// STEP 2: Apply color adjustments (WebGL2 or CPU fallback)
	if (useWebGL2) {
		const colorResult = processWithWebGL2(
			workingData,
			width,
			height,
			gain.value,
			contrast.value,
			gamma.value,
			saturation.value,
			vibrance.value,
			saturationRepeats.value
		);
		if (colorResult) {
			workingData = colorResult;
		} else {
			workingData = applyColorAdjustments16(workingData, width, height, gain.value, contrast.value, gamma.value, saturation.value, vibrance.value, saturationRepeats.value);
		}
	} else {
		workingData = applyColorAdjustments16(workingData, width, height, gain.value, contrast.value, gamma.value, saturation.value, vibrance.value, saturationRepeats.value);
	}

	// STEP 3: Noise reduction (only with wavelets) - WebGL2 Gaussian blur
	if (sharpeningMethod.value === 'wavelets' && postNoiseReduction.value >= 3) {
		const ksize = parseInt(postNoiseReduction.value, 10) | 1;
		const blurResult = blurWithWebGL2(workingData, width, height, ksize);
		if (blurResult) {
			workingData = blurResult;
		}
	}

	// STEP 4: Apply edge mask (fill outside circle with background color)
	if (edgeMaskEnabled.value) {
		workingData = applyEdgeMaskToData(workingData, width, height);
	}

	// Store 16-bit result
	sharpenedImage16 = Image16.fromFloat32Array(workingData, width, height);

	// Convert to 8-bit for display
	sharpenedImageData = sharpenedImage16.toImageData();

	// Apply pending canvas dimensions only if size actually changed
	if (pendingCanvasDimensions) {
		const needsResize = canvas.value.width !== pendingCanvasDimensions.width ||
		                    canvas.value.height !== pendingCanvasDimensions.height;
		if (needsResize) {
			canvas.value.width = pendingCanvasDimensions.width;
			canvas.value.height = pendingCanvasDimensions.height;
			ctx = canvas.value.getContext('2d', { willReadFrequently: true });
		}
		pendingCanvasDimensions = null;
	}

	// Render processed image
	ctx.putImageData(sharpenedImageData, 0, 0);

	// Draw green circle overlay when in edge mask mode
	if (edgeMaskMode.value) {
		ctx.strokeStyle = '#00ff00';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(edgeMaskCenterX.value, edgeMaskCenterY.value, edgeMaskRadius.value, 0, Math.PI * 2);
		ctx.stroke();
	}

	isProcessing.value = false;
};

// Debounce: wait 50ms after last input before processing (prevents memory buildup)
const applyProcessing = debounce(applyProcessingInternal, 50);

// WebGL-accelerated deconvolution
let deconvTaskId = 0;

async function deconvolveInWorker(imageData, psfRadius, iterations) {
	deconvTaskId++;
	const currentTask = deconvTaskId;

	console.log(`WebGL deconvolution: PSF=${psfRadius}, iterations=${iterations}`);
	return deconvolveWebGL(imageData, psfRadius, iterations, (progress) => {
		// Check if superseded
		if (deconvTaskId !== currentTask) {
			throw new Error('Deconv task superseded');
		}
	});
}

async function deconvolveInWorker16(floatData, width, height, psfRadius, iterations) {
	deconvTaskId++;
	const currentTask = deconvTaskId;

	console.log(`WebGL deconvolution 16-bit: PSF=${psfRadius}, iterations=${iterations}`);
	return deconvolveWebGL16(floatData, width, height, psfRadius, iterations, (progress) => {
		// Check if superseded
		if (deconvTaskId !== currentTask) {
			throw new Error('Deconv task superseded');
		}
	});
}

function logCopy(name, array){
	if( array === undefined ){
		console.log(name, 'undefined');
		return;
	}
	console.log(name, JSON.parse(JSON.stringify(array)));
}

function applyConditionalGain(imageData, gain, threshold, reducedGainFactor) {
	const data = imageData.data;
	const width = imageData.width;
	const height = imageData.height;
	const newData = new Uint8ClampedArray(data.length);

	for (let i = 0; i < data.length; i += 4) {
		// For RGB channels
		for (let j = 0; j < 3; j++) {
			const value = data[i + j];
			const applyFullGain = value > threshold; // Determine whether to apply full gain
			const effectiveGain = applyFullGain ? gain : gain * reducedGainFactor;
			newData[i + j] = value * effectiveGain;
		}
		// Copy the alpha channel without change
		newData[i + 3] = data[i + 3];
	}

	return new ImageData(newData, width, height);
}

// Wavelet sharpening worker wrapper
let currentTaskId16 = 0;
let lastReturnedTaskId16 = 0;
function waveletSharpenInWorker16(data, width, height, amount, radius, luminanceOnly = false) {
	currentTaskId16++;
	const workerId = currentTaskId16 % waveletWorkers.length;
	const currentTask = currentTaskId16;

	return new Promise((resolve, reject) => {
		function handleWorkerMsg(e) {
			const { imageData: resultData, taskId, is16bit } = e.data;

			waveletWorkers[workerId].removeEventListener('message', handleWorkerMsg);

			if (currentTask === taskId || taskId > lastReturnedTaskId16) {
				lastReturnedTaskId16 = taskId;
				// Result is already Float32Array
				resolve(resultData);
			} else {
				console.log('reject 16-bit wavelet', currentTask, taskId);
				reject(new Error('Wavelet task superseded'));
			}
		}

		waveletWorkers[workerId].addEventListener('message', handleWorkerMsg);

		// Send copy to worker (no transfer to avoid data corruption issues)
		const dataCopy = new Float32Array(data);
		waveletWorkers[workerId].postMessage(
			{ imageData: dataCopy, width, height, amount, radius, taskId: currentTask, is16bit: true, luminanceOnly }
		);
	});
}

// 16-bit USM sharpening worker wrapper
let usmTaskId16 = 0;
let lastUsmTaskId16 = 0;
function usmSharpenInWorker16(data, width, height, radius, amount, threshold, luminanceOnly = false) {
	usmTaskId16++;
	const currentTask = usmTaskId16;

	return new Promise((resolve, reject) => {
		function handleWorkerMsg(e) {
			const { imageData: resultData, taskId, is16bit } = e.data;
			usmWorker.removeEventListener('message', handleWorkerMsg);

			if (currentTask === taskId || taskId > lastUsmTaskId16) {
				lastUsmTaskId16 = taskId;
				// Result is already Float32Array
				resolve(resultData);
			} else {
				reject(new Error('USM task superseded'));
			}
		}

		usmWorker.addEventListener('message', handleWorkerMsg);

		// Send copy to worker (no transfer to avoid data corruption issues)
		const dataCopy = new Float32Array(data);
		usmWorker.postMessage(
			{ imageData: dataCopy, width, height, radius, amount, threshold, taskId: currentTask, is16bit: true, luminanceOnly }
		);
	});
}

let fixedAberration = reactive({});

// ==================== CHROMATIC ABERRATION CORRECTION ====================
// These functions work on image data directly (not canvas) for proper pipeline integration

// Apply chromatic aberration correction to 16-bit Float32Array data
function applyChromaticAberrationCorrection16(data, width, height, redOffset, blueOffset) {
	const hasRedOffset = redOffset && (redOffset.x || redOffset.y);
	const hasBlueOffset = blueOffset && (blueOffset.x || blueOffset.y);

	if (!hasRedOffset && !hasBlueOffset) return data;

	const result = new Float32Array(data.length);
	// Copy all data first (we'll overwrite shifted channels)
	result.set(data);

	// Apply red channel shift
	if (hasRedOffset) {
		shiftChannel16(data, result, width, height, 0, -(redOffset.x || 0), -(redOffset.y || 0));
	}

	// Apply blue channel shift
	if (hasBlueOffset) {
		shiftChannel16(data, result, width, height, 2, -(blueOffset.x || 0), -(blueOffset.y || 0));
	}

	return result;
}

// Shift a single channel using bilinear interpolation (16-bit)
function shiftChannel16(srcData, dstData, width, height, channelIndex, offsetX, offsetY) {
	const needsInterpolation = (offsetX % 1 !== 0) || (offsetY % 1 !== 0);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dstIdx = (y * width + x) * 4 + channelIndex;

			const srcX = x + offsetX;
			const srcY = y + offsetY;

			if (needsInterpolation) {
				// Bilinear interpolation for sub-pixel precision
				const x0 = Math.floor(srcX);
				const y0 = Math.floor(srcY);
				const x1 = x0 + 1;
				const y1 = y0 + 1;
				const fx = srcX - x0;
				const fy = srcY - y0;

				if (x0 >= 0 && x1 < width && y0 >= 0 && y1 < height) {
					const v00 = srcData[(y0 * width + x0) * 4 + channelIndex];
					const v01 = srcData[(y0 * width + x1) * 4 + channelIndex];
					const v10 = srcData[(y1 * width + x0) * 4 + channelIndex];
					const v11 = srcData[(y1 * width + x1) * 4 + channelIndex];

					dstData[dstIdx] = v00 * (1 - fx) * (1 - fy) +
					                  v01 * fx * (1 - fy) +
					                  v10 * (1 - fx) * fy +
					                  v11 * fx * fy;
				} else {
					// Edge case: clamp to nearest valid pixel
					const clampedX = Math.max(0, Math.min(width - 1, Math.round(srcX)));
					const clampedY = Math.max(0, Math.min(height - 1, Math.round(srcY)));
					dstData[dstIdx] = srcData[(clampedY * width + clampedX) * 4 + channelIndex];
				}
			} else {
				// Integer offset - direct lookup
				const srcXi = Math.round(srcX);
				const srcYi = Math.round(srcY);

				if (srcXi >= 0 && srcXi < width && srcYi >= 0 && srcYi < height) {
					dstData[dstIdx] = srcData[(srcYi * width + srcXi) * 4 + channelIndex];
				} else {
					// Edge case: clamp to nearest valid pixel
					const clampedX = Math.max(0, Math.min(width - 1, srcXi));
					const clampedY = Math.max(0, Math.min(height - 1, srcYi));
					dstData[dstIdx] = srcData[(clampedY * width + clampedX) * 4 + channelIndex];
				}
			}
		}
	}
}

// ==================== AUTO COLOR BALANCE ====================
// Gray World assumption: adjusts R/G/B so their averages match (using green as reference)

// Apply auto color balance to 16-bit Float32Array data
function applyAutoColorBalance16(data, width, height) {
	const pixelCount = width * height;

	// Calculate average for each channel
	let sumR = 0, sumG = 0, sumB = 0;
	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		sumR += data[idx];
		sumG += data[idx + 1];
		sumB += data[idx + 2];
	}

	const avgR = sumR / pixelCount;
	const avgG = sumG / pixelCount;
	const avgB = sumB / pixelCount;

	// Use green as reference (typically most accurate in camera sensors)
	// Calculate scale factors to match green's average
	const scaleR = avgG / avgR;
	const scaleB = avgG / avgB;

	// Skip if already balanced (within 0.1% tolerance)
	if (Math.abs(scaleR - 1) < 0.001 && Math.abs(scaleB - 1) < 0.001) {
		return data;
	}

	console.log(`Auto color balance: R×${scaleR.toFixed(3)}, B×${scaleB.toFixed(3)}`);

	// Apply scaling
	const result = new Float32Array(data.length);
	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		result[idx] = Math.min(1, data[idx] * scaleR);
		result[idx + 1] = data[idx + 1]; // Green unchanged
		result[idx + 2] = Math.min(1, data[idx + 2] * scaleB);
		result[idx + 3] = data[idx + 3]; // Alpha unchanged
	}

	return result;
}

// ==================== AUTO STRETCH ====================
// Applies levels adjustment: maps black/white points to 0/1 range

function applyAutoStretch16(data, width, height) {
	const pixelCount = width * height;

	// Sample every Nth pixel for speed (max ~100k samples)
	const sampleStep = Math.max(1, Math.floor(pixelCount / 100000));

	// Collect luminance values (excluding near-black background)
	const luminances = [];
	for (let i = 0; i < pixelCount; i += sampleStep) {
		const idx = i * 4;
		const r = data[idx];
		const g = data[idx + 1];
		const b = data[idx + 2];
		// Standard luminance formula
		const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		// Skip pure black pixels (likely background)
		if (lum > 0.005) {
			luminances.push(lum);
		}
	}

	if (luminances.length < 100) {
		console.warn('Auto stretch: not enough non-black pixels, skipping');
		return data;
	}

	// Sort to find percentiles
	luminances.sort((a, b) => a - b);

	// Find 0.5% and 99.5% percentiles
	const lowIdx = Math.floor(luminances.length * 0.005);
	const highIdx = Math.floor(luminances.length * 0.995);
	const blackPoint = luminances[lowIdx];
	const whitePoint = luminances[highIdx];
	const range = whitePoint - blackPoint;

	if (range < 0.01) {
		console.warn('Auto stretch: image already has full range, skipping');
		return data;
	}

	console.log(`Auto stretch: black=${blackPoint.toFixed(4)}, white=${whitePoint.toFixed(4)}, range=${range.toFixed(4)}`);

	// Apply levels with headroom for sharpening
	// Stretch to 0.0-0.9 range (90%) to leave room for wavelet boosts
	const targetMax = 0.9;
	const scale = targetMax / range;

	const result = new Float32Array(data.length);
	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		// Stretch each channel using same black/white points, with headroom
		result[idx] = Math.max(0, Math.min(1, (data[idx] - blackPoint) * scale));
		result[idx + 1] = Math.max(0, Math.min(1, (data[idx + 1] - blackPoint) * scale));
		result[idx + 2] = Math.max(0, Math.min(1, (data[idx + 2] - blackPoint) * scale));
		result[idx + 3] = data[idx + 3]; // Alpha unchanged
	}

	return result;
}

// Crop functions
function startCropMode() {
	cropMode.value = true;
	cropSelection.value = null;

	// Add mouse event listeners to canvas
	const canvasEl = canvas.value;
	canvasEl.style.cursor = 'crosshair';
	canvasEl.addEventListener('mousedown', onCropMouseDown);
	canvasEl.addEventListener('mousemove', onCropMouseMove);
	canvasEl.addEventListener('mouseup', onCropMouseUp);

	// Add keyboard listener for Escape
	document.addEventListener('keydown', onCropKeyDown);
}

function onCropKeyDown(e) {
	if (e.key === 'Escape') {
		cancelCrop();
	}
}

function cancelCrop() {
	cropMode.value = false;
	cropSelection.value = null;
	cropStart = null;

	// Remove event listeners and restore canvas
	const canvasEl = canvas.value;
	canvasEl.style.cursor = 'default';
	canvasEl.removeEventListener('mousedown', onCropMouseDown);
	canvasEl.removeEventListener('mousemove', onCropMouseMove);
	canvasEl.removeEventListener('mouseup', onCropMouseUp);
	document.removeEventListener('keydown', onCropKeyDown);

	// Redraw to remove selection rectangle
	applyProcessing();
}

function onCropMouseDown(e) {
	const rect = canvas.value.getBoundingClientRect();
	const scaleX = canvas.value.width / rect.width;
	const scaleY = canvas.value.height / rect.height;

	cropStart = {
		x: Math.round((e.clientX - rect.left) * scaleX),
		y: Math.round((e.clientY - rect.top) * scaleY)
	};
	cropSelection.value = null;
}

function onCropMouseMove(e) {
	if (!cropStart) return;

	const rect = canvas.value.getBoundingClientRect();
	const scaleX = canvas.value.width / rect.width;
	const scaleY = canvas.value.height / rect.height;

	const currentX = Math.round((e.clientX - rect.left) * scaleX);
	const currentY = Math.round((e.clientY - rect.top) * scaleY);

	// Calculate selection rectangle (handle negative drag)
	const x = Math.min(cropStart.x, currentX);
	const y = Math.min(cropStart.y, currentY);
	const width = Math.abs(currentX - cropStart.x);
	const height = Math.abs(currentY - cropStart.y);

	// Clamp to canvas bounds
	cropSelection.value = {
		x: Math.max(0, x),
		y: Math.max(0, y),
		width: Math.min(width, canvas.value.width - x),
		height: Math.min(height, canvas.value.height - y)
	};

	// Draw selection rectangle
	drawCropOverlay();
}

function onCropMouseUp(e) {
	cropStart = null;
	// Keep selection visible for confirmation
}

function drawCropOverlay() {
	if (!cropSelection.value || !sharpenedImageData) return;

	// Redraw the current processed image
	ctx.putImageData(sharpenedImageData, 0, 0);

	const sel = cropSelection.value;

	// Draw semi-transparent overlay outside selection
	ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
	// Top
	ctx.fillRect(0, 0, canvas.value.width, sel.y);
	// Bottom
	ctx.fillRect(0, sel.y + sel.height, canvas.value.width, canvas.value.height - sel.y - sel.height);
	// Left
	ctx.fillRect(0, sel.y, sel.x, sel.height);
	// Right
	ctx.fillRect(sel.x + sel.width, sel.y, canvas.value.width - sel.x - sel.width, sel.height);

	// Draw selection border
	ctx.strokeStyle = '#00ff00';
	ctx.lineWidth = 2;
	ctx.strokeRect(sel.x, sel.y, sel.width, sel.height);

	// Show dimensions
	ctx.fillStyle = '#00ff00';
	ctx.font = '14px sans-serif';
	ctx.fillText(`${sel.width} x ${sel.height}`, sel.x + 5, sel.y + sel.height - 5);
}

function applyCrop() {
	if (!cropSelection.value) return;

	// Remove edge mask since coordinates become invalid after crop
	edgeMaskEnabled.value = false;

	const sel = cropSelection.value;

	// Save current state for undo (both 8-bit and 16-bit)
	preCropImageData = new ImageData(
		new Uint8ClampedArray(initCanvasImageData.data),
		initCanvasImageData.width,
		initCanvasImageData.height
	);
	preCropImage16 = image16.clone();
	preCropRotationState = {
		preRotationImage16: preRotationImage16 ? preRotationImage16.clone() : null,
		hasAppliedRotation: hasAppliedRotation.value,
		appliedRotation,
		rotation: rotation.value
	};
	canUndoCrop.value = true;

	// Crop from 16-bit image16 directly to preserve precision
	const srcWidth = image16.width;
	const srcData = image16.data;
	const croppedFloatData = new Float32Array(sel.width * sel.height * 4);

	for (let y = 0; y < sel.height; y++) {
		for (let x = 0; x < sel.width; x++) {
			const srcIdx = ((sel.y + y) * srcWidth + (sel.x + x)) * 4;
			const dstIdx = (y * sel.width + x) * 4;
			croppedFloatData[dstIdx] = srcData[srcIdx];
			croppedFloatData[dstIdx + 1] = srcData[srcIdx + 1];
			croppedFloatData[dstIdx + 2] = srcData[srcIdx + 2];
			croppedFloatData[dstIdx + 3] = srcData[srcIdx + 3];
		}
	}

	// Update canvas size
	canvas.value.width = sel.width;
	canvas.value.height = sel.height;

	// Update 16-bit image container from cropped float data
	image16 = Image16.fromFloat32Array(croppedFloatData, sel.width, sel.height);
	sharpenedImage16 = null;

	// Clear rotation backup (no longer valid for cropped dimensions)
	preRotationImage16 = null;
	hasAppliedRotation.value = false;
	appliedRotation = 0;
	rotation.value = 0;

	// Derive 8-bit initCanvasImageData from 16-bit for compatibility
	initCanvasImageData = image16.toImageData();
	gainedImageData = new ImageData(sel.width, sel.height);
	preNoiseReducedImageData = new ImageData(sel.width, sel.height);
	sharpenedImageData = new ImageData(sel.width, sel.height);

	// Clear caches
	prevValues = {};

	// Keep existing RGB alignment - CA is a global optical property, same offset applies to cropped region
	// (Don't re-run auto-alignment on crop - correlation often fails on smaller/different regions)

	// Reinitialize WebGL2 for new dimensions
	useWebGL2 = initWebGL2(sel.width, sel.height);

	// Exit crop mode
	cropMode.value = false;
	cropSelection.value = null;
	cropStart = null;

	const canvasEl = canvas.value;
	canvasEl.style.cursor = 'default';
	canvasEl.removeEventListener('mousedown', onCropMouseDown);
	canvasEl.removeEventListener('mousemove', onCropMouseMove);
	canvasEl.removeEventListener('mouseup', onCropMouseUp);
	document.removeEventListener('keydown', onCropKeyDown);

	// Reprocess with existing alignment settings
	applyProcessing();
}

function undoCrop() {
	if (!preCropImageData) return;

	// Restore canvas size
	canvas.value.width = preCropImageData.width;
	canvas.value.height = preCropImageData.height;

	// Restore 16-bit image from backup (or fall back to 8-bit conversion)
	if (preCropImage16) {
		image16 = preCropImage16;
		initCanvasImageData = image16.toImageData();
	} else {
		initCanvasImageData = preCropImageData;
		image16 = Image16.fromImageData(initCanvasImageData);
	}
	gainedImageData = new ImageData(preCropImageData.width, preCropImageData.height);
	preNoiseReducedImageData = new ImageData(preCropImageData.width, preCropImageData.height);
	sharpenedImageData = new ImageData(preCropImageData.width, preCropImageData.height);
	sharpenedImage16 = null;

	// Restore rotation state
	if (preCropRotationState) {
		preRotationImage16 = preCropRotationState.preRotationImage16;
		hasAppliedRotation.value = preCropRotationState.hasAppliedRotation;
		appliedRotation = preCropRotationState.appliedRotation;
		rotation.value = preCropRotationState.rotation;
	}

	// Force reprocess by clearing cached values
	prevValues = {};

	// Keep existing RGB alignment - CA is a global optical property

	preCropImageData = null;
	preCropImage16 = null;
	preCropRotationState = null;
	canUndoCrop.value = false;

	// Reinitialize WebGL2 for restored dimensions
	useWebGL2 = initWebGL2(canvas.value.width, canvas.value.height);

	// Reprocess with existing alignment settings
	applyProcessing();
}

// Rotation functions
function previewRotation() {
	// Show CSS rotation preview (difference from applied rotation)
	previewRotationAngle.value = rotation.value - appliedRotation;
}

function applyRotation() {
	// If rotation is same as already applied, nothing to do
	if (rotation.value === appliedRotation) {
		previewRotationAngle.value = 0;
		return;
	}

	// If rotation is 0 and we have applied rotation, reset instead
	if (rotation.value === 0 && hasAppliedRotation.value) {
		resetRotation();
		return;
	}

	// Remove edge mask since coordinates become invalid after rotation
	edgeMaskEnabled.value = false;

	// Save backup before first rotation
	if (!preRotationImage16) {
		preRotationImage16 = image16.clone();
	}

	// Rotate from the original backup (not current state - avoids accumulated interpolation)
	// Use Image16.rotate() to preserve 16-bit precision
	image16 = preRotationImage16.rotate(rotation.value);
	sharpenedImage16 = null;

	// Convert rotated Image16 to ImageData for display
	const rotatedData = image16.toImageData();

	// Update canvas size
	canvas.value.width = rotatedData.width;
	canvas.value.height = rotatedData.height;

	// Update all image data references
	initCanvasImageData = rotatedData;
	gainedImageData = new ImageData(rotatedData.width, rotatedData.height);
	preNoiseReducedImageData = new ImageData(rotatedData.width, rotatedData.height);
	sharpenedImageData = new ImageData(rotatedData.width, rotatedData.height);

	// Clear caches
	prevValues = {};

	// Keep existing RGB alignment - CA is a global optical property

	// Reinitialize WebGL2 for new dimensions
	useWebGL2 = initWebGL2(rotatedData.width, rotatedData.height);

	hasAppliedRotation.value = true;
	appliedRotation = rotation.value;

	// Clear CSS preview after pixels are rotated
	previewRotationAngle.value = 0;

	// Reprocess with existing alignment settings
	applyProcessing();
}

function resetRotation() {
	// Clear CSS preview
	previewRotationAngle.value = 0;

	if (!preRotationImage16) {
		rotation.value = 0;
		appliedRotation = 0;
		return;
	}

	// Restore from 16-bit backup
	image16 = preRotationImage16.clone();
	sharpenedImage16 = null;

	// Convert to ImageData for display
	initCanvasImageData = image16.toImageData();

	// Restore canvas size
	canvas.value.width = initCanvasImageData.width;
	canvas.value.height = initCanvasImageData.height;

	gainedImageData = new ImageData(initCanvasImageData.width, initCanvasImageData.height);
	preNoiseReducedImageData = new ImageData(initCanvasImageData.width, initCanvasImageData.height);
	sharpenedImageData = new ImageData(initCanvasImageData.width, initCanvasImageData.height);

	// Clear caches
	prevValues = {};

	// Keep existing RGB alignment - CA is a global optical property

	// Clear backup and reset values
	preRotationImage16 = null;
	rotation.value = 0;
	appliedRotation = 0;
	hasAppliedRotation.value = false;

	// Reinitialize WebGL2 for original dimensions
	useWebGL2 = initWebGL2(canvas.value.width, canvas.value.height);

	// Reprocess with existing alignment settings
	applyProcessing();
}

// ============ Edge Mask Functions ============

function startEdgeMaskMode() {
	edgeMaskMode.value = true;

	// Only auto-detect if no mask exists yet; otherwise keep existing position
	if (!edgeMaskEnabled.value) {
		autoDetectEdgeMaskCircle();
	}

	// Add mouse event listeners to canvas
	const canvasEl = canvas.value;
	canvasEl.style.cursor = 'move';
	canvasEl.addEventListener('mousedown', onEdgeMaskMouseDown);
	canvasEl.addEventListener('mousemove', onEdgeMaskMouseMove);
	canvasEl.addEventListener('mouseup', onEdgeMaskMouseUp);
	document.addEventListener('keydown', onEdgeMaskKeyDown);

	// Redraw with the green circle
	applyProcessing();
}

function autoDetectEdgeMaskCircle() {
	if (!initCanvasImageData) return;

	const width = initCanvasImageData.width;
	const height = initCanvasImageData.height;
	const data = image16 ? image16.data : initCanvasImageData.data;
	const isFloat = image16 !== null;

	// Find bounding box of bright pixels
	let minX = width, maxX = 0, minY = height, maxY = 0;
	const threshold = isFloat ? 0.1 : 25;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const idx = (y * width + x) * 4;
			const brightness = isFloat
				? (data[idx] + data[idx + 1] + data[idx + 2]) / 3
				: (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
			if (brightness > threshold) {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
		}
	}

	if (maxX > minX && maxY > minY) {
		edgeMaskCenterX.value = (minX + maxX) / 2;
		edgeMaskCenterY.value = (minY + maxY) / 2;
		// Use the larger dimension for radius, add small margin
		edgeMaskRadius.value = Math.max(maxX - minX, maxY - minY) / 2 + 5;
	} else {
		// Fallback to center of image
		edgeMaskCenterX.value = width / 2;
		edgeMaskCenterY.value = height / 2;
		edgeMaskRadius.value = Math.min(width, height) / 3;
	}
}

function onEdgeMaskKeyDown(e) {
	if (e.key === 'Escape') {
		cancelEdgeMask();
	}
}

function cancelEdgeMask() {
	edgeMaskMode.value = false;

	const canvasEl = canvas.value;
	canvasEl.style.cursor = 'default';
	canvasEl.removeEventListener('mousedown', onEdgeMaskMouseDown);
	canvasEl.removeEventListener('mousemove', onEdgeMaskMouseMove);
	canvasEl.removeEventListener('mouseup', onEdgeMaskMouseUp);
	document.removeEventListener('keydown', onEdgeMaskKeyDown);

	applyProcessing();
}

function onEdgeMaskMouseDown(e) {
	const rect = canvas.value.getBoundingClientRect();
	const scaleX = canvas.value.width / rect.width;
	const scaleY = canvas.value.height / rect.height;
	const x = (e.clientX - rect.left) * scaleX;
	const y = (e.clientY - rect.top) * scaleY;

	const dx = x - edgeMaskCenterX.value;
	const dy = y - edgeMaskCenterY.value;
	const dist = Math.sqrt(dx * dx + dy * dy);

	// Check if near the edge (within 15px for resize)
	if (Math.abs(dist - edgeMaskRadius.value) < 15) {
		edgeMaskResizing = true;
		edgeMaskOriginalRadius = edgeMaskRadius.value;
	} else if (dist < edgeMaskRadius.value) {
		// Inside circle - drag to move
		edgeMaskDragging = true;
		edgeMaskDragStart = { x, y };
		edgeMaskOriginalCenter = { x: edgeMaskCenterX.value, y: edgeMaskCenterY.value };
	}
}

function onEdgeMaskMouseMove(e) {
	const rect = canvas.value.getBoundingClientRect();
	const scaleX = canvas.value.width / rect.width;
	const scaleY = canvas.value.height / rect.height;
	const x = (e.clientX - rect.left) * scaleX;
	const y = (e.clientY - rect.top) * scaleY;

	if (edgeMaskDragging) {
		const dx = x - edgeMaskDragStart.x;
		const dy = y - edgeMaskDragStart.y;
		edgeMaskCenterX.value = edgeMaskOriginalCenter.x + dx;
		edgeMaskCenterY.value = edgeMaskOriginalCenter.y + dy;
		redrawEdgeMaskCircle();
	} else if (edgeMaskResizing) {
		const dx = x - edgeMaskCenterX.value;
		const dy = y - edgeMaskCenterY.value;
		edgeMaskRadius.value = Math.max(10, Math.sqrt(dx * dx + dy * dy));
		redrawEdgeMaskCircle();
	} else {
		// Update cursor based on position
		const dx = x - edgeMaskCenterX.value;
		const dy = y - edgeMaskCenterY.value;
		const dist = Math.sqrt(dx * dx + dy * dy);
		if (Math.abs(dist - edgeMaskRadius.value) < 15) {
			canvas.value.style.cursor = 'ew-resize';
		} else if (dist < edgeMaskRadius.value) {
			canvas.value.style.cursor = 'move';
		} else {
			canvas.value.style.cursor = 'default';
		}
	}
}

function onEdgeMaskMouseUp() {
	edgeMaskDragging = false;
	edgeMaskResizing = false;
}

function applyEdgeMask() {
	// Sample background color from corners
	sampleBackgroundColor();

	edgeMaskEnabled.value = true;
	edgeMaskMode.value = false;

	const canvasEl = canvas.value;
	canvasEl.style.cursor = 'default';
	canvasEl.removeEventListener('mousedown', onEdgeMaskMouseDown);
	canvasEl.removeEventListener('mousemove', onEdgeMaskMouseMove);
	canvasEl.removeEventListener('mouseup', onEdgeMaskMouseUp);
	document.removeEventListener('keydown', onEdgeMaskKeyDown);

	applyProcessing();
}

function sampleBackgroundColor() {
	if (!image16) return;

	const width = canvas.value.width;
	const height = canvas.value.height;
	const data = image16.data;
	const cx = edgeMaskCenterX.value;
	const cy = edgeMaskCenterY.value;
	const r = edgeMaskRadius.value;
	const rSq = r * r;

	// Collect minimum channel values from all pixels outside the mask circle
	const darkValues = [];

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dx = x - cx;
			const dy = y - cy;
			const distSq = dx * dx + dy * dy;

			// Only sample pixels outside the circle
			if (distSq > rSq) {
				const idx = (y * width + x) * 4;
				const pr = data[idx];
				const pg = data[idx + 1];
				const pb = data[idx + 2];
				// Use minimum channel to ignore color fringe contamination
				const minChannel = Math.min(pr, pg, pb);
				darkValues.push(minChannel);
			}
		}
	}

	if (darkValues.length === 0) {
		edgeMaskBackgroundColor.value = [0, 0, 0];
		return;
	}

	// Sort and average the darkest 20%
	darkValues.sort((a, b) => a - b);
	const darkest20Count = Math.max(1, Math.floor(darkValues.length * 0.2));
	let sum = 0;
	for (let i = 0; i < darkest20Count; i++) {
		sum += darkValues[i];
	}
	const avgDark = sum / darkest20Count;

	edgeMaskBackgroundColor.value = [avgDark, avgDark, avgDark];
}

function removeEdgeMask() {
	edgeMaskEnabled.value = false;
	applyProcessing();
}

// Lightweight redraw - just redraws existing image + green circle (no reprocessing)
function redrawEdgeMaskCircle() {
	if (!sharpenedImageData) return;
	const ctx = canvas.value.getContext('2d');
	ctx.putImageData(sharpenedImageData, 0, 0);
	ctx.strokeStyle = '#00ff00';
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.arc(edgeMaskCenterX.value, edgeMaskCenterY.value, edgeMaskRadius.value, 0, Math.PI * 2);
	ctx.stroke();
}

// ============ End Edge Mask Functions ============

function processChromaticAberration(channel, axis, magnitude){
	// Manual adjustment - no longer auto-aligned
	rgbAlignmentIsAuto.value = false;

	// Update the offset state (CA correction is now applied at the start of the pipeline)
	if( fixedAberration[channel] == undefined ){
		fixedAberration[channel] = {};
	}

	if( fixedAberration[channel][axis] == undefined ){
		fixedAberration[channel][axis] = 0;
	}

	fixedAberration[channel][axis] += magnitude;

	// Trigger full reprocessing with updated CA correction
	applyProcessing();
}

function resetRGBAlignment() {
	rgbAlignmentIsAuto.value = false;
	fixedAberration.red = undefined;
	fixedAberration.blue = undefined;
	applyProcessing();
}

// Handle Auto checkbox change
function onAutoAlignCheckboxChange() {
	if (rgbAlignmentIsAuto.value) {
		// Checkbox was just checked - run auto alignment
		autoAlignRGB();
	} else {
		// Checkbox was unchecked - revert alignment
		fixedAberration.red = undefined;
		fixedAberration.blue = undefined;
		applyProcessing();
	}
}

// Auto-detect RGB alignment using cross-correlation
async function autoAlignRGB() {
	// Use pre-crop image if available (larger image = more reliable correlation)
	// CA is a global optical property, so detecting on full image works for cropped regions too
	const sourceImage = preCropImage16 || image16;
	if (!sourceImage) return;

	isAutoAligning.value = true;

	// Use setTimeout to allow UI to update
	await new Promise(resolve => setTimeout(resolve, 10));

	try {
		// Extract channels from 16-bit data (scale to 0-255 for correlation)
		const width = sourceImage.width;
		const height = sourceImage.height;
		const data = sourceImage.data;
		const red = new Float32Array(width * height);
		const green = new Float32Array(width * height);
		const blue = new Float32Array(width * height);

		for (let i = 0; i < width * height; i++) {
			red[i] = data[i * 4] * 255;
			green[i] = data[i * 4 + 1] * 255;
			blue[i] = data[i * 4 + 2] * 255;
		}

		// Find offset using cross-correlation (green is reference)
		const redOffset = findChannelOffset(green, red, width, height);
		const blueOffset = findChannelOffset(green, blue, width, height);

		// Reset existing alignment
		fixedAberration.red = undefined;
		fixedAberration.blue = undefined;

		// Apply detected offsets (negated - correlation finds where channel IS, we need to shift it BACK)
		if (redOffset.x !== 0 || redOffset.y !== 0) {
			fixedAberration.red = { x: -redOffset.x, y: -redOffset.y };
		}
		if (blueOffset.x !== 0 || blueOffset.y !== 0) {
			fixedAberration.blue = { x: -blueOffset.x, y: -blueOffset.y };
		}

		// Mark as auto-aligned (so we re-run after crop/rotation)
		rgbAlignmentIsAuto.value = true;

		// Reapply processing with new alignment
		applyProcessing();

	} finally {
		isAutoAligning.value = false;
	}
}

// Find channel offset using normalized cross-correlation
function findChannelOffset(ref, target, width, height) {
	const maxSearch = 5; // Search range in pixels
	let bestScore = -Infinity;
	let bestX = 0;
	let bestY = 0;

	// Coarse search (1px steps)
	for (let dy = -maxSearch; dy <= maxSearch; dy++) {
		for (let dx = -maxSearch; dx <= maxSearch; dx++) {
			const score = correlationScore(ref, target, width, height, dx, dy);
			if (score > bestScore) {
				bestScore = score;
				bestX = dx;
				bestY = dy;
			}
		}
	}

	// Fine search around best (0.5px steps)
	// Store boundaries before loop to prevent drift
	const fineMinX = bestX - 1;
	const fineMaxX = bestX + 1;
	const fineMinY = bestY - 1;
	const fineMaxY = bestY + 1;

	for (let dy = fineMinY; dy <= fineMaxY; dy += 0.5) {
		for (let dx = fineMinX; dx <= fineMaxX; dx += 0.5) {
			const score = correlationScore(ref, target, width, height, dx, dy);
			if (score > bestScore) {
				bestScore = score;
				bestX = dx;
				bestY = dy;
			}
		}
	}

	// Round to 0.5px and clamp to search range
	return {
		x: Math.max(-maxSearch - 1, Math.min(maxSearch + 1, Math.round(bestX * 2) / 2)),
		y: Math.max(-maxSearch - 1, Math.min(maxSearch + 1, Math.round(bestY * 2) / 2))
	};
}

// Calculate correlation score between reference and shifted target
function correlationScore(ref, target, width, height, dx, dy) {
	let sum = 0;
	let count = 0;

	// Use center region only (avoid edges, faster)
	const margin = Math.max(10, Math.ceil(Math.abs(dx)) + 1, Math.ceil(Math.abs(dy)) + 1);

	for (let y = margin; y < height - margin; y++) {
		for (let x = margin; x < width - margin; x++) {
			const refIdx = y * width + x;

			// Bilinear interpolation for sub-pixel offset
			const srcX = x + dx;
			const srcY = y + dy;
			const x0 = Math.floor(srcX);
			const y0 = Math.floor(srcY);
			const fx = srcX - x0;
			const fy = srcY - y0;

			const idx00 = y0 * width + x0;
			const idx01 = y0 * width + (x0 + 1);
			const idx10 = (y0 + 1) * width + x0;
			const idx11 = (y0 + 1) * width + (x0 + 1);

			const val = target[idx00] * (1 - fx) * (1 - fy) +
			            target[idx01] * fx * (1 - fy) +
			            target[idx10] * (1 - fx) * fy +
			            target[idx11] * fx * fy;

			// Normalized correlation (multiply centered values)
			sum += (ref[refIdx] - 128) * (val - 128);
			count++;
		}
	}

	return count > 0 ? sum / count : 0;
}



</script>

<style scoped>
canvas {

}
.content {
	max-width: none;
}

/* Disabled controls state when no image loaded */
.controls-disabled {
	opacity: 0.5;
	pointer-events: none;
	user-select: none;
}

/* Intro content styling */
.intro-content {
	max-width: 600px;
}
.intro-content .file-input-wrapper {
	margin-bottom: 30px;
}
.intro-content .file-label {
	display: inline-block;
	padding: 12px 24px;
	font-size: 16px;
	cursor: pointer;
}
.intro-content .supported-formats {
	margin-top: 8px;
	color: #888;
	font-size: 13px;
}

/* Toolbar actions wrapper */
.toolbar-actions {
	display: flex;
	align-items: center;
	gap: 8px;
}

/* Kebab menu */
.kebab-menu {
	position: relative;
	display: inline-block;
}
.kebab-btn {
	background: #fefefe;
	border: none;
	color: #333;
	font-size: 14px;
	padding: 8px 12px;
	cursor: pointer;
	border-radius: 5px;
	font-weight: bold;
	line-height: 1;
}
.kebab-btn:hover {
	background: #f0f0f0;
}
.kebab-backdrop {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 99;
}
.kebab-dropdown {
	position: absolute;
	top: 100%;
	right: 0;
	margin-top: 4px;
	background: #fefefe;
	border-radius: 6px;
	box-shadow: 0 2px 10px rgba(0,0,0,0.2);
	z-index: 100;
	min-width: 180px;
	overflow: hidden;
}
.kebab-dropdown button {
	display: block;
	width: 100%;
	padding: 10px 15px;
	border: none;
	background: none;
	text-align: left;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
	color: #333;
}
.kebab-dropdown button:hover {
	background: #f0f0f0;
}

.color-alignment h4 {
	display: flex;
	align-items: center;
	gap: 10px;
}
.color-alignment h5 {
	margin: 8px 0 4px 0;
}
.color-alignment button {
	margin-right: 2px;
	min-width: 50px;
	padding: 4px 8px;
}
.manual-link {
	margin-left: 10px;
	font-size: 12px;
	font-weight: normal;
	color: #7ab;
}
.manual-link:hover {
	color: #9cd;
}
.manual-rgb-controls {
	margin-top: 8px;
	padding: 8px;
	background: rgba(255,255,255,0.05);
	border-radius: 4px;
}
.color-balance-section {
	margin: 15px 0;
}
.color-balance-section h4 {
	margin-bottom: 8px;
}
.checkbox-label {
	display: flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
	font-size: 14px;
}
.checkbox-label input[type="checkbox"] {
	width: 16px;
	height: 16px;
	cursor: pointer;
}
.luminance-only-option {
	margin: 2px 0 6px 0;
	font-size: 11px;
	color: #888;
}
.info-icon {
	cursor: pointer;
	color: #666;
	font-size: 0.85em;
	user-select: none;
}
.info-icon:hover {
	color: #333;
}
.info-text {
	font-size: 0.85em;
	color: #555;
	margin-bottom: 8px;
	padding: 6px 8px;
	background: #f5f5f5;
	border-radius: 4px;
}
.crop-controls {
	display: flex;
	gap: 10px;
	align-items: center;
	flex-wrap: wrap;
}
.crop-controls button {
	padding: 8px 16px;
	border: none;
	border-radius: 4px;
	cursor: pointer;
	background-color: #e8e8e8;
	color: #555;
}
.crop-controls .cancel-crop {
	background-color: #888;
	color: white;
}
.crop-controls .undo-crop {
	background-color: #ff9800;
	color: white;
}
.crop-hint {
	font-size: 12px;
	color: #666;
}

/* Edge mask controls */
.edge-mask-controls {
	display: flex;
	gap: 10px;
	align-items: center;
	flex-wrap: wrap;
}
.edge-mask-controls button {
	padding: 8px 16px;
	border: none;
	border-radius: 4px;
	cursor: pointer;
	background-color: #e8e8e8;
	color: #555;
}
.edge-mask-controls .cancel-mask {
	background-color: #888;
	color: white;
}
.edge-mask-controls .remove-mask {
	background-color: #ff6b6b;
	color: white;
}
.edge-mask-hint {
	font-size: 12px;
	color: #666;
}

.sharpening-frame {
	border: none;
	padding: 0;
	margin: 0;
}
.sharpening-frame legend {
	font-weight: bold;
	padding: 0;
	margin-bottom: 8px;
}
.sharpening-tabs {
	display: inline-flex;
	margin-bottom: 10px;
}
.sharpening-tabs button {
	padding: 6px 12px;
	border: 1px solid #ccc;
	border-radius: 0;
	margin-left: -1px;
	background-color: #e8e8e8;
	color: #555;
	cursor: pointer;
	font-size: 12px;
	white-space: nowrap;
	transition: background-color 0.2s;
}
.sharpening-tabs button:first-child {
	margin-left: 0;
	border-radius: 4px 0 0 4px;
}
.sharpening-tabs button:last-child {
	border-radius: 0 4px 4px 0;
	padding: 6px 8px;
}
.sharpening-tabs button:hover {
	background-color: #d0d0d0;
}
.sharpening-tabs button.active {
	background-color: #8CCF7E;
	color: #111;
}
.sharpening-content {
	padding-top: 5px;
}
.processing-indicator {
	position: absolute;
	top: 10px;
	right: 10px;
}
.spinner {
	width: 14px;
	height: 14px;
	border: 2px solid #27587c;
	border-top-color: transparent;
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}
@keyframes spin {
	to { transform: rotate(360deg); }
}
.controls {
	position: relative;
}
.loading-inline {
	position: absolute;
	top: 10px;
	left: 10px;
	display: inline-flex;
	align-items: center;
	gap: 6px;
	color: white;
	font-size: 13px;
	z-index: 10;
}
.reset-rotation {
	margin-left: 10px;
	padding: 4px 8px;
	font-size: 12px;
}
.export-hint {
	font-size: 12px;
	color: #888;
	margin-top: 5px;
}
.comparison-btn:disabled {
	opacity: 0.6;
	cursor: not-allowed;
}
.export-popup-overlay {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background: rgba(0, 0, 0, 0.6);
	display: flex;
	justify-content: center;
	align-items: center;
	z-index: 1000;
}
.export-popup {
	background: #fefefe;
	color: #333;
	border-radius: 10px;
	padding: 25px 30px;
	max-width: 400px;
	width: 90%;
	box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
.export-popup h3 {
	margin: 0 0 20px 0;
	color: #333;
	font-size: 18px;
}
.export-filename {
	margin-bottom: 20px;
}
.export-filename label {
	display: block;
	margin-bottom: 5px;
	font-weight: bold;
	font-size: 13px;
}
.export-filename input {
	width: 100%;
	padding: 10px;
	border: 1px solid #ccc;
	border-radius: 5px;
	font-size: 14px;
	box-sizing: border-box;
}
.export-filename input:focus {
	outline: none;
	border-color: #8CCF7E;
}
.export-buttons {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin-bottom: 20px;
}
.export-option {
	padding: 12px 16px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
	text-align: left;
	transition: background-color 0.2s;
	background-color: #8CCF7E;
	color: #111;
	font-weight: bold;
}
.export-option:hover:not(:disabled) {
	background-color: #7ABF6E;
}
.export-option.secondary {
	background-color: #e8e8e8;
	color: #333;
	font-weight: normal;
}
.export-option.secondary:hover:not(:disabled) {
	background-color: #d8d8d8;
}
.export-option.video {
	background-color: #5bc0de;
	color: #fff;
}
.export-option.video:hover:not(:disabled) {
	background-color: #4ab0ce;
}
.export-option:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
.share-note {
	font-size: 13px;
	color: #666;
	text-align: center;
	margin: 15px 0 0 0;
	padding-top: 15px;
	border-top: 1px solid #eee;
}
.export-popup-footer {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 10px;
	padding-top: 15px;
}
.close-btn {
	padding: 8px 20px;
	background-color: #eee;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
}
.close-btn:hover {
	background-color: #ddd;
}

/* Help popup */
.help-popup-overlay {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background: rgba(0, 0, 0, 0.6);
	display: flex;
	justify-content: center;
	align-items: center;
	z-index: 1000;
}
.help-popup {
	background: #fefefe;
	color: #333;
	border-radius: 10px;
	padding: 25px 30px;
	max-width: 500px;
	width: 90%;
	max-height: 80vh;
	overflow-y: auto;
	box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
}
.help-popup h3 {
	margin: 0 0 15px 0;
	color: #333;
	font-size: 18px;
}
.help-popup h4 {
	margin: 20px 0 10px 0;
	color: #333;
}
.help-popup p {
	margin: 8px 0;
	line-height: 1.5;
}
.help-popup-footer {
	display: flex;
	justify-content: flex-end;
	padding-top: 15px;
	margin-top: 15px;
	border-top: 1px solid #eee;
}

/* Feature list styling - muted descriptions with bold titles */
.content ul li {
	color: #9ab0c0;
}
.content ul li strong {
	color: #c6fffd;
}
</style>


<template>
<div class="page-layout page-layout-wide">
	<div class="card">
		<div class="controls">
			<div class="processing-indicator" v-if="isProcessing">
				<div class="spinner"></div>
			</div>
			<h4>Color Adjustments</h4>
			<div>
				<label>Gain:</label>
				<input type="range" min="0.5" max="3" step="0.01" v-model="gain" @input="applyProcessing"/>
				<span>{{ gain }}</span>
			</div>
			<div>
				<label>Contrast:</label>
				<input type="range" min="0.5" max="2" step="0.01" v-model="contrast" @input="applyProcessing"/>
				<span>{{ contrast }}</span>
			</div>
			<div>
				<label>Gamma:</label>
				<input type="range" min="0.3" max="3" step="0.01" v-model="gamma" @input="applyProcessing"/>
				<span>{{ gamma }}</span>
			</div>
			<div>
				<label>Saturation:</label>
				<input type="range" min="0" max="2" step="0.01" v-model="saturation" @input="applyProcessing"/>
				<span>{{ saturation }}</span>
			</div>
			<div>
				<label>Vibrance:</label>
				<input type="range" min="-1" max="2" step="0.01" v-model="vibrance" @input="applyProcessing"/>
				<span>{{ vibrance }}</span>
			</div>

			<fieldset class="sharpening-frame">
				<legend>Sharpening</legend>
				<div class="sharpening-tabs">
					<button :class="{ active: sharpeningMethod === 'wavelets' }" @click="setSharpeningMethod('wavelets')">Wavelets</button>
					<button :class="{ active: sharpeningMethod === 'usm' }" @click="setSharpeningMethod('usm')">Unsharp Mask</button>
					<button v-if="!liteMode" :class="{ active: sharpeningMethod === 'deconv' }" @click="setSharpeningMethod('deconv')">Deconvolution</button>
					<button :class="{ active: sharpeningMethod === 'none' }" @click="setSharpeningMethod('none')" title="None">⊘</button>
				</div>

				<div class="sharpening-content" v-if="sharpeningMethod === 'usm'">
					<div>
						<label>Radius:</label>
						<input type="range" min="0.5" max="10" step="0.1" v-model="usmRadius" @input="applyProcessing"/>
						<span>{{ usmRadius }}</span>
					</div>
					<div>
						<label>Amount:</label>
						<input type="range" min="0" max="10" step="0.1" v-model="usmAmount" @input="applyProcessing"/>
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
						<input type="range" min="0" max="100" step="0.1" v-model="waveletsAmount" @input="applyProcessing"/>
						<span>{{ waveletsAmount }}</span>
					</div>
					<div>
						<label>Denoise:</label>
						<input type="range" min="0" max="50" step="1" v-model="postNoiseReduction" @input="applyProcessing"/>
						<span>{{ postNoiseReduction > 0 ? postNoiseReduction : 'Off' }}</span>
					</div>
				</div>

				<div class="sharpening-content" v-if="sharpeningMethod === 'deconv'">
					<div>
						<label>PSF Radius:</label>
						<input type="range" min="0" max="10" step="0.1" v-model="deconvRadius" @input="applyProcessing"/>
						<span>{{ deconvRadius }}</span>
					</div>
					<div>
						<label>Iterations:</label>
						<input type="range" min="0" max="200" step="1" v-model="deconvIterations" @input="applyProcessing"/>
						<span>{{ deconvIterations }}</span>
					</div>
				</div>
			</fieldset>

			<div class="color-alignment">
				<h4>RGB Alignment <button class="auto-align-btn" @click="autoAlignRGB" :disabled="isAutoAligning">{{ isAutoAligning ? 'Detecting...' : 'Auto' }}</button></h4>

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

			<h4>Crop</h4>
			<div class="crop-controls">
				<button v-if="!cropMode" @click="startCropMode">Select crop area</button>
				<button v-if="!cropMode && canUndoCrop" class="undo-crop" @click="undoCrop">Undo crop</button>
				<template v-if="cropMode">
					<span class="crop-hint">Click and drag on the image to select area</span>
					<button class="apply-crop" @click="applyCrop" :disabled="!cropSelection">Apply crop</button>
					<button class="cancel-crop" @click="cancelCrop">Cancel</button>
				</template>
			</div>

			<h4>Rotation</h4>
			<div>
				<input type="range" min="-180" max="180" step="0.1" v-model.number="rotation" @input="previewRotation" @change="applyRotation" />
				<span>{{ rotation }}°</span>
				<button v-if="rotation !== 0 || hasAppliedRotation" class="reset-rotation" @click="resetRotation">Reset</button>
			</div>

		</div>
	</div>
	<div class="content">
		<div v-if="!props.file" class="empty-state">
			<h2>Post-processor</h2>
			<p>Load any image (PNG, TIFF, JPEG) to apply sharpening, color adjustments, and other processing.</p>
			<div class="empty-state-buttons">
				<input
					type="file"
					ref="directFileInput"
					accept="image/*"
					style="display: none"
					@change="handleDirectFileSelect"
				/>
				<button class="primary-btn" @click="triggerDirectFileSelect">Select image</button>
				<NuxtLink to="/" class="secondary-btn">Go to stacking</NuxtLink>
			</div>
			<div class="feature-list">
				<h4>Features</h4>
				<ul>
					<li><strong>Wavelet sharpening</strong> - multi-scale sharpening with denoise option</li>
					<li><strong>Unsharp mask</strong> - radius, amount, and threshold controls</li>
					<li><strong>Deconvolution</strong> - Richardson-Lucy iterative deconvolution</li>
					<li><strong>Color adjustments</strong> - gain, contrast, gamma, saturation, vibrance</li>
					<li><strong>RGB alignment</strong> - fix chromatic aberration with auto-detect or manual sub-pixel shifts</li>
					<li><strong>Rotation and crop</strong> - straighten and trim your image</li>
					<li><strong>16-bit support</strong> - maintains precision when loading 16-bit PNGs</li>
				</ul>
			</div>
		</div>
		<template v-else>
			<ZoomableCanvas ref="zoomableCanvasRef" id="postProcessCanvas" @canvasReady="handleCanvasReady" :disableDrag="cropMode" :previewRotation="previewRotationAngle">
				<template #overlay>
					<span v-if="isLoadingImage" class="loading-inline">
						<span class="spinner"></span> Loading image...
					</span>
				</template>
				<template #toolbar>
					<button class="export-btn" @click="openExportPopup">
						⬇ Export
					</button>
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
				<button v-if="use16bit && sharpenedImage16" class="export-option" @click="download16BitProcessedPNG">
					⬇ Processed PNG (16-bit)
				</button>
				<button class="export-option" @click="downloadUnprocessedPNG">
					⬇ Unprocessed PNG
				</button>
				<button v-if="props.croppedSerData" class="export-option secondary" @click="downloadCroppedSer">
					⬇ Cropped SER ({{ props.croppedSerData.cropSize }}x{{ props.croppedSerData.cropSize }})
				</button>
				<button v-if="props.croppedAviData" class="export-option secondary" @click="downloadCroppedAvi">
					⬇ Cropped AVI ({{ props.croppedAviData.frameCount }} frames)
				</button>
				<button
					class="export-option video"
					@click="downloadComparisonVideo"
					:disabled="!canExport() || isExportingVideo"
					:title="!canExport() ? 'Only available after running the full stack pipeline' : ''">
					{{ isExportingVideo ? exportProgress : '⬇ Comparison Video (mp4)' }}
				</button>
			</div>

			<div class="export-popup-footer">
				<a href="https://github.com/timing/eise.app/issues" target="_blank" class="feedback-cta" @click="handleFeedbackClick">
					💬 How was your result? Send feedback!
				</a>
				<button class="close-btn" @click="showExportPopup = false">Close</button>
			</div>
		</div>
	</div>

</div>
</template>

<script setup>
import { ref, onMounted, watch, defineProps, reactive, onUnmounted, computed, nextTick, inject } from 'vue';
import debounce from 'lodash/debounce';
import { adjustGain, adjustGainMultiply, cvMatToImageData } from '@/utils/sobel.js'
import { encodeAvi } from '@/utils/aviEncoder.js'
import { initWebGL, processWithWebGL, isWebGLAvailable, disposeWebGL } from '@/utils/webglProcessor.js'
import { deconvolveWebGL, deconvolveWebGL16, disposeDeconvWebGL } from '@/utils/webglDeconv.js'
import { Image16 } from '@/utils/Image16.js'
import { initWebGL2, processWithWebGL2, isWebGL2Available, disposeWebGL2, blurWithWebGL2 } from '@/utils/webgl2Processor.js'
import { download16BitPNG, decodePNG } from '@/utils/png16Encoder.js'
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
let useWebGL = false;
let useWebGL2 = false;

// 16-bit processing state
const use16bit = ref(true); // Enable 16-bit mode by default
let image16 = null; // Image16 container for 16-bit processing
let sharpenedImage16 = null; // Sharpened result in 16-bit

const handleCanvasReady = (canvasRef) => {
	// canvasRef is the direct ref to the canvas element
	console.log('Canvas is ready:', canvasRef);
	canvas = canvasRef;
	// You can now use canvasRef.value to access the canvas element directly
};

const downloadCanvasAsPNG = () => {
	if (!canvas) return;

	track('download_processed');
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

const downloadUnprocessedPNG = () => {
	if (!initCanvasImageData) return;

	track('download_unprocessed');
	// Create a temporary canvas to convert ImageData to PNG
	const tempCanvas = document.createElement('canvas');
	tempCanvas.width = initCanvasImageData.width;
	tempCanvas.height = initCanvasImageData.height;
	const tempCtx = tempCanvas.getContext('2d');
	tempCtx.putImageData(initCanvasImageData, 0, 0);

	const dataURL = tempCanvas.toDataURL('image/png');
	const link = document.createElement('a');
	const filename = exportFilename.value || inputFilename.value || 'eise_app';
	link.download = `${filename}_unprocessed.png`;
	link.href = dataURL;
	document.body.appendChild(link); // Required for Firefox
	link.click();
	document.body.removeChild(link);
	showExportPopup.value = false;
	openFeedbackAfterDownload();
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

		track('download_comparison_video');

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

	track('download_cropped_ser');
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

const downloadCroppedAvi = () => {
	if (!props.croppedAviData) return;

	track('download_cropped_avi');
	try {
		const aviBlob = encodeAvi(props.croppedAviData.frames, 25);
		const url = URL.createObjectURL(aviBlob);
		const a = document.createElement('a');
		a.href = url;
		const filename = exportFilename.value || inputFilename.value || 'eise_app';
		a.download = `${filename}_cropped.avi`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		showExportPopup.value = false;
		openFeedbackAfterDownload();
	} catch (e) {
		console.error('AVI encoding error:', e);
	}
};

const download16BitProcessedPNG = async () => {
	if (!sharpenedImage16) return;

	track('download_processed_16bit');
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
	croppedSerData: Object,
	croppedAviData: Object
});

const gain = ref(1);
const contrast = ref(1);
const gamma = ref(1);
const saturation = ref(1);
const vibrance = ref(0);
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
const sharpeningMethod = ref('wavelets'); // 'usm', 'wavelets', 'deconv', or 'none'
const rotation = ref(0); // degrees (slider value)
const previewRotationAngle = ref(0); // CSS preview rotation while dragging
const hasAppliedRotation = ref(false);
let preRotationImageData = null; // Backup of original image before rotation
let appliedRotation = 0; // Track what rotation has been applied to pixels
const isAutoAligning = ref(false);

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
let preCropImageData = null; // Store image before crop for undo
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
		loadImage(newVal);
	}
});

let workingMat;
let initCanvas;
let initCanvasImageData;
let gainedImageData;
let preNoiseReducedImageData;
let sharpenedImageData;
let ctx = null;

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

	// Lazy-load workers when first image is loaded
	initializeWorkers();

	console.log(file);

	// Check if we have 16-bit float32 data from stacking
	const hasFloat32Data = props.float32Data && props.imageDimensions &&
		props.imageDimensions.width && props.imageDimensions.height;

	// Try to decode 16-bit PNG directly (before browser clamps to 8-bit)
	let decoded16Bit = null;
	if (!hasFloat32Data) {
		const isPNG = file.type === 'image/png' || file.name?.toLowerCase().endsWith('.png');
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
		}
	}

	const img = new Image();
	img.onload = function() {
		canvas.value.width = img.width;
		canvas.value.height = img.height;
		// Use willReadFrequently for better performance with getImageData
		ctx = canvas.value.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(img, 0, 0);

		initCanvas = canvas;
		initCanvasImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
		gainedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
		preNoiseReducedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
		sharpenedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);

		// Initialize 16-bit image container
		if (hasFloat32Data) {
			// Use Float32Array directly from stacking (full precision preserved)
			image16 = Image16.fromFloat32Array(props.float32Data, props.imageDimensions.width, props.imageDimensions.height);
			console.log('16-bit image initialized from stacking data:', props.imageDimensions.width, 'x', props.imageDimensions.height);
		} else if (decoded16Bit) {
			// Use decoded 16-bit PNG data (full precision preserved)
			image16 = Image16.fromFloat32Array(decoded16Bit.data, decoded16Bit.width, decoded16Bit.height);
			console.log('16-bit image initialized from PNG file:', decoded16Bit.width, 'x', decoded16Bit.height);
		} else {
			// Upscale from 8-bit (fallback for direct file uploads)
			image16 = Image16.fromImageData(initCanvasImageData);
			console.log('8-bit image loaded:', img.width, 'x', img.height);
		}
		sharpenedImage16 = null;

		// Initialize WebGL2 for 16-bit processing (preferred)
		useWebGL2 = initWebGL2(img.width, img.height);
		if (useWebGL2) {
			console.log('WebGL2 acceleration enabled for 16-bit color adjustments');
		} else {
			console.log('WebGL2 not available, falling back to WebGL1/CPU');
		}

		// Initialize WebGL1 for legacy/fallback processing
		useWebGL = initWebGL(img.width, img.height);
		if (useWebGL && !useWebGL2) {
			console.log('WebGL1 acceleration enabled for 8-bit color adjustments');
		} else if (!useWebGL && !useWebGL2) {
			console.log('Using CPU for color adjustments');
		}

		isLoadingImage.value = false;

		// Center the canvas in its container
		nextTick(() => {
			zoomableCanvasRef.value?.centerCanvas();
		});

		// give a small processing improvement
		applyProcessing();

	};
	img.src = URL.createObjectURL(file);
}

// Apply gain, contrast, gamma, saturation, and vibrance in a single pass for efficiency
function applyColorAdjustments(sourceData, width, height, gainVal, contrastVal, gammaVal, saturationVal, vibranceVal) {
	const data = sourceData.data;
	const newData = new Uint8ClampedArray(data.length);

	// Precompute gamma LUT for performance
	const gammaLUT = new Uint8Array(256);
	const invGamma = 1 / gammaVal;
	for (let i = 0; i < 256; i++) {
		gammaLUT[i] = Math.round(Math.pow(i / 255, invGamma) * 255);
	}

	for (let i = 0; i < data.length; i += 4) {
		let r = data[i];
		let g = data[i + 1];
		let b = data[i + 2];

		// Apply gain
		r *= gainVal;
		g *= gainVal;
		b *= gainVal;

		// Apply contrast: (value - 128) * contrast + 128
		r = (r - 128) * contrastVal + 128;
		g = (g - 128) * contrastVal + 128;
		b = (b - 128) * contrastVal + 128;

		// Clamp before gamma (need valid 0-255 range for LUT)
		r = Math.max(0, Math.min(255, r));
		g = Math.max(0, Math.min(255, g));
		b = Math.max(0, Math.min(255, b));

		// Apply gamma using LUT
		r = gammaLUT[Math.round(r)];
		g = gammaLUT[Math.round(g)];
		b = gammaLUT[Math.round(b)];

		// Apply saturation
		// Luminance (Rec. 709)
		const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		r = lum + saturationVal * (r - lum);
		g = lum + saturationVal * (g - lum);
		b = lum + saturationVal * (b - lum);

		// Apply vibrance (saturation that affects less-saturated colors more)
		if (vibranceVal !== 0) {
			const maxC = Math.max(r, g, b);
			const minC = Math.min(r, g, b);
			const currentSat = maxC > 0 ? (maxC - minC) / maxC : 0;
			// Less saturated colors get more boost
			const vibranceAmount = vibranceVal * (1 - currentSat);
			const lum2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			r = r + (r - lum2) * vibranceAmount;
			g = g + (g - lum2) * vibranceAmount;
			b = b + (b - lum2) * vibranceAmount;
		}

		// Final clamp
		newData[i] = Math.max(0, Math.min(255, r));
		newData[i + 1] = Math.max(0, Math.min(255, g));
		newData[i + 2] = Math.max(0, Math.min(255, b));
		newData[i + 3] = data[i + 3]; // Alpha unchanged
	}

	return new ImageData(newData, width, height);
}

// Apply color adjustments in 16-bit (Float32Array, 0.0-1.0 range)
function applyColorAdjustments16(data, width, height, gainVal, contrastVal, gammaVal, saturationVal, vibranceVal) {
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

		// Apply contrast: (value - 0.5) * contrast + 0.5
		r = (r - 0.5) * contrastVal + 0.5;
		g = (g - 0.5) * contrastVal + 0.5;
		b = (b - 0.5) * contrastVal + 0.5;

		// Clamp before gamma (need positive values for pow)
		r = Math.max(0, r);
		g = Math.max(0, g);
		b = Math.max(0, b);

		// Apply gamma
		r = Math.pow(r, invGamma);
		g = Math.pow(g, invGamma);
		b = Math.pow(b, invGamma);

		// Apply saturation
		// Luminance (Rec. 709)
		const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		r = lum + saturationVal * (r - lum);
		g = lum + saturationVal * (g - lum);
		b = lum + saturationVal * (b - lum);

		// Apply vibrance (saturation that affects less-saturated colors more)
		if (vibranceVal !== 0) {
			const maxC = Math.max(r, g, b);
			const minC = Math.min(r, g, b);
			const currentSat = maxC > 0 ? (maxC - minC) / maxC : 0;
			const vibranceAmount = vibranceVal * (1 - currentSat);
			const lum2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			r = r + (r - lum2) * vibranceAmount;
			g = g + (g - lum2) * vibranceAmount;
			b = b + (b - lum2) * vibranceAmount;
		}

		// Final clamp to 0-1
		newData[idx] = Math.max(0, Math.min(1, r));
		newData[idx + 1] = Math.max(0, Math.min(1, g));
		newData[idx + 2] = Math.max(0, Math.min(1, b));
		newData[idx + 3] = data[idx + 3]; // Alpha unchanged
	}

	return newData;
}

// Apply color adjustments using WebGL or CPU
function doColorAdjustments(sourceData) {
	if (useWebGL) {
		const webglResult = processWithWebGL(
			sourceData,
			gain.value,
			contrast.value,
			gamma.value,
			saturation.value,
			vibrance.value
		);
		if (webglResult) return webglResult;
	}
	// Fallback to CPU
	return applyColorAdjustments(
		sourceData,
		canvas.value.width,
		canvas.value.height,
		gain.value,
		contrast.value,
		gamma.value,
		saturation.value,
		vibrance.value
	);
}

// Debounced processing - waits for user to stop dragging before heavy processing
const applyProcessingInternal = async() => {
	console.log('applyProcessing', use16bit.value ? '(16-bit)' : '(8-bit)');
	isProcessing.value = true;

	const width = canvas.value.width;
	const height = canvas.value.height;

	// Choose processing path based on 16-bit mode
	if (use16bit.value && image16) {
		// ==================== 16-BIT PROCESSING PATH ====================
		let workingData = new Float32Array(image16.data); // Copy for processing

		// STEP 1: Sharpening (based on selected method)
		if (sharpeningMethod.value === 'usm' && usmAmount.value > 0) {
			console.log(`USM 16-bit (radius=${usmRadius.value}, amount=${usmAmount.value}%, threshold=${usmThreshold.value})`);
			try {
				workingData = await usmSharpenInWorker16(
					workingData,
					width,
					height,
					parseFloat(usmRadius.value),
					parseFloat(usmAmount.value),
					parseFloat(usmThreshold.value)
				);
			} catch (e) {
				console.log('USM rejected (newer task running)');
				isProcessing.value = false;
				return;
			}
		} else if (sharpeningMethod.value === 'deconv' && deconvRadius.value > 0 && deconvIterations.value > 0) {
			console.log(`deconvolution 16-bit (PSF=${deconvRadius.value}, iterations=${deconvIterations.value})`);
			try {
				workingData = await deconvolveInWorker16(
					workingData,
					width,
					height,
					parseFloat(deconvRadius.value),
					parseInt(deconvIterations.value)
				);
			} catch (e) {
				console.log('Deconvolution rejected (newer task running)');
				isProcessing.value = false;
				return;
			}
		} else if (sharpeningMethod.value === 'wavelets' && waveletsAmount.value > 0) {
			console.log('wavelets 16-bit');
			try {
				workingData = await waveletSharpenInWorker16(
					workingData,
					width,
					height,
					parseFloat(waveletsAmount.value),
					parseFloat(waveletsRadius.value)
				);
			} catch (e) {
				console.log('Recent sharpening rejected because newer task is doing work');
				isProcessing.value = false;
				return;
			}
		}

		// STEP 2: Apply color adjustments (WebGL2 16-bit or CPU)
		if (useWebGL2) {
			console.log('color adjustments (WebGL2 16-bit)');
			const colorResult = processWithWebGL2(
				workingData,
				width,
				height,
				gain.value,
				contrast.value,
				gamma.value,
				saturation.value,
				vibrance.value
			);
			if (colorResult) {
				workingData = colorResult;
			} else {
				// Fallback to CPU 16-bit color adjustments
				console.log('WebGL2 failed, using CPU 16-bit');
				workingData = applyColorAdjustments16(workingData, width, height, gain.value, contrast.value, gamma.value, saturation.value, vibrance.value);
			}
		} else {
			console.log('color adjustments (CPU 16-bit)');
			workingData = applyColorAdjustments16(workingData, width, height, gain.value, contrast.value, gamma.value, saturation.value, vibrance.value);
		}

		// STEP 3: Noise reduction (only with wavelets) - WebGL2 Gaussian blur
		if (sharpeningMethod.value === 'wavelets' && postNoiseReduction.value >= 3) {
			const ksize = parseInt(postNoiseReduction.value, 10) | 1;
			console.log('noise reduction (WebGL2, kernel=' + ksize + ')');
			const blurResult = blurWithWebGL2(workingData, width, height, ksize);
			if (blurResult) {
				workingData = blurResult;
			} else {
				console.warn('WebGL2 blur failed, skipping noise reduction');
			}
		}

		// Store 16-bit result
		sharpenedImage16 = Image16.fromFloat32Array(workingData, width, height);

		// Convert to 8-bit for display
		sharpenedImageData = sharpenedImage16.toImageData();
		ctx.putImageData(sharpenedImageData, 0, 0);

	} else {
		// ==================== 8-BIT PROCESSING PATH (LEGACY) ====================
		let workingImage = initCanvasImageData;

		// STEP 1: Sharpening (based on selected method)
		if (sharpeningMethod.value === 'usm' && usmAmount.value > 0) {
			console.log(`USM (radius=${usmRadius.value}, amount=${usmAmount.value}%, threshold=${usmThreshold.value})`);
			try {
				workingImage = await usmSharpenInWorker(
					workingImage,
					parseFloat(usmRadius.value),
					parseFloat(usmAmount.value),
					parseFloat(usmThreshold.value)
				);
			} catch (e) {
				console.log('USM rejected (newer task running)');
				isProcessing.value = false;
				return;
			}
		} else if (sharpeningMethod.value === 'deconv' && deconvRadius.value > 0 && deconvIterations.value > 0) {
			console.log(`deconvolution (PSF=${deconvRadius.value}, iterations=${deconvIterations.value})`);
			try {
				workingImage = await deconvolveInWorker(workingImage, parseFloat(deconvRadius.value), parseInt(deconvIterations.value));
			} catch (e) {
				console.log('Deconvolution rejected (newer task running)');
				isProcessing.value = false;
				return;
			}
		} else if (sharpeningMethod.value === 'wavelets' && waveletsAmount.value > 0) {
			console.log('wavelets');
			try {
				workingImage = await waveletSharpenInWorker(
					workingImage,
					parseFloat(waveletsAmount.value),
					parseFloat(waveletsRadius.value)
				);
			} catch (e) {
				console.log('Recent sharpening rejected because newer task is doing work');
				isProcessing.value = false;
				return;
			}
		}

		// STEP 2: Apply color adjustments
		console.log('color adjustments', useWebGL ? '(WebGL)' : '(CPU)');
		workingImage = doColorAdjustments(workingImage);

		// STEP 3: Noise reduction (only with wavelets) - WebGL2 Gaussian blur
		if (sharpeningMethod.value === 'wavelets' && postNoiseReduction.value >= 3) {
			const ksize = parseInt(postNoiseReduction.value, 10) | 1;
			console.log('noise reduction (WebGL2, kernel=' + ksize + ')');
			// Convert ImageData to Float32Array for WebGL2
			const floatData = new Float32Array(workingImage.width * workingImage.height * 4);
			for (let i = 0; i < workingImage.data.length; i++) {
				floatData[i] = workingImage.data[i] / 255.0;
			}
			const blurResult = blurWithWebGL2(floatData, workingImage.width, workingImage.height, ksize);
			if (blurResult) {
				// Convert back to ImageData
				const pixels = new Uint8ClampedArray(blurResult.length);
				for (let i = 0; i < blurResult.length; i++) {
					pixels[i] = Math.round(Math.max(0, Math.min(1, blurResult[i])) * 255);
				}
				workingImage = new ImageData(pixels, workingImage.width, workingImage.height);
			} else {
				console.warn('WebGL2 blur failed, skipping noise reduction');
			}
		}

		// Store and display result
		sharpenedImageData = workingImage;
		sharpenedImage16 = null; // No 16-bit data in 8-bit mode
		ctx.putImageData(sharpenedImageData, 0, 0);
	}

	// Reapply chromatic aberration corrections
	redoChromaticAberration();

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

let currentTaskId = 0;
let lastReturnedTaskId = 0;
function waveletSharpenInWorker(imageData, amount, radius){
	const width = imageData.width
	const height = imageData.height;
	currentTaskId++;
	const workerId = currentTaskId % waveletWorkers.length;

	return new Promise((resolve, reject) => {

		function handleWorkerMsg(e){
			const { imageData, taskId } = e.data;

			waveletWorkers[workerId].removeEventListener('message', handleWorkerMsg)

			if( currentTaskId == taskId || taskId > lastReturnedTaskId ){
				lastReturnedTaskId = taskId;
				resolve(imageData);
			} else {
				console.log('reject', currentTaskId, taskId);
				reject();
			}
		}

		waveletWorkers[workerId].addEventListener('message', handleWorkerMsg);

		// Create a copy for transfer (original imageData needs to stay intact)
		const dataCopy = new Uint8ClampedArray(imageData.data);
		waveletWorkers[workerId].postMessage(
			{ imageData: dataCopy, width, height, amount, radius, taskId: currentTaskId },
			[dataCopy.buffer] // Transfer the buffer for zero-copy
		);
	});
}

let usmTaskId = 0;
let lastUsmTaskId = 0;
function usmSharpenInWorker(imageData, radius, amount, threshold) {
	const width = imageData.width;
	const height = imageData.height;
	usmTaskId++;
	const currentTask = usmTaskId;

	return new Promise((resolve, reject) => {
		function handleWorkerMsg(e) {
			const { imageData: resultData, taskId } = e.data;
			usmWorker.removeEventListener('message', handleWorkerMsg);

			if (currentTask === taskId || taskId > lastUsmTaskId) {
				lastUsmTaskId = taskId;
				resolve(new ImageData(resultData, width, height));
			} else {
				reject(new Error('USM task superseded'));
			}
		}

		usmWorker.addEventListener('message', handleWorkerMsg);

		// Create a copy for transfer
		const dataCopy = new Uint8ClampedArray(imageData.data);
		usmWorker.postMessage(
			{ imageData: dataCopy, width, height, radius, amount, threshold, taskId: currentTask },
			[dataCopy.buffer]
		);
	});
}

// 16-bit wavelet sharpening worker wrapper
let currentTaskId16 = 0;
let lastReturnedTaskId16 = 0;
function waveletSharpenInWorker16(data, width, height, amount, radius) {
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
			{ imageData: dataCopy, width, height, amount, radius, taskId: currentTask, is16bit: true }
		);
	});
}

// 16-bit USM sharpening worker wrapper
let usmTaskId16 = 0;
let lastUsmTaskId16 = 0;
function usmSharpenInWorker16(data, width, height, radius, amount, threshold) {
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
			{ imageData: dataCopy, width, height, radius, amount, threshold, taskId: currentTask, is16bit: true }
		);
	});
}

let fixedAberration = reactive({});

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

	const sel = cropSelection.value;

	// Save current state for undo
	preCropImageData = new ImageData(
		new Uint8ClampedArray(initCanvasImageData.data),
		initCanvasImageData.width,
		initCanvasImageData.height
	);
	canUndoCrop.value = true;

	// Extract cropped region from original image data
	const croppedData = new Uint8ClampedArray(sel.width * sel.height * 4);

	for (let y = 0; y < sel.height; y++) {
		for (let x = 0; x < sel.width; x++) {
			const srcIdx = ((sel.y + y) * initCanvasImageData.width + (sel.x + x)) * 4;
			const dstIdx = (y * sel.width + x) * 4;
			croppedData[dstIdx] = initCanvasImageData.data[srcIdx];
			croppedData[dstIdx + 1] = initCanvasImageData.data[srcIdx + 1];
			croppedData[dstIdx + 2] = initCanvasImageData.data[srcIdx + 2];
			croppedData[dstIdx + 3] = initCanvasImageData.data[srcIdx + 3];
		}
	}

	// Update canvas size
	canvas.value.width = sel.width;
	canvas.value.height = sel.height;

	// Update all image data references
	initCanvasImageData = new ImageData(croppedData, sel.width, sel.height);
	gainedImageData = new ImageData(sel.width, sel.height);
	preNoiseReducedImageData = new ImageData(sel.width, sel.height);
	sharpenedImageData = new ImageData(sel.width, sel.height);

	// Update 16-bit image container
	image16 = Image16.fromImageData(initCanvasImageData);
	sharpenedImage16 = null;

	// Clear caches
	prevValues = {};
	fixedAberration = reactive({});

	// Reinitialize WebGL/WebGL2 for new dimensions
	useWebGL2 = initWebGL2(sel.width, sel.height);
	useWebGL = initWebGL(sel.width, sel.height);

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

	// Reprocess with new dimensions
	applyProcessing();
}

function undoCrop() {
	if (!preCropImageData) return;

	// Restore canvas size
	canvas.value.width = preCropImageData.width;
	canvas.value.height = preCropImageData.height;

	// Restore image data
	initCanvasImageData = preCropImageData;
	gainedImageData = new ImageData(preCropImageData.width, preCropImageData.height);
	preNoiseReducedImageData = new ImageData(preCropImageData.width, preCropImageData.height);
	sharpenedImageData = new ImageData(preCropImageData.width, preCropImageData.height);

	// Restore 16-bit image container
	image16 = Image16.fromImageData(initCanvasImageData);
	sharpenedImage16 = null;

	// Clear only the sharpening cache (not settings)

	// Force reprocess by clearing only dimension-related cached values
	delete prevValues.gain;
	delete prevValues.contrast;
	delete prevValues.gamma;
	delete prevValues.saturation;
	delete prevValues.waveletsAmount;
	delete prevValues.waveletsRadius;
	delete prevValues.usmRadius;
	delete prevValues.usmAmount;
	delete prevValues.usmThreshold;

	preCropImageData = null;
	canUndoCrop.value = false;

	// Reinitialize WebGL/WebGL2 for restored dimensions
	useWebGL2 = initWebGL2(canvas.value.width, canvas.value.height);
	useWebGL = initWebGL(canvas.value.width, canvas.value.height);

	// Reprocess with current settings
	applyProcessing();
}

// Rotation functions
function rotateImageData(imageData, angleDegrees) {
	const angleRad = angleDegrees * Math.PI / 180;

	const width = imageData.width;
	const height = imageData.height;

	// Create temp canvas with old image
	const srcCanvas = document.createElement('canvas');
	srcCanvas.width = width;
	srcCanvas.height = height;
	const srcCtx = srcCanvas.getContext('2d');
	srcCtx.putImageData(imageData, 0, 0);

	// Create rotated canvas (same size - corners will be clipped)
	const rotatedCanvas = document.createElement('canvas');
	rotatedCanvas.width = width;
	rotatedCanvas.height = height;
	const rotatedCtx = rotatedCanvas.getContext('2d');

	// Fill with black background
	rotatedCtx.fillStyle = '#000000';
	rotatedCtx.fillRect(0, 0, width, height);

	// Rotate around center
	rotatedCtx.translate(width / 2, height / 2);
	rotatedCtx.rotate(angleRad);
	rotatedCtx.drawImage(srcCanvas, -width / 2, -height / 2);

	return rotatedCtx.getImageData(0, 0, width, height);
}

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

	// Save backup before first rotation
	if (!preRotationImageData) {
		preRotationImageData = new ImageData(
			new Uint8ClampedArray(initCanvasImageData.data),
			initCanvasImageData.width,
			initCanvasImageData.height
		);
	}

	// Rotate from the original backup (not current state - avoids accumulated interpolation)
	const rotatedData = rotateImageData(preRotationImageData, rotation.value);

	// Update canvas size
	canvas.value.width = rotatedData.width;
	canvas.value.height = rotatedData.height;

	// Update all image data references
	initCanvasImageData = rotatedData;
	gainedImageData = new ImageData(rotatedData.width, rotatedData.height);
	preNoiseReducedImageData = new ImageData(rotatedData.width, rotatedData.height);
	sharpenedImageData = new ImageData(rotatedData.width, rotatedData.height);

	// Update 16-bit image container
	image16 = Image16.fromImageData(initCanvasImageData);
	sharpenedImage16 = null;

	// Clear caches
	prevValues = {};
	fixedAberration = reactive({});

	// Reinitialize WebGL/WebGL2 for new dimensions
	useWebGL2 = initWebGL2(rotatedData.width, rotatedData.height);
	useWebGL = initWebGL(rotatedData.width, rotatedData.height);

	hasAppliedRotation.value = true;
	appliedRotation = rotation.value;

	// Reprocess with current settings
	applyProcessing();

	// Clear CSS preview after pixels are rotated
	previewRotationAngle.value = 0;
}

function resetRotation() {
	// Clear CSS preview
	previewRotationAngle.value = 0;

	if (!preRotationImageData) {
		rotation.value = 0;
		appliedRotation = 0;
		return;
	}

	// Restore from backup
	canvas.value.width = preRotationImageData.width;
	canvas.value.height = preRotationImageData.height;

	initCanvasImageData = new ImageData(
		new Uint8ClampedArray(preRotationImageData.data),
		preRotationImageData.width,
		preRotationImageData.height
	);
	gainedImageData = new ImageData(preRotationImageData.width, preRotationImageData.height);
	preNoiseReducedImageData = new ImageData(preRotationImageData.width, preRotationImageData.height);
	sharpenedImageData = new ImageData(preRotationImageData.width, preRotationImageData.height);

	// Restore 16-bit image container
	image16 = Image16.fromImageData(initCanvasImageData);
	sharpenedImage16 = null;

	// Clear caches
	prevValues = {};
	fixedAberration = reactive({});

	// Clear backup and reset values
	preRotationImageData = null;
	rotation.value = 0;
	appliedRotation = 0;
	hasAppliedRotation.value = false;

	// Reinitialize WebGL/WebGL2 for original dimensions
	useWebGL2 = initWebGL2(canvas.value.width, canvas.value.height);
	useWebGL = initWebGL(canvas.value.width, canvas.value.height);

	// Reprocess with current settings
	applyProcessing();
}

function processChromaticAberration(channel, axis, magnitude){
	fixChromaticAberration(canvas.value, channel, axis, magnitude);

	if( fixedAberration[channel] == undefined ){
		fixedAberration[channel] = reactive({});
	}

	if( fixedAberration[channel][axis] == undefined ){
		fixedAberration[channel][axis] = 0;
	}

	fixedAberration[channel][axis] += magnitude;
}

function redoChromaticAberration(){
	for( const channel in fixedAberration ){
		for( const axis in fixedAberration[channel] ){
			fixChromaticAberration(canvas.value, channel, axis, fixedAberration[channel][axis])
		}
	}
}

function resetRGBAlignment() {
	fixedAberration.red = undefined;
	fixedAberration.blue = undefined;
	applyProcessing();
}

// Auto-detect RGB alignment using cross-correlation
async function autoAlignRGB() {
	if (!sharpenedImageData) return;

	isAutoAligning.value = true;

	// Use setTimeout to allow UI to update
	await new Promise(resolve => setTimeout(resolve, 10));

	try {
		const width = sharpenedImageData.width;
		const height = sharpenedImageData.height;
		const data = sharpenedImageData.data;

		// Extract channels
		const red = new Float32Array(width * height);
		const green = new Float32Array(width * height);
		const blue = new Float32Array(width * height);

		for (let i = 0; i < width * height; i++) {
			red[i] = data[i * 4];
			green[i] = data[i * 4 + 1];
			blue[i] = data[i * 4 + 2];
		}

		// Find offset using cross-correlation (green is reference)
		const redOffset = findChannelOffset(green, red, width, height);
		const blueOffset = findChannelOffset(green, blue, width, height);

		console.log('Auto-detected offsets:', { red: redOffset, blue: blueOffset });

		// Reset existing alignment
		fixedAberration.red = undefined;
		fixedAberration.blue = undefined;

		// Apply detected offsets (negated - correlation finds where channel IS, we need to shift it BACK)
		if (redOffset.x !== 0 || redOffset.y !== 0) {
			fixedAberration.red = reactive({ x: -redOffset.x, y: -redOffset.y });
		}
		if (blueOffset.x !== 0 || blueOffset.y !== 0) {
			fixedAberration.blue = reactive({ x: -blueOffset.x, y: -blueOffset.y });
		}

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
	for (let dy = bestY - 1; dy <= bestY + 1; dy += 0.5) {
		for (let dx = bestX - 1; dx <= bestX + 1; dx += 0.5) {
			const score = correlationScore(ref, target, width, height, dx, dy);
			if (score > bestScore) {
				bestScore = score;
				bestX = dx;
				bestY = dy;
			}
		}
	}

	// Round to 0.5px
	return {
		x: Math.round(bestX * 2) / 2,
		y: Math.round(bestY * 2) / 2
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

// Sub-pixel chromatic aberration fix using bilinear interpolation
function fixChromaticAberration(canvas, channel, axis, magnitude) {
	const ctx = canvas.getContext('2d');
	const width = canvas.width;
	const height = canvas.height;

	const imageData = ctx.getImageData(0, 0, width, height);
	const data = imageData.data;
	const originalData = new Uint8ClampedArray(data);

	const channelIndexes = { 'red': 0, 'green': 1, 'blue': 2 };
	const channelIndex = channelIndexes[channel];
	if (channelIndex === undefined) return;

	// Calculate offset
	const offsetX = axis === 'x' ? -magnitude : 0;
	const offsetY = axis === 'y' ? -magnitude : 0;

	// Check if we need sub-pixel interpolation
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

				// Bounds check
				if (x0 >= 0 && x1 < width && y0 >= 0 && y1 < height) {
					const v00 = originalData[(y0 * width + x0) * 4 + channelIndex];
					const v01 = originalData[(y0 * width + x1) * 4 + channelIndex];
					const v10 = originalData[(y1 * width + x0) * 4 + channelIndex];
					const v11 = originalData[(y1 * width + x1) * 4 + channelIndex];

					const val = v00 * (1 - fx) * (1 - fy) +
					            v01 * fx * (1 - fy) +
					            v10 * (1 - fx) * fy +
					            v11 * fx * fy;

					data[dstIdx] = Math.round(val);
				}
			} else {
				// Integer offset - direct lookup
				const srcXi = Math.round(srcX);
				const srcYi = Math.round(srcY);

				if (srcXi >= 0 && srcXi < width && srcYi >= 0 && srcYi < height) {
					data[dstIdx] = originalData[(srcYi * width + srcXi) * 4 + channelIndex];
				}
			}
		}
	}

	ctx.putImageData(imageData, 0, 0);
}



</script>

<style scoped>
canvas {

}
.content {
	max-width: none;
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
.auto-align-btn {
	font-size: 11px;
	padding: 2px 8px;
	min-width: auto !important;
	background-color: #8CCF7E;
	border: none;
	border-radius: 3px;
	cursor: pointer;
}
.auto-align-btn:disabled {
	background-color: #ccc;
	cursor: wait;
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
}
.crop-controls .apply-crop {
	background-color: #8CCF7E;
	color: #111;
}
.crop-controls .apply-crop:disabled {
	background-color: #ccc;
	cursor: not-allowed;
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
.sharpening-frame {
	border: 2px groove #ccc;
	border-radius: 4px;
	padding: 10px;
	margin: 10px 0;
}
.sharpening-frame legend {
	font-weight: bold;
	color: #333;
	padding: 0 6px;
}
.sharpening-tabs {
	display: flex;
	gap: 0;
	margin-bottom: 10px;
	border-radius: 4px;
	overflow: hidden;
	border: 1px solid #ccc;
}
.sharpening-tabs button {
	flex: 1;
	padding: 6px 10px;
	border: none;
	background-color: #e8e8e8;
	color: #555;
	cursor: pointer;
	font-size: 12px;
	transition: background-color 0.2s;
}
.sharpening-tabs button:not(:last-child) {
	border-right: 1px solid #ccc;
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
button.download {
	display: block;
	margin-bottom: 8px;
	background-color: #8CCF7E;
	color: #111;
}
button.download:hover {
	background-color: #7ABF6E;
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
.export-btn {
	background-color: #8CCF7E;
	color: #111;
	padding: 8px 16px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-weight: bold;
	font-size: 14px;
}
.export-btn:hover {
	background-color: #7ABF6E;
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
.export-popup-footer {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 10px;
	padding-top: 15px;
	border-top: 1px solid #eee;
}
.feedback-cta {
	background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
	border: none;
	color: white;
	cursor: pointer;
	font-size: 13px;
	padding: 10px 16px;
	border-radius: 5px;
	font-weight: bold;
	flex: 1;
}
.feedback-cta:hover {
	opacity: 0.9;
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

.empty-state {
	text-align: center;
	padding: 40px 20px;
}

.empty-state-buttons {
	display: flex;
	flex-direction: column;
	gap: 12px;
	margin-top: 24px;
	align-items: center;
}

.empty-state-buttons .primary-btn {
	background-color: #8CCF7E;
	color: #111;
	padding: 12px 24px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
}

.empty-state-buttons .primary-btn:hover {
	background-color: #7ABF6E;
}

.empty-state-buttons .secondary-btn {
	display: inline-block;
	background-color: transparent;
	color: #c6fffd;
	padding: 10px 20px;
	border: 1px solid #c6fffd;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
	text-decoration: none;
}

.empty-state-buttons .secondary-btn:hover {
	background-color: rgba(198, 255, 253, 0.1);
}

.feature-list {
	margin-top: 32px;
	text-align: left;
	max-width: 500px;
}

.feature-list h4 {
	margin-bottom: 12px;
}

.feature-list ul {
	list-style: none;
	padding: 0;
	margin: 0;
}

.feature-list li {
	padding: 6px 0;
	font-size: 14px;
}
</style>


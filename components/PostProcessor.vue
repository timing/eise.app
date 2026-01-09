<template>
<div>
	<div class="card">
		<div class="controls">
			<h4>Color Adjustments</h4>
			<div>
				<label>Gain:</label>
				<input type="range" min="0.5" max="2" step="0.01" v-model="gain" @input="applyProcessing"/>
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

			<div class="mode-toggle">
				<label>
					<input type="checkbox" v-model="fastColorMode" @change="applyProcessing"/>
					Fast color mode
				</label>
				<span class="mode-hint">{{ fastColorMode ? '(colors applied after sharpening - faster)' : '(colors applied before sharpening - higher quality)' }}</span>
			</div>

			<h4>Sharpening</h4>

			<div class="sharpening-subsection">
				<h5>Wavelets</h5>
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
			</div>

			<div class="sharpening-subsection">
				<h5>Deconvolution (Richardson-Lucy)</h5>
				<div>
					<label>PSF Radius:</label>
					<input type="range" min="0" max="10" step="0.1" v-model="deconvRadius" @input="applyProcessing"/>
					<span>{{ deconvRadius }}</span>
				</div>
				<div>
					<label>Iterations:</label>
					<input type="range" min="0" max="50" step="1" v-model="deconvIterations" @input="applyProcessing"/>
					<span>{{ deconvIterations }}</span>
				</div>
			</div>

			<div class="sharpening-subsection">
				<h5>Noise Reduction</h5>
				<div>
					<label>Amount:</label>
					<input type="range" min="0" max="50" step="1" v-model="postNoiseReduction" @input="applyProcessing"/>
					<span>{{ postNoiseReduction > 0 ? postNoiseReduction : 'Off' }}</span>
				</div>
			</div>

			<div class="color-alignment">
			
				<h4 style="color:blue;">Blue color alignment</h4>

				<button @click="processChromaticAberration('blue', 'y', -1)">↑ 
					{{ fixedAberration.blue?.y < 0 ? Math.abs(fixedAberration.blue.y) : '' }}
				</button>
				<button @click="processChromaticAberration('blue', 'y', 1)">↓ 
					{{ fixedAberration.blue?.y > 0 ? fixedAberration.blue.y : '' }}
				</button>
				<button @click="processChromaticAberration('blue', 'x', -1)">← 
					{{ fixedAberration.blue?.x < 0 ? Math.abs(fixedAberration.blue.x) : '' }}
				</button>
				<button @click="processChromaticAberration('blue', 'x', 1)">→ 
					{{ fixedAberration.blue?.x > 0 ? fixedAberration.blue.x : '' }}
				</button>
				
				<h4 style="color:red;">Red color alignment</h4>

				<button @click="processChromaticAberration('red', 'y', -1)">↑ 
					{{ fixedAberration.red?.y < 0 ? Math.abs(fixedAberration.red.y) : '' }}
				</button>
				<button @click="processChromaticAberration('red', 'y', 1)">↓ 
					{{ fixedAberration.red?.y > 0 ? fixedAberration.red.y : '' }}
				</button>
				<button @click="processChromaticAberration('red', 'x', -1)">← 
					{{ fixedAberration.red?.x < 0 ? Math.abs(fixedAberration.red.x) : '' }}
				</button>
				<button @click="processChromaticAberration('red', 'x', 1)">→ 
					{{ fixedAberration.red?.x > 0 ? fixedAberration.red.x : '' }}
				</button>

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

			<h4>Save lossless image</h4>

			<button class="download" @click="downloadCanvasAsPNG">Save / Download as PNG</button>

		</div>
	</div>
	<div class="content">
		<div v-if="!props.file">
			<h2>Nothing loaded yet</h2>
			<p>Please upload a video (or bunch of files) for analyzing and stacking frames. Upload one image file for direct post processing.</p>
		</div>
		<ZoomableCanvas v-else id="postProcessCanvas" @canvasReady="handleCanvasReady" :disableDrag="cropMode" />
	</div>

</div>
</template>

<script setup>
import { ref, onMounted, watch, defineProps, reactive, onUnmounted } from 'vue';
import debounce from 'lodash/debounce';
import { adjustGain, adjustGainMultiply, cvMatToImageData } from '@/utils/sobel.js'
import { initWebGL, processWithWebGL, isWebGLAvailable, disposeWebGL } from '@/utils/webglProcessor.js'
import ZoomableCanvas from '@/components/ZoomableCanvas.vue';

const { $loadOpenCV } = useNuxtApp();

let canvas;
let opencvLoaded = false;
let useWebGL = false;

const handleCanvasReady = (canvasRef) => {
	// canvasRef is the direct ref to the canvas element
	console.log('Canvas is ready:', canvasRef);
	canvas = canvasRef;
	// You can now use canvasRef.value to access the canvas element directly
};

const downloadCanvasAsPNG = () => {
	if (!canvas) return;

	const dataURL = canvas.value.toDataURL('image/png');
	const link = document.createElement('a');
	link.download = 'eise_app_stacked_pps.png';
	link.href = dataURL;
	document.body.appendChild(link); // Required for Firefox
	link.click();
	document.body.removeChild(link);
};

let waveletWorkers = null;
let workersInitialized = false;

function initializeWorkers() {
	if (workersInitialized) return;
	workersInitialized = true;

	console.log('Lazy-loading wavelet workers for post-processing');
	waveletWorkers = new Array(8);
	for (let i = 0; i < waveletWorkers.length; i++) {
		waveletWorkers[i] = new Worker('/wavelet_worker.js', {type: 'module'});
		waveletWorkers[i].onerror = (e) => { console.error(e); };
	}
}

const props = defineProps({
	file: Object
});

const gain = ref(1);
const contrast = ref(1);
const gamma = ref(1);
const saturation = ref(1);
const preNoiseReduction = ref(0);
const waveletsRadius = ref(0);
const waveletsAmount = ref(0);
const deconvRadius = ref(0);
const deconvIterations = ref(0);
const bilateralFraction = ref(0.5);
const bilateralRange = ref(50);
const postNoiseReduction = ref(0);
const fastColorMode = ref(true); // Default to fast mode
const blueDown = ref(0);

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
});

onUnmounted(() => {
	disposeWebGL();
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
	// Lazy-load workers when first image is loaded
	initializeWorkers();

	// Lazy-load OpenCV for post-processing effects
	if (!opencvLoaded) {
		await $loadOpenCV();
		opencvLoaded = true;
	}

	console.log(file);

	const img = new Image();
	img.onload = function() {
		canvas.value.width = img.width;
		canvas.value.height = img.height;
		ctx = canvas.value.getContext('2d');
		ctx.drawImage(img, 0, 0);

		initCanvas = canvas;
		initCanvasImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
		gainedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
		preNoiseReducedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
		sharpenedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);

		// Initialize WebGL for accelerated processing
		useWebGL = initWebGL(img.width, img.height);
		if (useWebGL) {
			console.log('WebGL acceleration enabled for color adjustments');
		} else {
			console.log('Using CPU for color adjustments');
		}

		// give a small processing improvement
		applyProcessing();

	};
	img.src = URL.createObjectURL(file);
}

// Apply gain, contrast, gamma, and saturation in a single pass for efficiency
function applyColorAdjustments(sourceData, width, height, gainVal, contrastVal, gammaVal, saturationVal) {
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

		// Final clamp
		newData[i] = Math.max(0, Math.min(255, r));
		newData[i + 1] = Math.max(0, Math.min(255, g));
		newData[i + 2] = Math.max(0, Math.min(255, b));
		newData[i + 3] = data[i + 3]; // Alpha unchanged
	}

	return new ImageData(newData, width, height);
}

// Apply color adjustments using WebGL or CPU
function doColorAdjustments(sourceData) {
	if (useWebGL) {
		const webglResult = processWithWebGL(
			sourceData,
			gain.value,
			contrast.value,
			gamma.value,
			saturation.value
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
		saturation.value
	);
}

// Debounced processing - waits for user to stop dragging before heavy processing
const applyProcessingInternal = async() => {
	console.log('applyProcessing', fastColorMode.value ? '(fast mode)' : '(quality mode)');

	// Start with original image
	let workingImage = initCanvasImageData;

	// STEP 1: Apply colors (in quality mode, colors come first)
	if (!fastColorMode.value) {
		console.log('color adjustments (quality)', useWebGL ? '(WebGL)' : '(CPU)');
		workingImage = doColorAdjustments(workingImage);
	}

	// STEP 2: Deconvolution (if enabled)
	if (deconvRadius.value > 0 && deconvIterations.value > 0) {
		console.log(`deconvolution (PSF=${deconvRadius.value}, iterations=${deconvIterations.value})`);
		workingImage = richardsonLucy(workingImage, parseFloat(deconvRadius.value), parseInt(deconvIterations.value));
	}

	// STEP 3: Wavelet sharpening (if enabled)
	if (waveletsAmount.value > 0) {
		console.log('wavelets');
		try {
			workingImage = await waveletSharpenInWorker(
				workingImage,
				parseFloat(waveletsAmount.value),
				parseFloat(waveletsRadius.value)
			);
		} catch (e) {
			console.log('Recent sharpening rejected because newer task is doing work');
			return;
		}
	}

	// STEP 4: Apply colors (in fast mode, colors come after sharpening)
	if (fastColorMode.value) {
		console.log('color adjustments (fast)', useWebGL ? '(WebGL)' : '(CPU)');
		workingImage = doColorAdjustments(workingImage);
	}

	// STEP 5: Noise reduction (if enabled)
	if (postNoiseReduction.value >= 3) {
		console.log('noise reduction');
		const srcMat = imageDataToMat(workingImage);
		const dstMat = new cv.Mat();
		cv.cvtColor(srcMat, srcMat, cv.COLOR_RGBA2RGB, 0);
		const ksize = parseInt(postNoiseReduction.value, 10) | 1; // Ensure odd
		cv.GaussianBlur(srcMat, dstMat, new cv.Size(ksize, ksize), 0, 0, cv.BORDER_DEFAULT);

		// Convert back to ImageData
		const rgbaMat = new cv.Mat();
		cv.cvtColor(dstMat, rgbaMat, cv.COLOR_RGB2RGBA);
		workingImage = new ImageData(new Uint8ClampedArray(rgbaMat.data), workingImage.width, workingImage.height);

		srcMat.delete();
		dstMat.delete();
		rgbaMat.delete();
	}

	// Store and display result
	sharpenedImageData = workingImage;
	ctx.putImageData(sharpenedImageData, 0, 0);

	// Reapply chromatic aberration corrections
	redoChromaticAberration();
};

// Debounce: wait 50ms after last input before processing (prevents memory buildup)
const applyProcessing = debounce(applyProcessingInternal, 50);

function imageDataToMat(imageData) {
	let mat = new cv.Mat(imageData.height, imageData.width, cv.CV_8UC4);
	mat.data.set(imageData.data);
	return mat;
}

// Richardson-Lucy Deconvolution
function createGaussianPSF(radius) {
	const size = Math.max(3, Math.ceil(radius * 6) | 1); // Ensure odd size
	const psf = new cv.Mat(size, size, cv.CV_32F);
	const center = Math.floor(size / 2);
	const sigma = radius;
	let sum = 0;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = x - center;
			const dy = y - center;
			const value = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
			psf.floatPtr(y, x)[0] = value;
			sum += value;
		}
	}

	// Normalize
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			psf.floatPtr(y, x)[0] /= sum;
		}
	}

	return psf;
}

function richardsonLucy(imageData, psfRadius, iterations) {
	if (psfRadius <= 0 || iterations <= 0) return imageData;

	const width = imageData.width;
	const height = imageData.height;

	// Convert to OpenCV Mat
	const srcMat = imageDataToMat(imageData);
	const rgbMat = new cv.Mat();
	cv.cvtColor(srcMat, rgbMat, cv.COLOR_RGBA2RGB);

	// Convert to float and normalize to 0-1
	const floatMat = new cv.Mat();
	rgbMat.convertTo(floatMat, cv.CV_32FC3, 1/255.0);

	// Create PSF
	const psf = createGaussianPSF(psfRadius);

	// Create flipped PSF for correlation
	const psfFlipped = new cv.Mat();
	cv.flip(psf, psfFlipped, -1);

	// Split into channels
	const channels = new cv.MatVector();
	cv.split(floatMat, channels);

	// Process each channel
	for (let c = 0; c < 3; c++) {
		let estimate = channels.get(c).clone();

		for (let i = 0; i < iterations; i++) {
			// Convolve estimate with PSF
			const blurred = new cv.Mat();
			cv.filter2D(estimate, blurred, cv.CV_32F, psf);

			// Add small epsilon to avoid division by zero
			const epsilon = new cv.Mat(height, width, cv.CV_32F, new cv.Scalar(1e-10));
			cv.add(blurred, epsilon, blurred);

			// Divide observed by blurred
			const ratio = new cv.Mat();
			cv.divide(channels.get(c), blurred, ratio);

			// Convolve ratio with flipped PSF
			const correction = new cv.Mat();
			cv.filter2D(ratio, correction, cv.CV_32F, psfFlipped);

			// Multiply estimate by correction
			cv.multiply(estimate, correction, estimate);

			// Cleanup iteration mats
			blurred.delete();
			epsilon.delete();
			ratio.delete();
			correction.delete();
		}

		// Copy result back
		estimate.copyTo(channels.get(c));
		estimate.delete();
	}

	// Merge channels
	const resultFloat = new cv.Mat();
	cv.merge(channels, resultFloat);

	// Convert back to 8-bit
	const resultMat = new cv.Mat();
	resultFloat.convertTo(resultMat, cv.CV_8UC3, 255.0);

	// Convert to RGBA
	const resultRgba = new cv.Mat();
	cv.cvtColor(resultMat, resultRgba, cv.COLOR_RGB2RGBA);

	// Create output ImageData
	const outputData = new Uint8ClampedArray(resultRgba.data);
	const output = new ImageData(outputData, width, height);

	// Cleanup
	srcMat.delete();
	rgbMat.delete();
	floatMat.delete();
	psf.delete();
	psfFlipped.delete();
	for (let i = 0; i < 3; i++) channels.get(i).delete();
	channels.delete();
	resultFloat.delete();
	resultMat.delete();
	resultRgba.delete();

	return output;
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
			// Get the processed image data from the worker
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

	// Clear caches
		prevValues = {};
	fixedAberration = reactive({});

	// Reinitialize WebGL for new dimensions
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

	// Clear only the sharpening cache (not settings)
	
	// Force reprocess by clearing only dimension-related cached values
	delete prevValues.gain;
	delete prevValues.contrast;
	delete prevValues.gamma;
	delete prevValues.saturation;
	delete prevValues.waveletsAmount;
	delete prevValues.waveletsRadius;

	preCropImageData = null;
	canUndoCrop.value = false;

	// Reinitialize WebGL for restored dimensions
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

function fixChromaticAberration(canvas, channel, axis, magnitude) {
	const ctx = canvas.getContext('2d');
	const width = canvas.width;
	const height = canvas.height;

	// Get the image data
	const imageData = ctx.getImageData(0, 0, width, height);
	const data = imageData.data;

	// Create a copy of the original image data
	const originalData = new Uint8ClampedArray(data);

	for (let i = 0; i < data.length; i += 4) {
		// Calculate the pixel index adjustment based on axis and magnitude
		let indexAdjustment = 0;
		if (axis === 'x') {
			// Moving horizontally
			indexAdjustment = magnitude * -4; // Each pixel is 4 units in data (RGBA)
		} else if (axis === 'y') {
			// Moving vertically
			indexAdjustment = magnitude * width * -4; // Moving a full width's worth of pixels up or down
		}

		// Adjust specified color channels
		const channelIndexes = {
			'red': 0,
			'green': 1,
			'blue': 2
		};
		const channelIndex = channelIndexes[channel] ?? null;

		// Ensure the channelIndex is valid to prevent processing undefined channels
		if (channelIndex !== null && i + channelIndex + indexAdjustment >= 0 && i + channelIndex + indexAdjustment < data.length) {
			data[i + channelIndex] = originalData[i + channelIndex + indexAdjustment];
		}
	}

	// Put the image data back to canvas
	ctx.putImageData(imageData, 0, 0);
}



</script>

<style scoped>
canvas {

}
.content {
	max-width: none;
}
.color-alignment button {
	margin-right: 2px;
	min-width: 66px;
}
.mode-toggle {
	margin: 15px 0;
	padding: 10px;
	background-color: #f5f5f5;
	border-radius: 5px;
}
.mode-toggle label {
	font-weight: bold;
	cursor: pointer;
}
.mode-hint {
	display: block;
	font-size: 11px;
	color: #666;
	margin-top: 4px;
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
	background-color: #4CAF50;
	color: white;
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
.sharpening-subsection {
	margin: 10px 0;
	padding: 10px;
	background-color: #f8f8f8;
	border-radius: 5px;
	border-left: 3px solid #ddd;
}
.sharpening-subsection h5 {
	margin: 0 0 10px 0;
	font-size: 13px;
	color: #555;
}
</style>


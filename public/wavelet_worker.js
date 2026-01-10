/*
	this file is moved to public folder because Vite/Nuxt/Vue whatever tries
	to optimize it by using globalThis.__publicAssetsURL, but then it breaks
*/

// Load OpenCV at top level (same pattern as unified_analyze_worker.js)
self.importScripts('https://cdn.jsdelivr.net/npm/opencv-bindings@4.5.5/index.min.js');

// Use _cv to avoid conflicts with global 'cv'
let _cv = null;

const workers = [];
const channelDataResults = [null, null, null];
let pendingResults = 3; // Expecting 3 results
let globalWidth, globalHeight, globalTaskId, globalType;
let workersInitialized = false;

// Lazy-load sub-workers on first use
function initializeSubWorkers() {
	if (workersInitialized) return;
	workersInitialized = true;

	for (let i = 0; i < 3; i++) {
		workers[i] = new Worker('/sharpen_per_channel_worker.js', {type: 'module'});
		workers[i].addEventListener('message', handleWorkerResponse(i));
	}
}

// Initialize OpenCV reference (must be called before using _cv)
function ensureOpenCV() {
	if (_cv) return;
	if (!self.cv) {
		throw new Error('OpenCV not available');
	}
	_cv = self.cv;
	console.log('OpenCV initialized in wavelet worker');
}

self.addEventListener('message', async (e) => {
	const { type, imageData, width, height, amount, radius, psfRadius, iterations, taskId } = e.data;

	// Store for later use
	globalWidth = width;
	globalHeight = height;
	globalTaskId = taskId;
	globalType = type || 'wavelet';

	if (globalType === 'deconv') {
		// Deconvolution using OpenCV Richardson-Lucy
		try {
			ensureOpenCV();
			const result = runDeconvolution(imageData, width, height, psfRadius, iterations);
			self.postMessage({ imageData: result, taskId: globalTaskId, type: 'deconv' }, [result.data.buffer]);
		} catch (error) {
			console.error('Deconvolution error:', error);
			// Return original on error
			const fallback = new ImageData(new Uint8ClampedArray(imageData), width, height);
			self.postMessage({ imageData: fallback, taskId: globalTaskId, type: 'deconv', error: error.message });
		}
	} else {
		// Wavelet sharpening (existing logic)
		initializeSubWorkers();

		let channelData = extractChannelData(imageData);

		// Send each color channel to its respective worker
		channelData.forEach((channel, index) => {
			workers[index].postMessage({ imageData: channel, width, height, amount, radius });
		});
	}
});

// Richardson-Lucy Deconvolution
function runDeconvolution(imageData, width, height, psfRadius, iterations) {
	console.log(`Running deconvolution: PSF=${psfRadius}, iterations=${iterations}`);

	// Create source mat from imageData (RGBA)
	const srcMat = new _cv.Mat(height, width, _cv.CV_8UC4);
	srcMat.data.set(imageData);

	// Convert to RGB
	const rgbMat = new _cv.Mat();
	_cv.cvtColor(srcMat, rgbMat, _cv.COLOR_RGBA2RGB);

	// Convert to float [0, 1]
	const floatMat = new _cv.Mat();
	rgbMat.convertTo(floatMat, _cv.CV_32FC3, 1/255.0);

	// Create Gaussian PSF
	const psf = createGaussianPSF(psfRadius);
	const psfFlipped = new _cv.Mat();
	_cv.flip(psf, psfFlipped, -1);

	// Split into channels
	const channels = new _cv.MatVector();
	_cv.split(floatMat, channels);

	// Process each channel with Richardson-Lucy
	for (let c = 0; c < 3; c++) {
		const channel = channels.get(c);
		const estimate = channel.clone();

		for (let i = 0; i < iterations; i++) {
			// Convolve estimate with PSF
			const blurred = new _cv.Mat();
			_cv.filter2D(estimate, blurred, _cv.CV_32F, psf);

			// Add epsilon to avoid division by zero
			const epsilon = new _cv.Mat(height, width, _cv.CV_32F, new _cv.Scalar(1e-10));
			_cv.add(blurred, epsilon, blurred);

			// Divide observed by blurred
			const ratio = new _cv.Mat();
			_cv.divide(channel, blurred, ratio);

			// Convolve ratio with flipped PSF
			const correction = new _cv.Mat();
			_cv.filter2D(ratio, correction, _cv.CV_32F, psfFlipped);

			// Multiply estimate by correction
			_cv.multiply(estimate, correction, estimate);

			// Cleanup
			blurred.delete();
			epsilon.delete();
			ratio.delete();
			correction.delete();
		}

		// Copy result back to channel
		estimate.copyTo(channels.get(c));
		estimate.delete();
	}

	// Merge channels
	const resultFloat = new _cv.Mat();
	_cv.merge(channels, resultFloat);

	// Convert back to 8-bit
	const resultMat = new _cv.Mat();
	resultFloat.convertTo(resultMat, _cv.CV_8UC3, 255.0);

	// Convert to RGBA
	const resultRgba = new _cv.Mat();
	_cv.cvtColor(resultMat, resultRgba, _cv.COLOR_RGB2RGBA);

	// Create output ImageData
	const output = new ImageData(new Uint8ClampedArray(resultRgba.data), width, height);

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

	console.log('Deconvolution complete');
	return output;
}

function createGaussianPSF(radius) {
	const size = Math.max(3, Math.ceil(radius * 6) | 1); // Ensure odd
	const psf = new _cv.Mat(size, size, _cv.CV_32F);
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

function handleWorkerResponse(index) {
	return (e) => {
		channelDataResults[index] = e.data;
		pendingResults--;

		// When all channels are processed
		if (pendingResults === 0) {
			const mergedData = new Uint8ClampedArray(mergeChannelsIntoImageData(channelDataResults));
			const imageData = new ImageData(mergedData, globalWidth, globalHeight);
			// Transfer the buffer back for zero-copy
			self.postMessage({ imageData, taskId: globalTaskId, type: 'wavelet' }, [mergedData.buffer]);
			pendingResults = 3; // Reset for next image processing
		}
	};
}

function extractChannelData(data) {
	// Initialize arrays to hold channel data
	let redChannel = [];
	let greenChannel = [];
	let blueChannel = [];

	// Extract each channel
	for (let i = 0; i < data.length; i += 4) {
		redChannel.push(data[i]); // R
		greenChannel.push(data[i + 1]); // G
		blueChannel.push(data[i + 2]); // B
	}

	return [redChannel, greenChannel, blueChannel];
}

function mergeChannelsIntoImageData(channels) {
	const [redChannel, greenChannel, blueChannel] = channels;
	const mergedData = [];

	for (let i = 0; i < redChannel.length; i++) {
		mergedData[i * 4] = redChannel[i]; // R
		mergedData[i * 4 + 1] = greenChannel[i]; // G
		mergedData[i * 4 + 2] = blueChannel[i];	// B
		mergedData[i * 4 + 3] = 255; // Alpha Centauri
	}

	return mergedData;
}

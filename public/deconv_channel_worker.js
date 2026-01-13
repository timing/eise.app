/*
	Dedicated worker for Richardson-Lucy deconvolution on a single channel.
	Runs in parallel with other channel workers for ~3x speedup.
*/

self.importScripts('https://cdn.jsdelivr.net/npm/opencv-bindings@4.5.5/index.min.js');

let _cv = null;
let isCvReady = false;
const messageQueue = [];

// Wait for OpenCV WASM to be ready
function waitForOpenCV(onReady, onError) {
	if (self.cv && typeof self.cv.Mat === 'function') {
		onReady(self.cv);
		return;
	}

	let attempts = 0;
	const maxAttempts = 200; // 20 seconds max
	const checkInterval = setInterval(() => {
		attempts++;
		if (self.cv && typeof self.cv.Mat === 'function') {
			clearInterval(checkInterval);
			onReady(self.cv);
		} else if (attempts >= maxAttempts) {
			clearInterval(checkInterval);
			onError(new Error('OpenCV WASM initialization timeout'));
		}
	}, 100);
}

// Initialize OpenCV on first load
waitForOpenCV(
	(cv) => {
		_cv = cv;
		isCvReady = true;
		console.log('Deconv worker: OpenCV ready');

		// Process any queued messages
		while (messageQueue.length > 0) {
			processMessage(messageQueue.shift());
		}
	},
	(error) => {
		console.error('Deconv worker: OpenCV failed to load', error);
	}
);

self.addEventListener('message', (e) => {
	if (!isCvReady) {
		messageQueue.push(e.data);
		return;
	}
	processMessage(e.data);
});

function processMessage(data) {
	const { channelData, width, height, psfRadius, iterations, channelIndex } = data;

	try {
		const result = processChannel(channelData, width, height, psfRadius, iterations);
		self.postMessage({ channelData: result, channelIndex }, [result.buffer]);
	} catch (error) {
		console.error('Deconv channel error:', error);
		self.postMessage({ channelData: new Float32Array(channelData), channelIndex, error: error.message });
	}
}

function processChannel(channelData, width, height, psfRadius, iterations) {
	// Create channel Mat from float data
	const channel = new _cv.Mat(height, width, _cv.CV_32F);
	channel.data32F.set(channelData);

	// Create PSF
	const psf = createGaussianPSF(psfRadius);
	const psfFlipped = new _cv.Mat();
	_cv.flip(psf, psfFlipped, -1);

	// Create estimate (start with observed image)
	const estimate = channel.clone();

	// Pre-allocate work buffers (reuse across iterations)
	const blurred = new _cv.Mat();
	const ratio = new _cv.Mat();
	const correction = new _cv.Mat();
	const epsilon = new _cv.Mat(height, width, _cv.CV_32F, new _cv.Scalar(1e-10));

	// Richardson-Lucy iterations
	for (let i = 0; i < iterations; i++) {
		// Convolve estimate with PSF
		_cv.filter2D(estimate, blurred, _cv.CV_32F, psf);

		// Add epsilon to avoid division by zero
		_cv.add(blurred, epsilon, blurred);

		// Divide observed by blurred
		_cv.divide(channel, blurred, ratio);

		// Convolve ratio with flipped PSF
		_cv.filter2D(ratio, correction, _cv.CV_32F, psfFlipped);

		// Multiply estimate by correction
		_cv.multiply(estimate, correction, estimate);
	}

	// Extract result
	const result = new Float32Array(estimate.data32F);

	// Cleanup
	channel.delete();
	psf.delete();
	psfFlipped.delete();
	estimate.delete();
	blurred.delete();
	ratio.delete();
	correction.delete();
	epsilon.delete();

	return result;
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

/*
	Wavelet sharpening worker - dispatches to sub-workers for channel processing
	This file is in public/ because Vite/Nuxt tries to optimize it otherwise

	Supports both 8-bit (Uint8ClampedArray) and 16-bit (Float32Array) modes.
	When is16bit=true: input and output are Float32Array in 0.0-1.0 range
	When is16bit=false (default): input and output are Uint8ClampedArray in 0-255 range

	When luminanceOnly=true: sharpens only luminance channel, preserving colors
*/

const workers = [];
const channelDataResults = [null, null, null];
let pendingResults = 3;
let globalWidth, globalHeight, globalTaskId, globalIs16bit, globalLuminanceOnly;
let globalOriginalData = null; // Store original RGB for luminance-only mode
let workersInitialized = false;

// Get cache bust query string from this worker's own URL (passed by parent)
const cacheBust = self.location.search || '';

// Lazy-load sub-workers on first use
function initializeSubWorkers() {
	if (workersInitialized) return;
	workersInitialized = true;

	for (let i = 0; i < 3; i++) {
		workers[i] = new Worker('/sharpen_per_channel_worker.js' + cacheBust, {type: 'module'});
		workers[i].addEventListener('message', handleWorkerResponse(i));
	}
}

self.addEventListener('message', async (e) => {
	const { imageData, width, height, amount, radius, taskId, is16bit, luminanceOnly } = e.data;

	globalWidth = width;
	globalHeight = height;
	globalTaskId = taskId;
	globalIs16bit = is16bit || false;
	globalLuminanceOnly = luminanceOnly || false;

	console.log(`[wavelet_worker] luminanceOnly=${globalLuminanceOnly}, is16bit=${globalIs16bit}`);

	initializeSubWorkers();

	if (globalLuminanceOnly) {
		// Luminance-only mode: extract luminance, sharpen it, apply back
		globalOriginalData = imageData; // Keep reference to original
		pendingResults = 1; // Only one channel to process

		const luminance = globalIs16bit
			? extractLuminance16(imageData)
			: extractLuminance(imageData);

		// Send only luminance to first worker
		workers[0].postMessage({ imageData: luminance, width, height, amount, radius, is16bit: globalIs16bit });
	} else {
		// Original RGB mode: sharpen each channel independently
		globalOriginalData = null;
		pendingResults = 3;

		const channelData = globalIs16bit
			? extractChannelData16(imageData)
			: extractChannelData(imageData);

		channelData.forEach((channel, index) => {
			workers[index].postMessage({ imageData: channel, width, height, amount, radius, is16bit: globalIs16bit });
		});
	}
});

function handleWorkerResponse(index) {
	return (e) => {
		channelDataResults[index] = e.data;
		pendingResults--;

		// When all channels are processed
		if (pendingResults === 0) {
			let result;

			if (globalLuminanceOnly) {
				// Apply sharpened luminance back to original RGB
				const sharpenedLuminance = channelDataResults[0];
				result = globalIs16bit
					? applyLuminanceToRgb16(globalOriginalData, sharpenedLuminance)
					: applyLuminanceToRgb(globalOriginalData, sharpenedLuminance);
				globalOriginalData = null;
			} else {
				// Merge sharpened RGB channels
				result = globalIs16bit
					? mergeChannelsIntoImageData16(channelDataResults)
					: mergeChannelsIntoImageData(channelDataResults);
			}

			if (globalIs16bit) {
				self.postMessage({ imageData: result, taskId: globalTaskId, is16bit: true });
			} else {
				const mergedData = new Uint8ClampedArray(result);
				const imageData = new ImageData(mergedData, globalWidth, globalHeight);
				self.postMessage({ imageData, taskId: globalTaskId }, [mergedData.buffer]);
			}

			// Reset for next processing
			pendingResults = globalLuminanceOnly ? 1 : 3;
		}
	};
}

// ============== Luminance extraction and application ==============

/**
 * Extract luminance from 8-bit RGB data
 * @param {Uint8ClampedArray} data - RGBA data (0-255)
 * @returns {number[]} Luminance channel (0-255)
 */
function extractLuminance(data) {
	const pixelCount = data.length / 4;
	const luminance = new Array(pixelCount);

	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		// Rec. 601 luma coefficients
		luminance[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
	}

	return luminance;
}

/**
 * Extract luminance from 16-bit RGB data
 * @param {Float32Array} data - RGBA float data (0.0-1.0)
 * @returns {Float32Array} Luminance channel (0.0-1.0)
 */
function extractLuminance16(data) {
	const pixelCount = data.length / 4;
	const luminance = new Float32Array(pixelCount);

	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		// Rec. 601 luma coefficients
		luminance[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
	}

	return luminance;
}

/**
 * Apply sharpened luminance to original RGB by adding the luminance delta
 * This preserves saturation better than SetLuminosity blend
 * @param {Uint8ClampedArray} originalData - Original RGBA (0-255)
 * @param {number[]} sharpenedLum - Sharpened luminance (0-255)
 * @returns {number[]} Result RGBA data
 */
function applyLuminanceToRgb(originalData, sharpenedLum) {
	const pixelCount = originalData.length / 4;
	const result = new Array(pixelCount * 4);

	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		const r = originalData[idx];
		const g = originalData[idx + 1];
		const b = originalData[idx + 2];

		// Calculate original luminance
		const originalLum = 0.299 * r + 0.587 * g + 0.114 * b;

		// Get the sharpening delta
		const delta = sharpenedLum[i] - originalLum;

		// Add delta to all channels equally
		result[idx] = Math.max(0, Math.min(255, Math.round(r + delta)));
		result[idx + 1] = Math.max(0, Math.min(255, Math.round(g + delta)));
		result[idx + 2] = Math.max(0, Math.min(255, Math.round(b + delta)));
		result[idx + 3] = originalData[idx + 3];
	}

	return result;
}

/**
 * Apply sharpened luminance to original RGB by adding the luminance delta
 * This preserves saturation better than SetLuminosity blend
 * @param {Float32Array} originalData - Original RGBA (0.0-1.0)
 * @param {Float32Array} sharpenedLum - Sharpened luminance (0.0-1.0)
 * @returns {Float32Array} Result RGBA data
 */
function applyLuminanceToRgb16(originalData, sharpenedLum) {
	const pixelCount = originalData.length / 4;
	const result = new Float32Array(pixelCount * 4);

	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		const r = originalData[idx];
		const g = originalData[idx + 1];
		const b = originalData[idx + 2];

		// Calculate original luminance
		const originalLum = 0.299 * r + 0.587 * g + 0.114 * b;

		// Get the sharpening delta (how much luminance changed)
		const delta = sharpenedLum[i] - originalLum;

		// Add delta to all channels equally - preserves color ratios
		result[idx] = Math.max(0, Math.min(1, r + delta));
		result[idx + 1] = Math.max(0, Math.min(1, g + delta));
		result[idx + 2] = Math.max(0, Math.min(1, b + delta));
		result[idx + 3] = originalData[idx + 3];
	}

	return result;
}

/**
 * Get luminosity of an RGB color (Rec. 601)
 */
function getLuminosity(r, g, b) {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Set luminosity of an RGB color while preserving hue/saturation
 * Based on Photoshop's luminosity blend mode algorithm
 * @param {number} r - Red (0-1)
 * @param {number} g - Green (0-1)
 * @param {number} b - Blue (0-1)
 * @param {number} newLum - New luminosity (0-1)
 * @returns {number[]} [r, g, b] with new luminosity
 */
function setLuminosity(r, g, b, newLum) {
	const currentLum = getLuminosity(r, g, b);
	const d = newLum - currentLum;

	// Add delta to all channels
	r += d;
	g += d;
	b += d;

	// Clip back into legal [0,1] range while preserving hue
	const lum = getLuminosity(r, g, b);
	const cMin = Math.min(r, g, b);
	const cMax = Math.max(r, g, b);

	if (cMin < 0) {
		const t = lum / (lum - cMin);
		r = lum + (r - lum) * t;
		g = lum + (g - lum) * t;
		b = lum + (b - lum) * t;
	}

	if (cMax > 1) {
		const t = (1 - lum) / (cMax - lum);
		r = lum + (r - lum) * t;
		g = lum + (g - lum) * t;
		b = lum + (b - lum) * t;
	}

	return [r, g, b];
}

// ============== Original RGB channel functions ==============

function extractChannelData(data) {
	let redChannel = [];
	let greenChannel = [];
	let blueChannel = [];

	for (let i = 0; i < data.length; i += 4) {
		redChannel.push(data[i]);
		greenChannel.push(data[i + 1]);
		blueChannel.push(data[i + 2]);
	}

	return [redChannel, greenChannel, blueChannel];
}

function mergeChannelsIntoImageData(channels) {
	const [redChannel, greenChannel, blueChannel] = channels;
	const mergedData = [];

	for (let i = 0; i < redChannel.length; i++) {
		mergedData[i * 4] = redChannel[i];
		mergedData[i * 4 + 1] = greenChannel[i];
		mergedData[i * 4 + 2] = blueChannel[i];
		mergedData[i * 4 + 3] = 255;
	}

	return mergedData;
}

/**
 * Extract channel data from Float32Array (16-bit mode)
 * @param {Float32Array} data - RGBA float data
 * @returns {Float32Array[]} Array of [R, G, B] channel Float32Arrays
 */
function extractChannelData16(data) {
	const pixelCount = data.length / 4;
	const redChannel = new Float32Array(pixelCount);
	const greenChannel = new Float32Array(pixelCount);
	const blueChannel = new Float32Array(pixelCount);

	for (let i = 0; i < pixelCount; i++) {
		const idx = i * 4;
		redChannel[i] = data[idx];
		greenChannel[i] = data[idx + 1];
		blueChannel[i] = data[idx + 2];
	}

	return [redChannel, greenChannel, blueChannel];
}

/**
 * Merge channel data into Float32Array (16-bit mode)
 * @param {Float32Array[]} channels - Array of [R, G, B] channel Float32Arrays
 * @returns {Float32Array} RGBA float data
 */
function mergeChannelsIntoImageData16(channels) {
	const [redChannel, greenChannel, blueChannel] = channels;
	const mergedData = new Float32Array(redChannel.length * 4);

	for (let i = 0; i < redChannel.length; i++) {
		mergedData[i * 4] = redChannel[i];
		mergedData[i * 4 + 1] = greenChannel[i];
		mergedData[i * 4 + 2] = blueChannel[i];
		mergedData[i * 4 + 3] = 1.0; // Full alpha
	}

	return mergedData;
}

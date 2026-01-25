/*
	Wavelet sharpening worker - dispatches to 3 sub-workers for R, G, B channels
	This file is in public/ because Vite/Nuxt tries to optimize it otherwise

	Supports both 8-bit (Uint8ClampedArray) and 16-bit (Float32Array) modes.
	When is16bit=true: input and output are Float32Array in 0.0-1.0 range
	When is16bit=false (default): input and output are Uint8ClampedArray in 0-255 range
*/

const workers = [];
const channelDataResults = [null, null, null];
let pendingResults = 3;
let globalWidth, globalHeight, globalTaskId, globalIs16bit;
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
	const { imageData, width, height, amount, radius, taskId, is16bit } = e.data;

	globalWidth = width;
	globalHeight = height;
	globalTaskId = taskId;
	globalIs16bit = is16bit || false;

	initializeSubWorkers();

	// Extract and dispatch each color channel to its respective worker
	let channelData = globalIs16bit
		? extractChannelData16(imageData)
		: extractChannelData(imageData);

	channelData.forEach((channel, index) => {
		workers[index].postMessage({ imageData: channel, width, height, amount, radius, is16bit: globalIs16bit });
	});
});

function handleWorkerResponse(index) {
	return (e) => {
		channelDataResults[index] = e.data;
		pendingResults--;

		// When all channels are processed
		if (pendingResults === 0) {
			if (globalIs16bit) {
				// 16-bit mode: merge into Float32Array
				const mergedData = mergeChannelsIntoImageData16(channelDataResults);
				self.postMessage({ imageData: mergedData, taskId: globalTaskId, is16bit: true });
			} else {
				// 8-bit mode: merge into Uint8ClampedArray
				const mergedData = new Uint8ClampedArray(mergeChannelsIntoImageData(channelDataResults));
				const imageData = new ImageData(mergedData, globalWidth, globalHeight);
				self.postMessage({ imageData, taskId: globalTaskId }, [mergedData.buffer]);
			}
			pendingResults = 3; // Reset for next processing
		}
	};
}

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

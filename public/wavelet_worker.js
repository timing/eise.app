/*
	Wavelet sharpening worker - dispatches to 3 sub-workers for R, G, B channels
	This file is in public/ because Vite/Nuxt tries to optimize it otherwise
*/

const workers = [];
const channelDataResults = [null, null, null];
let pendingResults = 3;
let globalWidth, globalHeight, globalTaskId;
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

self.addEventListener('message', async (e) => {
	const { imageData, width, height, amount, radius, taskId } = e.data;

	globalWidth = width;
	globalHeight = height;
	globalTaskId = taskId;

	initializeSubWorkers();

	// Extract and dispatch each color channel to its respective worker
	let channelData = extractChannelData(imageData);
	channelData.forEach((channel, index) => {
		workers[index].postMessage({ imageData: channel, width, height, amount, radius });
	});
});

function handleWorkerResponse(index) {
	return (e) => {
		channelDataResults[index] = e.data;
		pendingResults--;

		// When all channels are processed
		if (pendingResults === 0) {
			const mergedData = new Uint8ClampedArray(mergeChannelsIntoImageData(channelDataResults));
			const imageData = new ImageData(mergedData, globalWidth, globalHeight);
			self.postMessage({ imageData, taskId: globalTaskId }, [mergedData.buffer]);
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

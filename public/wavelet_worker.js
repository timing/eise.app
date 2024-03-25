/* 
	this file is moved to public folder because Vite/Nuxt/Vue whatever tries 
	to optimize it by using globalThis.__publicAssetsURL, but then it breaks
*/

const workers = [];
const channelDataResults = [null, null, null];
let pendingResults = 3; // Expecting 3 results
let globalWidth, globalHeight, globalTaskId;

// Initialize workers
for (let i = 0; i < 3; i++) {
	workers[i] = new Worker('/sharpen_per_channel_worker.js', {type: 'module'});
	workers[i].addEventListener('message', handleWorkerResponse(i));
}

self.addEventListener('message', async (e) => {
	console.log('msg received', e.data);

	const { imageData, width, height, amount, radius, taskId } = e.data;

	// Store for later use
    globalWidth = width;
    globalHeight = height;
	globalTaskId = taskId;

	let channelData = extractChannelData(imageData);

	// Send each color channel to its respective worker
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
			const imageData = new ImageData(new Uint8ClampedArray(mergeChannelsIntoImageData(channelDataResults)), globalWidth, globalHeight);
			self.postMessage({ imageData, taskId: globalTaskId });
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



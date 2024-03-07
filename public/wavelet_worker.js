/* 
	this file is moved to public folder because Vite/Nuxt/Vue whatever tries 
	to optimize it by using globalThis.__publicAssetsURL, but then it breaks
*/

let wasmInstance;

import( new URL('/wavelet_sharpen_worker.js', import.meta.url))
	.then(async (module) => {
		wasmInstance = await module.default();
  		console.log('yoyo', wasmInstance);
 	 })
  	.catch(console.error);

self.addEventListener('message', async (e) => {

	console.log('msg received', e.data);

	const { imageData, width, height, amount, radius } = e.data;

	let channelData = extractChannelData(imageData);

	for( let c in channelData ){

		// Normalize imageData to floating-point values in the range [0, 1]
		let floatData = Float32Array.from(channelData[c], val => val / 255.0);

		// Allocate memory for the floating-point data
		const numBytes = floatData.length * floatData.BYTES_PER_ELEMENT;
		const ptr = wasmInstance._malloc(numBytes);

		// Copy the normalized floating-point data to WebAssembly memory
		let heapFloatArray = new Float32Array(wasmInstance.HEAPF32.buffer, ptr, floatData.length);
		heapFloatArray.set(floatData);
		
		//logCopy('pixel 4553 before', floatData[4553]);

		// Call the WebAssembly function
		//console.log('wavelet_sharpen', width, height, amount, radius);
		wasmInstance._wavelet_sharpen(ptr, width, height, amount, radius);

		// Retrieve the modified data
		let modifiedData = new Float32Array(wasmInstance.HEAPF32.buffer, ptr, floatData.length);
		
		//logCopy('pixel 4553 after', modifiedData[4553]);

		// Denormalize the data back to [0, 255] and convert to Uint8ClampedArray
		channelData[c] = Uint8ClampedArray.from(modifiedData, val => val * 255.0);
	
		wasmInstance._free(ptr);
	}	
	
	//console.log(channel, denormalizedData);
	//imageData = new ImageData(new Uint8ClampedArray(mergeChannelsIntoImageData(channelData)), width, height);

	self.postMessage({ imageData: new ImageData(new Uint8ClampedArray(mergeChannelsIntoImageData(channelData)), width, height) });
});

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



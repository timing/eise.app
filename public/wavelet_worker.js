let wasmInstance;

import( new URL('/wavelet_sharpen_worker.js', import.meta.url))
	.then(async (module) => {
		wasmInstance = await module.default();
  		console.log('yoyo', wasmInstance);
 	 })
  	.catch(console.error);

self.addEventListener('message', async (e) => {

	console.log('msg received', e.data);

	const { channel, imageData, width, height, amount, radius } = e.data;

	//console.log(channel);

	// Normalize imageData to floating-point values in the range [0, 1]
	let floatData = Float32Array.from(imageData, val => val / 255.0);

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
	let denormalizedData = Uint8ClampedArray.from(modifiedData, val => val * 255.0);

	wasmInstance._free(ptr);
	
	//console.log(channel, denormalizedData);

	self.postMessage({ channel, channelData: denormalizedData });
});

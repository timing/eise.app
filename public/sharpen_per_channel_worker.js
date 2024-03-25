// color_channel_worker.js
let wasmInstance;
let wasmModuleURL = new URL('/wavelet_sharpen_worker.js', import.meta.url).toString();

self.addEventListener('message', async (e) => {
	const { imageData, width, height, amount, radius } = e.data;

	// Load WASM module if not already loaded
	if (!wasmInstance) {
		import(wasmModuleURL)
			.then(async (module) => {
				wasmInstance = await module.default();
				processImageData(imageData, width, height, amount, radius);
			})
			.catch(console.error);
	} else {
		processImageData(imageData, width, height, amount, radius);
	}
});

function processImageData(imageData, width, height, amount, radius) {
	// Normalize imageData to floating-point values in the range [0, 1]
	let floatData = Float32Array.from(imageData, val => val / 255.0);

	// Allocate memory and process data
	const numBytes = floatData.length * floatData.BYTES_PER_ELEMENT;
	const ptr = wasmInstance._malloc(numBytes);
	let heapFloatArray = new Float32Array(wasmInstance.HEAPF32.buffer, ptr, floatData.length);
	heapFloatArray.set(floatData);
	wasmInstance._wavelet_sharpen(ptr, width, height, amount, radius);
	let modifiedData = new Float32Array(wasmInstance.HEAPF32.buffer, ptr, floatData.length);
	wasmInstance._free(ptr);

	// Denormalize and post back
	const processedData = Uint8ClampedArray.from(modifiedData, val => val * 255.0);
	self.postMessage(processedData);
}


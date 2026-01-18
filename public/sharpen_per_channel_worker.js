// color_channel_worker.js
// Supports both 8-bit (array of 0-255) and 16-bit (Float32Array 0.0-1.0) modes
let wasmInstance;
let wasmModuleURL = new URL('/wavelet_sharpen_worker.js', import.meta.url).toString();
let pendingTask = null;

self.addEventListener('message', async (e) => {
	const { imageData, width, height, amount, radius, is16bit } = e.data;

	// Store task for processing after WASM loads
	pendingTask = { imageData, width, height, amount, radius, is16bit: is16bit || false };

	// Load WASM module if not already loaded
	if (!wasmInstance) {
		import(wasmModuleURL)
			.then(async (module) => {
				wasmInstance = await module.default();
				if (pendingTask) {
					const task = pendingTask;
					pendingTask = null;
					processImageData(task.imageData, task.width, task.height, task.amount, task.radius, task.is16bit);
				}
			})
			.catch(console.error);
	} else {
		const task = pendingTask;
		pendingTask = null;
		processImageData(task.imageData, task.width, task.height, task.amount, task.radius, task.is16bit);
	}
});

function processImageData(imageData, width, height, amount, radius, is16bit) {
	let floatData;

	if (is16bit) {
		// 16-bit mode: input is already Float32Array in 0-1 range
		floatData = imageData instanceof Float32Array ? imageData : new Float32Array(imageData);
	} else {
		// 8-bit mode: normalize from 0-255 to 0-1
		floatData = Float32Array.from(imageData, val => val / 255.0);
	}

	// Allocate memory and process data
	const numBytes = floatData.length * floatData.BYTES_PER_ELEMENT;
	const ptr = wasmInstance._malloc(numBytes);
	let heapFloatArray = new Float32Array(wasmInstance.HEAPF32.buffer, ptr, floatData.length);
	heapFloatArray.set(floatData);
	wasmInstance._wavelet_sharpen(ptr, width, height, amount, radius);
	// Copy result BEFORE freeing to avoid use-after-free
	let modifiedData = new Float32Array(wasmInstance.HEAPF32.buffer, ptr, floatData.length);
	const resultCopy = new Float32Array(modifiedData);
	wasmInstance._free(ptr);

	if (is16bit) {
		// 16-bit mode: return Float32Array directly (already in 0-1 range)
		self.postMessage(resultCopy);
	} else {
		// 8-bit mode: denormalize and return Uint8ClampedArray
		const processedData = Uint8ClampedArray.from(resultCopy, val => val * 255.0);
		self.postMessage(processedData);
	}
}


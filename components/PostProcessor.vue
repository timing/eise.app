<template>
	<div class="wrapper">
		<canvas ref="canvas"></canvas>
	</div>
	<div class="controls">
		<div>
			<label>Gain:</label>
			<input type="range" min="0" max="2" step="0.01" v-model="gain" @input="applyProcessing"/>
		</div>
		<div>
			<label>Pre Noise Reduction:</label>
			<input type="range" min="0" max="3" step="0.01" v-model="preNoiseReduction" @input="applyProcessing"/>
		</div>
		<div>
			<label>Wavelets Radius:</label>
			<input type="range" min="0" max="10" step="0.1" v-model="waveletsRadius" @input="applyProcessing"/>
			<span>{{ waveletsRadius }}</span>
		</div>
		<div>
			<label>Wavelets Amount:</label>
			<input type="range" min="0" max="200" step="0.01" v-model="waveletsAmount" @input="applyProcessing"/>
			<span>{{ waveletsAmount }}</span>
		</div>
		<div>
			<label>Bilateral Fraction:</label>
			<input type="range" min="0" max="1" step="0.01" v-model="bilateralFraction" @input="applyProcessing"/>
		</div>
		<div>
			<label>Bilateral Range:</label>
			<input type="range" min="0" max="255" step="0.1" v-model="bilateralRange" @input="applyProcessing"/>
		</div>
		<div>
			<label>Post Noise Reduction:</label>
			<input type="range" min="0" max="1" step="0.01" v-model="postNoiseReduction" @input="applyProcessing"/>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted, watch, defineProps } from 'vue';
import { adjustGain, adjustGainMultiply, cvMatToImageData } from '@/utils/sobel.js'

let waveletWorker;

onMounted(() => {
	waveletWorker = new Worker(new URL('@/utils/wavelet_worker.js', import.meta.url), {type: 'module'});
	waveletWorker.addEventListener('message', (e) => {
		if (e.data.status === 'wasmLoaded') {
        	console.log('WASM module is ready to use.');
		}
		console.log(e); 
	});
	waveletWorker.onerror = (event) => { console.error(event); };
});

/*import Module from '@/utils/wavelet_sharpen.js'

let wasmInstance;

Module().then((module) => {
	wasmInstance = module;
	console.log(wasmInstance);
});*/


const props = defineProps({
	file: Object
});

const canvas = ref(null);

const gain = ref(1);
const preNoiseReduction = ref(50);
const waveletsRadius = ref(0.3);
const waveletsAmount = ref(9);
const bilateralFraction = ref(0.5);
const bilateralRange = ref(50);
const postNoiseReduction = ref(50);

onMounted(() => {
	if (props.file) {
		loadImage(props.file);
	}
});


onMounted(async () => {
	try {
		
		// If the module exports a function you want to call, do it here
		// module.yourExportedFunction();
	} catch (error) {
		console.error('Failed to load the module:', error);
	}
});

watch(() => props.file, (newVal) => {
	if (newVal) {
		loadImage(newVal);
	}
});

let initialMat;
let workingMat;
let initCanvas;
let initCanvasImageData;
let ctx = null;

let prevGain;

async function loadImage(file) {

	console.log(file);

	const img = new Image();
	img.onload = function() {
		canvas.value.width = img.width;
		canvas.value.height = img.height;
		ctx = canvas.value.getContext('2d');
		ctx.drawImage(img, 0, 0);

		initCanvas = canvas;
		initCanvasImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
		//console.log('canvas ImageData', initCanvasImageData);

		initialMat = cv.matFromImageData(initCanvasImageData);
	};
	img.src = URL.createObjectURL(file);
}

const applyProcessing = () => {
	// Apply OpenCV.js operations based on the current state of controls
	// This is where you'd use cv.GaussianBlur, cv.bilateralFilter, etc.
	console.log("Applying processing with current settings:", {
		gain: gain.value,
		preNoiseReduction: preNoiseReduction.value,
		// Add other parameters
	});
	
	// Gain
	let imageData = prevGain == gain.value ? initCanvasImageData.data : initCanvasImageData.data.map(value => value * gain.value);
	prevGain = gain.value;
	

	/*console.log('cv.bilateralFilter start');
	cv.bilateralFilter(gainedMat, gainedMat, 0, parseFloat(bilateralFraction.value), parseFloat(bilateralRange.value), cv.BORDER_DEFAULT);
	console.log('cv.bilateralFilter end');*/

	//let sharpenedImageData = sharpenImage(matToImageData(gainedMat), parseFloat(waveletsRadius.value), parseFloat(waveletsAmount.value));

	//imageData = waveletSharpen(imageData, initCanvasImageData.width, initCanvasImageData.height, parseFloat(waveletsAmount.value), parseFloat(waveletsRadius.value));

	if( false ){
	// THIS WORKS, but tryint to work with the web worker for now
		imageData = waveletSharpenPerChannel(imageData, initCanvasImageData.width, initCanvasImageData.height, parseFloat(waveletsAmount.value), parseFloat(waveletsRadius.value));
		ctx.putImageData(new ImageData(imageData, initCanvasImageData.width, initCanvasImageData.height), 0, 0);
	} else {
		imageData = waveletSharpenInWorker(imageData, initCanvasImageData.width, initCanvasImageData.height, parseFloat(waveletsAmount.value), parseFloat(waveletsRadius.value));
	}

	//workingMat.delete();
	//gainedMat.delete();
};

function matToArray(mat) {
	const dataArray = new Array(mat.rows * mat.cols);
	for (let i = 0; i < mat.rows; i++) {
		for (let j = 0; j < mat.cols; j++) {
			dataArray[i * mat.cols + j] = mat.ucharPtr(i, j)[0];
		}
	}
	return dataArray;
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

	console.log('extractChannelData length compare', data.length, redChannel.length);

	return [redChannel, greenChannel, blueChannel];
}

function arrayToMat(array, width, height) {
	const mat = new cv.Mat(height, width, cv.CV_8UC1);
	for (let i = 0; i < height; i++) {
		for (let j = 0; j < width; j++) {
			mat.ucharPtr(i, j)[0] = array[i * width + j];
		}
	}
	return mat;
}

function mergeChannelsIntoImageData(channels) {
	const [redChannel, greenChannel, blueChannel] = channels;
	const mergedData = [];
	
	for (let i = 0; i < redChannel.length; i++) {
		mergedData[i * 4] = redChannel[i]; // R
		mergedData[i * 4 + 1] = greenChannel[i]; // G
		mergedData[i * 4 + 2] = blueChannel[i];	// B
		mergedData[i * 4 + 3] = 255;						 // Alpha channel set to fully opaque
	}
	
	return mergedData;
}

function normalizeMat(inputMat) {
	// Assuming the inputMat is CV_8UC3 for color images or CV_8UC1 for grayscale
	// and you want to normalize to the range [0, 1]
	let normalizedMat = new cv.Mat();
	// Convert and normalize to [0, 1]
	inputMat.convertTo(normalizedMat, cv.CV_32F, 1.0 / 255.0);
	return normalizedMat;
}

function matToPSSImageData(mat) {
	const rows = mat.rows;
	const cols = mat.cols;
	const channels = mat.channels();
	const imageData = new Array(rows);
	
	for (let i = 0; i < rows; i++) {
		imageData[i] = new Array(cols);
		for (let j = 0; j < cols; j++) {
			imageData[i][j] = new Array(channels);
			const pixel = mat.ucharPtr(i, j);
			for (let k = 0; k < channels; k++) {
				imageData[i][j][k] = pixel[k];
			}
		}
	}
	return imageData; // imageData[rows][cols][color_channel]
}

function pssImageDataToMat(imageData, targetMat) {
	const rows = imageData.length;
	const cols = imageData[0].length;
	const channels = 3;

	/*if (!targetMat) {
		targetMat = new cv.Mat(rows, cols, cv.CV_8UC(channels));
	} else {
		if (targetMat.rows !== rows || targetMat.cols !== cols || targetMat.channels() !== channels) {
			console.error('Target Mat dimensions do not match the dimensions of the imageData array.');
			return null;
		}
	}*/

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			for (let ch = 0; ch < channels; ch++) {
				//targetMat.at(row, col * channels + ch, pixel[ch] * 65535);
				targetMat.ucharPtr(row, col)[ch] = Math.max(imageData[row][col][ch] * 65535, 65535);
			}
		}
	}

	return targetMat;
}

function hatTransform(temp, base, st, size, sc) {
	let i;
	for (i = 0; i < sc; i++)
		temp[i] = 2 * base[st * i] + base[st * (sc - i)] + base[st * (i + sc)];
	for (; i + sc < size; i++)
		temp[i] = 2 * base[st * i] + base[st * (i - sc)] + base[st * (i + sc)];
	for (; i < size; i++)
		temp[i] = 2 * base[st * i] + base[st * (i - sc)] + base[st * (2 * size - 2 - (i + sc))];
}

function logCopy(name, array){
	if( array === undefined ){
		console.log(name, 'undefined');
		return;
	}
	console.log(name, JSON.parse(JSON.stringify(array)));
}

function waveletSharpenPerChannel(imageData, width, height, amount, radius) {

	const channelData = extractChannelData(imageData);

	for( let c in channelData ){
		channelData[c] = waveletSharpen(channelData[c], width, height, amount, radius);
	}

	return new Uint8ClampedArray(mergeChannelsIntoImageData(channelData));
}

function waveletSharpenInWorker(imageData, width, height, amount, radius){

	let channelsCount = 0;
	let allChannelsData = [];

	function handleWorkerMsg(e){
		// Get the processed image data from the worker
		const { channel, channelData } = e.data;

		allChannelsData[channel] = channelData;
	
		channelsCount++;
		
		console.log('handleWorkerMsg', e.data, channelsCount, allChannelsData);
		/*logCopy('channelData', channelData);
		logCopy('allChannelsData', allChannelsData);*/

		if( channelsCount == 3 ){
			console.log(allChannelsData, mergeChannelsIntoImageData(allChannelsData).length, initCanvasImageData.width, initCanvasImageData.height);
			ctx.putImageData(new ImageData(new Uint8ClampedArray(mergeChannelsIntoImageData(allChannelsData)), initCanvasImageData.width, initCanvasImageData.height), 0, 0);
			waveletWorker.removeEventListener('message', handleWorkerMsg)
		}
	}

	waveletWorker.addEventListener('message', handleWorkerMsg);

	const channelData = extractChannelData(imageData);

	for( let c in channelData ){
		// To send data to the worker for processing
		waveletWorker.postMessage({ channel: parseInt(c, 10), imageData: channelData[c], width, height, amount, radius });	
	}
}

/* THE REAL DEAL */
function waveletSharpen(imageData, width, height, amount, radius) {
	// Normalize imageData to floating-point values in the range [0, 1]
	let floatData = Float32Array.from(imageData, val => val / 255.0);

	// Allocate memory for the floating-point data
	const numBytes = floatData.length * floatData.BYTES_PER_ELEMENT;
	const ptr = wasmInstance._malloc(numBytes);

	// Copy the normalized floating-point data to WebAssembly memory
	let heapFloatArray = new Float32Array(wasmInstance.HEAPF32.buffer, ptr, floatData.length);
	heapFloatArray.set(floatData);
	
	// Call the WebAssembly function
	wasmInstance._wavelet_sharpen(ptr, width, height, amount, radius);

	// Retrieve the modified data
	let modifiedData = new Float32Array(wasmInstance.HEAPF32.buffer, ptr, floatData.length);
	
	// Denormalize the data back to [0, 255] and convert to Uint8ClampedArray
	let denormalizedData = Uint8ClampedArray.from(modifiedData, val => val * 255.0);

	wasmInstance._free(ptr);

	return denormalizedData;
}


</script>

<style>
.wrapper {
	max-width: 100vw;
	overflow: scroll;
	max-height: 70vh;
	border: 1px solid lightyellow; /* Optional: for visual boundary */
}
canvas {
	display: block; /* Prevents inline default and allows for proper overflow handling */
	width: auto;
	height: auto;
}
</style>


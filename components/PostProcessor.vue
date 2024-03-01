<template>
	<div class="wrapper">
		<canvas id="postProcessCanvas" ref="canvas"></canvas>
	</div>
	<div class="controls">
		<div>
			<label>Gain:</label>
			<input type="range" min="0" max="3" step="0.01" v-model="gain" @input="applyProcessing"/>
		</div>
		<div>
			<label>Pre Noise Reduction:</label>
			<input type="range" min="1" max="50" step="2" v-model="preNoiseReduction" @input="applyProcessing"/>
			<span>{{ preNoiseReduction }}</span>
		</div>
		<div>
			<label>Wavelets Radius:</label>
			<input type="range" min="0" max="2" step="0.1" v-model="waveletsRadius" @input="applyProcessing"/>
			<span>{{ waveletsRadius }}</span>
		</div>
		<div>
			<label>Wavelets Amount:</label>
			<input type="range" min="0" max="100" step="0.01" v-model="waveletsAmount" @input="applyProcessing"/>
			<span>{{ waveletsAmount }}</span>
		</div>
		<!--<div>
			<label>Bilateral Fraction:</label>
			<input type="range" min="0" max="1" step="0.01" v-model="bilateralFraction" @input="applyProcessing"/>
			<span>{{ bilateralFraction }}</span>
		</div>
		<div>
			<label>Bilateral Range:</label>
			<input type="range" min="0" max="255" step="0.1" v-model="bilateralRange" @input="applyProcessing"/>
			<span>{{ bilateralRange }}</span>
		</div>-->
		<div>
			<label>Post Noise Reduction:</label>
			<input type="range" min="1" max="50" step="2" v-model="postNoiseReduction" @input="applyProcessing"/>
			<span>{{ postNoiseReduction }}</span>
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
const preNoiseReduction = ref(1);
const waveletsRadius = ref(0);
const waveletsAmount = ref(0);
const bilateralFraction = ref(0.5);
const bilateralRange = ref(50);
const postNoiseReduction = ref(1);

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

let workingMat;
let initCanvas;
let initCanvasImageData;
let gainedImageData;
let preNoiseReducedImageData;
let sharpenedImageData;
let ctx = null;

let prevGain;

let prevValues = {}

function valueIsChanged(prop, value){
	if( prevValues[prop] === undefined ){
		prevValues[prop] = value;
		return true;
	}

	let isChanged = prevValues[prop] != value;
	prevValues[prop] = value;

	return isChanged;
}

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
		gainedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
		preNoiseReducedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
		sharpenedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
	};
	img.src = URL.createObjectURL(file);
}

async function applyProcessing (){
	if( valueIsChanged('gain', gain.value) ){ 
		gainedImageData = new ImageData(initCanvasImageData.data.map(value => value * gain.value), canvas.value.width, canvas.value.height);
		preNoiseReducedImageData = gainedImageData;
		ctx.putImageData(gainedImageData, 0, 0);
	}

	if( valueIsChanged('preNoiseReduction', preNoiseReduction.value) ){
		const srcMat = imageDataToMat(gainedImageData);
		const dstMat = new cv.Mat();
		cv.cvtColor(srcMat, srcMat, cv.COLOR_RGBA2RGB, 0);
		cv.GaussianBlur(srcMat, dstMat, new cv.Size(parseInt(preNoiseReduction.value, 10), parseInt(preNoiseReduction.value, 10)), 0, 0, cv.BORDER_DEFAULT);
		cv.imshow('postProcessCanvas', dstMat);
		//preNoiseReducedImageData = matToImageData(dstMat);
		preNoiseReducedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
	}

	if( valueIsChanged('waveletsAmount', waveletsAmount.value) || valueIsChanged('waveletsRadius', waveletsRadius.value) ){
		sharpenedImageData = await waveletSharpenInWorker(preNoiseReducedImageData, parseFloat(waveletsAmount.value), parseFloat(waveletsRadius.value));
		ctx.putImageData(sharpenedImageData, 0, 0);
	}

	if( valueIsChanged('postNoiseReduction', postNoiseReduction.value) ){
		const srcMat = imageDataToMat(sharpenedImageData);
		const dstMat = new cv.Mat();
		cv.cvtColor(srcMat, srcMat, cv.COLOR_RGBA2RGB, 0);
		cv.GaussianBlur(srcMat, dstMat, new cv.Size(parseInt(postNoiseReduction.value, 10), parseInt(postNoiseReduction.value, 10)), 0, 0, cv.BORDER_DEFAULT);
		cv.imshow('postProcessCanvas', dstMat);
	}
};

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

function imageDataToMat(imageData) {
	let mat = new cv.Mat(imageData.height, imageData.width, cv.CV_8UC4);
	mat.data.set(imageData.data);
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

function logCopy(name, array){
	if( array === undefined ){
		console.log(name, 'undefined');
		return;
	}
	console.log(name, JSON.parse(JSON.stringify(array)));
}

function waveletSharpenInWorker(imageData, amount, radius){
	const width = imageData.width
	const height = imageData.height;
	return new Promise((resolve, reject) => {
		let channelsCount = 0;
		let allChannelsData = [];

		function handleWorkerMsg(e){
			// Get the processed image data from the worker
			const { channel, channelData } = e.data;

			allChannelsData[channel] = channelData;
		
			channelsCount++;
			
			if( channelsCount == 3 ){
				//ctx.putImageData(new ImageData(new Uint8ClampedArray(mergeChannelsIntoImageData(allChannelsData)), initCanvasImageData.width, initCanvasImageData.height), 0, 0);
				waveletWorker.removeEventListener('message', handleWorkerMsg)
				resolve(new ImageData(new Uint8ClampedArray(mergeChannelsIntoImageData(allChannelsData)), initCanvasImageData.width, initCanvasImageData.height));
			}
		}

		waveletWorker.addEventListener('message', handleWorkerMsg);

		const channelData = extractChannelData(imageData.data);

		for( let c in channelData ){
			// To send data to the worker for processing
			waveletWorker.postMessage({ channel: parseInt(c, 10), imageData: channelData[c], width, height, amount, radius });	
		}
	});
}

</script>

<style>
	canvas {

	}
</style>


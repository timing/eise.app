<template>
<div>
	<div class="content" v-if="!props.file">
		<h2>Nothing loaded yet</h2>
		<p>Please upload a video (or bunch of files) for analyzing and stacking frames. Upload one image file for direct post processing.</p>
	</div>
	<div v-else>
		<div class="controls">
			<h4>Wavelets sharpen</h4>
			<div>
				<label>Gain:</label>
				<input type="range" min="0.5" max="2" step="0.01" v-model="gain" @input="applyProcessing"/>
				<span>{{ gain }}</span>
			</div>
			<div style="display:none;">
				<label>Pre Noise Reduction:</label>
				<input type="range" min="-1" max="50" step="2" v-model="preNoiseReduction" @input="applyProcessing"/>
				<span>{{ preNoiseReduction }}</span>
			</div>
			<div>
				<label>Wavelets Radius:</label>
				<input type="range" min="0" max="5" step="0.1" v-model="waveletsRadius" @input="applyProcessing"/>
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
				<input type="range" min="-1" max="50" step="2" v-model="postNoiseReduction" @input="applyProcessing"/>
				<span>{{ postNoiseReduction }}</span>
			</div>

			<div class="color-alignment">
			
				<h4 style="color:blue;">Blue color alignment</h4>

				<button @click="processChromaticAberration('blue', 'y', -1)">↑ 
					{{ fixedAberration.blue?.y < 0 ? Math.abs(fixedAberration.blue.y) : '' }}
				</button>
				<button @click="processChromaticAberration('blue', 'y', 1)">↓ 
					{{ fixedAberration.blue?.y > 0 ? fixedAberration.blue.y : '' }}
				</button>
				<button @click="processChromaticAberration('blue', 'x', -1)">← 
					{{ fixedAberration.blue?.x < 0 ? Math.abs(fixedAberration.blue.x) : '' }}
				</button>
				<button @click="processChromaticAberration('blue', 'x', 1)">→ 
					{{ fixedAberration.blue?.x > 0 ? fixedAberration.blue.x : '' }}
				</button>
				
				<h4 style="color:red;">Red color alignment</h4>

				<button @click="processChromaticAberration('red', 'y', -1)">↑ 
					{{ fixedAberration.red?.y < 0 ? Math.abs(fixedAberration.red.y) : '' }}
				</button>
				<button @click="processChromaticAberration('red', 'y', 1)">↓ 
					{{ fixedAberration.red?.y > 0 ? fixedAberration.red.y : '' }}
				</button>
				<button @click="processChromaticAberration('red', 'x', -1)">← 
					{{ fixedAberration.red?.x < 0 ? Math.abs(fixedAberration.red.x) : '' }}
				</button>
				<button @click="processChromaticAberration('red', 'x', 1)">→ 
					{{ fixedAberration.red?.x > 0 ? fixedAberration.red.x : '' }}
				</button>

			</div>

			<h4>Save lossless image</h4>

			<button class="download" @click="downloadCanvasAsPNG">Save / Download as PNG</button>

		</div>
		<ZoomableCanvas id="postProcessCanvas" @canvasReady="handleCanvasReady" />
	</div>
</div>
</template>

<script setup>
import { ref, onMounted, watch, defineProps, reactive } from 'vue';
import throttle from 'lodash/throttle';
import { adjustGain, adjustGainMultiply, cvMatToImageData } from '@/utils/sobel.js'
import ZoomableCanvas from '@/components/ZoomableCanvas.vue';

let waveletWorker;
let canvas;

const handleCanvasReady = (canvasRef) => {
	// canvasRef is the direct ref to the canvas element
	console.log('Canvas is ready:', canvasRef);
	canvas = canvasRef;
	// You can now use canvasRef.value to access the canvas element directly
};

const downloadCanvasAsPNG = () => {
	if (!canvas) return;

	const dataURL = canvas.value.toDataURL('image/png');
	const link = document.createElement('a');
	link.download = 'EISE_stacked_pps.png';
	link.href = dataURL;
	document.body.appendChild(link); // Required for Firefox
	link.click();
	document.body.removeChild(link);
};

onMounted(() => {
	waveletWorker = new Worker('/wavelet_worker.js', {type: 'module'});
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

const gain = ref(1);
const preNoiseReduction = ref(0);
const waveletsRadius = ref(0.42);
const waveletsAmount = ref(4.2);
const bilateralFraction = ref(0.5);
const bilateralRange = ref(50);
const postNoiseReduction = ref(0);
const blueDown = ref(0);

onMounted(() => {
	if (props.file) {
		loadImage(props.file);
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

		// give a small processing improvement
		applyProcessing();

	};
	img.src = URL.createObjectURL(file);
}

const applyProcessing = throttle(async() => {
	console.log('applyProcessing');
	let doGain = valueIsChanged('gain', gain.value);
	if( doGain ){ 
		console.log('gain');
		gainedImageData = new ImageData(initCanvasImageData.data.map(value => value * gain.value), canvas.value.width, canvas.value.height);
		//gainedImageData = applyConditionalGain(initCanvasImageData, gain.value, 10, 0.8); // the edges get too hard
		preNoiseReducedImageData = gainedImageData;
		//ctx.putImageData(gainedImageData, 0, 0);
	}

	/*if( valueIsChanged('preNoiseReduction', preNoiseReduction.value) ){
		console.log('preNoise');
		const srcMat = imageDataToMat(gainedImageData);
		const dstMat = new cv.Mat();
		cv.cvtColor(srcMat, srcMat, cv.COLOR_RGBA2RGB, 0);
		cv.GaussianBlur(srcMat, dstMat, new cv.Size(parseInt(preNoiseReduction.value, 10), parseInt(preNoiseReduction.value, 10)), 0, 0, cv.BORDER_DEFAULT);
		cv.imshow('postProcessCanvas', dstMat);
		//preNoiseReducedImageData = matToImageData(dstMat);
		preNoiseReducedImageData = ctx.getImageData(0, 0, canvas.value.width, canvas.value.height);
	}*/

	let doSharpening = (doGain || valueIsChanged('waveletsAmount', waveletsAmount.value) || valueIsChanged('waveletsRadius', waveletsRadius.value));
	if( doSharpening ){
		console.log('wavelets');
		sharpenedImageData = await waveletSharpenInWorker(preNoiseReducedImageData, parseFloat(waveletsAmount.value), parseFloat(waveletsRadius.value));
		ctx.putImageData(sharpenedImageData, 0, 0);
	}
		
	if( postNoiseReduction.value == -1 ){
		postNoiseReduction.value = 0;
	}

	if( (doSharpening && postNoiseReduction.value >= 3) || valueIsChanged('postNoiseReduction', postNoiseReduction.value) && postNoiseReduction.value >= 3 ){
		console.log('postNoise');
		const srcMat = imageDataToMat(sharpenedImageData);
		const dstMat = new cv.Mat();
		cv.cvtColor(srcMat, srcMat, cv.COLOR_RGBA2RGB, 0);
		cv.GaussianBlur(srcMat, dstMat, new cv.Size(parseInt(postNoiseReduction.value, 10), parseInt(postNoiseReduction.value, 10)), 0, 0, cv.BORDER_DEFAULT);
		cv.imshow('postProcessCanvas', dstMat);
	}

	redoChromaticAberration()

}, 250);

function imageDataToMat(imageData) {
	let mat = new cv.Mat(imageData.height, imageData.width, cv.CV_8UC4);
	mat.data.set(imageData.data);
	return mat;
}

function logCopy(name, array){
	if( array === undefined ){
		console.log(name, 'undefined');
		return;
	}
	console.log(name, JSON.parse(JSON.stringify(array)));
}

function applyConditionalGain(imageData, gain, threshold, reducedGainFactor) {
	const data = imageData.data;
	const width = imageData.width;
	const height = imageData.height;
	const newData = new Uint8ClampedArray(data.length);

	for (let i = 0; i < data.length; i += 4) {
		// For RGB channels
		for (let j = 0; j < 3; j++) {
			const value = data[i + j];
			const applyFullGain = value > threshold; // Determine whether to apply full gain
			const effectiveGain = applyFullGain ? gain : gain * reducedGainFactor;
			newData[i + j] = value * effectiveGain;
		}
		// Copy the alpha channel without change
		newData[i + 3] = data[i + 3];
	}

	return new ImageData(newData, width, height);
}

function waveletSharpenInWorker(imageData, amount, radius){
	const width = imageData.width
	const height = imageData.height;
	return new Promise((resolve, reject) => {

		function handleWorkerMsg(e){
			// Get the processed image data from the worker
			const { imageData } = e.data;

			console.log('imageDataaa', imageData);

			waveletWorker.removeEventListener('message', handleWorkerMsg)
			resolve(imageData);
		}

		waveletWorker.addEventListener('message', handleWorkerMsg);

		waveletWorker.postMessage({ imageData: imageData.data, width, height, amount, radius });	
	});
}

let fixedAberration = reactive({});

function processChromaticAberration(channel, axis, magnitude){
	fixChromaticAberration(canvas.value, channel, axis, magnitude);

	if( fixedAberration[channel] == undefined ){
		fixedAberration[channel] = reactive({});
	}

	if( fixedAberration[channel][axis] == undefined ){
		fixedAberration[channel][axis] = 0;
	}
	
	fixedAberration[channel][axis] += magnitude;
}

function redoChromaticAberration(){
	for( const channel in fixedAberration ){
		for( const axis in fixedAberration[channel] ){
			fixChromaticAberration(canvas.value, channel, axis, fixedAberration[channel][axis])
		}
	}
}

function fixChromaticAberration(canvas, channel, axis, magnitude) {
	const ctx = canvas.getContext('2d');
	const width = canvas.width;
	const height = canvas.height;

	// Get the image data
	const imageData = ctx.getImageData(0, 0, width, height);
	const data = imageData.data;

	// Create a copy of the original image data
	const originalData = new Uint8ClampedArray(data);

	for (let i = 0; i < data.length; i += 4) {
		// Calculate the pixel index adjustment based on axis and magnitude
		let indexAdjustment = 0;
		if (axis === 'x') {
			// Moving horizontally
			indexAdjustment = magnitude * -4; // Each pixel is 4 units in data (RGBA)
		} else if (axis === 'y') {
			// Moving vertically
			indexAdjustment = magnitude * width * -4; // Moving a full width's worth of pixels up or down
		}

		// Adjust specified color channels
		const channelIndexes = {
			'red': 0,
			'green': 1,
			'blue': 2
		};
		const channelIndex = channelIndexes[channel] ?? null;

		// Ensure the channelIndex is valid to prevent processing undefined channels
		if (channelIndex !== null && i + channelIndex + indexAdjustment >= 0 && i + channelIndex + indexAdjustment < data.length) {
			data[i + channelIndex] = originalData[i + channelIndex + indexAdjustment];
		}
	}

	// Put the image data back to canvas
	ctx.putImageData(imageData, 0, 0);
}



</script>

<style>
canvas {

}
.controls {
	float: right;
	width: 300px; 
	background: white;
	height: 100vh;
	padding: 10px;	
}
.color-alignment button {
	margin-right: 2px;
	min-width: 66px;
}
</style>


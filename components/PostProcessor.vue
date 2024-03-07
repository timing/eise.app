<template>
<div>
	<div class="controls">
		<h4>Wavelets sharpen</h4>
		<div>
			<label>Gain:</label>
			<input type="range" min="0" max="3" step="0.01" v-model="gain" @input="applyProcessing"/>
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

		<button class="download" @click="downloadCanvasAsPNG">Save / Download as PNG</button>

	</div>
	<div class="wrapper">
		<ZoomableCanvas id="postProcessCanvas" @canvasReady="handleCanvasReady" />
	</div>
</div>
</template>

<script setup>
import { ref, onMounted, watch, defineProps } from 'vue';
import { throttle } from 'lodash';
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
	link.download = 'PICS_stacked_pps.png';
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
const waveletsRadius = ref(0);
const waveletsAmount = ref(0);
const bilateralFraction = ref(0.5);
const bilateralRange = ref(50);
const postNoiseReduction = ref(0);

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
	};
	img.src = URL.createObjectURL(file);
}

const applyProcessing = throttle(async() => {
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
		
	if( postNoiseReduction.value == -1 ){
		postNoiseReduction.value = 0;
	}

	if( valueIsChanged('postNoiseReduction', postNoiseReduction.value) && postNoiseReduction.value >= 3 ){
		const srcMat = imageDataToMat(sharpenedImageData);
		const dstMat = new cv.Mat();
		cv.cvtColor(srcMat, srcMat, cv.COLOR_RGBA2RGB, 0);
		cv.GaussianBlur(srcMat, dstMat, new cv.Size(parseInt(postNoiseReduction.value, 10), parseInt(postNoiseReduction.value, 10)), 0, 0, cv.BORDER_DEFAULT);
		cv.imshow('postProcessCanvas', dstMat);
	}
}, 100);

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
.download {
	margin-top: 10px;
}
</style>


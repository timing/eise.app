<template>
	<div>
		<canvas ref="canvasRef"></canvas>
	</div>
</template>

<script setup>
import { onMounted, ref, watch, defineProps } from 'vue';
import { calculateSharpness } from '@/utils/sobel.js'

const props = defineProps({
	frames: Array
});
const canvasRef = ref(null);

onMounted(() => {
	if (props.frames) {
		processImageFrames(props.frames);
	}
});

watch(() => props.frames, (newVal) => {
	if (newVal) {
		processImageFrames(newVal);
	}
});

async function processImageFrames(frames) {
	if (!canvasRef.value) return;

	const ctx = canvasRef.value.getContext('2d', {willReadFrequently: true});

	const promises = [];

	let bestFrame = 0;

	for( const frame in frames ){

		const promise = new Promise((resolve, reject) => {

			const frameData = frames[frame].data;
			const blob = new Blob([frameData], { type: 'image/png' });
			const url = URL.createObjectURL(blob);
			const img = new Image();

			img.onload = () => {
				canvasRef.value.width = img.width;
				canvasRef.value.height = img.height;
				//ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height);
				ctx.drawImage(img, 0, 0);

				frames[frame].imageData = ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height);
				frames[frame].sharpness = calculateSharpness(frames[frame].imageData);	
				frames[frame].center_of_gravity = calculateCenterOfGravity(frames[frame].imageData);

				console.log(frames[frame].center_of_gravity);

				frames[frame].data = null;

				if( frames[frame].sharpness > frames[bestFrame].sharpness ){
					bestFrame = frame;
				}

				URL.revokeObjectURL(url); // Clean up the object URL after drawing the image

				resolve(); 
			};
			img.src = url;

		});

		promises.push(promise); // Add the promise to the array
	}

	await Promise.all(promises); // Wait for all frame processing promises to resolve

	// Disregard all the upcoming code, this was too difficult for now :)
	// Let's loop all 10% best images maybe?
	// add a slider so all images can be seen?

	return;
		
	const referenceCoG = frames[bestFrame].center_of_gravity; // Using the best frame as reference

	for( const frame in frames ){

		// Calculate displacements
		const frameCoG = frames[frame].center_of_gravity;
		const dx = referenceCoG.x - frameCoG.x;
		const dy = referenceCoG.y - frameCoG.y;

		//ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height);

		ctx.putImageData(frames[frame].imageData, dx, dy);

		// Store the canvas or its ImageData for further processing
		frames[frame].imageData = ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height)
	}

	console.log(frames);
		
	//ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height);

	console.log('clear canvas', canvasRef.value.width, canvasRef.value.height);

	// Loop all centered frames
	let curFrame = 0;
	setInterval(function(){
		if( !frames[curFrame] ){
			curFrame = 0;
		}
		ctx.putImageData(frames[curFrame].imageData, 0, 0);
		ctx.fillStyle = 'red';
		console.log(referenceCoG.x -2, referenceCoG.y -2);
		ctx.fillRect(referenceCoG.x -2, referenceCoG.y -2, 5, 5);
		ctx.fillStyle = 'blue';
		ctx.fillRect(10, 10, 5, 5);
		curFrame++;
	}, 200);
	return;

	//ctx.putImageData(stackFramesMedian(frames), 0, 0);

	/* stackImages(frames).then((resultImageData) => {
		if (canvasRef.value && resultImageData) {
			ctx.putImageData(resultImageData, 0, 0);
			console.log('Done with openCV stack');
		}
	});*/

	const openCVStack = stackImagesWithOpenCV(frames);

	console.log('stackData', openCVStack);

	ctx.putImageData(openCVStack, 0, 0);
	console.log('Done with better openCV stack');
}
async function stackImages(frames) {
	if (!cv || !cv.Mat) {
		console.error('OpenCV not loaded');
		return;
	}

	let width = frames[0].imageData.width;
	let height = frames[0].imageData.height;
	
	// Create a new OpenCV Mat to store the result
	let resultMat = new cv.Mat(height, width, cv.CV_8UC4);
	let tempMat = new cv.Mat(height, width, cv.CV_8UC4);

	// Convert ImageData objects to OpenCV Mats and accumulate
	frames.forEach((frame, index) => {
		let mat = cv.matFromImageData(frame.imageData);
		if (index === 0) {
			mat.copyTo(resultMat);
		} else {
			cv.addWeighted(resultMat, index / (index + 1), mat, 1 / (index + 1), 0, tempMat);
			tempMat.copyTo(resultMat);
		}
		mat.delete();
	});
	tempMat.delete();

	// Convert the result Mat back to ImageData (if needed for further processing/display)
	let resultImageData = new ImageData(new Uint8ClampedArray(resultMat.data), width, height);
	resultMat.delete();
	
	return resultImageData;
}

</script>

<style>
	canvas {
		width: 500px;
		height: 320px;
	}
</style>

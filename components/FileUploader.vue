<template>
<div>
	<div class="card">
		<label for="file-upload">
			<h3>Select file(s)</h3>
			<input id="file-upload" type="file" accept="video/*,image/*,.ser" multiple @change="onFileChanged" />
			<p>Max filesize: 2G (or use file trimmer below)</p>
		</label>

		<LoadingIndicator />

		<div class="separator"></div>

		<h4>Maximum number of frames to analyze</h4>
		<input type="range" min="2" max="5000" step="1" v-model="maxFrames" /> {{ maxFrames }}
		<p>Memory issues? Lower the amount of frames imported from the video.</p>
		
		<div class="separator"></div>

		<h4>File trimmer</h4>
		<label>
			<input type="checkbox" id="maxFileSizeCut" v-model="maxFileSizeCut" />
			Only loads the first 2G of the selected file.
		</label>
		<p>(FFmpeg might not like this.)</p>
	
	</div>
	<div class="content">
		<h2>Welcome to eise.app</h2>
		<h3>An easy planetary image stacker for astrophotography</h3>
		<p>Turn your blurry and shaky videos of planets into one stacked and sharp image.</p>
	
		<ul>
			<li>Select one video file for stacking followed by post processing.</li>
			<!-- <li>Coming soon: Select multiple image files for stacking and post processing.</li> -->
			<li>Select one image file for post processing only.</li>
		</ul>	

		<p>When stacking a video, eise.app will first analyze all frames, and then use 30% of the best frames for stacking.</p>

	</div>
</div>
</template>

<script setup>
import { fetchFile } from '@ffmpeg/ffmpeg';
import { defineEmits, ref } from 'vue';
import { useEventBus } from '@/composables/eventBus';

const { $ffmpeg, $loadFFmpeg } = useNuxtApp();

const maxFrames = ref(1000)
const maxFileSizeCut = ref(false);

const emit = defineEmits(['singleFrame', 'frames', 'postProcessing', 'lastFrame']);

const { addLog } = useEventBus();

let ffmpeg = null;

async function onFileChanged(event){
	useEventBus().emit('start-loading');
	await processVideo(event);
	useEventBus().emit('stop-loading');
}

async function processVideo(event) {

	const files = Array.from(event.target.files); // Convert FileList to Array

	console.log(files);
	
	const videoFiles = files.filter(file => file.type.startsWith('video/') || file.name.endsWith('.ser'));
	const imageFiles = files.filter(file => file.type.startsWith('image/'));

	if (videoFiles.length > 1) {
		alert('Please select only one video file.');
		return;
	}

	if (videoFiles.length === 1 && imageFiles.length > 0) {
		alert('Please select either a video file or image files, not both.');
		return;
	}

	let filesInternal = [];

	const frames = [];

	if( videoFiles.length == 1 ){


		let fileToProcess = videoFiles[0]; // Default to the first file selected
		
		if( maxFileSizeCut.value  ){
			const MAX_SIZE = 1.9 * 1024 * 1024 * 1024; // First int is the amount of GB

			// If the file is larger than MAX_SIZE, trim it
			if (fileToProcess.size > MAX_SIZE) {
				const trimmedBlob = fileToProcess.slice(0, MAX_SIZE);
				console.log(trimmedBlob);
				fileToProcess = new File([trimmedBlob], fileToProcess.name, { type: fileToProcess.type });
				addLog('File trimmed to fit within the memory limit');
			}
		}

		await $loadFFmpeg();

		// Storing video in memory
		addLog('Storing video in memory');
		await $ffmpeg.FS('writeFile', fileToProcess.name, await fetchFile(fileToProcess));
		fileToProcess = null;
		addLog('Storing video in memory done');
		
		//await $ffmpeg.run('-formats');

		// Extract frames from the video
		try {
			await $ffmpeg.run('-i', videoFiles[0].name, '-vframes', '' + maxFrames.value + '', 'out%d.png');
		} catch(err){
			console.log(err);
			addLog('FFmpeg forcefully exited, but continuing!');
		}

		addLog('Cleaning up ffmpeg memory');

		filesInternal = $ffmpeg.FS('readdir', '.').filter(file => file.endsWith('.png'));
		
		$ffmpeg.FS('unlink', videoFiles[0].name);

		addLog('Cleanup done. Analyzing frames for quality.');

		emit('frames', filesInternal);
	
	} else if( imageFiles.length == 1 ){

		if( ['image/png', 'image/jpg', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].indexOf(imageFiles[0].type) == -1 ){
		
			addLog('One image selected that is not natively supported by browsers, converting..');

			await $loadFfmpeg();

			$ffmpeg.FS('writeFile', imageFiles[0].name, await fetchFile(imageFiles[0]));

			await $ffmpeg.run('-i', imageFiles[0].name, imageFiles[0].name + '.png');

			const data = $ffmpeg.FS('readFile', imageFiles[0].name + '.png');

			console.log(data);

			const blob = new Blob([data.buffer], { type: 'image/png' });

			$ffmpeg.FS('unlink', imageFiles[0].name);
			$ffmpeg.FS('unlink', imageFiles[0].name + '.png');

			addLog('Load post processing');

			emit('postProcessing', blob)
		} else {

			addLog('One image selected that is supported right away, load post processing');
			emit('postProcessing', imageFiles[0]);
		}
	} else if( imageFiles.length >= 2 ){

		// TODO tiff etc need to be changed to PNG

		// filesInternal = imageFiles;
		frames = imageFiles;

		emit('frames', frames);
	}	
}

</script>

<style>
.file-upload-wrapper {
	display: block;
	color: #003366;
	border: 3px dashed #003366;
	border-radius: 10px;
	margin: 20px auto;
	padding: 20px 40px;
	cursor: pointer;
}
.file-upload-wrapper ul {
	padding-left: 0;
}
.file-upload-wrapper:hover {
	background: #ffeeff;
}
</style>

<template>
<div>
	<div class="content">
		<h2>Welcome to Planetary Image Cloud Stacker!</h2>
		<p>The name says what it is, maybe a bit boring though. Get started by uploading a video file.</p>
	</div>
	<label class="file-upload-wrapper" for="file-upload">
		<h3>Select file(s)</h3>
		<input id="file-upload" type="file" accept="video/*,image/*,.ser" multiple @change="onFileChanged" />
		<ul>
			<li>Select one video file for stacking and post processing.</li>
			<li>Coming soon: Select multiple image files for stacking and post processing.</li>
			<li>Select one image file for post processing only.</li>
			<li>Max 2k frames are extracted from video files. 30% or 300 frames are used for the final stack.</li>
			<li>For now choosing video files smaller than 2GB works, but let us find the limit!</li>
		</ul>
	</label>
</div>
</template>

<script setup>
import { fetchFile } from '@ffmpeg/ffmpeg';
import { defineEmits, ref } from 'vue';
import { useEventBus } from '@/composables/eventBus';

const { $ffmpeg, $loadFFmpeg } = useNuxtApp();

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

		addLog('Video selected, we need to convert this to a bunch of PNGs');

		await $loadFFmpeg();
		
		// Write the video file to the FFmpeg filesystem
		addLog('Storing video in memory');
		$ffmpeg.FS('writeFile', videoFiles[0].name, await fetchFile(videoFiles[0]));

		//await $ffmpeg.run('-formats');

		// Extract frames from the video
		await $ffmpeg.run('-i', videoFiles[0].name, '-vframes', '2500', 'out%d.png');

		addLog('Analyzing frames for quality, and cleaning up memory');

		filesInternal = $ffmpeg.FS('readdir', '.').filter(file => file.endsWith('.png'));
		
		$ffmpeg.FS('unlink', videoFiles[0].name);

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
	max-width: 400px;
	margin: 80px auto 50px auto;
	padding: 50px;
	cursor: pointer;
}
.file-upload-wrapper ul {
	padding-left: 0;
}
.file-upload-wrapper:hover {
	background: #ffeeff;
}
</style>

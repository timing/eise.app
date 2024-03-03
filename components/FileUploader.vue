<template>
	<label class="file-upload-wrapper" for="file-upload">
		<input id="file-upload" type="file" accept="video/*,image/*,.ser" multiple @change="processVideo" />
		<h3>Select file(s)</h3>
		<ul>
			<li>Select one video file for stacking and post processing.</li>
			<li>Coming soon: Select multiple image files for stacking and post processing.</li>
			<li>Select one image file for post processing only.</li>
		</ul>
	</label>
</template>

<script setup>
import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';
import { defineEmits, ref } from 'vue';
import { useEventBus } from '@/composables/eventBus';

const emit = defineEmits(['frames', 'postProcessing']);

const { addLog } = useEventBus();


let ffmpeg = null;

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

		await loadFfmpeg();
		
		// Write the video file to the FFmpeg filesystem
		ffmpeg.FS('writeFile', videoFiles[0].name, await fetchFile(videoFiles[0]));

		// Extract frames from the video
		await ffmpeg.run('-i', videoFiles[0].name, 'out%d.png');

		filesInternal = ffmpeg.FS('readdir', '.').filter(file => file.endsWith('.png'));

		for (const file of filesInternal) {
			const data = ffmpeg.FS('readFile', file);
			frames.push({data: new Uint8Array(data)}); // Emit each frame's data
			ffmpeg.FS('unlink', file); // Optionally, clean up by removing the file after processing
		}
		ffmpeg.FS('unlink', videoFiles[0].name);

	} else if( imageFiles.length == 1 ){

		console.log('typecheck', imageFiles[0].type, ['image/png', 'image/jpg', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].indexOf(imageFiles[0].type));

		if( ['image/png', 'image/jpg', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].indexOf(imageFiles[0].type) == -1 ){
		
			addLog('One image selected that is not natively supported by browsers, converting..');

			await loadFfmpeg();

			ffmpeg.FS('writeFile', imageFiles[0].name, await fetchFile(imageFiles[0]));

			await ffmpeg.run('-i', imageFiles[0].name, imageFiles[0].name + '.png');

			const data = ffmpeg.FS('readFile', imageFiles[0].name + '.png');

			console.log(data);

			const blob = new Blob([data.buffer], { type: 'image/png' });

			ffmpeg.FS('unlink', imageFiles[0].name);
			ffmpeg.FS('unlink', imageFiles[0].name + '.png');

			addLog('Load post processing');

			emit('postProcessing', blob)
		} else {

			addLog('One image selected that is supported right away, load post processing');
			emit('postProcessing', imageFiles[0]);
		}
	} else if( imageFiles.length >= 2 ){

		// TODO tiff's need to be changed to PNG

		// filesInternal = imageFiles;
		frames = imageFiles;
	}
	
	emit('frames', frames);
	
}

async function loadFfmpeg(){
	if( ffmpeg ){
		return;
	}

	addLog('Loading FFmpeg')

	ffmpeg = createFFmpeg({ 
		corePath: 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js',
		log: true 
	});
	
	await ffmpeg.load();

	addLog('Loading FFmpeg done');

	ffmpeg.setLogger(({ type, message }) => {
		if( message.includes('frame=') ){
			addLog(message);
		}
	}) 
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
.file-upload-wrapper:hover {
	background: #ffeeff;
}
</style>

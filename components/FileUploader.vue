<template>
	<div>
		<input type="file" accept="video/*,image/*,.ser" multiple @change="processVideo" />
		Select one file for just post processing
	</div>
</template>

<script setup>
import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';
import { defineEmits, ref } from 'vue';

const emit = defineEmits(['frames', 'postProcessing']);

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
			await loadFfmpeg();

			ffmpeg.FS('writeFile', imageFiles[0].name, await fetchFile(imageFiles[0]));

			await ffmpeg.run('-i', imageFiles[0].name, imageFiles[0].name + '.png');

			const data = ffmpeg.FS('readFile', imageFiles[0].name + '.png');

			console.log(data);

			const blob = new Blob([data.buffer], { type: 'image/png' });

			ffmpeg.FS('unlink', imageFiles[0].name);
			ffmpeg.FS('unlink', imageFiles[0].name + '.png');

			emit('postProcessing', blob)
		} else {
			emit('postProcessing', imageFiles[0]);
		}
	} else if( imageFiles.length >= 2 ){

		// tiff's need to be changed to PNG

		filesInternal = imageFiles;
	}
	
	emit('frames', frames);
	
}

async function loadFfmpeg(){
	if( ffmpeg ){
		return;
	}
	ffmpeg = createFFmpeg({ 
		corePath: 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js',
		log: true 
	});

	await ffmpeg.load();
}
</script>


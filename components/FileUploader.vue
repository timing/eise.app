<template>
	<div>
		<input type="file" accept="video/*,image/*" multiple @change="processVideo" />
		Select one file for just post processing
	</div>
</template>

<script setup>
import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';
import { defineEmits, ref } from 'vue';

const emit = defineEmits(['frames']);

async function processVideo(event) {

	const files = Array.from(event.target.files); // Convert FileList to Array
        
	const videoFiles = files.filter(file => file.type.startsWith('video/'));
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
		const ffmpeg = createFFmpeg({ 
			corePath: 'https://unpkg.com/@ffmpeg/core@0.10.0/dist/ffmpeg-core.js',
			log: true 
		});

		await ffmpeg.load();

		// Write the video file to the FFmpeg FS (filesystem)
		ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(videoFiles[0]));

		// Extract frames from the video
		await ffmpeg.run('-i', 'input.mp4', 'out%d.png');

		filesInternal = ffmpeg.FS('readdir', '.').filter(file => file.endsWith('.png'));

		for (const file of filesInternal) {
			const data = ffmpeg.FS('readFile', file);
			frames.push({data: new Uint8Array(data)}); // Emit each frame's data
			ffmpeg.FS('unlink', file); // Optionally, clean up by removing the file after processing
		}

	} else if( imageFiles.length == 1 ){
		emit('postProcessing', imageFiles[0]);
	} else if( imageFiles.length >= 2 ){
		filesInternal = imageFiles;
	}
	
	emit('frames', frames);
	
}
</script>


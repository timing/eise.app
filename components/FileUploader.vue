<template>
<div>
	<div class="card">
		<label for="file-upload">
			<h3>Select file(s)</h3>
			<input id="file-upload" type="file" accept="video/*,image/*,.ser" multiple @change="onFileChanged" />
		</label>

		<LoadingIndicator />

		<div class="separator"></div>

		<h4>Maximum number of frames to analyze</h4>
		<label>
			<input type="checkbox" v-model="enableMaxFrames" />
			Enable max frames to analyze
		</label>
		<input type="range" min="2" max="5000" step="1" v-model="selectedMaxFrames" :disabled="!enableMaxFrames" /> 
		{{ enableMaxFrames ? selectedMaxFrames : 'Unlimited' }}
		<p>Memory issues? Lower the amount of frames imported from the video.</p>
		
		<div class="separator"></div>

		<h4>SER file color profile</h4>
		<select v-model="bayerPattern">
			<option value="AUTO">Auto-Detect</option>
			<option value="COLOR_BayerRG2RGB">RGGB</option>
			<option value="COLOR_BayerBG2RGB">BGGR</option>
			<option value="COLOR_BayerGB2RGB">GBRG</option>
			<option value="COLOR_BayerGR2RGB">GRBG</option>
			<option value="MONO">Monochrome</option>
		</select>
		<p>For .ser files, you can manually select the color pattern if auto-detection fails.</p>
	
	</div>
	<div class="content">
		<h2>Welcome to eise.app</h2>
		<h3>An easy planetary image stacker for astrophotography</h3>
		<p>Turn your blurry and shaky videos of planets into one stacked and sharp image.</p>
	
		<ul>
			<li>Select one video file for stacking followed by post processing.</li>
			<li>Using SER files is highly recommended, as it allows better memory management.</li>
			<!-- <li>Coming soon: Select multiple image files for stacking and post processing.</li> -->
			<li>Select one image file for post processing only.</li>
		</ul>	

		<p>When stacking a video, eise.app will first analyze all frames, and then use 30% of the best frames for stacking.</p>

		<h3>More information, bugs and feature requests?</h3>
		<p>Read more about Eise.app on the About page, or head over to <a href="https://github.com/timing/eise.app" target="_blank">Eise.app on Github</a>.</p>

	</div>
</div>
</template>

<script setup>
import { fetchFile } from '@ffmpeg/ffmpeg';
import { defineEmits, ref } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useSerReader } from '@/composables/useSerReader';

const { $ffmpeg, $loadFFmpeg } = useNuxtApp();

const enableMaxFrames = ref(false);
const selectedMaxFrames = ref(5000);

const bayerPattern = ref('COLOR_BayerRG2RGB');

const emit = defineEmits(['frames', 'postProcessing', 'processing-started']);

const { addLog, emit: eventBusEmit } = useEventBus();

async function onFileChanged(event){
	eventBusEmit('start-loading');
	await processVideo(event);
	eventBusEmit('stop-loading');
}

async function processVideo(event) {

	const files = Array.from(event.target.files); 
	
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

	if( videoFiles.length == 1 ){
		emit('processing-started');
		let fileToProcess = videoFiles[0];
		
		const MAX_SIZE = 1.9 * 1024 * 1024 * 1024;
		if (!fileToProcess.name.endsWith('.ser') && fileToProcess.size > MAX_SIZE) {
			if (confirm('The selected file is larger than 2GB. Do you want to trim it to 2GB? This might not work for all video formats.')) {
				const trimmedBlob = fileToProcess.slice(0, MAX_SIZE);
				fileToProcess = new File([trimmedBlob], fileToProcess.name, { type: fileToProcess.type });
				addLog('File trimmed to fit within the memory limit');
			}
		}

		if (fileToProcess.name.endsWith('.ser')) {
			const { readSerFile } = useSerReader();
			const maxFramesValue = enableMaxFrames.value ? selectedMaxFrames.value : -1;
			await readSerFile(fileToProcess, maxFramesValue, bayerPattern.value);
			// The new useSerReader handles the whole pipeline
			return;
		}

		eventBusEmit('set-caption', 'Importing frames from video');
		await $loadFFmpeg();

		addLog('Storing video in memory');
		await $ffmpeg.FS('writeFile', fileToProcess.name, await fetchFile(fileToProcess));
		addLog('Storing video in memory done');
		
		try {
			const frameLimit = enableMaxFrames.value ? ['-vframes', '' + selectedMaxFrames.value + ''] : [];
			await $ffmpeg.run('-i', videoFiles[0].name, ...frameLimit, 'out%d.png');
		} catch(err){
			console.log(err);
			addLog('FFmpeg forcefully exited, but continuing!');
		}

		addLog('Cleaning up ffmpeg memory');
		const filesInternal = $ffmpeg.FS('readdir', '.').filter(file => file.endsWith('.png'));
		$ffmpeg.FS('unlink', videoFiles[0].name);
		addLog('Cleanup done. Analyzing frames for quality.');

		emit('frames', filesInternal);
	
	} else if( imageFiles.length == 1 ){
		// ... (rest of the image logic is unchanged)
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

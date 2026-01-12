<template>
<div>
	<div class="card">
		<!-- LoadingIndicator always mounted so it can receive events -->
		<LoadingIndicator />

		<!-- Cancel button during processing -->
		<div v-if="isProcessing" class="action-buttons processing-actions">
			<button class="cancel-button" @click="cancelProcessing">Cancel</button>
		</div>

		<!-- Initial state: file selection and settings (hidden during processing) -->
		<template v-if="!isProcessing">
			<label for="file-upload">
				<h3>Select file(s)</h3>
				<input id="file-upload" ref="fileInput" type="file" accept="video/*,image/*,.ser" multiple @change="onFileChanged" />
			</label>

			<div v-if="selectedFiles.length > 0" class="selected-files">
				<p><strong>Selected:</strong> {{ selectedFilesDescription }}</p>
				<div class="action-buttons">
					<button class="start-button" @click="startProcessing">{{ startButtonText }}</button>
					<button class="clear-button" @click="clearSelection">Clear</button>
				</div>
			</div>

			<div v-if="errorMessage" class="error-message">
				<p>{{ errorMessage }}</p>
			</div>

			<div v-if="hasSerFiles" class="ser-option">
				<label>
					<input type="checkbox" v-model="serThroughFfmpeg" />
					Run SER through FFmpeg first (debug)
				</label>
			</div>

			<div class="separator"></div>

			<h4>Max frames <span class="info-icon" @click="showMaxFramesInfo = !showMaxFramesInfo">ⓘ</span></h4>
			<label>
				<input type="checkbox" v-model="enableMaxFrames" />
				Limit frames
			</label>
			<input type="range" min="2" max="5000" step="1" v-model="selectedMaxFrames" :disabled="!enableMaxFrames" />
			{{ enableMaxFrames ? selectedMaxFrames : '∞' }}
			<p v-if="showMaxFramesInfo" class="info-text">Lower this if you experience memory issues.</p>

			<div class="separator"></div>

			<h4>Crop margin <span class="info-icon" @click="showCropMarginInfo = !showCropMarginInfo">ⓘ</span></h4>
			<input type="range" min="5" max="50" step="5" v-model="cropMarginPercent" />
			{{ cropMarginPercent }}%
			<p v-if="showCropMarginInfo" class="info-text">Extra space around detected object. Increase for Saturn's rings, decrease for tighter crops.</p>

			<div class="separator"></div>

			<h4>Quality threshold</h4>
			<label>
				<input type="checkbox" v-model="autoStack" />
				Just stack the best 30%, no manual selection
			</label>
			<p v-if="!autoStack" class="info-text">After analysis, you'll see a quality graph and can choose which frames to stack. Note: this keeps all frames in memory.</p>
			<p v-if="autoStack" class="info-text">Recommended for large files or multiple SER files. Only keeps the best frames in memory.</p>
		</template>
	</div>

	<!-- Welcome content: only show when not processing -->
	<div class="content" v-if="!isProcessing">
		<h2>Welcome to eise.app</h2>
		<h3>An easy planetary image stacker for astrophotography</h3>
		<p>Turn your blurry and shaky videos of planets into one stacked and sharp image using <em>lucky imaging</em>.</p>
		<ul>
			<li>Select one or more SER files for stacking followed by post processing. (Multiple SER files will be combined)</li>
			<li>Select one video file (AVI, MP4, etc.) for stacking followed by post processing.</li>
			<li>Select multiple image files (TIFF, PNG, JPG, etc.) for stacking and post processing.</li>
			<li>Select one image file for post processing only.</li>
		</ul>
		<p>When stacking, eise.app will first analyze all frames/images, and then use 30% of the best ones for stacking.</p>
		<h3>More information, bugs and feature requests?</h3>
		<p>Read more about Eise.app on the <a href="#" @click.prevent="showAbout">About page</a>, or head over to <a href="https://github.com/timing/eise.app" target="_blank">Eise.app on Github</a>.</p>
	</div>
</div>
</template>

<script setup>
import { fetchFile } from '@ffmpeg/ffmpeg';
import { computed, defineEmits, ref } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useSerReader } from '@/composables/useSerReader';
import { useAviReader } from '@/composables/useAviReader';
import { useImageReader } from '@/composables/useImageReader';
import { useProcessingState } from '@/composables/useProcessingState';

const { $ffmpeg, $loadFFmpeg } = useNuxtApp();

const enableMaxFrames = ref(false);
const selectedMaxFrames = ref(5000);

// Always enable auto-crop and client-side stacking
const enableAutoCrop = true;
const enableClientSideStacking = true;

const errorMessage = ref(null);

// Info toggle state
const showMaxFramesInfo = ref(false);
const showCropMarginInfo = ref(false);

// Crop margin setting (percentage of detected object size to add as margin)
const cropMarginPercent = ref(10);

// Auto-stack option (when checked, skip manual threshold selection)
const autoStack = ref(false);

// Debug option: route SER through FFmpeg instead of direct reader
const serThroughFfmpeg = ref(false);

const selectedFiles = ref([]);
const isProcessing = ref(false);
const fileInput = ref(null);

const emit = defineEmits(['frames', 'postProcessing', 'processing-started', 'showAbout']);

const selectedFilesDescription = computed(() => {
	if (selectedFiles.value.length === 0) return '';
	if (selectedFiles.value.length === 1) return selectedFiles.value[0].name;
	return `${selectedFiles.value.length} files`;
});

// Check if any selected files are SER files
const hasSerFiles = computed(() => {
	return selectedFiles.value.some(f => f.name.endsWith('.ser'));
});

const startButtonText = computed(() => {
	if (selectedFiles.value.length === 1) {
		const file = selectedFiles.value[0];
		if (file.type.startsWith('image/')) {
			return 'Post process';
		}
	}
	return 'Stack';
});

const { addLog, emit: eventBusEmit, on } = useEventBus();

// Listen for upload errors to display them
on('upload-error', (message) => {
	errorMessage.value = message;
});

function onFileChanged(event){
	errorMessage.value = null; // Clear previous error
	selectedFiles.value = Array.from(event.target.files);
	eventBusEmit('stop-loading');
}

async function startProcessing() {
	if (selectedFiles.value.length === 0) return;
	errorMessage.value = null;
	isProcessing.value = true;
	eventBusEmit('start-loading', 'Preparing...');
	try {
		await processFiles(selectedFiles.value);
	} catch (error) {
		console.error('Processing error:', error);
		errorMessage.value = error.message || 'An error occurred during processing';
		isProcessing.value = false;
		eventBusEmit('show-error');
	}
}

function cancelProcessing() {
	isProcessing.value = false;
	selectedFiles.value = [];
	if (fileInput.value) {
		fileInput.value.value = '';
	}
	eventBusEmit('stop-loading');
	eventBusEmit('cancel-processing');
	window.location.reload();
}

function clearSelection() {
	selectedFiles.value = [];
	if (fileInput.value) {
		fileInput.value.value = '';
	}
	errorMessage.value = null;
}

function showAbout() {
	emit('showAbout');
}

async function processFiles(files) {
	const { setInputFilename } = useProcessingState();

	const videoFiles = files.filter(file => file.type.startsWith('video/') || file.name.endsWith('.ser') || file.name.endsWith('.avi'));
	const imageFiles = files.filter(file => file.type.startsWith('image/'));

	// Set the input filename for output file naming
	const primaryFile = videoFiles[0] || imageFiles[0];
	if (primaryFile) {
		setInputFilename(primaryFile.name);
	}

	// Multiple SER files are allowed - they'll be combined for stacking
	// But mixing video types or mixing videos with images is not allowed
	const serFiles = videoFiles.filter(f => f.name.endsWith('.ser'));
	const nonSerVideos = videoFiles.filter(f => !f.name.endsWith('.ser'));

	if (serFiles.length > 0 && nonSerVideos.length > 0) {
		alert('Please select either SER files or other video files, not both.');
		isProcessing.value = false;
		eventBusEmit('stop-loading');
		return;
	}

	if (nonSerVideos.length > 1) {
		alert('Please select only one video file (multiple SER files are supported).');
		isProcessing.value = false;
		eventBusEmit('stop-loading');
		return;
	}

	if (videoFiles.length >= 1 && imageFiles.length > 0) {
		alert('Please select either a video file or image files, not both.');
		isProcessing.value = false;
		eventBusEmit('stop-loading');
		return;
	}

	// Handle multiple SER files (combined stacking) - only when NOT routing through FFmpeg
	if (serFiles.length > 1 && !serThroughFfmpeg.value) {
		emit('processing-started');
		const { readSerFiles } = useSerReader();
		const maxFramesValue = enableMaxFrames.value ? selectedMaxFrames.value : -1;
		addLog(`Processing ${serFiles.length} SER files for combined stacking`);
		await readSerFiles(serFiles, maxFramesValue, enableAutoCrop, enableClientSideStacking, !autoStack.value, cropMarginPercent.value);
		return;
	}

	// When routing SER through FFmpeg, only allow single file
	if (serFiles.length > 1 && serThroughFfmpeg.value) {
		alert('Multiple SER files not supported when routing through FFmpeg. Please select a single SER file.');
		isProcessing.value = false;
		eventBusEmit('stop-loading');
		return;
	}

	if( videoFiles.length == 1 ){
		let fileToProcess = videoFiles[0];

		const MAX_SIZE = 1.9 * 1024 * 1024 * 1024;
		if (!fileToProcess.name.endsWith('.ser') && !fileToProcess.name.endsWith('.avi') && fileToProcess.size > MAX_SIZE) {
			if (confirm('The selected file is larger than 2GB. Do you want to trim it to 2GB? This might not work for all video formats.')) {
				const trimmedBlob = fileToProcess.slice(0, MAX_SIZE);
				fileToProcess = new File([trimmedBlob], fileToProcess.name, { type: fileToProcess.type });
				addLog('File trimmed to fit within the memory limit');
			}
		}

		// Handle SER files - either direct reader or through FFmpeg based on checkbox
		if (fileToProcess.name.endsWith('.ser') && !serThroughFfmpeg.value) {
			emit('processing-started');
			const { readSerFile } = useSerReader();
			const maxFramesValue = enableMaxFrames.value ? selectedMaxFrames.value : -1;
			await readSerFile(fileToProcess, maxFramesValue, enableAutoCrop, enableClientSideStacking, !autoStack.value, cropMarginPercent.value);
			return;
		}
		// When serThroughFfmpeg is true, SER falls through to FFmpeg processing below

		let needsFfmpeg = !fileToProcess.name.endsWith('.avi'); // Non-AVI always needs FFmpeg
		let expectedFrameCount = null; // From AVI header if available

		if (fileToProcess.name.endsWith('.avi')) {
			// First, just check the header (only 5MB) to see if we can process directly
			const { readAviFile, checkAviFormat } = useAviReader();

			addLog('Checking AVI format...');
			const headerProbeSize = Math.min(fileToProcess.size, 1024 * 1024 * 5);
			const headerSlice = fileToProcess.slice(0, headerProbeSize);
			const headerBuffer = await headerSlice.arrayBuffer();

			const formatInfo = await checkAviFormat(headerBuffer);

			if (formatInfo.isEasy) {
				// Can process directly - readAviFile will read frames as needed
				emit('processing-started');
				const maxFramesValue = enableMaxFrames.value ? selectedMaxFrames.value : -1;
				await readAviFile(fileToProcess, maxFramesValue, enableAutoCrop, enableClientSideStacking, !autoStack.value);
				return;
			} else {
				addLog(`AVI format '${formatInfo.fourCC}' needs FFmpeg processing.`);
				needsFfmpeg = true;
				expectedFrameCount = formatInfo.frameCount; // Use frame count from header
			}
		}

		if (!needsFfmpeg) return;

		eventBusEmit('set-caption', 'Loading FFmpeg...');
		try {
			await $loadFFmpeg();
		} catch (err) {
			eventBusEmit('upload-error', err.message || 'Failed to load FFmpeg. Please refresh and try again.');
			eventBusEmit('show-error');
			return;
		}

		eventBusEmit('set-caption', 'Importing frames from video');

		addLog('Storing video in memory');
		try {
			$ffmpeg.FS('writeFile', fileToProcess.name, await fetchFile(fileToProcess));
		} catch(err) {
			console.error('FFmpeg writeFile error:', err);
			addLog(`ffmpeg: Storing video in memory failed: ${err.message || err}`);
			eventBusEmit('upload-error', 'Failed to load video into memory. The file may be too large. Try using a SER file instead, or enable frame limiting.');
			eventBusEmit('show-error');
			return;
		}
		addLog('Storing video in memory done');

		// Only switch to processing view after we know the file loaded successfully
		emit('processing-started');

		// Set up progress tracking for FFmpeg
		let lastFrameCount = 0;
		// Use max frames limit if set, otherwise use frame count from AVI header if available
		const totalFramesTarget = enableMaxFrames.value ? selectedMaxFrames.value : expectedFrameCount;
		$ffmpeg.setLogger(({ type, message }) => {
			// Parse frame count from FFmpeg output: "frame=  304 fps= 36 ..."
			const frameMatch = message.match(/frame=\s*(\d+)/);
			if (frameMatch) {
				const currentFrame = parseInt(frameMatch[1], 10);
				if (currentFrame !== lastFrameCount) {
					lastFrameCount = currentFrame;
					if (totalFramesTarget) {
						// Show percentage if we have a target
						const progress = Math.min((currentFrame / totalFramesTarget) * 100, 100);
						eventBusEmit('update-loading', { progress, current: currentFrame, total: totalFramesTarget });
					} else {
						// Just show frame count without percentage
						eventBusEmit('update-loading', { progress: -1, current: currentFrame, total: '?' });
					}
				}
			}
		});

		try {
			const frameLimit = enableMaxFrames.value ? ['-vframes', '' + selectedMaxFrames.value + ''] : [];
			await $ffmpeg.run('-i', videoFiles[0].name, ...frameLimit, 'out%d.png');
		} catch(err){
			console.log(err);
			addLog('FFmpeg forcefully exited, but continuing!');
		}

		// Clear the logger after FFmpeg completes
		$ffmpeg.setLogger(({ message }) => {});

		addLog('Cleaning up ffmpeg memory');
		const filesInternal = $ffmpeg.FS('readdir', '.').filter(file => file.endsWith('.png'));
		$ffmpeg.FS('unlink', videoFiles[0].name);
		addLog('Cleanup done. Processing frames through AVI reader.');

		// Route FFmpeg frames through AVI reader for unified processing (including cropping)
		const { processFFmpegFrames } = useAviReader();
		await processFFmpegFrames($ffmpeg, filesInternal, enableAutoCrop, enableClientSideStacking, !autoStack.value);
	
	} else if (imageFiles.length > 1) {
		// Multiple images selected - analyze and stack them
		emit('processing-started');
		addLog(`${imageFiles.length} images selected for stacking`);

		const { readImageFiles } = useImageReader();
		await readImageFiles(imageFiles, $ffmpeg, $loadFFmpeg, !autoStack.value);

	} else if (imageFiles.length == 1) {
		// Single image - go directly to post processing
		if (['image/png', 'image/jpg', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].indexOf(imageFiles[0].type) == -1) {

			addLog('One image selected that is not natively supported by browsers, converting..');

			await $loadFFmpeg();

			$ffmpeg.FS('writeFile', imageFiles[0].name, await fetchFile(imageFiles[0]));

			await $ffmpeg.run('-i', imageFiles[0].name, imageFiles[0].name + '.png');

			const data = $ffmpeg.FS('readFile', imageFiles[0].name + '.png');

			const blob = new Blob([data.buffer], { type: 'image/png' });

			$ffmpeg.FS('unlink', imageFiles[0].name);
			$ffmpeg.FS('unlink', imageFiles[0].name + '.png');

			addLog('Load post processing');

			emit('postProcessing', blob);
		} else {

			addLog('One image selected that is supported right away, load post processing');
			emit('postProcessing', imageFiles[0]);
		}
	}
}
</script>

<style>
.error-message {
	background-color: #ffcccc;
	color: #D9534F;
	padding: 10px;
	margin-top: 10px;
	border-radius: 5px;
	font-weight: bold;
}
.ser-option {
	margin-top: 10px;
	padding: 8px;
	background-color: #fff8e0;
	border-radius: 5px;
	font-size: 12px;
}
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
.selected-files {
	margin-top: 15px;
	padding: 10px;
	background-color: #f0f8ff;
	border-radius: 5px;
}
.action-buttons {
	display: flex;
	gap: 10px;
	margin-top: 10px;
}
.start-button {
	background-color: #8CCF7E;
	color: #111;
	padding: 10px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
}
.start-button:hover {
	background-color: #7ABF6E;
}
.clear-button {
	background-color: #888;
	color: white;
	padding: 10px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
}
.clear-button:hover {
	background-color: #666;
}
.cancel-button {
	background-color: #D9534F;
	color: white;
	padding: 10px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
}
.cancel-button:hover {
	background-color: #C9302C;
}
.processing-actions {
	justify-content: center;
	margin-top: 20px;
}
.info-icon {
	cursor: pointer;
	color: #666;
	font-size: 0.9em;
	user-select: none;
}
.info-icon:hover {
	color: #333;
}
.info-text {
	font-size: 0.9em;
	color: #555;
	margin-top: 5px;
	padding: 8px;
	background: #f5f5f5;
	border-radius: 4px;
}
.info-text ul {
	margin: 0;
	padding-left: 20px;
}
</style>

<template>
	<div v-if="visible">
		<div class="card">
			<h3>Select Color Profile</h3>
			<p>Your SER file contains raw Bayer data that needs to be converted to color.</p>
			<p>Click on the thumbnail that shows the <strong>correct colors</strong> for your subject.</p>
			<p>The auto-detected profile is highlighted with a blue border, but this may not always be correct.</p>
			<LoadingIndicator />
		</div>
		<div class="content">
			<h2>Which image looks correct?</h2>
			<div class="thumbnails">
				<div
					v-for="profile in profiles"
					:key="profile.id"
					class="thumbnail-wrapper"
					:class="{ autodetected: autoDetectedProfile === profile.id }"
					@click="confirmProfile(profile.id)"
				>
					<canvas :ref="el => canvasRefs[profile.id] = el" class="thumbnail-canvas"></canvas>
					<div class="profile-label">
						{{ profile.label }}
						<span v-if="autoDetectedProfile === profile.id" class="auto-badge">auto</span>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted, nextTick, watch } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import LoadingIndicator from '@/components/LoadingIndicator.vue';

const { $loadOpenCV } = useNuxtApp();
const { on, emit: eventBusEmit } = useEventBus();

let opencvLoaded = false;

const visible = ref(false);
const autoDetectedProfile = ref(null);
const canvasRefs = ref({});
const currentResolve = ref(null);
const frameData = ref(null);
const headerData = ref(null);

const profiles = [
	{ id: 'COLOR_BayerRG2BGR', label: 'RGGB' },
	{ id: 'COLOR_BayerBG2BGR', label: 'BGGR' },
	{ id: 'COLOR_BayerGB2BGR', label: 'GBRG' },
	{ id: 'COLOR_BayerGR2BGR', label: 'GRBG' },
	{ id: 'MONO', label: 'Mono' }
];

function confirmProfile(profileId) {
	if (currentResolve.value) {
		currentResolve.value(profileId);
		currentResolve.value = null;
	}
	visible.value = false;
	eventBusEmit('color-profile-selected', profileId);
}

async function renderThumbnails() {
	await nextTick();

	// Lazy-load OpenCV for thumbnail rendering
	if (!opencvLoaded) {
		await $loadOpenCV();
		opencvLoaded = true;
	}

	const { width, height, pixelDepth } = headerData.value;
	const buffer = frameData.value;

	// Calculate thumbnail size (max 150px, maintain aspect ratio)
	const maxSize = 150;
	const scale = Math.min(maxSize / width, maxSize / height);
	const thumbWidth = Math.floor(width * scale);
	const thumbHeight = Math.floor(height * scale);

	for (const profile of profiles) {
		const canvas = canvasRefs.value[profile.id];
		if (!canvas) continue;

		canvas.width = thumbWidth;
		canvas.height = thumbHeight;

		try {
			// Create mat from buffer
			const type = pixelDepth > 8 ? cv.CV_16UC1 : cv.CV_8UC1;
			const data = pixelDepth > 8 ? new Uint16Array(buffer) : new Uint8Array(buffer);
			let mat = cv.matFromArray(height, width, type, data);

			// Convert to 8-bit
			let temp8u = new cv.Mat();
			mat.convertTo(temp8u, cv.CV_8U, pixelDepth > 8 ? 1/256 : 1);

			// Apply demosaicing based on profile
			let displayMat = new cv.Mat();
			if (profile.id !== 'MONO' && cv[profile.id] !== undefined) {
				cv.demosaicing(temp8u, displayMat, cv[profile.id]);
			} else {
				temp8u.copyTo(displayMat);
			}

			// Auto-stretch
			let stretched = new cv.Mat();
			cv.normalize(displayMat, stretched, 0, 255, cv.NORM_MINMAX, cv.CV_8U);

			// Resize for thumbnail
			let resized = new cv.Mat();
			cv.resize(stretched, resized, new cv.Size(thumbWidth, thumbHeight));

			// Display on canvas
			cv.imshow(canvas, resized);

			// Cleanup
			mat.delete();
			temp8u.delete();
			displayMat.delete();
			stretched.delete();
			resized.delete();
		} catch (error) {
			console.error(`Error rendering ${profile.id}:`, error);
		}
	}
}

onMounted(() => {
	on('show-color-profile-selector', async (data) => {
		frameData.value = data.frameBuffer;
		headerData.value = data.header;
		autoDetectedProfile.value = data.autoDetectedProfile;
		currentResolve.value = data.resolve;
		visible.value = true;

		await nextTick();
		renderThumbnails();
	});
});
</script>

<style scoped>
.thumbnails {
	display: flex;
	gap: 15px;
	flex-wrap: wrap;
	margin-top: 20px;
}

.thumbnail-wrapper {
	cursor: pointer;
	border: 3px solid #ddd;
	border-radius: 8px;
	padding: 8px;
	transition: all 0.2s ease;
	background: #f9f9f9;
}

.thumbnail-wrapper:hover {
	border-color: #4CAF50;
	transform: scale(1.02);
	background: #e8f5e9;
}

.thumbnail-wrapper.autodetected {
	border-color: #2196F3;
	border-style: dashed;
}

.thumbnail-canvas {
	display: block;
	border-radius: 4px;
}

.profile-label {
	text-align: center;
	margin-top: 8px;
	font-weight: bold;
	font-size: 14px;
	color: #333;
}

.auto-badge {
	background: #2196F3;
	color: white;
	font-size: 10px;
	padding: 2px 6px;
	border-radius: 10px;
	margin-left: 5px;
	font-weight: normal;
}
</style>

<template>
<div class="batch-post-processor">
	<!-- Navigation header -->
	<div class="batch-nav-header">
		<div class="nav-controls">
			<button class="nav-btn" @click="prevImage" :disabled="currentIndex <= 0">&larr;</button>
			<span class="nav-title">
				{{ currentResult?.name || 'Image' }}
				<span class="nav-index">({{ currentIndex + 1 }}/{{ results.length }})</span>
			</span>
			<button class="nav-btn" @click="nextImage" :disabled="currentIndex >= results.length - 1">&rarr;</button>
		</div>
		<button class="btn-secondary btn-small" @click="alignAllStacks" :disabled="isAligning || results.length < 2">
			{{ isAligning ? 'Aligning...' : 'Align Stacks' }}
		</button>
	</div>

	<!-- Main post processor wrapper (grows to fill space) -->
	<div class="post-processor-wrapper">
		<!-- Main post processor (no :key so settings persist across navigation) -->
		<PostProcessor
			v-if="currentResult"
			:file="currentBlob"
			:float32Data="currentFloat32Data"
			:imageDimensions="currentDimensions"
		/>
	</div>

	<!-- Bottom bar with thumbnails and actions -->
	<div class="batch-bottom-bar">
		<div class="batch-thumbnails" v-if="results.length > 1">
			<div
				v-for="(result, index) in results"
				:key="result.id"
				class="thumbnail-item"
				:class="{ active: index === currentIndex }"
				@click="selectImage(index)"
			>
				<img v-if="thumbnails[result.id]" :src="thumbnails[result.id]" :alt="result.name" />
				<div v-else class="thumbnail-loading"></div>
				<span class="thumbnail-name">{{ truncateName(result.name, 12) }}</span>
			</div>
		</div>

		<!-- Batch actions -->
		<div class="batch-actions">
			<button class="btn-primary" @click="exportAllImages" :disabled="isExporting">
				{{ isExporting ? 'Downloading...' : 'Download All' }}
			</button>
		</div>
	</div>
</div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import PostProcessor from '@/components/PostProcessor.vue';
import { alignStackedImages } from '@/utils/stackAlignment.js';
import { useProcessingState } from '@/composables/useProcessingState.js';

const props = defineProps({
	results: {
		type: Array,
		required: true,
		default: () => []
	}
});

const emit = defineEmits(['close']);

// Get setInputFilename to update export filename when navigating
const { setInputFilename } = useProcessingState();

// State
const currentIndex = ref(0);
const thumbnails = ref({});
const isExporting = ref(false);
const isAligning = ref(false);
const alignedResults = ref(null); // Store aligned versions

// Current result (use aligned if available)
const currentResult = computed(() => {
	if (props.results.length === 0 || currentIndex.value < 0) return null;
	const original = props.results[currentIndex.value];

	// If we have aligned results, merge the aligned data
	if (alignedResults.value && alignedResults.value[currentIndex.value]) {
		return {
			...original,
			result: {
				...original.result,
				...alignedResults.value[currentIndex.value]
			}
		};
	}
	return original;
});

// Current blob for PostProcessor
const currentBlob = computed(() => {
	return currentResult.value?.result?.blob || null;
});

// Current float32 data for PostProcessor
const currentFloat32Data = computed(() => {
	return currentResult.value?.result?.float32Data || null;
});

// Current dimensions
const currentDimensions = computed(() => {
	const result = currentResult.value?.result;
	if (!result) return { width: 0, height: 0 };
	return { width: result.width, height: result.height };
});

// Navigation
function prevImage() {
	if (currentIndex.value > 0) {
		currentIndex.value--;
	}
}

function nextImage() {
	if (currentIndex.value < props.results.length - 1) {
		currentIndex.value++;
	}
}

function selectImage(index) {
	currentIndex.value = index;
}

// Helper function
function truncateName(name, maxLength = 15) {
	if (!name) return '';
	if (name.length <= maxLength) return name;
	const ext = name.split('.').pop();
	const base = name.slice(0, -(ext.length + 1));
	const truncatedBase = base.slice(0, maxLength - 4) + '...';
	return truncatedBase;
}

// Generate thumbnails
async function generateThumbnails() {
	for (const result of props.results) {
		if (!result.result?.blob || thumbnails.value[result.id]) continue;

		try {
			const imageBitmap = await createImageBitmap(result.result.blob);
			const canvas = document.createElement('canvas');
			const scale = Math.min(60 / imageBitmap.width, 60 / imageBitmap.height);
			canvas.width = imageBitmap.width * scale;
			canvas.height = imageBitmap.height * scale;
			const ctx = canvas.getContext('2d');
			ctx.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
			thumbnails.value[result.id] = canvas.toDataURL('image/jpeg', 0.8);
		} catch (e) {
			console.warn('Failed to generate thumbnail:', e);
		}
	}
}

// Export current image
// Export all images (sequential downloads)
async function exportAllImages() {
	isExporting.value = true;

	try {
		for (let i = 0; i < props.results.length; i++) {
			const result = props.results[i];
			// Use aligned blob if available, otherwise original
			const blob = alignedResults.value?.[i]?.blob || result.result?.blob;
			if (!blob) continue;

			const baseName = result.name.replace(/\.[^/.]+$/, '');
			const index = String(i + 1).padStart(3, '0');
			const suffix = alignedResults.value ? '_aligned' : '';
			const filename = `${baseName}_eise_stacked${suffix}_${index}.png`;

			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);

			// Small delay between downloads
			await new Promise(resolve => setTimeout(resolve, 300));
		}
	} finally {
		isExporting.value = false;
	}
}

// Align all stacks for wobble-free animation
async function alignAllStacks() {
	if (props.results.length < 2) return;

	isAligning.value = true;

	try {
		// Collect results with float32Data
		const stackedResults = props.results
			.filter(r => r.result?.float32Data)
			.map(r => ({
				float32Data: r.result.float32Data,
				width: r.result.width,
				height: r.result.height
			}));

		if (stackedResults.length < 2) {
			console.warn('[Alignment] Not enough images with float32Data');
			return;
		}

		console.log(`[Alignment] Aligning ${stackedResults.length} stacks...`);

		// Run alignment
		const aligned = await alignStackedImages(stackedResults, {
			onProgress: (current, total, message) => {
				console.log(`[Alignment] ${message}`);
			}
		});

		// Store aligned results
		alignedResults.value = aligned;

		// Regenerate thumbnails for aligned images
		await generateThumbnailsForAligned();

		console.log('[Alignment] Complete!');
	} catch (err) {
		console.error('[Alignment] Failed:', err);
	} finally {
		isAligning.value = false;
	}
}

// Generate thumbnails for aligned images
async function generateThumbnailsForAligned() {
	if (!alignedResults.value) return;

	for (let i = 0; i < props.results.length; i++) {
		const result = props.results[i];
		const aligned = alignedResults.value[i];
		if (!aligned?.blob) continue;

		try {
			const imageBitmap = await createImageBitmap(aligned.blob);
			const canvas = document.createElement('canvas');
			const scale = Math.min(60 / imageBitmap.width, 60 / imageBitmap.height);
			canvas.width = imageBitmap.width * scale;
			canvas.height = imageBitmap.height * scale;
			const ctx = canvas.getContext('2d');
			ctx.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
			thumbnails.value[result.id] = canvas.toDataURL('image/jpeg', 0.8);
		} catch (e) {
			console.warn('Failed to generate aligned thumbnail:', e);
		}
	}
}

// Keyboard navigation
function handleKeydown(e) {
	if (e.key === 'ArrowLeft') {
		prevImage();
	} else if (e.key === 'ArrowRight') {
		nextImage();
	}
}

onMounted(() => {
	generateThumbnails();
	window.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
	window.removeEventListener('keydown', handleKeydown);
});

// Regenerate thumbnails when results change
watch(() => props.results, () => {
	generateThumbnails();
}, { deep: true });

// Update export filename when navigating between images
watch(currentResult, (result) => {
	if (result?.name) {
		// Remove extension for cleaner export filename
		const baseName = result.name.replace(/\.[^/.]+$/, '');
		setInputFilename(baseName);
	}
}, { immediate: true });
</script>

<style scoped>
.batch-post-processor {
	display: flex;
	flex-direction: column;
	min-height: 100vh;
	width: 100%;
}

.batch-nav-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 10px 15px;
	background: #1a1a2e;
	border-bottom: 1px solid #333;
	position: sticky;
	top: 0;
	z-index: 100;
	flex-shrink: 0;
}

.nav-controls {
	display: flex;
	align-items: center;
	gap: 15px;
	flex: 1;
	justify-content: center;
}

.btn-small {
	padding: 6px 12px;
	font-size: 13px;
}

.nav-btn {
	background: #333;
	color: white;
	border: none;
	padding: 8px 15px;
	border-radius: 4px;
	cursor: pointer;
	font-size: 16px;
}

.nav-btn:hover:not(:disabled) {
	background: #444;
}

.nav-btn:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

.nav-title {
	font-size: 14px;
	color: white;
}

.nav-index {
	color: #888;
	margin-left: 5px;
}

/* PostProcessor wrapper - fills available space */
.post-processor-wrapper {
	flex: 1;
	min-height: 0;
	overflow: auto;
}

/* Bottom bar containing thumbnails and actions */
.batch-bottom-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 15px;
	padding: 10px 15px;
	background: #1a1a2e;
	border-top: 1px solid #333;
	flex-shrink: 0;
}

.batch-thumbnails {
	display: flex;
	gap: 8px;
	overflow-x: auto;
	flex: 1;
	min-width: 0;
}

.thumbnail-item {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 4px;
	padding: 4px;
	border-radius: 4px;
	cursor: pointer;
	border: 2px solid transparent;
	transition: border-color 0.2s;
	flex-shrink: 0;
}

.thumbnail-item:hover {
	border-color: #555;
}

.thumbnail-item.active {
	border-color: #8CCF7E;
}

.thumbnail-item img {
	width: 50px;
	height: 50px;
	object-fit: cover;
	border-radius: 3px;
}

.thumbnail-loading {
	width: 50px;
	height: 50px;
	background: #333;
	border-radius: 3px;
}

.thumbnail-name {
	font-size: 10px;
	color: #888;
	max-width: 60px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.batch-actions {
	display: flex;
	gap: 10px;
	flex-shrink: 0;
}

/* Responsive: stack bottom bar on small screens */
@media (max-width: 600px) {
	.batch-bottom-bar {
		flex-direction: column;
		align-items: stretch;
	}

	.batch-thumbnails {
		justify-content: center;
	}

	.batch-actions {
		justify-content: center;
	}
}
</style>

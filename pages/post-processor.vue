<template>
	<!-- Batch mode: multiple stacked images -->
	<div v-if="batchResults && batchResults.length > 0" class="batch-page">
		<BatchPostProcessor :results="batchResults" />
	</div>
	<!-- Single image mode -->
	<PostProcessor
		v-else
		:file="selectedFile"
		:float32Data="stackedFloat32Data"
		:imageDimensions="stackedImageDimensions"
		:croppedSerData="croppedSerData"
	/>
</template>

<script setup>
// Static, NOT defineAsyncComponent: an async component is never resolved
// during prerender, so this page used to ship an empty <main> and the intro
// copy inside PostProcessor.vue (h1, lede, feature list) was invisible to
// every crawler and assistant. Importing it statically puts that content in
// the prerendered HTML, which is also what makes /post-processor.md exist.
//
// The cost is that PostProcessor (~22 KB gzipped + 3 KB CSS) folds into this
// route's chunk, which Nuxt would otherwise prefetch from the header nav on
// every page. Every NuxtLink to /post-processor/ therefore carries
// :prefetch="false", so the chunk still loads on navigation, not on idle.
import PostProcessor from '@/components/PostProcessor.vue';

// Batch mode only ever renders after a stack finishes, never at prerender,
// so it stays lazy.
const BatchPostProcessor = defineAsyncComponent(() => import('@/components/BatchPostProcessor.vue'));

const selectedFile = inject('selectedFile');
const stackedFloat32Data = inject('stackedFloat32Data');
const stackedImageDimensions = inject('stackedImageDimensions');
const croppedSerData = inject('croppedSerData');
const batchResults = inject('batchResults');

const isBatchMode = computed(() => batchResults?.value?.length > 0);

useHead({
	title: computed(() => isBatchMode.value ? 'Batch Post Processing - Eise.app' : 'Post Processing - Eise.app'),
	meta: [
		{ name: 'description', content: 'Post-process your stacked astrophotography images with wavelet sharpening and more.' },
	],
});
</script>

<style scoped>
.batch-page {
	min-height: 100vh;
	display: flex;
	flex-direction: column;
}
</style>

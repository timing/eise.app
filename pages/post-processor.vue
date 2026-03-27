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
const PostProcessor = defineAsyncComponent(() => import('@/components/PostProcessor.vue'));
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

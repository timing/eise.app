<template>
	<PostProcessor
		:file="selectedFile"
		:float32Data="stackedFloat32Data"
		:imageDimensions="stackedImageDimensions"
		:croppedSerData="croppedSerData"
	/>
</template>

<script setup>
const PostProcessor = defineAsyncComponent(() => import('@/components/PostProcessor.vue'));

const selectedFile = inject('selectedFile');
const stackedFloat32Data = inject('stackedFloat32Data');
const stackedImageDimensions = inject('stackedImageDimensions');
const croppedSerData = inject('croppedSerData');

useHead({
	title: 'Post Processing - eise.app',
	meta: [
		{ name: 'description', content: 'Post-process your stacked astrophotography images with wavelet sharpening and more.' },
	],
});
</script>

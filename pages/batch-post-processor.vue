<template>
	<div v-if="batchResults && batchResults.length > 0" class="batch-page">
		<BatchPostProcessor :results="batchResults" />
	</div>
	<div v-else class="no-results">
		<div class="card">
			<h3>No batch results</h3>
			<p>No stacked images available. Please process a batch of files first.</p>
			<NuxtLink to="/" class="btn-primary">Go to stacking</NuxtLink>
		</div>
	</div>
</template>

<script setup>
const BatchPostProcessor = defineAsyncComponent(() => import('@/components/BatchPostProcessor.vue'));

const batchResults = inject('batchResults');

useHead({
	title: 'Batch Post Processing - eise.app',
	meta: [
		{ name: 'description', content: 'Post-process multiple stacked astrophotography images at once.' },
	],
});
</script>

<style scoped>
.batch-page {
	min-height: 100vh;
	display: flex;
	flex-direction: column;
}

.no-results {
	display: flex;
	justify-content: center;
	align-items: center;
	min-height: 50vh;
	padding: 20px;
}

.no-results .card {
	text-align: center;
	max-width: 400px;
}

.no-results h3 {
	margin-bottom: 10px;
}

.no-results p {
	margin-bottom: 20px;
	color: #666;
}
</style>

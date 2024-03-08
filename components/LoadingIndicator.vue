<template>
	<div v-if="loading" class="loading-indicator">
		<div v-if="isIndeterminate" class="indeterminate"></div>
		<div v-else class="determinate" :style="{ width: progress + '%' }"></div>
	</div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useEventBus } from '@/composables/eventBus'; // Adjust the path to your eventBus

const { on, emit, off } = useEventBus();
const loading = ref(false);
const isIndeterminate = ref(true);
const progress = ref(0);

onMounted(() => {
	on('start-loading', () => {
		loading.value = true;
		isIndeterminate.value = true;
	});
	on('start-loading-determinate', (initialProgress) => {
		loading.value = true;
		isIndeterminate.value = false;
		progress.value = initialProgress;
	});
	on('update-loading', (newProgress) => {
		isIndeterminate.value = false;
		progress.value = Math.ceil(newProgress);
	});
	on('stop-loading', () => {
		loading.value = false;
	});
});

onUnmounted(() => {
	off('start-loading');
	off('start-loading-determinate');
	off('update-loading');
	off('stop-loading');
});
</script>

<style>
.loading-indicator {
	width: 100%;
	height: 5px;
	position: absolute;
	background-color: #4A90E2;
	overflow: hidden;
}

.determinate {
	height: 100%;
	background-color: #8CCF7E;
	width: 0%; 
	transition: width 0.5s ease; 
}

.indeterminate {
	height: 100%;
	position: relative;
}

.indeterminate::before {
	content: '';
	position: absolute;
	height: 100%;
	width: 50%;
	background-color: #8CCF7E;
	animation: moveIndeterminate 2s infinite linear;
}

@keyframes moveIndeterminate {
	0% {
		left: -50%;
	}
	100% {
		left: 100%;
	}
}

</style>


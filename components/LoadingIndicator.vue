<template>
	<div class="loading-wrapper">
		<div v-if="loading" class="loading-indicator">
			<div v-if="isIndeterminate" class="indeterminate"></div>
			<div v-else class="determinate" :style="{ width: progress + '%' }"></div>
		</div>
		<div class="caption">{{ caption }}</div>
	</div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useEventBus } from '@/composables/eventBus'; // Adjust the path to your eventBus

const { on, emit, off, caption, setCaption } = useEventBus();
const loading = ref(false);
const isIndeterminate = ref(true);
const progress = ref(0);

onMounted(() => {
	on('start-loading', (newCaption) => {
		loading.value = true;
		isIndeterminate.value = true;
		if (newCaption) {
			setCaption(newCaption);
		}
	});
	on('update-loading', (newProgress) => {
		isIndeterminate.value = false;
		progress.value = Math.ceil(newProgress);
	});
	on('stop-loading', () => {
		loading.value = false;
		setCaption('');
	});
	on('set-caption', (newCaption) => {
		setCaption(newCaption);
	});
});

onUnmounted(() => {
	off('start-loading');
	off('start-loading-determinate');
	off('update-loading');
	off('stop-loading');
	off('set-caption');
});
</script>

<style>
.loading-indicator {
	height: 5px;
	background-color: #4A90E2;
	overflow: hidden;
}
.loading-wrapper {
	height: 25px;
	margin-bottom: 5px;
}
.caption {
	text-align: center;
	margin-top: 5px;
	font-size: 12px;
	color: #333;
}
.determinate {
	height: 100%;
	background-color: #8CCF7E;
	width: 0%; 
	transition: width 0.5s ease; 
	position: relative;
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


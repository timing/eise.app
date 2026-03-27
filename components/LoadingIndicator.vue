<template>
	<div class="loading-wrapper" v-if="loading || hasError">
		<div v-if="hasError" class="error-state">
			<div class="error-title">Something went wrong</div>
			<div class="error-subtitle">Check the logs below for details</div>
		</div>
		<div v-else class="loading-content">
			<div class="caption" v-if="caption">{{ caption }}</div>
			<div class="frame-counter" v-if="totalFrames > 0">{{ currentFrame }} / {{ totalFrames }}</div>
			<div class="loading-indicator">
				<div v-if="isIndeterminate" class="indeterminate"></div>
				<div v-else class="determinate" :style="{ width: progress + '%' }"></div>
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useEventBus } from '@/composables/eventBus';

const { on, emit, off, caption, setCaption } = useEventBus();
const loading = ref(false);
const isIndeterminate = ref(true);
const progress = ref(0);
const currentFrame = ref(0);
const totalFrames = ref(0);
const hasError = ref(false);

onMounted(() => {
	on('start-loading', (newCaption) => {
		loading.value = true;
		hasError.value = false;
		isIndeterminate.value = true;
		currentFrame.value = 0;
		totalFrames.value = 0;
		if (newCaption) {
			setCaption(newCaption);
		}
	});
	on('show-error', () => {
		loading.value = false;
		hasError.value = true;
	});
	on('update-loading', (data) => {
		// Support both simple percentage and object with frame counts
		if (typeof data === 'object') {
			// progress < 0 means indeterminate (show animation) but with frame count
			if (data.progress >= 0) {
				isIndeterminate.value = false;
				progress.value = Math.ceil(data.progress);
			} else {
				isIndeterminate.value = true;
			}
			if (data.current !== undefined) currentFrame.value = data.current;
			if (data.total !== undefined) totalFrames.value = data.total;
		} else {
			isIndeterminate.value = false;
			progress.value = Math.ceil(data);
		}
	});
	on('stop-loading', () => {
		loading.value = false;
		hasError.value = false;
		setCaption('');
		currentFrame.value = 0;
		totalFrames.value = 0;
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
	off('show-error');
});
</script>

<style>
.loading-wrapper {
	margin-bottom: 15px;
	padding: 10px 0;
}
.caption {
	text-align: center;
	font-size: 16px;
	font-weight: bold;
	color: #333;
	margin-bottom: 5px;
}
.frame-counter {
	text-align: center;
	font-size: 24px;
	font-weight: bold;
	color: #4A90E2;
	margin-bottom: 10px;
}
.loading-indicator {
	height: 8px;
	background-color: #e0e0e0;
	border-radius: 4px;
	overflow: hidden;
}
.determinate {
	height: 100%;
	background-color: #8CCF7E;
	width: 0%;
	transition: width 0.3s ease;
	border-radius: 4px;
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
	border-radius: 4px;
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
.error-state {
	text-align: center;
	padding: 20px 10px;
}
.error-title {
	font-size: 18px;
	font-weight: bold;
	color: #e74c3c;
	margin-bottom: 8px;
}
.error-subtitle {
	font-size: 14px;
	color: #666;
}
</style>


<template>
	<div class="loading-wrapper" v-if="loading || hasError">
		<div v-if="hasError" class="error-state">
			<div class="error-title">Something went wrong</div>
			<div class="error-subtitle">Check the logs below for details</div>
		</div>
		<div v-else class="loading-content">
			<div class="caption" v-if="caption">
				<span class="caption-dot" aria-hidden="true"></span>
				<span>{{ caption }}</span>
			</div>
			<div class="loading-readout">
				<span class="frame-counter" v-if="totalFrames > 0">{{ currentFrame }} / {{ totalFrames }}</span>
				<span class="frame-counter frame-counter-dots" v-else aria-hidden="true">
					<span>.</span><span>.</span><span>.</span>
				</span>
				<span class="loading-percent">{{ isIndeterminate ? 'estimating…' : progress + '%' }}</span>
			</div>
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
	margin-bottom: 4px;
}
/* Title line: pulsing gilt dot + what is running right now. */
.caption {
	display: flex;
	align-items: center;
	gap: 9px;
	margin-bottom: 18px;
	font-size: 15px;
	font-weight: 600;
	color: #ffffff;
}
.caption-dot {
	flex: 0 0 auto;
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--eise-gilt);
	animation: caption-pulse 1.4s ease-in-out infinite;
}
@keyframes caption-pulse {
	0%, 100% { opacity: 0.35; }
	50% { opacity: 1; }
}
.loading-readout {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 9px;
}
.frame-counter {
	font-family: var(--eise-mono);
	font-size: 22px;
	font-weight: 500;
	letter-spacing: -0.01em;
	color: var(--eise-gilt-lt);
}
.loading-percent {
	font-family: var(--eise-mono);
	font-size: 12px;
	color: #8fa9b1;
}
.frame-counter-dots {
	letter-spacing: 6px;
}
.frame-counter-dots span {
	display: inline-block;
	opacity: 0.2;
	animation: frame-counter-dot 1.4s infinite;
}
.frame-counter-dots span:nth-child(2) { animation-delay: 0.2s; }
.frame-counter-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes frame-counter-dot {
	0%, 60%, 100% { opacity: 0.2; }
	30% { opacity: 1; }
}
.loading-indicator {
	position: relative;
	height: 6px;
	background-color: rgba(255, 255, 255, 0.09);
	border-radius: 3px;
	overflow: hidden;
}
.determinate {
	height: 100%;
	width: 0%;
	background: linear-gradient(90deg, #d9a94a, #eec36c);
	border-radius: 3px;
	transition: width 0.24s ease;
}
.indeterminate {
	height: 100%;
	position: relative;
}
.indeterminate::before {
	content: '';
	position: absolute;
	top: 0;
	bottom: 0;
	left: 0;
	width: 30%;
	border-radius: 3px;
	background: linear-gradient(90deg, rgba(217, 169, 74, 0), #d9a94a, rgba(217, 169, 74, 0));
	animation: moveIndeterminate 1.5s ease-in-out infinite;
}
@keyframes moveIndeterminate {
	0% { transform: translateX(-100%); }
	100% { transform: translateX(320%); }
}
.error-state {
	padding: 4px 0 8px;
}
.error-title {
	font-size: 15px;
	font-weight: 600;
	color: #e58a8a;
	margin-bottom: 6px;
}
.error-subtitle {
	font-size: 12.5px;
	color: var(--eise-muted-2);
}
</style>


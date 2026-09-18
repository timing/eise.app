<template>
	<div class="logger" :class="{ 'is-expanded': isExpanded }">
		<div class="logger-row">
			<span class="logger-mem">● {{ memoryDisplay ? 'Mem ' + memoryDisplay : 'Logs' }}</span>
			<pre ref="logContent" class="logger-log"></pre>
			<button @click="toggleExpand" class="expand-button">{{ isExpanded ? 'Collapse' : 'Expand logs' }}</button>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useLiteMode } from '@/composables/useLiteMode';
import { useEnvironmentInfo } from '@/composables/useEnvironmentInfo';

const { logs, onLogAdded, off } = useEventBus();
const { isLiteMode } = useLiteMode();
const { getEnvironmentInfo } = useEnvironmentInfo();
const logContent = ref(null);
const isExpanded = ref(false);
const memoryDisplay = ref('');
let memoryIntervalId = null;

// Update memory display without blocking - uses requestIdleCallback when available
const updateMemory = () => {
	if (performance && performance.memory && performance.memory.usedJSHeapSize) {
		const mb = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(0);
		memoryDisplay.value = `${mb}MB`;
	}
	// Schedule next update during idle time
	if (typeof requestIdleCallback !== 'undefined') {
		memoryIntervalId = setTimeout(() => requestIdleCallback(updateMemory), 2000);
	} else {
		memoryIntervalId = setTimeout(updateMemory, 2000);
	}
};

const toggleExpand = () => {
	isExpanded.value = !isExpanded.value;
	logContent.value.style.height = isExpanded.value ? '400px' : '';
	logContent.value.scrollTop = logContent.value.scrollHeight;
};

const handleLogAdded = (log) => {
	if (!logContent.value) return; // Guard against unmounted component

	logContent.value.innerHTML += (new Date()).toLocaleString() + ': ' + log.trim() + '\n';

	const shouldScroll = !isExpanded.value || (logContent.value.scrollTop + logContent.value.clientHeight >= logContent.value.scrollHeight - 50);
	if (shouldScroll) {
		logContent.value.scrollTop = logContent.value.scrollHeight;
	}
};

onMounted(async () => {
	const hasGPU = !!navigator.gpu;
	const lite = isLiteMode();
	let gpuInfo = '';
	if (hasGPU) {
		try {
			const adapter = await navigator.gpu.requestAdapter();
			if (adapter) {
				const maxBuf = adapter.limits.maxBufferSize;
				gpuInfo = `, ${Math.round(maxBuf / 1024 / 1024)}MB max buffer`;
			}
		} catch (e) { /* ignore */ }
	}
	const { os, browser } = await getEnvironmentInfo();
	const mode = (hasGPU ? 'GPU' : 'CPU') + (lite ? ', Lite' : '') + gpuInfo;
	logContent.value.innerHTML += (new Date()).toLocaleString() + `: Welcome to Eise.app! (${browser} on ${os}, ${mode})\n`;

	onLogAdded(handleLogAdded);

	// Start memory monitoring
	updateMemory();
});

onUnmounted(() => {
	off('log', handleLogAdded);
	if (memoryIntervalId) {
		clearTimeout(memoryIntervalId);
	}
});
</script>

<style scoped>
/* Status bar pinned to the bottom of the viewport. */
.logger {
	position: fixed;
	bottom: 0;
	right: 0;
	left: 0;
	/* Above .app-content (z-index 1), like the sticky header. */
	z-index: 20;
	background: rgba(6, 38, 48, 0.93);
	backdrop-filter: blur(10px);
	border-top: 1px solid rgba(255, 255, 255, 0.08);
	font-family: var(--eise-mono);
	font-size: 11.5px;
	color: var(--eise-muted);
}
.logger-row {
	display: flex;
	align-items: center;
	gap: 14px;
	height: 40px;
	padding: 0 28px;
	box-sizing: border-box;
}
.logger.is-expanded .logger-row {
	align-items: flex-start;
	height: auto;
	padding: 10px 28px;
}
.logger-mem {
	flex: 0 0 auto;
	color: var(--eise-gilt);
}
/* Collapsed: one line, scrolled to the newest entry (the scroll position is
   what keeps the latest log visible, so this stays scrollable, just without a
   visible scrollbar). */
.logger-log {
	flex: 1;
	min-width: 0;
	height: 14px;
	margin: 0;
	overflow: auto;
	line-height: 14px;
	white-space: pre;
	scrollbar-width: none;
}
.logger-log::-webkit-scrollbar {
	display: none;
}
.logger.is-expanded .logger-log {
	line-height: 16px;
}
button.expand-button {
	flex: 0 0 auto;
	padding: 3px 10px;
	background: transparent;
	border: 1px solid rgba(255, 255, 255, 0.14);
	border-radius: 5px;
	font-family: inherit;
	font-size: 11px;
	color: var(--eise-on-dark);
	cursor: pointer;
}
button.expand-button:hover {
	background: rgba(255, 255, 255, 0.07);
	color: #ffffff;
}
@media (max-width: 700px) {
	.logger-row {
		gap: 10px;
		padding: 0 16px;
	}
}
</style>

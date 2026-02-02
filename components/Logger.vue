<template>
	<div class="logger">
		<button @click="toggleExpand" class="expand-button">Expand</button>
		<b>Logs{{ memoryDisplay }}</b>
		<pre ref="logContent"></pre>
	</div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useLiteMode } from '@/composables/useLiteMode';

const { logs, onLogAdded, off } = useEventBus();
const { isLiteMode } = useLiteMode();
const logContent = ref(null);
const isExpanded = ref(false);
const memoryDisplay = ref('');
let memoryIntervalId = null;

// Update memory display without blocking - uses requestIdleCallback when available
const updateMemory = () => {
	if (performance && performance.memory && performance.memory.usedJSHeapSize) {
		const mb = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(0);
		memoryDisplay.value = ` - Mem: ${mb}MB`;
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

onMounted(() => {
	const hasGPU = !!navigator.gpu;
	const lite = isLiteMode();
	const mode = (hasGPU ? 'GPU' : 'CPU') + (lite ? ', Lite' : '');
	logContent.value.innerHTML += (new Date()).toLocaleString() + `: Welcome to eise.app! (${mode})\n`;

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
.logger {
	background-color: rgba(0,0,0,1);
	padding: 10px;
	position: fixed;
	bottom: 0;
	right: 0;
	left: 0;
	color: #eee;
}
.logger pre {
	overflow-y: scroll;
	font-size: 10px;
	line-height: 12px;
	height: 12px;
	margin-top: 20px; 
}
button.expand-button {
	position: absolute;
	top: 0;
	right: 0;
	background: transparent;
	font-size: 10px;
	color: #eee;
	font-weight: bold;
}
</style>


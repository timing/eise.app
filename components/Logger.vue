<template>
	<div class="logger">
		<button @click="toggleExpand" class="expand-button">Expand</button>
		<b>Logs</b>
		<pre ref="logContent"></pre>
	</div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue';
import { useEventBus } from '@/composables/eventBus';

const { logs, onLogAdded } = useEventBus();
const logContent = ref(null);
const isExpanded = ref(false);

const toggleExpand = () => {
	isExpanded.value = !isExpanded.value;
	logContent.value.style.height = isExpanded.value ? '400px' : '';
	logContent.value.scrollTop = logContent.value.scrollHeight;
};

onMounted(() => {
	logContent.value.innerHTML += (new Date()).toLocaleString() + ': Welcome to eise.app! \n';

	onLogAdded((log) => {
		let mem = '';
		if (performance && performance.memory && performance.memory.usedJSHeapSize) {
			mem = ' Mem:' + (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(2) + 'MB';
		}

		logContent.value.innerHTML += (new Date()).toLocaleString() + ': ' + log.trim() + mem + '\n';

		//nextTick(() => {
			const shouldScroll = !isExpanded.value || (logContent.value.scrollTop + logContent.value.clientHeight >= logContent.value.scrollHeight -50);
			if (shouldScroll) {
				logContent.value.scrollTop = logContent.value.scrollHeight;
			}
		//});
	});
});
</script>

<style scoped>
.logger {
	background-color: #f0f0f0;
	border: 1px solid #ddd;
	padding: 10px;
	position: fixed;
	bottom: 0;
	right: 0;
	left: 0;
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
	color: black;
	font-size: 10px;
}
</style>


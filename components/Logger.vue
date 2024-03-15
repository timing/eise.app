<template>
	<div class="logger" ref="loggerContainer">
		<b>Logs</b>
		<pre ref="logContent"></pre>
	</div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue';
import { useEventBus } from '@/composables/eventBus';

const { logs, onLogAdded } = useEventBus();

const loggerContainer = ref(null);
const logContent = ref(null);

onMounted(() => {

	logContent.value.innerHTML += (new Date()).toLocaleString() + ': Welcome to eise.app! \n';	

	onLogAdded((log) => {

		logContent.value.innerHTML += (new Date()).toLocaleString() + ': ' + log + '\n';

		nextTick(() => {
			logContent.value.scrollTop = logContent.value.scrollHeight;
})})});

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
}
</style>


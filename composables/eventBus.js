import { ref } from 'vue';

const logs = ref([]);
const eventCallbacks = {};

export const useEventBus = () => {
	const addLog = (log) => {
		logs.value.push(log);
		// Trigger callbacks specifically listening for logs
		if (eventCallbacks['log']) {
			eventCallbacks['log'].forEach(cb => cb(log));
		}
	};

	const onLogAdded = (cb) => {
		if (!eventCallbacks['log']) {
			eventCallbacks['log'] = [];
		}
		eventCallbacks['log'].push(cb);
	};

	// General purpose methods for handling various events
	const emit = (event, payload) => {
		if (eventCallbacks[event]) {
			eventCallbacks[event].forEach(cb => cb(payload));
		}
	};

	const on = (event, callback) => {
		if (!eventCallbacks[event]) {
			eventCallbacks[event] = [];
		}
		eventCallbacks[event].push(callback);
	};

	const off = (event, callback) => {
		if (eventCallbacks[event]) {
			const index = eventCallbacks[event].indexOf(callback);
			if (index > -1) {
				eventCallbacks[event].splice(index, 1);
			}
		}
	};

	return { logs, addLog, onLogAdded, emit, on, off };
};


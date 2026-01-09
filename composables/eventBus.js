import { ref } from 'vue';

// Clear any stale data on module load
const logs = ref([]);
const eventCallbacks = {};
const caption = ref('');

// Global worker registry for cleanup on page unload
const activeWorkers = new Set();

// Cleanup all workers on page unload
if (typeof window !== 'undefined') {
	window.addEventListener('beforeunload', () => {
		activeWorkers.forEach(worker => {
			try {
				worker.terminate();
			} catch (e) {
				// Ignore errors during cleanup
			}
		});
		activeWorkers.clear();
	});
}

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

	const setCaption = (newCaption) => {
		caption.value = newCaption;
	};

	// General purpose methods for handling various events
	const emit = (event, payload) => {
		if (event === 'set-caption') {
			setCaption(payload);
		}
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

	// Worker registration for cleanup
	const registerWorker = (worker) => {
		activeWorkers.add(worker);
	};

	const unregisterWorker = (worker) => {
		activeWorkers.delete(worker);
	};

	return { logs, addLog, onLogAdded, emit, on, off, caption, setCaption, registerWorker, unregisterWorker };
};


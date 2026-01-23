import { ref } from 'vue';

// Clear any stale data on module load
const logs = ref([]);
const eventCallbacks = {};
const caption = ref('');

// Global worker registry for cleanup on page unload
const activeWorkers = new Set();

// Debug: store frames for inspection
let debugFrames = [];

// Debug utility to download a specific frame
if (typeof window !== 'undefined') {
	window.debugSaveFrame = async (index) => {
		if (!debugFrames || debugFrames.length === 0) {
			console.log('No frames available. Load a SER/AVI file first.');
			return;
		}
		if (index < 0 || index >= debugFrames.length) {
			console.log(`Invalid index. Available frames: 0 to ${debugFrames.length - 1}`);
			return;
		}
		const frame = debugFrames[index];
		if (!frame.blob) {
			console.log(`Frame ${index} has no blob`);
			return;
		}
		const url = URL.createObjectURL(frame.blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `debug_frame_${index}_sharpness_${frame.sharpness?.toFixed(2) || 'unknown'}.png`;
		a.click();
		URL.revokeObjectURL(url);
		console.log(`Downloaded frame ${index} (sharpness: ${frame.sharpness?.toFixed(2)})`);
	};

	window.debugListFrames = () => {
		if (!debugFrames || debugFrames.length === 0) {
			console.log('No frames available. Load a SER/AVI file first.');
			return;
		}
		console.log(`${debugFrames.length} frames available:`);
		console.log('Top 10 by sharpness:');
		debugFrames.slice(0, 10).forEach((f, i) => {
			console.log(`  [${f.originalIndex ?? i}] sharpness: ${f.sharpness?.toFixed(2)}`);
		});
		console.log('Use window.debugSaveFrame(index) to download a frame');
	};
}

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
		// Capture frames for debug export
		if ((event === 'quality-selection-ready' || event === 'debug-frames-available') && payload?.frames) {
			debugFrames = payload.frames;
			console.log(`Debug: ${debugFrames.length} frames available. Use window.debugListFrames() or window.debugSaveFrame(index)`);
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

// Direct export for use outside Vue components (e.g., error reporting)
export { logs };


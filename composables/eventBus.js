import { ref } from 'vue';

const logs = ref([]);

const callbacks = [];

export const useEventBus = () => {
	const addLog = (log) => {
		logs.value.push(log);
		callbacks.forEach(cb => cb(log));
	};

	const onLogAdded = (cb) => {
        callbacks.push(cb);
    };

	return { logs, addLog, onLogAdded };
};


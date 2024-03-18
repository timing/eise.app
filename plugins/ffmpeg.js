import { createFFmpeg } from '@ffmpeg/ffmpeg';
import { useEventBus } from '@/composables/eventBus';


export default defineNuxtPlugin(nuxtApp => {
	const ffmpeg = createFFmpeg({
		log: true,
		corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
		// 0.12.6 is not compatible with the ffmpeg/ffmpeg include via npm install
		//corePath: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js'
	});

	const { addLog } = useEventBus();

	const loadFFmpeg = async () => {
		if (!ffmpeg.isLoaded()) {
			await ffmpeg.load();
			addLog('Loading FFmpeg done');

			ffmpeg.setLogger(({ type, message }) => {
				//if (message.includes('frame=')) {
					addLog(message);
				//}

				// Check memory usage and terminate if necessary
				const usedJSHeapSize = performance.memory.usedJSHeapSize;
				const jsHeapSizeLimit = performance.memory.jsHeapSizeLimit;
				const usageLimit = 0.999 * jsHeapSizeLimit;

				if (usedJSHeapSize > usageLimit) {
					addLog('Memory limit approaching, stopping FFmpeg process.');
					/*try {
						ffmpeg.exit(); // Terminate FFmpeg process
					} catch(err) {
						console.log(err);
						addLog('Forcefully exiting ffmpeg gave an (expected) error');
					}*/
				}

			});
		}
	};

	nuxtApp.$ffmpeg = ffmpeg;
	nuxtApp.$loadFFmpeg = loadFFmpeg;
});


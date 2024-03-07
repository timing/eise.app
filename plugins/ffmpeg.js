import { createFFmpeg } from '@ffmpeg/ffmpeg';
import { useEventBus } from '@/composables/eventBus';


export default defineNuxtPlugin(nuxtApp => {
	const ffmpeg = createFFmpeg({
		log: true,
		corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
	});

	const { addLog } = useEventBus();

	const loadFFmpeg = async () => {
		if (!ffmpeg.isLoaded()) {
			await ffmpeg.load();
			addLog('Loading FFmpeg done');

			ffmpeg.setLogger(({ type, message }) => {
				if (message.includes('frame=')) {
					addLog(message);
				}
			});
		}
	};

	nuxtApp.$ffmpeg = ffmpeg;
	nuxtApp.$loadFFmpeg = loadFFmpeg;
});


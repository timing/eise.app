import { createFFmpeg } from '@ffmpeg/ffmpeg';
import { useEventBus } from '@/composables/eventBus';


export default defineNuxtPlugin(nuxtApp => {
	let ffmpeg = null;
	let isLoaded = false;

	const { addLog } = useEventBus();

	// Cleanup on page unload to help release WASM memory
	if (typeof window !== 'undefined') {
		window.addEventListener('beforeunload', () => {
			if (ffmpeg && isLoaded) {
				try {
					ffmpeg.exit();
				} catch (e) {
					// Ignore errors during cleanup
				}
			}
			ffmpeg = null;
			isLoaded = false;
		});
	}

	const loadFFmpeg = async () => {
		if (isLoaded) return;

		if (!ffmpeg) {
			addLog('Initializing FFmpeg...');
			ffmpeg = createFFmpeg({
				log: true,
				corePath: '/ffmpeg/ffmpeg-core.js',
			});
		}

		try {
			await ffmpeg.load();
			isLoaded = true;
		} catch (err) {
			const errorMsg = err?.message || String(err);
			console.error('FFmpeg load failed:', err);
			addLog(`FFmpeg failed to load: ${errorMsg}`);
			throw new Error(`Failed to load FFmpeg: ${errorMsg}`);
		}
		addLog('Loading FFmpeg done');

		ffmpeg.setLogger(({ type, message }) => {
			if (message && message.includes('frame=')) {
				addLog(message);
			}
		});
	};

	// Getter that ensures FFmpeg is created (but not necessarily loaded)
	const getFFmpeg = () => {
		if (!ffmpeg) {
			ffmpeg = createFFmpeg({
				log: true,
				corePath: '/ffmpeg/ffmpeg-core.js',
			});
		}
		return ffmpeg;
	};

	// Tear down and reload the FFmpeg-WASM instance to reclaim its internal decode heap.
	// The 0.10.x core doesn't fully release memory between run() calls, so long-running
	// per-frame extraction loops (e.g. many 4K frames) need periodic recycling to avoid
	// an internal OOM. Caller is responsible for re-writing any files it needs afterward.
	// Returns the fresh instance - callers must use the returned value, not a previously
	// destructured `$ffmpeg`, since destructuring only reads the getter once.
	const recycleFFmpeg = async () => {
		if (ffmpeg && isLoaded) {
			try {
				ffmpeg.exit();
			} catch (e) {
				// Ignore errors during teardown
			}
		}
		ffmpeg = null;
		isLoaded = false;
		await loadFFmpeg();
		return ffmpeg;
	};

	// Use defineProperty so $ffmpeg access is lazy
	Object.defineProperty(nuxtApp, '$ffmpeg', {
		get: () => getFFmpeg()
	});
	nuxtApp.$loadFFmpeg = loadFFmpeg;
	nuxtApp.$recycleFFmpeg = recycleFFmpeg;
});


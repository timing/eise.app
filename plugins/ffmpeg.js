import { createFFmpeg } from '@ffmpeg/ffmpeg';
import { useEventBus } from '@/composables/eventBus';

// Thrown when the current browser can't run FFmpeg-WASM at all (missing
// SharedArrayBuffer, i.e. no cross-origin isolation). Callers should present
// alternatives (different file type, desktop app) rather than reporting to Sentry.
export class FFmpegUnsupportedError extends Error {
	constructor(reason) {
		super(`FFmpeg is not supported in this browser: ${reason}`);
		this.name = 'FFmpegUnsupportedError';
		this.reason = reason;
	}
}

export default defineNuxtPlugin(nuxtApp => {
	let ffmpeg = null;
	let isLoaded = false;

	const { addLog, emit } = useEventBus();

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

		// FFmpeg-WASM's pthread runtime can abort asynchronously from inside a
		// worker (e.g. `RuntimeError: abort(OOM)` on a large video). The abort
		// surfaces as an uncaught `error` event with only a blob-URL frame, so
		// the in-flight ffmpeg.run() promise doesn't reliably reject and the
		// user sees a generic "Something went wrong". Intercept it and surface
		// an actionable message instead. Sentry's beforeSend drops the raw
		// event separately (see plugins/sentry.client.js).
		const isFFmpegPthreadAbort = (msg) =>
			typeof msg === 'string' && /abort\(OOM\)|pthread sent an error/i.test(msg);
		window.addEventListener('error', (event) => {
			const msg = event?.error?.message || event?.message || '';
			if (!isFFmpegPthreadAbort(msg)) return;
			addLog(`FFmpeg ran out of memory: ${msg}`);
			emit('upload-error', 'Your device ran out of memory while decoding this video. Try lowering the max-frames limit, using a shorter clip, or the Eise desktop app for large files.');
			emit('show-error');
		});
		window.addEventListener('unhandledrejection', (event) => {
			const msg = event?.reason?.message || String(event?.reason || '');
			if (!isFFmpegPthreadAbort(msg)) return;
			addLog(`FFmpeg ran out of memory: ${msg}`);
			emit('upload-error', 'Your device ran out of memory while decoding this video. Try lowering the max-frames limit, using a shorter clip, or the Eise desktop app for large files.');
			emit('show-error');
		});
	}

	const loadFFmpeg = async () => {
		if (isLoaded) return;

		// FFmpeg-WASM needs SharedArrayBuffer for its pthread runtime. Some
		// Android/iOS in-app browsers (HeyTap, Samsung Internet on older versions,
		// pre-16.4 iOS Safari) don't expose SAB even when we send COOP/COEP, so
		// we fail fast with a distinguishable error before touching ffmpeg.load().
		if (typeof SharedArrayBuffer === 'undefined') {
			throw new FFmpegUnsupportedError('SharedArrayBuffer is not available');
		}

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
			if (/SharedArrayBuffer/i.test(errorMsg)) {
				throw new FFmpegUnsupportedError(errorMsg);
			}
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


// composables/useMediabunnyReader.js
// Handles video decoding using Mediabunny + WebCodecs (lighter alternative to FFmpeg)

import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
import { useEventBus } from '@/composables/eventBus';
import { useStacker } from '@/composables/useStacker';
import { useComparisonExport } from '@/composables/useComparisonExport';
import { useWebGpuAnalyzeWorker } from '@/composables/useWebGpuAnalyzeWorker';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { computePreCropRegion } from '@/composables/useDebayerReader';
import { resetPass2Counters, bumpPass2Packet, bumpPass2Frame, bumpPass2Batch, setPass2QueueSize, getPass2Counters } from '@/composables/useProcessingState';

// If the WebCodecs decoder swallows chunks but stops producing frames, the
// backpressure spin below hangs forever (queue stays > 3, `!decoderError` stays
// true, no new decode calls, no error callback fires). Observed on 4K HEVC on
// Windows Edge (jobs 00og7ibu, 01ao14gr) and 4K H.264 High on mobile Chrome
// (00venzdh) — every case froze at `pac=22 fra=10 bat=0 q=4` for minutes to
// hours until the user rage-cancelled. This watchdog gives up after N seconds
// of zero frame output so FileUploader can trigger the FFmpeg fallback.
const PASS2_STALL_TIMEOUT_MS = 12000;
import { reportError } from '@/composables/useSentryReporting';

export function useMediabunnyReader() {
	const { addLog, emit, on } = useEventBus();
	const { stackFramesLocally } = useStacker();
	const { capturePreCropFrame, capturePostCropFrame, resetCaptures } = useComparisonExport();
	const {
		initializeGpuWorker,
		terminateGpuWorker,
		analyzeRgbaBatchGpu,
		detectCropAnalyzeRgbaGpu,
		getMaxBatchSize,
		assertDeviceCanFitFrame
	} = useWebGpuAnalyzeWorker();
	const { workerUrl } = useWorkerUrl();

	let cancelled = false;

	// Cancel processing
	function cancelProcessing() {
		cancelled = true;
		addLog('Cancelling Mediabunny processing...');
		terminateGpuWorker();
	}

	on('cancel-processing', cancelProcessing);

	/**
	 * Check if a video file can be handled by Mediabunny + WebCodecs
	 * @param {File} file - Video file to check
	 * @returns {Promise<{supported: boolean, reason?: string}>}
	 */
	async function canHandle(file) {
		// Check WebCodecs availability
		if (typeof VideoDecoder === 'undefined') {
			return { supported: false, reason: 'WebCodecs not supported in this browser' };
		}

		// Try to probe the file with Mediabunny. Always dispose the input on
		// exit — the previous version returned early on unsupported codecs
		// without disposing, leaking file handles and Blob source buffers
		// across every failed probe.
		let input = null;
		try {
			const source = new BlobSource(file);
			input = new Input({ source, formats: ALL_FORMATS });

			const videoTracks = await input.getVideoTracks();
			if (!videoTracks || videoTracks.length === 0) {
				return { supported: false, reason: 'No video tracks found' };
			}

			const track = videoTracks[0];
			const codec = track.codec;
			const decoderConfig = await track.getDecoderConfig();

			const codecString = decoderConfig?.codec || getWebCodecsCodecString(codec, track);
			if (!codecString) {
				return { supported: false, reason: `Unsupported codec: ${codec}` };
			}

			const decoderSupport = await VideoDecoder.isConfigSupported({
				codec: codecString,
				codedWidth: track.codedWidth,
				codedHeight: track.codedHeight
			});
			if (!decoderSupport.supported) {
				return { supported: false, reason: `WebCodecs cannot decode ${codec}` };
			}

			return { supported: true };
		} catch (err) {
			console.warn('[Mediabunny] Probe failed:', err);
			return { supported: false, reason: err.message };
		} finally {
			try { input?.dispose(); } catch (_) { /* already disposed */ }
		}
	}

	/**
	 * Detect bit depth from codec string.
	 * For H.264: profile_idc byte encodes 10-bit profiles (0x6e = High 10, 0x86 = High 10 Intra).
	 * For HEVC/H.265: hev1/hvc1 profiles similarly encode bit depth.
	 */
	function detectBitDepthFromCodec(codecString) {
		if (!codecString) return '?';
		// H.264: avc1.PPCCLL — PP = profile_idc hex
		const avcMatch = codecString.match(/^avc[13]\.([0-9a-fA-F]{2})/);
		if (avcMatch) {
			const profileIdc = parseInt(avcMatch[1], 16);
			// High 10 = 0x6e (110), High 10 Intra = 0x86 (134)
			if (profileIdc === 0x6e || profileIdc === 0x86) return '10';
			return '8';
		}
		// HEVC: hev1/hvc1 — bit depth encoded in constraint bytes, harder to parse
		// but main10 profiles are detectable
		if (/^he[vc]1\.2/.test(codecString)) return '10'; // Main 10 profile
		if (/^hev1|^hvc1/.test(codecString)) return '8';
		// VP9: vp09.PP.LL.BB — BB = bit depth
		const vp9Match = codecString.match(/^vp09\.\d+\.\d+\.(\d+)/);
		if (vp9Match) return vp9Match[1];
		// AV1: av01.P.LLT.DD — DD = bit depth
		const av1Match = codecString.match(/^av01\.\d+\.\d+\w\.(\d+)/);
		if (av1Match) return av1Match[1];
		return '?';
	}

	/**
	 * Map Mediabunny codec names to WebCodecs codec strings
	 */
	function getWebCodecsCodecString(codec, track) {
		// Common mappings
		const codecMap = {
			'avc': 'avc1.42001f', // H.264 Baseline
			'h264': 'avc1.42001f',
			'hevc': 'hev1.1.6.L93.B0', // H.265
			'h265': 'hev1.1.6.L93.B0',
			'vp8': 'vp8',
			'vp9': 'vp09.00.10.08',
			'av1': 'av01.0.01M.08'
		};

		const codecLower = codec?.toLowerCase();

		// Try direct mapping
		if (codecMap[codecLower]) {
			return codecMap[codecLower];
		}

		// Try to use decoderConfig from track if available
		if (track.decoderConfig?.codec) {
			return track.decoderConfig.codec;
		}

		return null;
	}

	/**
	 * Process video frames using Mediabunny + WebCodecs — two-pass streaming pipeline:
	 *   Pass 1: decode all packets, keep ~50 reservoir samples → detect crop region → free samples
	 *   Pass 2: decode packets in groups of BATCH_SIZE, flush → GPU analyze → free RGBA → keep only
	 *           small cropped uint8Buffer for ranked frames. Peak RGBA in memory: BATCH_SIZE × frame_size.
	 */
	async function processVideoFrames(file, options = {}) {
		const {
			maxFrames = 0,
			manualThreshold = false,
			cropMarginPercent = 10,
			stackPercentage = 30,
			drizzleScale = 1.5,
			surfaceMode = false,
			useWebGPU = true,
			// isMobile: when true, timing out during Pass 1 keyframe decoding
			// proceeds with whatever samples were collected instead of throwing.
			// On desktop we throw so the caller can transparently fall back to
			// the heavier FFmpeg pipeline. On mobile FFmpeg would OOM anyway,
			// so we prefer a slightly worse crop detection over a hard failure.
			isMobile = false
		} = options;

		resetCaptures();
		cancelled = false;

		// Tag errors with a `source` so the caller can distinguish where the
		// mediabunny pipeline actually failed (setup/codec vs decoder vs
		// per-frame RGBA copy vs downstream analyze worker).
		const tagErr = (err, source) => {
			const e = err instanceof Error ? err : new Error(String(err));
			if (!e.source) e.source = source;
			return e;
		};

		// Resources that live across the pipeline. Hoisted so the outer
		// finally block can clean them up on any error path — otherwise
		// VideoFrames (GPU-backed), decoders, mediabunny input, and CPU
		// workers all leak on throw, compounding across retries. See Gemini's
		// mediabunny performance audit + section 11.18.
		let input = null;
		let decoder1 = null;
		let decoder2 = null;
		let cpuWorkers = [];
		const rawSamples = [];      // Pass 1 in-flight VideoFrames
		let currentBatch = [];      // Pass 2 in-flight VideoFrames

		try {
			// Init GPU or CPU workers. Both init paths can throw; keep them
			// inside the outer try so any failure surfaces via the outer catch
			// (Sentry + addLog + rethrow) with fail_stage='setup' instead of
			// landing in the null/unknown bucket.
			let useGPU = false;
			if (useWebGPU) {
				try {
					useGPU = await initializeGpuWorker();
				} catch (err) {
					throw tagErr(err, 'setup');
				}
			}

			if (!useGPU) {
				addLog('WebGPU not available, using CPU analysis workers');
				const CPU_WORKER_COUNT = Math.min(navigator.hardwareConcurrency || 2, 4);
				for (let i = 0; i < CPU_WORKER_COUNT; i++) {
					cpuWorkers.push(new Worker(workerUrl('/unified_analyze_worker.js')));
				}
				try {
					await Promise.all(cpuWorkers.map((worker, i) =>
						new Promise((resolve, reject) => {
							const timeout = setTimeout(() => reject(new Error(`CPU worker ${i} init timeout`)), 30000);
							worker.onerror = (e) => { clearTimeout(timeout); reject(new Error(e.message || 'CPU worker onerror')); };
							worker.onmessage = (e) => {
								if (!e.data) { clearTimeout(timeout); reject(new Error('Worker crashed')); return; }
								if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
								else if (e.data.type === 'error') { clearTimeout(timeout); reject(new Error(e.data.message)); }
							};
							worker.postMessage({ type: 'init' });
						})
					));
				} catch (err) {
					throw tagErr(err, 'setup');
				}
			}

			addLog(`Processing video with Mediabunny + WebCodecs (${useGPU ? 'GPU' : 'CPU'})`);
			emit('set-caption', 'Opening video...');

			// Open video with Mediabunny. Any throw from getVideoTracks /
			// getDecoderConfig gets tagged 'setup' so analytics can distinguish
			// container/codec-lookup failures from decoder failures.
			let videoTrack, decoderConfig;
			try {
				const source = new BlobSource(file);
				input = new Input({ source, formats: ALL_FORMATS });
				const videoTracks = await input.getVideoTracks();
				videoTrack = videoTracks[0];
				if (!videoTrack) {
					throw new Error('No video track found');
				}
				decoderConfig = await videoTrack.getDecoderConfig();
			} catch (err) {
				throw tagErr(err, 'setup');
			}

			const trackWidth = videoTrack.codedWidth;
			const trackHeight = videoTrack.codedHeight;
			const codec = videoTrack.codec;

			const fullCodecString = decoderConfig?.codec || getWebCodecsCodecString(codec, videoTrack);
			const bitDepth = detectBitDepthFromCodec(fullCodecString);
			addLog(`Video: ${trackWidth}x${trackHeight}, codec: ${codec} (${fullCodecString}), bit depth: ${bitDepth}-bit`);

			const codecString = decoderConfig?.codec || getWebCodecsCodecString(codec, videoTrack);
			if (!codecString) {
				throw tagErr(new Error(`Cannot determine WebCodecs codec string for: ${codec}`), 'setup');
			}
			const baseConfig = decoderConfig || { codec: codecString, codedWidth: trackWidth, codedHeight: trackHeight };

			// Funnel checkpoint: container parsed, codec resolved. Everything past
			// here depends on the decoder + GPU pipeline, not the container.
			emit('stack-step', 'mediabunny_opened');

			let actualWidth = 0, actualHeight = 0;

			// Tracker for the sharpest frame we've shown so far, plus a helper
			// to publish a preview blob whenever we find a sharper one. Used
			// both after crop detection (Pass 1) and inside Pass 2's rankFrame,
			// so the "Sharpest Frame" preview populates as early as possible.
			let bestFrameSoFar = null;
			async function maybePublishBestFrame(frame) {
				if (!frame?.uint8Buffer || !frame.width || !frame.height) return;
				if (bestFrameSoFar && frame.sharpness <= bestFrameSoFar.sharpness) return;
				bestFrameSoFar = frame;
				try {
					const src = new Uint8ClampedArray(frame.uint8Buffer.slice(0));
					const canvas = new OffscreenCanvas(frame.width, frame.height);
					const ctx = canvas.getContext('2d');
					ctx.putImageData(new ImageData(src, frame.width, frame.height), 0, 0);
					const blob = await canvas.convertToBlob({ type: 'image/png' });
					if (bestFrameSoFar?.index === frame.index) {
						bestFrameSoFar.blob = blob;
						emit('best-frame-updated', bestFrameSoFar);
					}
				} catch (e) {
					console.warn('[Mediabunny] Best-frame preview blob failed:', e);
				}
			}

			// Helper: create and configure a fresh decoder. `dec.configure` can
			// throw synchronously on unsupported profiles; tag as 'setup' so
			// the failure lands in the right analytics bucket.
			let decoderError = null;
			function makeDecoder(outputFn) {
				try {
					const dec = new VideoDecoder({
						output: outputFn,
						error: (e) => {
							console.error('[WebCodecs] Decoder error:', e);
							addLog(`Decoder error: ${e.message}`);
							decoderError = e;
						}
					});
					dec.configure(baseConfig);
					return dec;
				} catch (err) {
					throw tagErr(err, 'setup');
				}
			}

			// Helper: set actual dimensions from first VideoFrame (clamped to strip codec padding)
			function initDims(frame) {
				if (actualWidth !== 0) return;
				const rawW = frame.displayWidth || frame.codedWidth;
				const rawH = frame.displayHeight || frame.codedHeight;
				actualWidth = Math.min(rawW, trackWidth);
				actualHeight = Math.min(rawH, trackHeight);
				const cs = frame.colorSpace;
			addLog(`Frame pixel format: ${frame.format || 'unknown'}, declared full range: ${cs?.fullRange ?? 'unknown'}, matrix: ${cs?.matrix ?? '?'}`);
				if (rawW !== trackWidth || rawH !== trackHeight) {
					addLog(`Codec frame size: ${rawW}x${rawH}, clamped to ${actualWidth}x${actualHeight} (track: ${trackWidth}x${trackHeight})`);
				}
			}

			// Get first key packet, reused for both passes.
			let sink1, firstKeyPacket;
			try {
				sink1 = new EncodedPacketSink(videoTrack);
				firstKeyPacket = await sink1.getFirstKeyPacket({ verifyKeyPackets: true });
			} catch (err) {
				throw tagErr(err, 'setup');
			}
			if (!firstKeyPacket) throw tagErr(new Error('No key frame found in video'), 'setup');

			// ══════════════════════════════════════════════════════════════
			// PASS 1 — Crop detection
			// Grab ~50 keyframes spread evenly across the video and decode ONLY
			// those. Keyframes are self-contained (no dependency on prior
			// frames), so each requires exactly one decode — no wasted work
			// walking through the whole video like a linear decode would.
			//
			// Tolerance: `getKeyPacket(t)` snaps to the nearest keyframe ≤ t, so
			// our samples may land within ±(keyframe spacing) of the requested
			// timestamp. Different target timestamps may also snap to the same
			// keyframe, giving us fewer than SAMPLE_SIZE unique samples. The
			// downstream code (crop detection, medianSize, medianCenter) works
			// fine with any count ≥ 1, so that's not a problem — just log it.
			// ══════════════════════════════════════════════════════════════
			emit('set-caption', 'Detecting crop region...');

			const SAMPLE_SIZE = 50;
			// rawSamples is hoisted above the outer try for cleanup on error paths
			let pass1Count = 0;

			decoder1 = makeDecoder((frame) => {
				if (cancelled) { frame.close(); return; }
				initDims(frame);
				// Every frame the decoder emits was requested — no reservoir
				// sampling. Just keep it.
				rawSamples.push({ frame, index: pass1Count });
				pass1Count++;
			});

			decoderError = null;

			// Duration lets us build evenly-spaced target timestamps. If the
			// container doesn't expose it (rare), fall back to reservoir-style
			// linear iteration of the first ~SAMPLE_SIZE keyframes.
			let duration = 0;
			try { duration = await videoTrack.computeDuration(); } catch (_) { duration = 0; }

			// Build unique keyframe packets snapped to evenly-spaced timestamps.
			// Deduplicate on packet timestamp — multiple targets can map to the
			// same keyframe on videos with sparse keyframes, e.g. long-GOP.
			const seenKeyTs = new Set();
			const keyPackets = [];
			if (duration > 0) {
				for (let i = 0; i < SAMPLE_SIZE; i++) {
					if (cancelled) break;
					// (i + 0.5) so we sample midpoints of 50 buckets rather than
					// the exact video start/end, which are often not keyframe-
					// aligned (start is fine, end never is).
					const ts = ((i + 0.5) / SAMPLE_SIZE) * duration;
					try {
						const kp = await sink1.getKeyPacket(ts, { verifyKeyPackets: true });
						if (!kp) continue;
						if (seenKeyTs.has(kp.timestamp)) continue;
						seenKeyTs.add(kp.timestamp);
						keyPackets.push(kp);
					} catch (_) { /* skip this target on failure */ }
				}
			} else {
				// No duration — fall back to the first N key packets in decode order.
				addLog('Video duration unavailable — sampling the first key packets sequentially instead.');
				let kp = firstKeyPacket;
				while (kp && keyPackets.length < SAMPLE_SIZE) {
					if (cancelled) break;
					if (!seenKeyTs.has(kp.timestamp)) {
						seenKeyTs.add(kp.timestamp);
						keyPackets.push(kp);
					}
					try { kp = await sink1.getNextKeyPacket(kp, { verifyKeyPackets: true }); } catch (_) { break; }
				}
			}

			addLog(`Sampling ${keyPackets.length} keyframes for crop detection (target: ${SAMPLE_SIZE}, duration: ${duration.toFixed(1)}s)`);

			// WebCodecs decoders don't necessarily emit a frame per decode() call
			// — some codecs buffer internally waiting for more input. So submit
			// every decode up front, then await flush() to force all outputs.
			// Progress ticks come from the output callback naturally.
			//
			// Wrap the whole submit + flush in one timeout: 15s per keyframe
			// worth of budget. A genuinely stuck decoder trips this; a slow
			// device on a big video doesn't.
			// Two-stage timing check:
			// 1. THROUGHPUT PROBE — 2 keyframes within 5s (desktop) / 10s (mobile).
			//    Catches genuinely stuck decoders fast so the user isn't waiting
			//    a minute+ to discover software fallback is glacial.
			// 2. TOTAL BUDGET — after the probe passes, the whole Pass 1 must
			//    finish within 60s (desktop) / 120s (mobile). Catches decoders
			//    that emit the first frames fast then slow to a crawl (seen on
			//    Chrome 151 Windows with 24 keyframes running for 15+ min).
			//
			// On total-budget timeout, continue with partial samples only if we
			// got enough AND the decode rate was healthy. Rate gate exists
			// because Pass 2 uses the same VideoDecoder and has no timeout of
			// its own — accepting partials from a catastrophically slow decoder
			// commits us to a Pass 2 crawl with no ffmpeg fallback. Better to
			// bail out to ffmpeg now, while we know it's crappy, than later.
			const THROUGHPUT_PROBE_MS = isMobile ? 10_000 : 5_000;
			// Tight total budget: users cancel on long silent waits, and FFmpeg
			// fallback gives visible progress. Better to fall back at 10-20s than
			// wait a minute for a stalled decoder that started fast.
			const TOTAL_BUDGET_MS = isMobile ? 20_000 : 10_000;
			const PROBE_REQUIRED_SAMPLES = 2;

			let decodeAllResolved = false;
			const decodeAll = (async () => {
				for (let i = 0; i < keyPackets.length; i++) {
					if (cancelled || decoderError) break;
					decoder1.decode(keyPackets[i].toEncodedVideoChunk());
				}
				await decoder1.flush();
				decodeAllResolved = true;
			})();
			const progressTicker = setInterval(() => {
				emit('update-loading', {
					progress: -1,
					current: rawSamples.length,
					total: SAMPLE_SIZE,
				});
			}, 100);

			const passStart = Date.now();
			const probe = new Promise((resolve, reject) => {
				const check = setInterval(() => {
					if (rawSamples.length >= PROBE_REQUIRED_SAMPLES) {
						clearInterval(check);
						resolve();
					} else if (Date.now() - passStart >= THROUGHPUT_PROBE_MS) {
						clearInterval(check);
						reject(new Error(
							`Video decoder too slow — only ${rawSamples.length} keyframe(s) in ${Math.round((Date.now() - passStart) / 1000)}s. ` +
							`This is usually a software-decode fallback for an unsupported hardware codec. Switching decoders.`
						));
					}
				}, 100);
			});
			const totalDeadline = new Promise((_, reject) => {
				setTimeout(() => reject(Object.assign(
					new Error(`Video decoder too slow — only ${rawSamples.length}/${keyPackets.length} keyframes in ${Math.round(TOTAL_BUDGET_MS / 1000)}s. Switching decoders.`),
					{ isTotalTimeout: true }
				)), TOTAL_BUDGET_MS);
			});
			try {
				await probe;
				// Funnel checkpoint: throughput probe passed, decoder is producing frames.
				emit('stack-step', 'mediabunny_probe_ok');
				await Promise.race([decodeAll, totalDeadline]);
			} catch (err) {
				// Any Pass 1 shortfall — probe failure OR total-budget timeout —
				// now falls back to ffmpeg. Prod telemetry (jobs 00og7ibu,
				// 01ao14gr, 00venzdh) shows the "continue with partial samples"
				// path reliably deadlocked in Pass 2's backpressure spin: all
				// three crashes had 10 keyframes at 1.0 kf/s, cleared the old
				// enough+fast thresholds, then froze in Pass 2 for minutes. If
				// Pass 1 couldn't keep up in its own budget, Pass 2 (which also
				// decodes P/B frames) has near-zero chance of working — and the
				// 12s Pass 2 stall watchdog is a safety net, not the primary
				// signal. Skipping straight to ffmpeg saves that 12s wait.
				if (err?.isTotalTimeout) {
					const elapsedS = (Date.now() - passStart) / 1000;
					const rate = elapsedS > 0 ? rawSamples.length / elapsedS : 0;
					addLog(`Slow decoder: ${rawSamples.length}/${keyPackets.length} keyframes in ${Math.round(TOTAL_BUDGET_MS / 1000)}s (${rate.toFixed(2)} kf/s). Falling back to ffmpeg — Pass 2 deadlocks on all observed slow-Pass-1 videos.`);
					emit('stack-step', 'mediabunny_pass1_too_slow');
				}
				throw tagErr(err, 'decoder');
			} finally {
				clearInterval(progressTicker);
				try { decoder1.close(); } catch (_) { /* already closing / closed */ }
			}

			// If the VideoDecoder.error callback fired during pass 1, surface it.
			// Otherwise a bad decoder silently produces zero samples and we
			// misattribute the "No frames decoded" throw to something else.
			if (decoderError) {
				throw tagErr(decoderError, 'decoder');
			}

			// Funnel checkpoint: all requested keyframes decoded (or partial samples
			// accepted after total-budget timeout with >= MIN_USABLE_SAMPLES).
			emit('stack-step', 'mediabunny_decoded');

			// Convert sampled VideoFrames to RGBA async (no canvas, preserves source bit depth)
			let reservoir;
			try {
				reservoir = await Promise.all(
					rawSamples.map(async ({ frame, index }) => {
						const data = await videoFrameToRgba(frame, actualWidth, actualHeight);
						frame.close();
						return { data, index };
					})
				);
			} catch (copyErr) {
				throw tagErr(copyErr, 'copy');
			}

			// Funnel checkpoint: all sampled frames converted to RGBA. Everything
			// past here is analysis, not decode/copy.
			emit('stack-step', 'mediabunny_copied');

			// Pass 2 (below) still iterates every packet in the video for the
			// actual analysis + stacking, so it needs the true frame count for
			// progress + stackPercentage. computePacketStats returns it cheaply
			// (packet-header scan, no decode). For video tracks packetCount ==
			// the video's frame count. If unavailable, fall back to a rough
			// estimate from duration × averageFrameRate, then to sample count.
			let totalFrames = reservoir.length;
			try {
				const stats = await videoTrack.computePacketStats();
				if (stats?.packetCount > 0) totalFrames = stats.packetCount;
				else if (stats?.averagePacketRate && duration > 0) totalFrames = Math.round(duration * stats.averagePacketRate);
			} catch (_) { /* keep the fallback estimate */ }
			if (maxFrames > 0) totalFrames = Math.min(totalFrames, maxFrames);

			const detectedFullRange = reservoir.length > 0 && !isLimitedRange(reservoir[0].data);
			addLog(`Pass 1: ${reservoir.length}/${SAMPLE_SIZE} keyframe samples analyzed (video ~${totalFrames} frames), detected range: ${detectedFullRange ? 'full (expansion skipped)' : 'limited (expansion applied)'}`);
			if (reservoir.length === 0) throw tagErr(new Error('No frames decoded from video'), 'decoder');

			// Bail early when the device's per-buffer cap can't fit a single frame's
			// analysis buffers at native resolution. Seen on Android Chrome with 4K
			// video: moments buffer would be ~228 MB while maxStorageBufferBindingSize
			// caps at 128 MB. Throwing here (source='device-capability') keeps
			// FileUploader from attempting the ffmpeg fallback — ffmpeg feeds the same
			// analyze worker and would blow up identically. Better to fail fast with
			// an actionable message than download 25 MB of decoder to hit the same wall.
			if (useGPU) {
				try {
					await assertDeviceCanFitFrame(actualWidth, actualHeight, 8);
				} catch (err) {
					if (err.source === 'device-capability') throw err;
					throw tagErr(err, 'setup');
				}
			}

			// Diagnostic: peak RGB brightness across sample frames (CPU-side).
			// If the GPU crop detection returns a phantom 1×1 object at (0,0) but
			// the CPU already saw bright pixels here, the failure is in the GPU path.
			if (reservoir.length > 0) {
				let peakMin = 255, peakMax = 0, peakSum = 0;
				for (const { data } of reservoir) {
					const step = Math.max(4, Math.floor(data.length / 4000)) * 4;
					let framePeak = 0;
					for (let i = 0; i < data.length - 3; i += step) {
						const px = Math.max(data[i], data[i + 1], data[i + 2]);
						if (px > framePeak) framePeak = px;
					}
					if (framePeak < peakMin) peakMin = framePeak;
					if (framePeak > peakMax) peakMax = framePeak;
					peakSum += framePeak;
				}
				const peakMean = Math.round(peakSum / reservoir.length);
				addLog(`Sample peak brightness (per-frame max RGB): min=${peakMin}, mean=${peakMean}, max=${peakMax}`);
			}

			// Detect crop region from reservoir samples
			let cropRegion = null;
			let reservoirBounds = null;  // saved for seeding the pass-2 ROI
			// sampleResults declared at outer scope so the crop-detection preview
			// block below can read it after the MIN_SIZE_FOR_CROP branch closes.
			let sampleResults = null;
			const MIN_SIZE_FOR_CROP = 300;
			if (actualWidth >= MIN_SIZE_FOR_CROP && actualHeight >= MIN_SIZE_FOR_CROP && reservoir.length > 0) {
				if (useGPU) {
					// Chunk the reservoir so no single analyzeBatch exceeds the device's
					// maxBufferSize. On Macs with maxBufferSize=2GB, a 50-frame 1080p
					// batch would request a ~3GB moments buffer; WebGPU would silently
					// return an invalid buffer and every frame would be reported as a
					// 1px "planet" at (0, 0). See Sentry EISE-M2.
					// Any throw from getMaxBatchSize or analyzeRgbaBatchGpu (e.g. mobile
					// maxStorageBufferBindingSize exceeded, WebGPU validation error,
					// device-lost cascade) is tagged 'analyze' so it lands in the right
					// analytics bucket instead of being reported as fail_stage=null.
					try {
						const maxBatch = await getMaxBatchSize(actualWidth, actualHeight, 8);
						if (reservoir.length > maxBatch) {
							addLog(`Chunking crop-detection: ${reservoir.length} samples / ${maxBatch} per GPU batch (maxBufferSize limit)`);
						}
						sampleResults = [];
						for (let start = 0; start < reservoir.length; start += maxBatch) {
							const chunk = reservoir.slice(start, start + maxBatch);
							const chunkResults = await analyzeRgbaBatchGpu(chunk, actualWidth, actualHeight);
							sampleResults.push(...chunkResults);
						}
					} catch (err) {
						// Preserve upstream tags (e.g. 'device-capability' from the analyze worker).
						if (err.source) throw err;
						throw tagErr(err, 'analyze');
					}
				} else {
					// CPU: detect bounds via workers. Add onerror + 'error' type handler
					// + timeout so a worker crash doesn't hang forever (previously silent —
					// contributes to the "stack_step then silence" bucket).
					const CPU_BOUNDS_TIMEOUT_MS = 60_000;
					const promises = reservoir.map((frame, i) => {
						const worker = cpuWorkers[i % cpuWorkers.length];
						return new Promise((resolve, reject) => {
							const timeout = setTimeout(() => {
								worker.removeEventListener('message', handler);
								worker.removeEventListener('error', onerror);
								reject(new Error(`CPU bounds worker ${i} timeout after ${CPU_BOUNDS_TIMEOUT_MS / 1000}s`));
							}, CPU_BOUNDS_TIMEOUT_MS);
							const cleanup = () => {
								clearTimeout(timeout);
								worker.removeEventListener('message', handler);
								worker.removeEventListener('error', onerror);
							};
							const handler = (e) => {
								if (!e.data) { cleanup(); reject(new Error('CPU bounds worker crashed (empty message)')); return; }
								if (e.data.type === 'bounds') {
									cleanup();
									resolve({ bounds: e.data.bounds.canCrop ? e.data.bounds : null, index: frame.index });
								} else if (e.data.type === 'error') {
									cleanup();
									reject(new Error(e.data.message || 'CPU bounds worker error'));
								}
							};
							const onerror = (e) => {
								cleanup();
								reject(new Error(e.message || 'CPU bounds worker onerror'));
							};
							worker.addEventListener('message', handler);
							worker.addEventListener('error', onerror);
							const buffer = frame.data.buffer.slice(0);
							worker.postMessage({
								type: 'detect-bounds-rgba',
								rgbaBuffer: buffer,
								width: actualWidth,
								height: actualHeight,
								index: frame.index
							}, [buffer]);
						});
					});
					try {
						sampleResults = await Promise.all(promises);
					} catch (err) {
						throw tagErr(err, 'analyze');
					}
				}
				// Funnel checkpoint: crop-detection analysis completed (before the
				// median-size check that decides whether the crop is usable).
				emit('stack-step', 'mediabunny_analyzed');
				const detectedCenters = [], detectedSizes = [];
				let nullCount = 0, trivialCount = 0;
				const validBounds = [];  // normalized bounds objects for ROI seeding
				for (const r of sampleResults) {
					if (!r.bounds) { nullCount++; continue; }
					const size = Math.max(r.bounds.width, r.bounds.height);
					detectedCenters.push({ x: r.bounds.centroidX, y: r.bounds.centroidY });
					detectedSizes.push(size);
					// size ≤ 2 usually means the bounds shader's initial (0,0,0,0) leaked
					// through — no pixel actually exceeded the brightness threshold.
					if (size <= 2) trivialCount++;
					// Skip trivial "phantom" bounds so they don't drag the ROI to (0,0).
					if (size > 2) {
						// Some shaders emit x/y explicitly; others only centroidX/Y+width/height.
						// Fall back to centroid-derived corner in the second case.
						const bx = r.bounds.x !== undefined ? r.bounds.x : Math.max(0, r.bounds.centroidX - r.bounds.width / 2);
						const by = r.bounds.y !== undefined ? r.bounds.y : Math.max(0, r.bounds.centroidY - r.bounds.height / 2);
						validBounds.push({
							x: bx, y: by,
							width: r.bounds.width, height: r.bounds.height,
							centroidX: r.bounds.centroidX, centroidY: r.bounds.centroidY,
							size, cutOff: r.bounds.cutOff
						});
					}
				}
				reservoirBounds = validBounds.length > 0 ? validBounds : null;

				// Diagnostic: size / center distribution across sample frames.
				// If every frame reports size=1 at (0,0), the grayscale/threshold
				// path returned no bright pixels on the user's GPU (phantom detection).
				if (detectedSizes.length > 0) {
					const sortedS = [...detectedSizes].sort((a, b) => a - b);
					const sMin = sortedS[0];
					const sMed = sortedS[Math.floor(sortedS.length / 2)];
					const sMax = sortedS[sortedS.length - 1];
					const xs = detectedCenters.map(c => c.x);
					const ys = detectedCenters.map(c => c.y);
					const xMin = Math.round(Math.min(...xs)), xMax = Math.round(Math.max(...xs));
					const yMin = Math.round(Math.min(...ys)), yMax = Math.round(Math.max(...ys));
					addLog(`Bounds: ${detectedSizes.length} valid, ${nullCount} null, ${trivialCount} trivial (size≤2) | sizes[min/med/max]=${sMin}/${sMed}/${sMax}px | centers x[${xMin}..${xMax}] y[${yMin}..${yMax}]`);
				} else {
					addLog(`Bounds: 0 valid, ${nullCount} null (all samples). Threshold=0.1 saw no bright pixels.`);
				}

				if (detectedCenters.length < reservoir.length * 0.5) {
					addLog(`Only ${detectedCenters.length}/${reservoir.length} samples detected a bright object. Skipping auto-crop.`);
				} else {
					const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
					const medianSize = sortedSizes[Math.floor(sortedSizes.length / 2)];
					const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
					const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
					const medianX = sortedX[Math.floor(sortedX.length / 2)];
					const medianY = sortedY[Math.floor(sortedY.length / 2)];
					const desiredSize = Math.ceil(medianSize * (1 + cropMarginPercent / 100) / 2) * 2;
					const maxAllowedSize = Math.min(actualWidth, actualHeight);

					// Real planets at 1080p are at least ~15-20px across. A median object
					// size of a few pixels across 50 samples means auto-detection failed
					// (e.g. planet too dim, below GPU brightness threshold, or shader
					// anomaly returning phantom bounds at (0,0) as in Sentry EISE-M2).
					// Falling through with a 2×2 cropRegion causes every downstream frame
					// to be rejected — and even if we processed full frames, the planet is
					// too small relative to the frame for stacking to align correctly. Stop
					// with a clear message rather than proceed to guaranteed-broken output.
					if (medianSize <= 4) {
						throw tagErr(new Error(`Planet detection failed — the detected object was only ${Math.round(medianSize)}px across ${detectedCenters.length} samples. This can happen with very dim planets, unusual video formats, or on some GPUs. Try re-encoding the video at a lower resolution, cropping around the planet in a video editor first, or a different browser.`), 'detect');
					} else if (desiredSize >= maxAllowedSize) {
						if (surfaceMode) {
							addLog(`Surface mode: using full frame ${maxAllowedSize}x${maxAllowedSize}`);
							cropRegion = { size: maxAllowedSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
						} else {
							addLog(`Skipping crop: detected size ${desiredSize}px (median: ${Math.round(medianSize)}px) exceeds frame ${maxAllowedSize}px`);
						}
					} else {
						cropRegion = { size: desiredSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
						addLog(`Detected crop size: ${desiredSize}x${desiredSize}, median object: ${Math.round(medianSize)}px`);
						addLog(`Median center: (${Math.round(medianX)}, ${Math.round(medianY)})`);
					}
				}
			}

			// Funnel checkpoint: crop detection is done (or explicitly skipped).
			// If we got here, mediabunny decoded enough samples to run detection —
			// the primary "did the reader actually work?" signal.
			emit('stack-step', 'crop_detected');

			// Publish the sharpest reservoir sample as an initial preview so the
			// user sees "here's what we detected" the moment crop detection
			// finishes, before Pass 2's per-frame ranking has produced anything.
			if (reservoir.length > 0 && sampleResults?.length === reservoir.length) {
				let bestIdx = -1, bestSharp = -Infinity;
				for (let i = 0; i < sampleResults.length; i++) {
					const s = sampleResults[i]?.sharpness || 0;
					if (s > bestSharp && sampleResults[i]?.bounds) {
						bestSharp = s;
						bestIdx = i;
					}
				}
				if (bestIdx >= 0) {
					const sample = reservoir[bestIdx];
					const b = sampleResults[bestIdx].bounds;
					// If we know a crop region, deliver a cropped preview centered
					// on the detected planet; otherwise show the full sample.
					let previewBuffer, previewW, previewH;
					if (cropRegion) {
						previewW = previewH = cropRegion.size;
						previewBuffer = cropRgba(sample.data, actualWidth, actualHeight,
							cropRegion.size, b.centroidX, b.centroidY);
					} else {
						previewW = actualWidth;
						previewH = actualHeight;
						previewBuffer = sample.data.buffer.slice(0);
					}
					maybePublishBestFrame({
						index: sample.index,
						sharpness: bestSharp,
						width: previewW,
						height: previewH,
						uint8Buffer: previewBuffer,
						centerX: b.centroidX,
						centerY: b.centroidY,
					});
				}
			}

			// Free sample RGBA — no longer needed
			reservoir.length = 0;

			// ══════════════════════════════════════════════════════════════
			// PASS 2 — Streaming batch analysis
			// Decode packets in groups of BATCH_SIZE. After each group, flush
			// the decoder and GPU-analyze the batch. RGBA is freed after each
			// batch; only the small cropped uint8Buffer is kept for ranked frames.
			// For manual threshold mode ALL frames' uint8Buffers are retained
			// (they are the small cropped region, not the full RGBA frame).
			// ══════════════════════════════════════════════════════════════
			emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');
			emit('update-loading', { progress: 0, current: 0, total: totalFrames });

			const BATCH_SIZE = useGPU ? 32 : 8;
			const bestFramesCapacity = Math.max(1, Math.floor(totalFrames * stackPercentage / 100));
			const bestFramesForStacking = [];
			const allAnalyzedFrames = manualThreshold ? [] : null;
			const frameCenters = new Map();
			let skippedFrames = 0, cutOffFrames = 0, oversizedFrames = 0;
			let pass2FrameIndex = 0;

			// (bestFrameSoFar + maybePublishBestFrame declared earlier so Pass 1
			// can also fire an initial preview once crop detection completes.)

			// ROI pre-crop state. Same idea as the SER precrop_worker but the
			// "cropping" happens inside VideoFrame.copyTo() via its rect parameter,
			// so we skip the decoded YUV → RGBA copy work on pixels outside the ROI.
			// The video codec still decodes the whole frame (fundamental constraint),
			// but the per-frame copy + GPU upload shrinks to the ROI size.
			//
			// Only active when we have a cropRegion (detected planet) and not in
			// surface mode. Seeded from reservoir bounds (below) so batch 0 benefits.
			let preCropRegion = null;
			let preCropLoggedFor = null;  // avoid spamming the log when ROI shifts
			const roiActive = () => cropRegion && !surfaceMode && preCropRegion !== null;

			// A crop centered on the planet must fit inside the ROI. computePreCropRegion's
			// 1.5×planet-size margin is enough for typical motion, but if the planet is
			// small the absolute margin can be smaller than the crop's own half-size,
			// which caused the "square border" artifact when planet drifted a bit within
			// a batch. Enforce a floor that gives the crop cropRegion.size + 100 px of
			// room (50 px of drift budget per side, well above per-batch drift).
			function enforceMinRoi(region) {
				if (!region || !cropRegion) return region;
				const minSize = cropRegion.size + 100;
				let { x, y, width, height } = region;
				if (width < minSize) {
					const grow = minSize - width;
					x = Math.max(0, x - Math.floor(grow / 2));
					width = Math.min(minSize, actualWidth - x);
				}
				if (height < minSize) {
					const grow = minSize - height;
					y = Math.max(0, y - Math.floor(grow / 2));
					height = Math.min(minSize, actualHeight - y);
				}
				// If we hit the frame edge on one side, push the origin back so we still
				// get the full minSize when there's room on the other side.
				if (width < minSize && x > 0) {
					x = Math.max(0, actualWidth - minSize);
					width = Math.min(minSize, actualWidth - x);
				}
				if (height < minSize && y > 0) {
					y = Math.max(0, actualHeight - minSize);
					height = Math.min(minSize, actualHeight - y);
				}
				// Even dimensions/coords keep GPU byte-alignment consistent.
				x = x & ~1; y = y & ~1;
				width = width & ~1; height = height & ~1;
				return { x, y, width, height };
			}

			// Seed the ROI from reservoir bounds so batch 0 already benefits AND the
			// initial ROI reflects the full range of planet positions across the whole
			// clip (reservoir was uniform-sampled across all frames), not just the
			// first batch's ~1 second of footage. Use marginFactor 2.0 (wider than the
			// 1.5 used for per-batch updates) since the between-sample gap can be
			// several seconds of unaccounted drift.
			if (cropRegion && !surfaceMode && reservoirBounds) {
				let seeded = computePreCropRegion(reservoirBounds, actualWidth, actualHeight, 2.0);
				seeded = enforceMinRoi(seeded);
				if (seeded) {
					const reduction = ((actualWidth * actualHeight) - (seeded.width * seeded.height)) / (actualWidth * actualHeight) * 100;
					if (reduction > 10) {
						preCropRegion = seeded;
						preCropLoggedFor = `${seeded.width}x${seeded.height}`;
						addLog(`ROI pre-crop seeded from reservoir: ${seeded.width}x${seeded.height} (${reduction.toFixed(0)}% smaller than full ${actualWidth}x${actualHeight})`);
					}
				}
			}

			function rankFrame(frame) {
				if (frame.uint8Buffer && frame.width && frame.height) {
					capturePostCropFrame(frame.uint8Buffer, frame.width, frame.height, frame.index, totalFrames);
				}
				if (manualThreshold) allAnalyzedFrames.push(frame);

				if (bestFramesForStacking.length < bestFramesCapacity) {
					bestFramesForStacking.push(frame);
				} else {
					const minIdx = bestFramesForStacking.reduce((minI, f, i, arr) =>
						f.sharpness < arr[minI].sharpness ? i : minI, 0);
					if (frame.sharpness > bestFramesForStacking[minIdx].sharpness) {
						bestFramesForStacking[minIdx] = frame;
					}
				}

				// Fire-and-forget preview publish — decides internally whether
				// this frame beats the current best.
				maybePublishBestFrame(frame);
			}

			// Crop RGBA buffer around a center point
			function cropRgba(rgbaData, srcWidth, srcHeight, cropSize, centerX, centerY) {
				const halfSize = cropSize / 2;
				const startX = Math.max(0, Math.min(srcWidth - cropSize, Math.floor(centerX - halfSize)));
				const startY = Math.max(0, Math.min(srcHeight - cropSize, Math.floor(centerY - halfSize)));
				const cropped = new Uint8ClampedArray(cropSize * cropSize * 4);
				for (let y = 0; y < cropSize; y++) {
					const srcOff = ((startY + y) * srcWidth + startX) * 4;
					const dstOff = y * cropSize * 4;
					cropped.set(rgbaData.subarray(srcOff, srcOff + cropSize * 4), dstOff);
				}
				return cropped;
			}

			// Detect bounds for a single RGBA frame via CPU worker
			function detectBoundsCpu(worker, rgbaData, width, height, index) {
				return new Promise((resolve) => {
					const handler = (e) => {
						if (e.data.type === 'bounds') {
							worker.removeEventListener('message', handler);
							resolve({ bounds: e.data.bounds.canCrop ? e.data.bounds : null, index });
						}
					};
					worker.addEventListener('message', handler);
					const buffer = rgbaData.buffer.slice(0);
					worker.postMessage({ type: 'detect-bounds-rgba', rgbaBuffer: buffer, width, height, index }, [buffer]);
				});
			}

			// Analyze a single RGBA frame via CPU worker, returns a promise
			function analyzeCpuFrame(worker, rgbaData, width, height, index) {
				return new Promise((resolve, reject) => {
					const handler = (e) => {
						worker.removeEventListener('message', handler);
						if (e.data.skipped) { resolve({ skipped: true, reason: e.data.reason, index }); return; }
						resolve({
							sharpness: e.data.sharpness || 0,
							uint8Buffer: e.data.uint8Buffer,
							width: e.data.width || width,
							height: e.data.height || height,
							index
						});
					};
					worker.addEventListener('message', handler);
					const buffer = rgbaData.buffer.slice(0);
					worker.postMessage({
						type: 'rgba',
						rgbaBuffer: buffer,
						width, height, index,
						includeRgba: true
					}, [buffer]);
				});
			}

			// Called after each decoder flush — analyzes an already-RGBA batch.
			// The RGBA copy and VideoFrame.close() happen in the decoder output
			// callback so decoder-pool slots are freed as fast as they're produced;
			// see the callback for the deadlock rationale.
			async function processBatch(batch) {
				if (batch.length === 0) return;

				// ROI snapshot for the downstream coord shifts. The RGBA copy
				// already applied the ROI at output time; here we just need the
				// dimensions and the offsets used to map ROI-local → full-frame.
				const roi = roiActive() ? preCropRegion : null;
				const roiW = roi ? roi.width : actualWidth;
				const roiH = roi ? roi.height : actualHeight;

				const rgbaBatch = batch;

				// Coordinates returned by GPU/CPU are ROI-local when ROI is active;
				// bounds fields need to be shifted back to full-frame coords before
				// cutoff checks (which are measured against actualWidth/Height) and
				// before we hand results downstream.
				const shiftX = roi ? roi.x : 0;
				const shiftY = roi ? roi.y : 0;
				const collectedBounds = [];
				// Lost-track detector: if the ROI moved away from the planet (e.g. user
				// nudged the scope between batches), most detections come back empty.
				// Count and, at the end of the batch, reset ROI to null if the rate is
				// too high so the next batch scans full-frame and re-locks.
				let batchAttempts = 0;
				let batchNoBounds = 0;

				if (useGPU) {
					// GPU path
					if (cropRegion) {
						const combinedResults = await detectCropAnalyzeRgbaGpu(
							rgbaBatch, roiW, roiH, cropRegion.size, 0.1, true
						);
						for (let j = 0; j < combinedResults.length; j++) {
							const gpuResult = combinedResults[j];
							batchAttempts++;
							if (!gpuResult.bounds) { batchNoBounds++; skippedFrames++; continue; }

							// gpuResult.centerX/Y are in the buffer we sent (ROI-local when
							// ROI active, full-frame otherwise). Shift into full-frame coords
							// for the outward-facing outputs, but keep the ROI-local value
							// around for the cut-off check.
							const localCx = gpuResult.centerX;
							const localCy = gpuResult.centerY;
							const centerX = localCx + shiftX;
							const centerY = localCy + shiftY;
							const shiftedBounds = {
								...gpuResult.bounds,
								x: (gpuResult.bounds.x || 0) + shiftX,
								y: (gpuResult.bounds.y || 0) + shiftY,
								centroidX: (gpuResult.bounds.centroidX || 0) + shiftX,
								centroidY: (gpuResult.bounds.centroidY || 0) + shiftY
							};
							collectedBounds.push(shiftedBounds);

							if (!surfaceMode) {
								// Reject if the crop would straddle the buffer we operated on.
								// When ROI is active, that's the ROI; when not, it's the full
								// frame (roiW/roiH reduce to actualWidth/Height). Pixels outside
								// the ROI weren't copied, so a crop that reaches past the ROI
								// edge shows GPU sampler clamp/border, not real pixel data.
								const halfCrop = cropRegion.size / 2;
								if (localCx - halfCrop < 0 || localCy - halfCrop < 0 ||
									localCx + halfCrop > roiW || localCy + halfCrop > roiH) {
									cutOffFrames++; continue;
								}
							}
							if (cropRegion.medianObjectSize) {
								if (Math.max(gpuResult.bounds.width, gpuResult.bounds.height) / cropRegion.medianObjectSize > 1.3) {
									oversizedFrames++; continue;
								}
							}
							frameCenters.set(rgbaBatch[j].index, { x: centerX, y: centerY });
							rankFrame({
								sharpness: gpuResult.sharpness,
								width: cropRegion.size, height: cropRegion.size,
								index: rgbaBatch[j].index,
								centerX, centerY,
								circularity: gpuResult.circularity || 0,
								uint8Buffer: gpuResult.uint8Buffer
							});
						}
					} else {
						const results = await analyzeRgbaBatchGpu(rgbaBatch, roiW, roiH);
						for (const result of results) {
							rankFrame({
								sharpness: result.sharpness || 0,
								width: roiW, height: roiH,
								index: result.index,
								centerX: roiW / 2 + shiftX, centerY: roiH / 2 + shiftY,
								circularity: result.circularity || 0,
								uint8Buffer: result.uint8Buffer
							});
						}
					}
				} else {
					// CPU path
					if (cropRegion) {
						// Detect bounds, crop, then analyze each frame
						for (let j = 0; j < rgbaBatch.length; j++) {
							const frame = rgbaBatch[j];
							const worker = cpuWorkers[j % cpuWorkers.length];

							// Detect object center within the (possibly ROI-cropped) buffer.
							batchAttempts++;
							const boundsResult = await detectBoundsCpu(worker, frame.data, roiW, roiH, frame.index);
							if (!boundsResult.bounds) { batchNoBounds++; skippedFrames++; continue; }

							// ROI-local center and full-frame center.
							const localCx = boundsResult.bounds.centroidX;
							const localCy = boundsResult.bounds.centroidY;
							const cx = localCx + shiftX;
							const cy = localCy + shiftY;
							collectedBounds.push({
								...boundsResult.bounds,
								x: (boundsResult.bounds.x || 0) + shiftX,
								y: (boundsResult.bounds.y || 0) + shiftY,
								centroidX: cx,
								centroidY: cy
							});

							if (!surfaceMode) {
								// Same reasoning as the GPU branch: reject if the crop reaches
								// outside the buffer we actually copied. cropRgba below clamps
								// silently, so without this check a drifted-to-edge planet
								// would come out with a hard ROI-boundary border on one side.
								const halfCrop = cropRegion.size / 2;
								if (localCx - halfCrop < 0 || localCy - halfCrop < 0 ||
									localCx + halfCrop > roiW || localCy + halfCrop > roiH) {
									cutOffFrames++; continue;
								}
							}
							if (cropRegion.medianObjectSize) {
								if (Math.max(boundsResult.bounds.width, boundsResult.bounds.height) / cropRegion.medianObjectSize > 1.3) {
									oversizedFrames++; continue;
								}
							}

							// Crop from the ROI buffer using ROI-local coords so the crop
							// doesn't need to re-derive full-frame offsets.
							const cropped = cropRgba(frame.data, roiW, roiH, cropRegion.size, localCx, localCy);
							const result = await analyzeCpuFrame(worker, cropped, cropRegion.size, cropRegion.size, frame.index);
							if (result.skipped) { skippedFrames++; continue; }

							frameCenters.set(frame.index, { x: cx, y: cy });
							rankFrame({
								sharpness: result.sharpness,
								width: cropRegion.size, height: cropRegion.size,
								index: frame.index,
								centerX: cx, centerY: cy,
								circularity: 0,
								uint8Buffer: result.uint8Buffer
							});
						}
					} else {
						// No crop — analyze full frames in parallel
						const promises = rgbaBatch.map((frame, i) => {
							const worker = cpuWorkers[i % cpuWorkers.length];
							return analyzeCpuFrame(worker, frame.data, actualWidth, actualHeight, frame.index);
						});
						const results = await Promise.all(promises);
						for (const result of results) {
							if (result.skipped) { skippedFrames++; continue; }
							rankFrame({
								sharpness: result.sharpness,
								width: result.width, height: result.height,
								index: result.index,
								centerX: result.width / 2, centerY: result.height / 2,
								circularity: 0,
								uint8Buffer: result.uint8Buffer
							});
						}
					}
				}

				// Lost-track recovery. If most frames in the batch had no detected
				// bounds AND we were using an ROI, the planet has probably drifted
				// out of it. Drop the ROI so the next batch scans full-frame and
				// re-locks; skip the ROI update since the sparse detections we do
				// have would just point at the ROI edge and pull it the wrong way.
				const lostTrack = roi && batchAttempts >= 4 && batchNoBounds / batchAttempts > 0.7;
				if (lostTrack) {
					preCropRegion = null;
					preCropLoggedFor = null;
					addLog(`ROI pre-crop reset: ${batchNoBounds}/${batchAttempts} frames lost planet, rescanning full frame`);
				}

				// Update the ROI for the next batch. Guard by cropRegion+non-surface
				// (matches SER: no ROI when there's no planet detection or when the
				// whole frame is the subject). Skip on lost-track — see above.
				if (!lostTrack && cropRegion && !surfaceMode && collectedBounds.length > 0) {
					let newRegion = computePreCropRegion(collectedBounds, actualWidth, actualHeight, 1.5);
					newRegion = enforceMinRoi(newRegion);
					if (newRegion) {
						const reduction = ((actualWidth * actualHeight) - (newRegion.width * newRegion.height)) / (actualWidth * actualHeight) * 100;
						if (reduction > 10) {
							// Only update if it moved noticeably (avoid jitter).
							const moved = !preCropRegion
								|| Math.abs(newRegion.x - preCropRegion.x) > 10
								|| Math.abs(newRegion.y - preCropRegion.y) > 10;
							if (moved) {
								preCropRegion = newRegion;
								const logKey = `${newRegion.width}x${newRegion.height}`;
								if (preCropLoggedFor !== logKey) {
									addLog(`ROI pre-crop: ${newRegion.width}x${newRegion.height} (${reduction.toFixed(0)}% smaller than full ${actualWidth}x${actualHeight})`);
									preCropLoggedFor = logKey;
								}
							}
						} else if (preCropRegion) {
							// New computed ROI is basically the full frame — planet drifted
							// wide enough that pre-crop no longer buys us anything. Drop it
							// so subsequent batches process at full resolution.
							preCropRegion = null;
							preCropLoggedFor = null;
							addLog('ROI pre-crop disabled (planet motion covers most of frame)');
						}
					}
				}

				emit('update-loading', {
					progress: 50 + (pass2FrameIndex / totalFrames) * 40,
					current: pass2FrameIndex,
					total: totalFrames
				});
			}

			// currentBatch is hoisted above the outer try for cleanup on error paths

			// In-flight RGBA conversions. WebCodecs fires the output callback and
			// discards any Promise it returns, so we must track them here and
			// await them before batching — otherwise decoder2.flush() can
			// resolve while some frames are still copying, leading to a
			// short/misordered batch (and stragglers leaking into the next).
			const pendingConversions = new Set();

			decoder2 = makeDecoder((frame) => {
				if (cancelled) { frame.close(); return; }
				// Convert to RGBA + close the VideoFrame IMMEDIATELY, before the
				// decoder's frame pool fills. Holding raw VideoFrames in
				// currentBatch was pinning 30–60 output surfaces (BATCH_SIZE + GOP)
				// against a HW pool of ~10–16 slots, causing the decoder to
				// silently stop producing frames — see 4K stalls in jobs 00venzdh,
				// 00og7ibu, 01ao14gr, all frozen at ~10 frames out.
				const index = pass2FrameIndex++;
				const p = (async () => {
					try {
						const data = await videoFrameToRgba(frame, actualWidth, actualHeight, roiActive() ? preCropRegion : null);
						frame.close();
						currentBatch.push({ data, index });
						bumpPass2Frame();
					} catch (e) {
						try { frame.close(); } catch (_) {}
						if (!decoderError) decoderError = e;
					} finally {
						pendingConversions.delete(p);
					}
				})();
				pendingConversions.add(p);
			});

			const sink2 = new EncodedPacketSink(videoTrack);
			const firstKeyPacket2 = await sink2.getFirstKeyPacket({ verifyKeyPackets: true });
			let packetsSinceFlush = 0;

			// Reset pass-2 telemetry so this run's counters don't reflect any
			// prior attempt. Read by app.vue's stack_ping snapshot to pin which
			// await is stalling: packet iterator, decoder output, backpressure,
			// or batch analyze.
			resetPass2Counters();

			// Funnel checkpoint: Pass 2 has been set up and is about to start
			// iterating packets. Distinguishes "died in Pass 2 setup" from
			// "died mid-loop". Section 11.15 showed users vanishing between
			// crop_detected and stack_finished; this is the first Pass 2 waypoint.
			emit('stack-step', 'mediabunny_pass2_started');

			decoderError = null;
			// processBatch fans out to the analyze worker (GPU or CPU). Any
			// error here is downstream of decode, tag as 'analyze' so we can
			// distinguish it from decoder/copy failures in analytics.
			const runBatch = async (batch) => {
				try {
					await processBatch(batch);
					bumpPass2Batch();
				} catch (analyzeErr) {
					throw tagErr(analyzeErr, 'analyze');
				}
			};
			for await (const packet of sink2.packets(firstKeyPacket2, undefined, { verifyKeyPackets: true })) {
				bumpPass2Packet();
				if (cancelled || decoderError) break;
				if (maxFrames > 0 && pass2FrameIndex >= maxFrames) break;

				const chunk = packet.toEncodedVideoChunk();

				// Flush and process at keyframe boundaries only — after flush(), WebCodecs requires
				// the next packet to be a keyframe (same as after configure()). Camera H.264 places
				// keyframes every GOP (typically 30–120 frames), so we batch at those boundaries
				// once we've accumulated at least BATCH_SIZE frames.
				if (packetsSinceFlush >= BATCH_SIZE && chunk.type === 'key') {
					await decoder2.flush();
					// flush() only waits for decode; the output callback fires
					// async RGBA copies that WebCodecs doesn't track. Drain
					// them before consuming currentBatch so the batch is
					// complete and no stragglers land in the next batch.
					if (pendingConversions.size) await Promise.all([...pendingConversions]);
					const batch = currentBatch;
					currentBatch = [];
					await runBatch(batch);
					packetsSinceFlush = 0;
				}

				// Backpressure: wait for decoder to catch up if queue is too deep
				while (decoder2.decodeQueueSize > 3 && !decoderError) {
					setPass2QueueSize(decoder2.decodeQueueSize);
					// Stall watchdog: if the decoder has emitted at least one
					// frame but hasn't produced any in PASS2_STALL_TIMEOUT_MS,
					// bail. Tag as `decoder-stall` (not plain `decoder`) so
					// FileUploader can SKIP the FFmpeg fallback for this case
					// specifically — by Pass 2 stall time we've already decoded
					// thousands of frames and heap is 5-10+ GB. Adding a 25 MB
					// FFmpeg wasm download and running it on that stressed heap
					// routinely OOMs the tab (see prod job 01w7id3f: 10 GB →
					// 12 GB → tab killed silently, no terminal event).
					const counters = getPass2Counters();
					if (counters.frame_index > 0 && counters.last_frame_ts) {
						const stallMs = Date.now() - counters.last_frame_ts;
						if (stallMs > PASS2_STALL_TIMEOUT_MS) {
							throw tagErr(new Error(
								`Decoder stalled: no frame output in ${stallMs}ms (queue=${decoder2.decodeQueueSize}, frames_out=${counters.frame_index}, packets_in=${counters.packet_count})`
							), 'decoder-stall');
						}
					}
					await new Promise(r => setTimeout(r, 5));
				}
				setPass2QueueSize(decoder2.decodeQueueSize);

				// The backpressure loop above exits on `!decoderError`, so if the
				// error callback fired mid-wait we'd fall through and hit
				// `VideoDecoder is not configured` here (Safari tears the decoder
				// down on error). See EISE-P5.
				if (decoderError) break;

				decoder2.decode(chunk);
				packetsSinceFlush++;
			}
			// Drain remaining
			await decoder2.flush();
			if (pendingConversions.size) await Promise.all([...pendingConversions]);
			await runBatch(currentBatch);
			currentBatch = [];

			// A pass-2 decoder failure was silently suppressed by the loop's
			// `if (decoderError) break;` guard. Surface it now so we don't hand
			// back a truncated, unusable set of frames to the stacker.
			if (decoderError) {
				throw tagErr(decoderError, 'decoder');
			}

			decoder2.close();
			input.dispose();

			// Funnel checkpoint: Pass 2 packet loop completed and all batches
			// have been analyzed. Distinguishes "died mid-Pass-2" from
			// "died in the post-Pass-2 stacking step". Only reached if every
			// packet was decoded, every batch analyzed, and no decoder error.
			emit('stack-step', 'mediabunny_pass2_drained');

			// Clean up CPU workers (GPU worker cleaned up by terminateGpuWorker)
			cpuWorkers.forEach(w => w.terminate());
			cpuWorkers = [];

			if (cancelled) { addLog('Processing cancelled'); emit('stop-loading'); return; }

			const skipMsgs = [];
			if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} no-bounds`);
			if (cutOffFrames > 0) skipMsgs.push(`${cutOffFrames} near-edge`);
			if (oversizedFrames > 0) skipMsgs.push(`${oversizedFrames} size-outlier`);
			if (skipMsgs.length > 0) addLog(`Skipped: ${skipMsgs.join(', ')}`);

			// Manual threshold mode: keep all uint8Buffers for quality selector
			if (manualThreshold) {
				// Funnel branch: user is in manual/continuous quality mode. The
				// stacker handoff never happens; instead we hand ranked frames
				// to the UI for the user to pick a threshold. This is a
				// legitimate terminal outcome from mediabunny's perspective.
				emit('stack-step', 'mediabunny_pass2_manual');
				const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
				emit('quality-selection-ready', {
					frames: allFramesSorted,
					useWebGPU: useGPU,
					drizzleScale,
					frameCenters,
					frameReReader: null
				});
				return;
			}

			// Stack best frames
			emit('set-caption', 'Stacking frames...');
			addLog(`Stacking ${bestFramesForStacking.length} frames`);
			// Funnel checkpoint: about to hand off to the stacker. Sessions
			// that reach here but never fire stack_finished / stack_failed are
			// dying inside stackFramesLocally (template match, warp, accumulate).
			emit('stack-step', 'mediabunny_pass2_stacking');

			const stackResult = await stackFramesLocally(
				bestFramesForStacking,
				null,
				drizzleScale,
				useGPU,
				frameCenters,
				surfaceMode
			);

			if (stackResult) {
				emit('postProcessing', stackResult.blob, stackResult.float32Data, stackResult.width, stackResult.height);
			} else {
				addLog('Stacking failed');
				emit('upload-error', 'Stacking failed. Please try again.');
			}

		} catch (err) {
			// Default any untagged throw to source='unknown' and flag it so we
			// can find the remaining gaps in Sentry (search
			// `extra.untagged_source:true`). Once no untagged errors appear in
			// production for a week, every future analytics fail_stage value
			// should be one of the known tags.
			const untagged = !err.source;
			if (untagged) err.source = 'unknown';
			console.error('[Mediabunny] Processing failed:', err);
			addLog(`Error: ${err.message}`);
			reportError(err, {
				component: 'useMediabunnyReader',
				action: 'processVideoFrames',
				extra: { source: err.source, untagged_source: untagged }
			});
			// Re-throw so the caller (FileUploader) can decide: fall back to
			// FFmpeg + fire stack_reader_fallback, or surface the error via
			// its top-level catch. Emitting upload-error/stop-loading here
			// would short-circuit that decision.
			throw err;
		} finally {
			// Best-effort cleanup on ALL paths (success + error). On the
			// success path most of these are already closed/disposed by the
			// pipeline — the try/catch(_) makes double-close safe. On error
			// paths, this is the only thing preventing GPU memory (undrained
			// VideoFrames) and file handles (mediabunny Input) from
			// accumulating across retries, which browsers throttle over time.
			for (const s of rawSamples) { try { s.frame?.close(); } catch (_) {} }
			for (const s of currentBatch) { try { s.frame?.close(); } catch (_) {} }
			try { decoder1?.close(); } catch (_) {}
			try { decoder2?.close(); } catch (_) {}
			try { input?.dispose(); } catch (_) {}
			for (const w of cpuWorkers) { try { w.terminate(); } catch (_) {} }
		}
	}

	/**
	 * Heuristic: check whether RGBA buffer actually contains limited-range data.
	 * Full-range video will have pixel values below 16 (valid dark pixels).
	 * Limited-range video should never have values below 16 (16 = black level).
	 * Samples a spread of pixels to avoid false positives from padding rows.
	 */
	function isLimitedRange(buffer) {
		const step = Math.max(4, Math.floor(buffer.length / 4000)) * 4; // ~1000 samples
		for (let i = 0; i < buffer.length - 3; i += step) {
			if (buffer[i] < 16 || buffer[i + 1] < 16 || buffer[i + 2] < 16) return false;
		}
		return true;
	}

	/**
	 * Convert VideoFrame to RGBA Uint8ClampedArray, optionally to just a sub-region.
	 * Uses frame.copyTo() with explicit RGBA format for all pixel formats — avoids
	 * OffscreenCanvas which always quantizes to 8-bit and loses 10-bit source data.
	 *
	 * WebCodecs copyTo() does the YUV→RGB matrix conversion but does NOT apply
	 * limited→full-range expansion for broadcast-range video (luma 16–235).
	 * Camera H.264 is almost always limited range, so we expand manually.
	 *
	 * @param {VideoFrame} frame - source frame
	 * @param {number} maxWidth - full-frame width (post codec-padding clamp)
	 * @param {number} maxHeight - full-frame height
	 * @param {{x:number,y:number,width:number,height:number}|null} roi - optional sub-region
	 *   to extract instead of the whole frame. Same trick as SER pre-crop: decode still
	 *   processes the whole frame (codec constraint) but the VideoFrame→RGBA copy and
	 *   downstream GPU upload shrink to the ROI.
	 */
	async function videoFrameToRgba(frame, maxWidth, maxHeight, roi = null) {
		const frameW = frame.displayWidth || frame.codedWidth;
		const frameH = frame.displayHeight || frame.codedHeight;
		const fullWidth = maxWidth ? Math.min(frameW, maxWidth) : frameW;
		const fullHeight = maxHeight ? Math.min(frameH, maxHeight) : frameH;

		const rect = roi
			? { x: roi.x, y: roi.y, width: roi.width, height: roi.height }
			: { x: 0, y: 0, width: fullWidth, height: fullHeight };
		const width = rect.width;
		const height = rect.height;

		// Safari's VideoFrame.copyTo() is stricter than Chrome's: it rejects our
		// tight-stride RGBA layout with "layout size is invalid" (EISE-NG) for
		// certain frame configurations (portrait video, some NV12 sources).
		// Canvas draw yields the same 8-bit RGBA as copyTo({format:'RGBA'}) — no
		// precision loss — but it's the universally-supported path.
		let buffer;
		try {
			buffer = new Uint8ClampedArray(width * height * 4);
			await frame.copyTo(buffer, {
				format: 'RGBA',
				rect,
				layout: [{ offset: 0, stride: width * 4 }]
			});
		} catch (copyErr) {
			const canvas = new OffscreenCanvas(width, height);
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			ctx.drawImage(frame, rect.x, rect.y, width, height, 0, 0, width, height);
			buffer = ctx.getImageData(0, 0, width, height).data;
		}

		// Limited range (luma 16–235) → full range (0–255) expansion, only if needed.
		// Some cameras (e.g. iOS MOV) encode full-range YUV (yuvj420p / pc range) but the
		// container metadata incorrectly declares limited range, causing WebCodecs to report
		// fullRange=false when the data is actually 0–255. Applying expansion in that case
		// clips and distorts the gradient. Detect the actual range by checking for sub-16 values.
		if (frame.colorSpace?.fullRange === false && isLimitedRange(buffer)) {
			for (let i = 0; i < buffer.length - 3; i += 4) {
				buffer[i]     = Math.min(255, Math.max(0, (buffer[i]     - 16) * 255 / 219 + 0.5) | 0);
				buffer[i + 1] = Math.min(255, Math.max(0, (buffer[i + 1] - 16) * 255 / 219 + 0.5) | 0);
				buffer[i + 2] = Math.min(255, Math.max(0, (buffer[i + 2] - 16) * 255 / 219 + 0.5) | 0);
				// alpha unchanged
			}
		}

		return buffer;
	}

	return {
		canHandle,
		processVideoFrames
	};
}

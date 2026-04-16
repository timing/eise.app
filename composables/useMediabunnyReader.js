// composables/useMediabunnyReader.js
// Handles video decoding using Mediabunny + WebCodecs (lighter alternative to FFmpeg)

import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
import { useEventBus } from '@/composables/eventBus';
import { useStacker } from '@/composables/useStacker';
import { useComparisonExport } from '@/composables/useComparisonExport';
import { useWebGpuAnalyzeWorker } from '@/composables/useWebGpuAnalyzeWorker';
import { useWorkerUrl } from '@/composables/useWorkerUrl';

export function useMediabunnyReader() {
	const { addLog, emit, on } = useEventBus();
	const { stackFramesLocally } = useStacker();
	const { capturePreCropFrame, capturePostCropFrame, resetCaptures } = useComparisonExport();
	const {
		initializeGpuWorker,
		terminateGpuWorker,
		analyzeRgbaBatchGpu,
		detectCropAnalyzeRgbaGpu
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

		// Try to probe the file with Mediabunny
		try {
			const source = new BlobSource(file);
			const input = new Input({ source, formats: ALL_FORMATS });

			// Get video tracks (this probes the file)
			const videoTracks = await input.getVideoTracks();
			if (!videoTracks || videoTracks.length === 0) {
				input.dispose();
				return { supported: false, reason: 'No video tracks found' };
			}

			const track = videoTracks[0];
			const codec = track.codec;

			// Get decoder config from track
			const decoderConfig = await track.getDecoderConfig();

			// Check if WebCodecs can decode this codec
			const codecString = decoderConfig?.codec || getWebCodecsCodecString(codec, track);
			if (!codecString) {
				input.dispose();
				return { supported: false, reason: `Unsupported codec: ${codec}` };
			}

			const decoderSupport = await VideoDecoder.isConfigSupported({
				codec: codecString,
				codedWidth: track.codedWidth,
				codedHeight: track.codedHeight
			});

			input.dispose();

			if (!decoderSupport.supported) {
				return { supported: false, reason: `WebCodecs cannot decode ${codec}` };
			}

			return { supported: true };
		} catch (err) {
			console.warn('[Mediabunny] Probe failed:', err);
			return { supported: false, reason: err.message };
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
			useWebGPU = true
		} = options;

		resetCaptures();
		cancelled = false;

		// Use GPU if available and requested, otherwise CPU workers
		const useGPU = useWebGPU ? await initializeGpuWorker() : false;
		let cpuWorkers = [];

		if (!useGPU) {
			addLog('WebGPU not available, using CPU analysis workers');
			const CPU_WORKER_COUNT = Math.min(navigator.hardwareConcurrency || 2, 4);
			for (let i = 0; i < CPU_WORKER_COUNT; i++) {
				cpuWorkers.push(new Worker(workerUrl('/unified_analyze_worker.js')));
			}
			await Promise.all(cpuWorkers.map((worker, i) =>
				new Promise((resolve, reject) => {
					const timeout = setTimeout(() => reject(new Error(`CPU worker ${i} timeout`)), 30000);
					worker.onmessage = (e) => {
						if (!e.data) { clearTimeout(timeout); reject(new Error('Worker crashed')); return; }
						if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
						else if (e.data.type === 'error') { clearTimeout(timeout); reject(new Error(e.data.message)); }
					};
					worker.postMessage({ type: 'init' });
				})
			));
		}

		addLog(`Processing video with Mediabunny + WebCodecs (${useGPU ? 'GPU' : 'CPU'})`);
		emit('set-caption', 'Opening video...');

		try {
			// Open video with Mediabunny
			const source = new BlobSource(file);
			const input = new Input({ source, formats: ALL_FORMATS });

			const videoTracks = await input.getVideoTracks();
			const videoTrack = videoTracks[0];
			if (!videoTrack) {
				throw new Error('No video track found');
			}

			const trackWidth = videoTrack.codedWidth;
			const trackHeight = videoTrack.codedHeight;
			const codec = videoTrack.codec;
			const decoderConfig = await videoTrack.getDecoderConfig();

			const fullCodecString = decoderConfig?.codec || getWebCodecsCodecString(codec, videoTrack);
			const bitDepth = detectBitDepthFromCodec(fullCodecString);
			addLog(`Video: ${trackWidth}x${trackHeight}, codec: ${codec} (${fullCodecString}), bit depth: ${bitDepth}-bit`);

			const codecString = decoderConfig?.codec || getWebCodecsCodecString(codec, videoTrack);
			if (!codecString) {
				throw new Error(`Cannot determine WebCodecs codec string for: ${codec}`);
			}
			const baseConfig = decoderConfig || { codec: codecString, codedWidth: trackWidth, codedHeight: trackHeight };

			let actualWidth = 0, actualHeight = 0;

			// Helper: create and configure a fresh decoder
			function makeDecoder(outputFn) {
				const dec = new VideoDecoder({
					output: outputFn,
					error: (e) => console.error('[WebCodecs] Decoder error:', e)
				});
				dec.configure(baseConfig);
				return dec;
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

			// Get first key packet — reused for both passes
			const sink1 = new EncodedPacketSink(videoTrack);
			const firstKeyPacket = await sink1.getFirstKeyPacket({ verifyKeyPackets: true });
			if (!firstKeyPacket) throw new Error('No key frame found in video');

			// ══════════════════════════════════════════════════════════════
			// PASS 1 — Crop detection
			// Decode all packets but only convert ~50 reservoir-sampled frames
			// to RGBA. Non-sampled frames are decoded and immediately closed,
			// so only ≤50 × frameSize bytes live in memory at once.
			// ══════════════════════════════════════════════════════════════
			emit('set-caption', 'Detecting crop region...');

			const SAMPLE_SIZE = 50;
			const rawSamples = [];  // { frame: VideoFrame, index: number } — kept alive until converted
			let pass1Count = 0;

			const decoder1 = makeDecoder((frame) => {
				if (cancelled) { frame.close(); return; }
				initDims(frame);

				// Reservoir sampling — uniform random sample without knowing total count upfront.
				// Keeps VideoFrame objects alive; non-selected frames are closed immediately.
				if (rawSamples.length < SAMPLE_SIZE) {
					rawSamples.push({ frame, index: pass1Count });
				} else {
					const j = Math.floor(Math.random() * (pass1Count + 1));
					if (j < SAMPLE_SIZE) {
						rawSamples[j].frame.close(); // release replaced frame
						rawSamples[j] = { frame, index: pass1Count };
					} else {
						frame.close();
					}
				}
				pass1Count++;
			});

			for await (const packet of sink1.packets(firstKeyPacket, undefined, { verifyKeyPackets: true })) {
				if (cancelled) break;
				if (maxFrames > 0 && pass1Count >= maxFrames) break;
				decoder1.decode(packet.toEncodedVideoChunk());
			}
			await decoder1.flush();
			decoder1.close();

			// Convert sampled VideoFrames to RGBA async (no canvas, preserves source bit depth)
			const reservoir = await Promise.all(
				rawSamples.map(async ({ frame, index }) => {
					const data = await videoFrameToRgba(frame, actualWidth, actualHeight);
					frame.close();
					return { data, index };
				})
			);


			const totalFrames = maxFrames > 0 ? Math.min(pass1Count, maxFrames) : pass1Count;
			const detectedFullRange = reservoir.length > 0 && !isLimitedRange(reservoir[0].data);
			addLog(`Pass 1: ${totalFrames} frames, ${reservoir.length} samples for crop detection, detected range: ${detectedFullRange ? 'full (expansion skipped)' : 'limited (expansion applied)'}`);
			if (totalFrames === 0) throw new Error('No frames decoded from video');

			// Detect crop region from reservoir samples
			let cropRegion = null;
			const MIN_SIZE_FOR_CROP = 300;
			if (actualWidth >= MIN_SIZE_FOR_CROP && actualHeight >= MIN_SIZE_FOR_CROP && reservoir.length > 0) {
				const sampleResults = await analyzeRgbaBatchGpu(reservoir, actualWidth, actualHeight);
				const detectedCenters = [], detectedSizes = [];
				for (const r of sampleResults) {
					if (r.bounds) {
						detectedCenters.push({ x: r.bounds.centroidX, y: r.bounds.centroidY });
						detectedSizes.push(Math.max(r.bounds.width, r.bounds.height));
					}
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

					if (desiredSize >= maxAllowedSize) {
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

			const BATCH_SIZE = 32;
			const bestFramesCapacity = Math.max(1, Math.floor(totalFrames * stackPercentage / 100));
			const bestFramesForStacking = [];
			const allAnalyzedFrames = manualThreshold ? [] : null;
			const frameCenters = new Map();
			let skippedFrames = 0, cutOffFrames = 0, oversizedFrames = 0;
			let pass2FrameIndex = 0;

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

			// Called after each decoder flush — converts VideoFrames to RGBA, then analyzes.
			// Frames are closed after conversion; RGBA is freed after processing.
			async function processBatch(batch) {
				if (batch.length === 0) return;

				// Convert VideoFrames to RGBA async (no canvas, preserves source bit depth)
				const rgbaBatch = await Promise.all(
					batch.map(async ({ frame, index }) => {
						const data = await videoFrameToRgba(frame, actualWidth, actualHeight);
						frame.close();
						return { data, index };
					})
				);

				if (useGPU) {
					// GPU path
					if (cropRegion) {
						const combinedResults = await detectCropAnalyzeRgbaGpu(
							rgbaBatch, actualWidth, actualHeight, cropRegion.size, 0.1, true
						);
						for (let j = 0; j < combinedResults.length; j++) {
							const gpuResult = combinedResults[j];
							if (!gpuResult.bounds) { skippedFrames++; continue; }

							if (!surfaceMode) {
								const halfCrop = cropRegion.size / 2;
								if (gpuResult.centerX - halfCrop < 0 || gpuResult.centerY - halfCrop < 0 ||
									gpuResult.centerX + halfCrop > actualWidth || gpuResult.centerY + halfCrop > actualHeight) {
									cutOffFrames++; continue;
								}
							}
							if (cropRegion.medianObjectSize) {
								if (Math.max(gpuResult.bounds.width, gpuResult.bounds.height) / cropRegion.medianObjectSize > 1.3) {
									oversizedFrames++; continue;
								}
							}
							frameCenters.set(rgbaBatch[j].index, { x: gpuResult.centerX, y: gpuResult.centerY });
							rankFrame({
								sharpness: gpuResult.sharpness,
								width: cropRegion.size, height: cropRegion.size,
								index: rgbaBatch[j].index,
								centerX: gpuResult.centerX, centerY: gpuResult.centerY,
								circularity: gpuResult.circularity || 0,
								uint8Buffer: gpuResult.uint8Buffer
							});
						}
					} else {
						const results = await analyzeRgbaBatchGpu(rgbaBatch, actualWidth, actualHeight);
						for (const result of results) {
							rankFrame({
								sharpness: result.sharpness || 0,
								width: actualWidth, height: actualHeight,
								index: result.index,
								centerX: actualWidth / 2, centerY: actualHeight / 2,
								circularity: result.circularity || 0,
								uint8Buffer: result.uint8Buffer
							});
						}
					}
				} else {
					// CPU path — distribute frames across workers
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

				emit('update-loading', {
					progress: 50 + (pass2FrameIndex / totalFrames) * 40,
					current: pass2FrameIndex,
					total: totalFrames
				});
			}

			let currentBatch = [];

			const decoder2 = makeDecoder((frame) => {
				if (cancelled) { frame.close(); return; }
				// Store raw VideoFrame — conversion to RGBA happens async in processBatch
				currentBatch.push({ frame, index: pass2FrameIndex++ });
			});

			const sink2 = new EncodedPacketSink(videoTrack);
			const firstKeyPacket2 = await sink2.getFirstKeyPacket({ verifyKeyPackets: true });
			let packetsSinceFlush = 0;

			for await (const packet of sink2.packets(firstKeyPacket2, undefined, { verifyKeyPackets: true })) {
				if (cancelled) break;
				if (maxFrames > 0 && pass2FrameIndex >= maxFrames) break;

				const chunk = packet.toEncodedVideoChunk();

				// Flush and process at keyframe boundaries only — after flush(), WebCodecs requires
				// the next packet to be a keyframe (same as after configure()). Camera H.264 places
				// keyframes every GOP (typically 30–120 frames), so we batch at those boundaries
				// once we've accumulated at least BATCH_SIZE frames.
				if (packetsSinceFlush >= BATCH_SIZE && chunk.type === 'key') {
					await decoder2.flush();
					const batch = currentBatch;
					currentBatch = [];
					await processBatch(batch);
					packetsSinceFlush = 0;
				}

				decoder2.decode(chunk);
				packetsSinceFlush++;
			}
			// Drain remaining
			await decoder2.flush();
			await processBatch(currentBatch);
			currentBatch = [];

			decoder2.close();
			input.dispose();

			// Clean up CPU workers (GPU worker cleaned up by terminateGpuWorker)
			cpuWorkers.forEach(w => w.terminate());
			cpuWorkers = [];

			if (cancelled) { addLog('Processing cancelled'); emit('stop-loading'); return; }

			const skipMsgs = [];
			if (cutOffFrames > 0) skipMsgs.push(`${cutOffFrames} cut-off`);
			if (oversizedFrames > 0) skipMsgs.push(`${oversizedFrames} oversized`);
			if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} skipped`);
			if (skipMsgs.length > 0) addLog(`Skipped: ${skipMsgs.join(', ')}`);

			// Manual threshold mode: keep all uint8Buffers for quality selector
			if (manualThreshold) {
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
			console.error('[Mediabunny] Processing failed:', err);
			addLog(`Error: ${err.message}`);
			emit('upload-error', `Video processing failed: ${err.message}`);
			emit('stop-loading');
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
	 * Convert VideoFrame to RGBA Uint8ClampedArray, cropped to maxWidth×maxHeight.
	 * Uses frame.copyTo() with explicit RGBA format for all pixel formats — avoids
	 * OffscreenCanvas which always quantizes to 8-bit and loses 10-bit source data.
	 *
	 * WebCodecs copyTo() does the YUV→RGB matrix conversion but does NOT apply
	 * limited→full-range expansion for broadcast-range video (luma 16–235).
	 * Camera H.264 is almost always limited range, so we expand manually.
	 */
	async function videoFrameToRgba(frame, maxWidth, maxHeight) {
		const frameW = frame.displayWidth || frame.codedWidth;
		const frameH = frame.displayHeight || frame.codedHeight;
		const width = maxWidth ? Math.min(frameW, maxWidth) : frameW;
		const height = maxHeight ? Math.min(frameH, maxHeight) : frameH;

		const buffer = new Uint8ClampedArray(width * height * 4);
		await frame.copyTo(buffer, {
			format: 'RGBA',
			rect: { x: 0, y: 0, width, height },
			layout: [{ offset: 0, stride: width * 4 }]
		});

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

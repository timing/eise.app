// composables/useMediabunnyReader.js
// Handles video decoding using Mediabunny + WebCodecs (lighter alternative to FFmpeg)

import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from 'mediabunny';
import { useEventBus } from '@/composables/eventBus';
import { useStacker } from '@/composables/useStacker';
import { useComparisonExport } from '@/composables/useComparisonExport';
import { useWebGpuAnalyzeWorker } from '@/composables/useWebGpuAnalyzeWorker';

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
	 * Process video frames using Mediabunny + WebCodecs
	 */
	async function processVideoFrames(file, options = {}) {
		const {
			maxFrames = 0,
			manualThreshold = false,
			cropMarginPercent = 10,
			stackPercentage = 30,
			drizzleScale = 1.5,
			surfaceMode = false
		} = options;

		resetCaptures();
		cancelled = false;

		// Initialize GPU worker
		const gpuOk = await initializeGpuWorker();
		if (!gpuOk) {
			addLog('GPU worker failed to initialize');
			emit('stop-loading');
			return;
		}

		addLog(`Processing video with Mediabunny + WebCodecs (GPU)`);
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
			const totalFrames = maxFrames > 0 ? maxFrames : 1000; // frameCount not always available

			addLog(`Video: ${trackWidth}x${trackHeight}, codec: ${codec}`);
			addLog(`Target frames: ${totalFrames}`);

			// Set up WebCodecs decoder
			const codecString = decoderConfig?.codec || getWebCodecsCodecString(codec, videoTrack);
			if (!codecString) {
				throw new Error(`Cannot determine WebCodecs codec string for: ${codec}`);
			}

			// Collect decoded frames - actual dimensions determined from first frame
			// (may differ from track metadata due to codec padding, e.g. 1080 -> 1088 for H.264)
			const decodedFrames = [];
			let frameIndex = 0;
			let actualWidth = 0;
			let actualHeight = 0;

			const decoder = new VideoDecoder({
				output: (frame) => {
					if (cancelled) {
						frame.close();
						return;
					}

					// Get actual dimensions from first frame, clamped to track-declared dimensions.
					// H.264 pads height to macroblock boundaries (e.g. 1080 → 1088). Those extra
					// rows often contain replicated content from the last real row, spanning the full
					// width — which confuses the GPU bounds detector into treating the whole frame as
					// a bright object. Strip them by capping to the container-declared size.
					if (actualWidth === 0) {
						const rawWidth = frame.displayWidth || frame.codedWidth;
						const rawHeight = frame.displayHeight || frame.codedHeight;
						actualWidth = Math.min(rawWidth, trackWidth);
						actualHeight = Math.min(rawHeight, trackHeight);
						if (rawWidth !== trackWidth || rawHeight !== trackHeight) {
							addLog(`Codec frame size: ${rawWidth}x${rawHeight}, clamped to ${actualWidth}x${actualHeight} (track: ${trackWidth}x${trackHeight})`);
						}
					}

					// Convert VideoFrame to RGBA Uint8ClampedArray, cropped to actualWidth×actualHeight
					const rgba = videoFrameToRgba(frame, actualWidth, actualHeight);
					decodedFrames.push({
						data: rgba,
						index: frameIndex++,
						width: actualWidth,
						height: actualHeight
					});

					frame.close();

					// Progress update
					if (frameIndex % 50 === 0) {
						emit('update-loading', {
							progress: Math.min((frameIndex / totalFrames) * 50, 50),
							current: frameIndex,
							total: totalFrames
						});
					}
				},
				error: (e) => {
					console.error('[WebCodecs] Decoder error:', e);
				}
			});

			// Configure decoder (use config from track, or build a basic one)
			const config = decoderConfig || {
				codec: codecString,
				codedWidth: width,
				codedHeight: height
			};
			decoder.configure(config);

			emit('set-caption', 'Decoding frames...');
			emit('update-loading', { progress: 0, current: 0, total: totalFrames });

			// Decode frames from video track - must start from a key frame
			let packetCount = 0;
			const packetSink = new EncodedPacketSink(videoTrack);

			// Get first key frame to start decoding (WebCodecs requirement)
			// Use verifyKeyPackets to inspect bitstream and ensure it's a real key frame
			const firstKeyPacket = await packetSink.getFirstKeyPacket({ verifyKeyPackets: true });
			if (!firstKeyPacket) {
				throw new Error('No key frame found in video');
			}

			for await (const packet of packetSink.packets(firstKeyPacket, undefined, { verifyKeyPackets: true })) {
				if (cancelled) break;
				if (maxFrames > 0 && frameIndex >= maxFrames) break;

				const chunk = packet.toEncodedVideoChunk();
				decoder.decode(chunk);
				packetCount++;
			}

			// Final flush
			await decoder.flush();
			decoder.close();
			input.dispose();

			addLog(`Decoded ${decodedFrames.length} frames`);

			if (decodedFrames.length === 0) {
				throw new Error('No frames decoded from video');
			}

			// Now process frames through GPU analyzer (same as FFmpeg path)
			// Use actual decoded frame dimensions (may differ from track metadata)
			await processDecodedFrames(decodedFrames, {
				width: actualWidth,
				height: actualHeight,
				manualThreshold,
				cropMarginPercent,
				stackPercentage,
				drizzleScale,
				surfaceMode
			});

		} catch (err) {
			console.error('[Mediabunny] Processing failed:', err);
			addLog(`Error: ${err.message}`);
			emit('upload-error', `Video processing failed: ${err.message}`);
			emit('stop-loading');
		}
	}

	/**
	 * Convert VideoFrame to RGBA Uint8ClampedArray, cropped to maxWidth×maxHeight.
	 * Pass maxWidth/maxHeight to strip H.264 macroblock-alignment padding rows.
	 */
	function videoFrameToRgba(frame, maxWidth, maxHeight) {
		const frameW = frame.displayWidth || frame.codedWidth;
		const frameH = frame.displayHeight || frame.codedHeight;
		const width = maxWidth ? Math.min(frameW, maxWidth) : frameW;
		const height = maxHeight ? Math.min(frameH, maxHeight) : frameH;

		// Try direct copyTo for RGBA/BGRA formats (faster, no canvas needed)
		const format = frame.format;
		if (format === 'RGBA' || format === 'RGBX') {
			const buffer = new Uint8ClampedArray(width * height * 4);
			frame.copyTo(buffer, { rect: { x: 0, y: 0, width, height } });
			return buffer;
		}

		if (format === 'BGRA' || format === 'BGRX') {
			const buffer = new Uint8ClampedArray(width * height * 4);
			frame.copyTo(buffer, { rect: { x: 0, y: 0, width, height } });
			// Swap B and R channels
			for (let i = 0; i < buffer.length; i += 4) {
				const b = buffer[i];
				buffer[i] = buffer[i + 2];
				buffer[i + 2] = b;
			}
			return buffer;
		}

		// For YUV formats (I420, NV12, etc.), use canvas for color conversion.
		// drawImage with explicit src rect crops padding rows (e.g. H.264 1088 → 1080).
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');
		ctx.drawImage(frame, 0, 0, width, height, 0, 0, width, height);
		return ctx.getImageData(0, 0, width, height).data;
	}

	/**
	 * Process decoded RGBA frames through GPU analyzer and stacker
	 * (Same logic as processFFmpegFrames but takes RGBA frames directly)
	 */
	async function processDecodedFrames(frames, options) {
		const {
			width,
			height,
			manualThreshold,
			cropMarginPercent,
			stackPercentage,
			drizzleScale,
			surfaceMode
		} = options;

		const frameCount = frames.length;

		// Detect crop region by sampling frames and analyzing bounds
		emit('set-caption', 'Detecting crop region...');

		const MIN_SIZE_FOR_CROP = 300;
		let cropRegion = null;

		if (width >= MIN_SIZE_FOR_CROP && height >= MIN_SIZE_FOR_CROP) {
			// Sample frames for crop detection
			const sampleIndices = getSampleIndices(frameCount, Math.min(50, frameCount));
			addLog(`Sampling ${sampleIndices.length} frames for crop detection...`);
			const sampleFrames = sampleIndices.map(i => ({ data: frames[i].data, index: frames[i].index }));

			// Analyze sample frames to detect bounds
			const sampleResults = await analyzeRgbaBatchGpu(sampleFrames, width, height);

			const detectedCenters = [];
			const detectedSizes = [];

			for (const result of sampleResults) {
				if (result.bounds) {
					detectedCenters.push({ x: result.bounds.centroidX, y: result.bounds.centroidY });
					detectedSizes.push(result.bounds.size || Math.max(result.bounds.width, result.bounds.height));
				}
			}

			const cropThreshold = sampleIndices.length * 0.5;
			if (detectedCenters.length < cropThreshold) {
				addLog(`Only ${detectedCenters.length}/${sampleIndices.length} frames detected a bright object. Skipping auto-crop.`);
			} else {
				// Calculate median size and center
				const sortedSizes = [...detectedSizes].sort((a, b) => a - b);
				const medianSize = sortedSizes[Math.floor(sortedSizes.length / 2)];

				const sortedX = detectedCenters.map(c => c.x).sort((a, b) => a - b);
				const sortedY = detectedCenters.map(c => c.y).sort((a, b) => a - b);
				const medianX = sortedX[Math.floor(sortedX.length / 2)];
				const medianY = sortedY[Math.floor(sortedY.length / 2)];

				const marginMultiplier = 1 + (cropMarginPercent / 100);
				const desiredSize = Math.ceil(medianSize * marginMultiplier / 2) * 2;
				const maxAllowedSize = Math.min(width, height);

				if (desiredSize >= maxAllowedSize) {
					if (surfaceMode) {
						addLog(`Surface mode: using full frame ${maxAllowedSize}x${maxAllowedSize} with per-frame centering`);
						cropRegion = { size: maxAllowedSize, referenceCenter: { x: medianX, y: medianY }, medianObjectSize: medianSize };
					} else {
						addLog(`Skipping crop: detected size ${desiredSize}px (median object: ${Math.round(medianSize)}px) exceeds frame ${maxAllowedSize}px`);
					}
				} else {
					cropRegion = {
						size: desiredSize,
						referenceCenter: { x: medianX, y: medianY },
						medianObjectSize: medianSize
					};
					addLog(`Detected crop size: ${desiredSize}x${desiredSize}, median object size: ${Math.round(medianSize)}px`);
					addLog(`Median center: (${Math.round(medianX)}, ${Math.round(medianY)}), frame center: (${Math.round(width/2)}, ${Math.round(height/2)})`);
				}
			}
		}

		// Analyze all frames
		emit('set-caption', cropRegion ? 'Cropping and analyzing frames' : 'Analyzing frames');

		const bestFramesCapacity = Math.max(1, Math.floor(frameCount * stackPercentage / 100));
		const bestFramesForStacking = [];
		let bestFrameSoFar = null;
		let refCandidateSoFar = null;
		const allAnalyzedFrames = [];
		const frameCenters = new Map();
		let skippedFrames = 0;
		let cutOffFrames = 0;
		let oversizedFrames = 0;

		function rankFrame(frame) {
			if (frame.uint8Buffer && frame.width && frame.height) {
				capturePostCropFrame(frame.uint8Buffer, frame.width, frame.height, frame.index, frameCount);
			}

			if (manualThreshold) {
				allAnalyzedFrames.push(frame);
			}

			if (!bestFrameSoFar || frame.sharpness > bestFrameSoFar.sharpness) {
				bestFrameSoFar = frame;
			}

			if (!refCandidateSoFar || (frame.circularity || 0) > (refCandidateSoFar.circularity || 0)) {
				refCandidateSoFar = frame;
			}

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

		// Process frames in batches
		const batchSize = 32;
		for (let i = 0; i < frameCount && !cancelled; i += batchSize) {
			const batchEnd = Math.min(i + batchSize, frameCount);
			const batch = frames.slice(i, batchEnd).map(f => ({ data: f.data, index: f.index }));

			if (cropRegion) {
				// Combined detect + crop + analyze in ONE GPU pass (same as FFmpeg path)
				const combinedResults = await detectCropAnalyzeRgbaGpu(
					batch, width, height, cropRegion.size, 0.1, true
				);

				for (let j = 0; j < combinedResults.length; j++) {
					const gpuResult = combinedResults[j];
					const frameIdx = batch[j].index;

					// Check if bounds were detected
					if (!gpuResult.bounds) {
						skippedFrames++;
						continue;
					}

					// Check for cut-off (crop region would exceed frame bounds) - skip for Sun/Moon
					if (!surfaceMode) {
						const halfCrop = cropRegion.size / 2;
						const cx = gpuResult.centerX;
						const cy = gpuResult.centerY;
						if (cx - halfCrop < 0 || cy - halfCrop < 0 ||
							cx + halfCrop > width || cy + halfCrop > height) {
							cutOffFrames++;
							continue;
						}
					}

					// Check oversized
					if (cropRegion.medianObjectSize) {
						const size = Math.max(gpuResult.bounds.width, gpuResult.bounds.height);
						if (size / cropRegion.medianObjectSize > 1.3) {
							oversizedFrames++;
							continue;
						}
					}

					const center = { x: gpuResult.centerX, y: gpuResult.centerY };
					frameCenters.set(frameIdx, center);

					const currentFrame = {
						sharpness: gpuResult.sharpness,
						width: cropRegion.size,
						height: cropRegion.size,
						index: frameIdx,
						centerX: center.x,
						centerY: center.y,
						circularity: gpuResult.circularity || 0,
						uint8Buffer: gpuResult.uint8Buffer
					};

					rankFrame(currentFrame);
				}
			} else {
				// No crop - analyze full frames
				const results = await analyzeRgbaBatchGpu(batch, width, height);

				for (const result of results) {
					const currentFrame = {
						sharpness: result.sharpness || 0,
						width: width,
						height: height,
						index: result.index,
						centerX: width / 2,
						centerY: height / 2,
						circularity: result.circularity || 0,
						uint8Buffer: result.uint8Buffer
					};

					rankFrame(currentFrame);
				}
			}

			const progress = 50 + (batchEnd / frameCount) * 40;
			emit('update-loading', { progress, current: batchEnd, total: frameCount });
		}

		const skipMsgs = [];
		if (cutOffFrames > 0) skipMsgs.push(`${cutOffFrames} cut-off`);
		if (oversizedFrames > 0) skipMsgs.push(`${oversizedFrames} oversized`);
		if (skippedFrames > 0) skipMsgs.push(`${skippedFrames} skipped`);
		if (skipMsgs.length > 0) {
			addLog(`Skipped: ${skipMsgs.join(', ')}`);
		}

		if (cancelled) {
			addLog('Processing cancelled');
			emit('stop-loading');
			return;
		}

		// Manual threshold mode: emit frames for user selection
		if (manualThreshold) {
			const allFramesSorted = [...allAnalyzedFrames].sort((a, b) => b.sharpness - a.sharpness);
			emit('quality-selection-ready', {
				frames: allFramesSorted,
				useWebGPU: true,
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
			null, // No CPU worker needed for GPU path
			drizzleScale,
			true, // useWebGPU
			frameCenters,
			surfaceMode
		);

		if (stackResult) {
			emit('postProcessing', stackResult.blob, stackResult.float32Data, stackResult.width, stackResult.height);
		} else {
			addLog('Stacking failed');
			emit('upload-error', 'Stacking failed. Please try again.');
		}
	}

	/**
	 * Get evenly spaced sample indices
	 */
	function getSampleIndices(total, numSamples) {
		if (total <= numSamples) {
			return Array.from({ length: total }, (_, i) => i);
		}
		const step = (total - 1) / (numSamples - 1);
		return Array.from({ length: numSamples }, (_, i) => Math.round(i * step));
	}

	return {
		canHandle,
		processVideoFrames
	};
}

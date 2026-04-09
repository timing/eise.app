/**
 * Video encoder utility using WebCodecs + mediabunny
 * Creates social media ready MP4 files from image sequences
 */

import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } from 'mediabunny';

/**
 * Check if WebCodecs video encoding is supported
 * @returns {Promise<boolean>}
 */
export async function isVideoEncodingSupported() {
	if (typeof VideoEncoder === 'undefined') {
		return false;
	}

	try {
		const support = await VideoEncoder.isConfigSupported({
			codec: 'avc1.42001f', // H.264 Baseline
			width: 640,
			height: 480,
			bitrate: 1_000_000,
			framerate: 30
		});
		return support.supported;
	} catch {
		return false;
	}
}

/**
 * Encode frames to MP4 video
 * @param {Array<{float32Data: Float32Array, width: number, height: number}>} frames - Array of frame data
 * @param {Object} options - Encoding options
 * @param {number} options.fps - Frames per second (default: 12)
 * @param {boolean} options.pingPong - Create ping-pong loop (default: true)
 * @param {number} options.holdFirstFrame - Hold first frame for N extra frames (default: 6)
 * @param {number} options.holdLastFrame - Hold last frame for N extra frames (default: 6)
 * @param {Function} options.onProgress - Progress callback (current, total, message)
 * @returns {Promise<Blob>} MP4 video blob
 */
export async function encodeFramesToMP4(frames, options = {}) {
	const {
		fps = 12,
		pingPong = true,
		holdFirstFrame = 6,
		holdLastFrame = 6,
		onProgress = null
	} = options;

	if (frames.length === 0) {
		throw new Error('No frames to encode');
	}

	// Get dimensions from first frame
	const { width, height } = frames[0];

	// Ensure dimensions are even (required for H.264)
	const videoWidth = width % 2 === 0 ? width : width + 1;
	const videoHeight = height % 2 === 0 ? height : height + 1;

	// Build frame sequence with holds and optional ping-pong
	const frameSequence = buildFrameSequence(frames, { pingPong, holdFirstFrame, holdLastFrame });
	const totalFrames = frameSequence.length;

	if (onProgress) onProgress(0, totalFrames, 'Initializing encoder...');

	// Create mediabunny output
	const target = new BufferTarget();
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
		target
	});

	// Create encoded video source
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource, { frameRate: fps });

	// Create offscreen canvas for frame rendering
	const canvas = new OffscreenCanvas(videoWidth, videoHeight);
	const ctx = canvas.getContext('2d');

	// Track encoded chunks to add to muxer
	let firstChunkMeta = null;
	const pendingChunks = [];

	// Create WebCodecs encoder
	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
			// Store first chunk metadata for decoder config
			if (!firstChunkMeta && meta?.decoderConfig) {
				firstChunkMeta = meta;
			}
			pendingChunks.push({ chunk, meta: meta || firstChunkMeta });
		},
		error: (e) => {
			console.error('VideoEncoder error:', e);
			throw e;
		}
	});

	// H.264 config optimized for social media
	const config = {
		codec: 'avc1.42001f', // Baseline profile, level 3.1
		width: videoWidth,
		height: videoHeight,
		bitrate: Math.min(8_000_000, videoWidth * videoHeight * 8),
		framerate: fps,
		latencyMode: 'quality'
	};

	encoder.configure(config);

	// Encode each frame
	const frameDuration = 1_000_000 / fps; // microseconds

	for (let i = 0; i < frameSequence.length; i++) {
		const frameData = frameSequence[i];

		if (onProgress) {
			onProgress(i + 1, totalFrames, `Encoding frame ${i + 1}/${totalFrames}`);
		}

		// Convert float32 RGBA to canvas ImageData
		const imageData = float32ToImageData(frameData.float32Data, frameData.width, frameData.height);

		// Draw to canvas
		ctx.fillStyle = '#000';
		ctx.fillRect(0, 0, videoWidth, videoHeight);
		ctx.putImageData(imageData, 0, 0);

		// Create video frame
		const videoFrame = new VideoFrame(canvas, {
			timestamp: i * frameDuration,
			duration: frameDuration
		});

		// Encode (keyframe every 12 frames for seeking)
		encoder.encode(videoFrame, { keyFrame: i % 12 === 0 });
		videoFrame.close();

		// Yield to prevent UI blocking
		if (i % 4 === 0) {
			await new Promise(r => setTimeout(r, 0));
		}
	}

	// Flush encoder and wait for all chunks
	if (onProgress) onProgress(totalFrames, totalFrames, 'Finalizing video...');
	await encoder.flush();
	encoder.close();

	// Start output and add all encoded chunks to muxer
	await output.start();

	for (const { chunk, meta } of pendingChunks) {
		const packet = EncodedPacket.fromEncodedChunk(chunk);
		await videoSource.add(packet, meta);
	}

	// Finalize muxer
	await output.finalize();

	return new Blob([target.buffer], { type: 'video/mp4' });
}

/**
 * Build frame sequence with holds and optional ping-pong
 */
function buildFrameSequence(frames, options) {
	const { pingPong, holdFirstFrame, holdLastFrame } = options;
	const sequence = [];

	// Hold first frame
	for (let i = 0; i < holdFirstFrame; i++) {
		sequence.push(frames[0]);
	}

	// Forward sequence
	for (const frame of frames) {
		sequence.push(frame);
	}

	// Hold last frame
	for (let i = 0; i < holdLastFrame; i++) {
		sequence.push(frames[frames.length - 1]);
	}

	// Reverse sequence for ping-pong (excluding first and last to avoid duplicates)
	if (pingPong && frames.length > 2) {
		for (let i = frames.length - 2; i > 0; i--) {
			sequence.push(frames[i]);
		}
	}

	return sequence;
}

/**
 * Convert Float32Array RGBA (0-1) to ImageData (0-255)
 */
function float32ToImageData(float32Data, width, height) {
	const uint8 = new Uint8ClampedArray(width * height * 4);

	for (let i = 0; i < float32Data.length; i++) {
		uint8[i] = Math.round(Math.max(0, Math.min(1, float32Data[i])) * 255);
	}

	return new ImageData(uint8, width, height);
}

/**
 * Download a blob as a file
 */
export function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

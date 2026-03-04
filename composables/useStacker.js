import { useEventBus } from '@/composables/eventBus';
import { useComparisonExport } from '@/composables/useComparisonExport';
import { useWorkerUrl } from '@/composables/useWorkerUrl';
import { useLiteMode } from '@/composables/useLiteMode';
import { useProcessingState } from '@/composables/useProcessingState';

// Custom error for WebGPU unavailability - callers can catch this to show user choice
export class WebGPUUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WebGPUUnavailableError';
    }
}

export function useStacker() {
    const { addLog, emit } = useEventBus();
    const { captureUnstackedImage, capturePostCropFrame, capturePreCropFrame } = useComparisonExport();
    const { workerUrl } = useWorkerUrl();
    const { getMinApQuality, getApPatchSize } = useProcessingState();

    // Timing stats collector for performance analysis
    let stackingStats = null;
    function resetStackingStats() {
        stackingStats = {
            frameLoadMs: [],      // Time to read frames from disk
            gpuDemosaicMs: [],    // Time for GPU demosaic+crop
            grayscaleMs: [],      // Time for grayscale conversion
            templateMatchMs: [],  // Time for GPU template matching
            accumulateMs: [],     // Time for GPU accumulation
            totalFrames: 0,
            startTime: performance.now(),
            analysisStartTime: null // Set separately for total pipeline time
        };
    }
    function logStackingStats() {
        if (!stackingStats) return;
        const elapsed = performance.now() - stackingStats.startTime;
        const avg = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '0';
        const sum = arr => arr.reduce((a, b) => a + b, 0);
        const pct = (ms) => elapsed > 0 ? ((ms / elapsed) * 100).toFixed(0) : '0';

        const loadTotal = sum(stackingStats.frameLoadMs);
        const demosaicTotal = sum(stackingStats.gpuDemosaicMs);
        const grayTotal = sum(stackingStats.grayscaleMs);
        const matchTotal = sum(stackingStats.templateMatchMs);
        const accumTotal = sum(stackingStats.accumulateMs);

        addLog(`─── Stacking Performance Summary ───`);
        addLog(`Stacking time: ${(elapsed / 1000).toFixed(1)}s for ${stackingStats.totalFrames} frames`);
        addLog(`Frame loading (disk): ${avg(stackingStats.frameLoadMs)}ms avg, ${(loadTotal / 1000).toFixed(1)}s total (${pct(loadTotal)}%)`);
        addLog(`GPU demosaic+crop: ${avg(stackingStats.gpuDemosaicMs)}ms avg, ${(demosaicTotal / 1000).toFixed(1)}s total (${pct(demosaicTotal)}%)`);
        addLog(`Grayscale: ${avg(stackingStats.grayscaleMs)}ms avg, ${(grayTotal / 1000).toFixed(1)}s total (${pct(grayTotal)}%)`);
        addLog(`Template match: ${avg(stackingStats.templateMatchMs)}ms avg, ${(matchTotal / 1000).toFixed(1)}s total (${pct(matchTotal)}%)`);
        addLog(`Accumulate: ${avg(stackingStats.accumulateMs)}ms avg, ${(accumTotal / 1000).toFixed(1)}s total (${pct(accumTotal)}%)`);

        // Total pipeline time (analysis + stacking)
        if (stackingStats.analysisStartTime) {
            const totalPipeline = performance.now() - stackingStats.analysisStartTime;
            addLog(`─── Total pipeline: ${(totalPipeline / 1000).toFixed(1)}s ───`);
        } else {
            addLog(`────────────────────────────────────`);
        }
    }

    /**
     * Convert Float32 buffer to Uint8 buffer (for display/export)
     */
    function float32ToUint8(float32Buffer, width, height) {
        const float32Data = new Float32Array(float32Buffer);
        const uint8Data = new Uint8Array(float32Data.length);
        for (let i = 0; i < float32Data.length; i++) {
            uint8Data[i] = Math.round(float32Data[i] * 255);
        }
        return uint8Data.buffer;
    }

    /**
     * Create a PNG blob from float32Buffer for preview display
     */
    async function float32ToBlob(float32Buffer, width, height) {
        const float32Data = new Float32Array(float32Buffer);
        const uint8Data = new Uint8ClampedArray(float32Data.length);
        for (let i = 0; i < float32Data.length; i++) {
            uint8Data[i] = Math.round(float32Data[i] * 255);
        }
        const imageData = new ImageData(uint8Data, width, height);
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(imageData, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
    }

    /**
     * Create a PNG blob from uint8Buffer for preview display
     */
    async function uint8ToBlob(uint8Buffer, width, height) {
        const uint8Data = new Uint8ClampedArray(uint8Buffer);
        const imageData = new ImageData(uint8Data, width, height);
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(imageData, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
    }

    /**
     * Convert RGBA buffer to grayscale for alignment (supports both Float32 and Uint8 input)
     * Returns Uint8Array (8-bit grayscale) because:
     * - NCC alignment normalizes by mean/variance, so relative patterns matter, not precision
     * - 256 intensity levels capture planetary features well (high contrast against dark sky)
     * - 20x20 patches provide statistical robustness for reliable template matching
     * - Industry standard: AutoStakkert, PIPP, Registax all use 8-bit for alignment
     * The GPU template matcher packs this u8 data (4 pixels per u32) for 4x memory savings
     */
    function rgbaToGrayscale(buffer, width, height, isFloat32 = false) {
        const gray = new Uint8Array(width * height);
        if (isFloat32) {
            const rgba = new Float32Array(buffer);
            for (let i = 0; i < width * height; i++) {
                gray[i] = Math.round(
                    (0.299 * rgba[i * 4] +
                    0.587 * rgba[i * 4 + 1] +
                    0.114 * rgba[i * 4 + 2]) * 255
                );
            }
        } else {
            const rgba = new Uint8ClampedArray(buffer);
            for (let i = 0; i < width * height; i++) {
                gray[i] = Math.round(
                    0.299 * rgba[i * 4] +
                    0.587 * rgba[i * 4 + 1] +
                    0.114 * rgba[i * 4 + 2]
                );
            }
        }
        return gray;
    }

    /**
     * Calculate mean brightness of non-black pixels (for normalization)
     * Supports both Float32 (0.0-1.0) and Uint8 (0-255) input
     */
    function calcMeanBrightness(buffer, width, height, isFloat32 = false) {
        let sum = 0;
        let count = 0;
        const step = 8;

        if (isFloat32) {
            const data = new Float32Array(buffer);
            const blackCutoff = 10 / 255; // ~0.04 in float range
            for (let y = 0; y < height; y += step) {
                for (let x = 0; x < width; x += step) {
                    const i = (y * width + x) * 4;
                    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    if (brightness > blackCutoff) {
                        sum += brightness;
                        count++;
                    }
                }
            }
        } else {
            const data = new Uint8Array(buffer);
            const blackCutoff = 10;
            for (let y = 0; y < height; y += step) {
                for (let x = 0; x < width; x += step) {
                    const i = (y * width + x) * 4;
                    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    if (brightness > blackCutoff) {
                        sum += brightness;
                        count++;
                    }
                }
            }
        }
        return count > 0 ? sum / count : (isFloat32 ? 1.0/255 : 1);
    }

    /**
     * Create alignment points grid (pure JS, no OpenCV)
     * PSS defaults: patchSize=20, searchRadius=8 (planets) or 34 (surface)
     */
    function createAPGrid(width, height, surfaceMode = false) {
        const patchSize = getApPatchSize();
        const searchRadius = surfaceMode ? 34 : 8;

        // Adaptive spacing based on image size
        const minDim = Math.min(width, height);
        let spacing;
        if (minDim < 300) {
            spacing = 20;  // Was 30 - more APs on small crops for better alignment
        } else if (minDim < 500) {
            spacing = 20;
        } else if (minDim < 800) {
            spacing = 15;
        } else {
            spacing = Math.floor(patchSize / 2); // 10px = 50% overlap
        }

        const alignmentPoints = [];
        const marginX = Math.floor((width % spacing) / 2) + patchSize / 2;
        const marginY = Math.floor((height % spacing) / 2) + patchSize / 2;

        for (let y = marginY; y < height - patchSize / 2; y += spacing) {
            for (let x = marginX; x < width - patchSize / 2; x += spacing) {
                alignmentPoints.push({ x, y });
            }
        }

        return { alignmentPoints, patchSize, searchRadius };
    }

    /**
     * Filter alignment points by structure (local contrast) and brightness
     * PSS defaults: minStructure=0.02, minBrightness=5
     */
    function filterAPsByQuality(alignmentPoints, refGray, width, height, patchSize, minStructure = 0.02, minBrightness = 5) {
        const halfPatch = Math.floor(patchSize / 2);
        const filtered = [];

        for (const ap of alignmentPoints) {
            const x0 = ap.x - halfPatch;
            const y0 = ap.y - halfPatch;

            if (x0 < 0 || y0 < 0 || x0 + patchSize > width || y0 + patchSize > height) {
                continue;
            }

            let sum = 0;
            let sumSq = 0;
            const n = patchSize * patchSize;

            for (let py = 0; py < patchSize; py++) {
                for (let px = 0; px < patchSize; px++) {
                    const val = refGray[(y0 + py) * width + (x0 + px)];
                    sum += val;
                    sumSq += val * val;
                }
            }

            const mean = sum / n;
            const variance = (sumSq / n) - (mean * mean);
            const stdDev = Math.sqrt(Math.max(0, variance));
            const structure = stdDev / 255;

            if (mean >= minBrightness && structure >= minStructure) {
                filtered.push(ap);
            }
        }

        return filtered;
    }

    /**
     * Prepare alignment data (pure JS, no OpenCV needed)
     * Creates alignment points grid and reference grayscale for template matching.
     *
     * Note: The grayscale data here is 8-bit and used ONLY for alignment (finding dx/dy shifts).
     * The actual frame data used for stacking accumulation remains float32 (16-bit precision).
     * See rgbaToGrayscale() for why 8-bit is sufficient for alignment.
     */
    function prepareAlignmentData(refFrame, surfaceMode = false) {
        // Support both uint8Buffer (new) and float32Buffer (legacy)
        const buffer = refFrame.uint8Buffer || refFrame.float32Buffer;
        const isFloat32 = !refFrame.uint8Buffer && !!refFrame.float32Buffer;
        if (!refFrame || !buffer || !refFrame.width || !refFrame.height) {
            throw new Error('Invalid reference frame');
        }

        const { width, height } = refFrame;

        // Convert RGBA to grayscale
        const refGrayData = rgbaToGrayscale(buffer, width, height, isFloat32);

        // Create AP grid
        const { alignmentPoints, patchSize, searchRadius } = createAPGrid(width, height, surfaceMode);

        // Filter APs by quality
        const filteredAPs = filterAPsByQuality(alignmentPoints, refGrayData, width, height, patchSize, 0.02, 5);
        const activeAPs = filteredAPs.length > 0 ? filteredAPs : alignmentPoints;

        return {
            alignmentPoints: activeAPs,
            refGrayData,
            patchSize,
            searchRadius,
            width,
            height
        };
    }

    /**
     * Pipelined two-pass GPU stacking
     * Loads frames from file and stacks them concurrently for better performance
     * Instead of: load ALL → then stack ALL
     * Does: load batch → align → stack, while loading next batch
     *
     * Supports both SER files (raw Bayer) and image files (RGBA)
     * @param surfaceMode - If true, use larger search radius for Moon/Sun surface alignment
     * @param noiseRobustAlignment - If true, use two-phase alignment (coarse on blurred, fine on original)
     */
    async function stackWithGpuPipelined(frameMetadata, frameReReader, drizzleScale, addLog, emit, surfaceMode = false, noiseRobustAlignment = false) {
        const frameCount = frameMetadata.length;
        resetStackingStats();
        stackingStats.analysisStartTime = frameReReader.analysisStartTime;

        // Detect frameReReader type and extract parameters
        const isSerFile = frameReReader.fileType === 'ser' || frameReReader.header;
        const isImageFile = frameReReader.fileType === 'image' || frameReReader.rgbaFrames;

        let cropSize, srcWidth, srcHeight, bayerPattern;
        const useVng = frameReReader.useVngDemosaic ?? false;  // VNG demosaic for stacking

        if (isSerFile) {
            const { header, bayerChoice, cropRegion } = frameReReader;
            cropSize = cropRegion?.size || header.width;
            srcWidth = header.width;
            srcHeight = header.height;

            // Use direct bayerPattern if available (no-crop mode), otherwise map from bayerChoice
            if (frameReReader.bayerPattern !== undefined) {
                bayerPattern = frameReReader.bayerPattern;
            } else {
                const bayerMap = {
                    // OpenCV uses inverted naming: BG=RGGB, RG=BGGR, GB=GRBG, GR=GBRG
                    'COLOR_BayerBG2RGB': 0, 'COLOR_BayerRG2RGB': 1,
                    'COLOR_BayerGB2RGB': 2, 'COLOR_BayerGR2RGB': 3,
                    'COLOR_BayerBG2RGB_VNG': 0, 'COLOR_BayerRG2RGB_VNG': 1,
                    'COLOR_BayerGB2RGB_VNG': 2, 'COLOR_BayerGR2RGB_VNG': 3,
                    'MONO': -1
                };
                bayerPattern = bayerMap[bayerChoice] ?? -1;
            }
        } else if (isImageFile) {
            cropSize = frameReReader.cropRegion?.size || frameReReader.srcWidth;
            srcWidth = frameReReader.srcWidth;
            srcHeight = frameReReader.srcHeight;
            bayerPattern = -1; // RGBA input, no demosaic
        } else {
            throw new Error('Unknown frameReReader type');
        }

        // Detect 16-bit source: SER files have pixelDepth in header, images are always 8-bit
        // 16-bit sources return float32Buffer from GPU analyze, 8-bit returns uint8Buffer
        const is16bit = isSerFile && frameReReader.header?.pixelDepth > 8;

        addLog(`Pipelined GPU stacking: ${frameCount} frames, ${cropSize}x${cropSize}${is16bit ? ' (16-bit)' : ''}${noiseRobustAlignment ? ' (two-phase)' : ''}`);
        emit('set-caption', 'Initializing GPU workers...');

        // Initialize GPU workers (no OpenCV worker needed - alignment prep is pure JS)
        const gpuAnalyzeWorker = new Worker(workerUrl('/webgpu_analyze_worker.js'));
        const gpuStackWorker = new Worker(workerUrl('/webgpu_worker.js'));

        try {
            // Init GPU workers in parallel
            await Promise.all([
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('GPU analyze worker timeout')), 30000);
                    gpuAnalyzeWorker.onmessage = (e) => {
                        if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                        else if (e.data.type === 'init-error') { clearTimeout(timeout); reject(new Error(e.data.error)); }
                    };
                    gpuAnalyzeWorker.postMessage({ type: 'init' });
                }),
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('GPU stack worker timeout')), 10000);
                    gpuStackWorker.onmessage = (e) => {
                        if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                        else if (e.data.type === 'init-error') { clearTimeout(timeout); reject(new Error(e.data.error)); }
                    };
                    gpuStackWorker.postMessage({ type: 'init' });
                })
            ]);
            addLog('GPU workers initialized');

            // Helper to load a batch of frames (SER from file, images from memory)
            async function loadRawBatch(batchFrames) {
                const frames = [];
                const centers = [];

                if (isSerFile) {
                    // Handle multi-file SER (uses getFrame method)
                    if (frameReReader.fileType === 'ser-multi') {
                        for (const frame of batchFrames) {
                            const result = await frameReReader.getFrame(frame.index);
                            if (result) {
                                const data = frameReReader.header.pixelDepth > 8
                                    ? new Uint16Array(result.frameBuffer)
                                    : new Uint8Array(result.frameBuffer);
                                frames.push({ data, index: frame.index });
                                centers.push({ x: result.centerX, y: result.centerY });
                            }
                        }
                    } else {
                        // Single-file SER
                        const { file, frameSize, header } = frameReReader;
                        for (const frame of batchFrames) {
                            const offset = 178 + (frame.index * frameSize);
                            const frameBuffer = await file.slice(offset, offset + frameSize).arrayBuffer();
                            const data = header.pixelDepth > 8
                                ? new Uint16Array(frameBuffer)
                                : new Uint8Array(frameBuffer);
                            frames.push({ data, index: frame.index });
                            centers.push({ x: frame.centerX, y: frame.centerY });
                        }
                    }
                } else if (isImageFile) {
                    for (const frame of batchFrames) {
                        // Support both pre-loaded rgbaFrames array and getFrame() function (for MJPEG)
                        let rgba;
                        if (frameReReader.getFrame) {
                            rgba = await frameReReader.getFrame(frame.index);
                        } else if (frameReReader.rgbaFrames) {
                            rgba = frameReReader.rgbaFrames[frame.index];
                        }
                        if (rgba) {
                            frames.push({ data: rgba.data, index: frame.index });
                            centers.push({ x: frame.centerX, y: frame.centerY });
                        }
                    }
                }

                return { frames, centers };
            }

            // Helper to process batch via GPU analyze worker
            async function processGpuBatch(frames, centers) {
                return new Promise((resolve, reject) => {
                    const requestId = Date.now() + Math.random();
                    const handler = (e) => {
                        if (e.data.requestId !== requestId) return;
                        gpuAnalyzeWorker.removeEventListener('message', handler);
                        if (e.data.type === 'crop-analyze-result') {
                            resolve(e.data.results);
                        } else if (e.data.type === 'crop-analyze-error') {
                            reject(new Error(e.data.error));
                        }
                    };
                    gpuAnalyzeWorker.addEventListener('message', handler);
                    gpuAnalyzeWorker.postMessage({
                        type: 'crop-analyze-batch',
                        frames,
                        srcWidth,
                        srcHeight,
                        cropSize,
                        centers,
                        bayerPattern,
                        threshold: 0.1,
                        requestId,
                        metadataOnly: false, // Get float32 data for stacking
                        useVng  // VNG demosaic for better quality during stacking
                    });
                });
            }

            // Step 1: Find and load reference frame
            emit('set-caption', 'Loading reference frame...');
            const sortedBySharpness = [...frameMetadata].sort((a, b) => b.sharpness - a.sharpness);
            const topCount = Math.max(1, Math.ceil(sortedBySharpness.length * 0.01));
            const topFrames = sortedBySharpness.slice(0, topCount);
            const avgCircularity = topFrames.reduce((sum, f) => sum + (f.circularity || 0), 0) / topFrames.length;

            let refFrameMeta;
            if (avgCircularity > 0.7) {
                refFrameMeta = topFrames.reduce((best, f) =>
                    (f.circularity || 0) > (best.circularity || 0) ? f : best
                );
            } else {
                refFrameMeta = sortedBySharpness[0];
            }

            // Load reference frame
            const { frames: refFrames, centers: refCenters } = await loadRawBatch([refFrameMeta]);
            const refResults = await processGpuBatch(refFrames, refCenters);

            // Use appropriate buffer type based on bit depth
            // 16-bit: float32Buffer (0.0-1.0), 8-bit: uint8Buffer (0-255)
            const refBuffer = is16bit ? refResults[0].float32Buffer : refResults[0].uint8Buffer;
            const refBlob = is16bit
                ? await float32ToBlob(refBuffer, cropSize, cropSize)
                : await uint8ToBlob(refBuffer, cropSize, cropSize);
            const refFrame = {
                ...refFrameMeta,
                ...(is16bit ? { float32Buffer: refBuffer } : { uint8Buffer: refBuffer }),
                width: cropSize,
                height: cropSize,
                blob: refBlob
            };
            emit('stacking-started', { referenceFrame: refFrame });
            addLog(`Reference frame loaded: index ${refFrame.index}`);

            // Step 2: Prepare alignment points (pure JS, no OpenCV)
            emit('set-caption', 'Preparing alignment points...');
            const refFrameData = {
                ...(is16bit ? { float32Buffer: refBuffer.slice(0) } : { uint8Buffer: refBuffer.slice(0) }),
                width: cropSize,
                height: cropSize,
                sharpness: refFrame.sharpness
            };

            const alignmentData = prepareAlignmentData(refFrameData, surfaceMode);
            const { alignmentPoints, refGrayData, patchSize, searchRadius } = alignmentData;
            addLog(`Alignment prepared: ${alignmentPoints.length} APs`);

            // Calculate reference brightness for normalization
            // calcMeanBrightness returns 0-255 scale for both formats
            const refBrightness = calcMeanBrightness(refBuffer, cropSize, cropSize, is16bit);

            // Step 3: Initialize GPU stacker
            await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'init-stacking-done') {
                        gpuStackWorker.removeEventListener('message', handler);
                        resolve();
                    } else if (e.data.type === 'init-stacking-error') {
                        gpuStackWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuStackWorker.addEventListener('message', handler);
                gpuStackWorker.postMessage({
                    type: 'init-stacking',
                    width: cropSize,
                    height: cropSize,
                    drizzleScale,
                    alignmentPoints,
                    patchSize,
                    refBrightness,
                    minApQuality: getMinApQuality()
                });
            });
            addLog('GPU stacker initialized');

            // Step 4: Process frames in pipelined batches
            emit('set-caption', 'Stacking...');
            // Dynamic batch size - start aggressive, OOM handling will scale back
            // Lite mode stays conservative for mobile/low-memory devices
            const frameBytes = cropSize * cropSize * 16; // Float32 RGBA = 16 bytes/pixel
            const { isLiteMode: checkLiteMode } = useLiteMode();
            const inLiteMode = checkLiteMode();
            const targetBatchMemory = inLiteMode ? (256 * 1024 * 1024) : (512 * 1024 * 1024);
            let effectiveBatchSize = Math.max(4, Math.min(64, Math.floor(targetBatchMemory / frameBytes)));
            const totalSharpness = frameMetadata.reduce((sum, f) => sum + f.sharpness, 0);
            let processedCount = 0;

            // Helper to check for OOM errors
            const isOOMError = (err) => err.message?.includes('Array buffer allocation failed') ||
                err.message?.includes('out of memory') || err.message?.includes('OOM') ||
                err.message?.includes('allocation failed');

            // For surface mode, sort frames by original index for temporal drift tracking
            let framesToProcess = [...frameMetadata];
            if (surfaceMode) {
                framesToProcess.sort((a, b) => (a.index || 0) - (b.index || 0));
                addLog('Surface mode: processing frames in temporal order for drift tracking');
            }

            // Cumulative drift tracking for surface mode
            let cumulativeDrift = { dx: 0, dy: 0 };

            // Pre-load first batch
            let batchStart = 0;
            let nextBatchPromise = null;

            while (batchStart < frameCount) {
                const batchEnd = Math.min(batchStart + effectiveBatchSize, frameCount);
                let batchFrames = framesToProcess.slice(batchStart, batchEnd);

                // Get current batch (pre-loaded or load now)
                let rawBatch;
                const t0Load = performance.now();
                if (nextBatchPromise) {
                    rawBatch = await nextBatchPromise;
                    // Trim if batch size was reduced
                    if (rawBatch.frames.length > effectiveBatchSize) {
                        rawBatch.frames = rawBatch.frames.slice(0, effectiveBatchSize);
                        rawBatch.centers = rawBatch.centers.slice(0, effectiveBatchSize);
                        batchFrames = batchFrames.slice(0, effectiveBatchSize);
                    }
                } else {
                    rawBatch = await loadRawBatch(batchFrames);
                }
                stackingStats.frameLoadMs.push(performance.now() - t0Load);

                // Start loading next batch while processing current
                const nextStart = batchStart + rawBatch.frames.length;
                if (nextStart < frameCount) {
                    const nextEnd = Math.min(nextStart + effectiveBatchSize, frameCount);
                    const nextFrames = framesToProcess.slice(nextStart, nextEnd);
                    nextBatchPromise = loadRawBatch(nextFrames);
                } else {
                    nextBatchPromise = null;
                }

                // Process current batch via GPU (demosaic + crop) with OOM handling
                const t0Demosaic = performance.now();
                let gpuResults = null;
                let retryFrames = rawBatch.frames;
                let retryCenters = rawBatch.centers;
                while (!gpuResults && retryFrames.length > 0) {
                    try {
                        gpuResults = await processGpuBatch(retryFrames, retryCenters);
                    } catch (err) {
                        if (isOOMError(err) && retryFrames.length > 1) {
                            const newSize = Math.max(1, Math.floor(retryFrames.length / 2));
                            addLog(`GPU memory error, reducing batch from ${retryFrames.length} to ${newSize}`);
                            retryFrames = retryFrames.slice(0, newSize);
                            retryCenters = retryCenters.slice(0, newSize);
                            batchFrames = batchFrames.slice(0, newSize);
                            effectiveBatchSize = newSize;
                            nextBatchPromise = null; // Cancel pre-fetch
                        } else {
                            throw err;
                        }
                    }
                }
                stackingStats.gpuDemosaicMs.push(performance.now() - t0Demosaic);
                if (!gpuResults) break;
                rawBatch.frames = retryFrames;
                rawBatch.centers = retryCenters;

                // Capture frames for comparison video (both raw pre-crop and processed post-crop)
                for (let i = 0; i < gpuResults.length; i++) {
                    const globalIndex = batchStart + i;
                    // Post-crop: convert to uint8 for capture (16-bit needs conversion)
                    const frameBuffer = is16bit ? gpuResults[i].float32Buffer : gpuResults[i].uint8Buffer;
                    const uint8ForCapture = is16bit
                        ? new Uint8Array(float32ToUint8(frameBuffer, cropSize, cropSize))
                        : new Uint8Array(frameBuffer);
                    capturePostCropFrame(uint8ForCapture, cropSize, cropSize, globalIndex, frameCount);
                    // Pre-crop: store raw Bayer data for lazy demosaic later
                    const rawFrame = rawBatch.frames[i];
                    capturePreCropFrame(rawFrame.data, srcWidth, srcHeight, globalIndex, frameCount, bayerPattern);
                }

                // Calculate shifts for batch via GPU template matching
                const t0Gray = performance.now();
                const frameGrayDatas = gpuResults.map(r => {
                    const buffer = is16bit ? r.float32Buffer : r.uint8Buffer;
                    return rgbaToGrayscale(buffer, cropSize, cropSize, is16bit);
                });
                stackingStats.grayscaleMs.push(performance.now() - t0Gray);

                // For surface mode, pass searchOffset to shift search region without affecting template extraction
                const searchOffset = surfaceMode && (cumulativeDrift.dx !== 0 || cumulativeDrift.dy !== 0)
                    ? { dx: cumulativeDrift.dx, dy: cumulativeDrift.dy }
                    : null;

                const t0Match = performance.now();
                const batchShifts = await new Promise((resolve, reject) => {
                    const requestId = batchStart;
                    const handler = (e) => {
                        if (e.data.requestId !== requestId) return;
                        gpuStackWorker.removeEventListener('message', handler);
                        if (e.data.type === 'batch-result') resolve(e.data.allShifts);
                        else if (e.data.type === 'batch-error') reject(new Error(e.data.error));
                    };
                    gpuStackWorker.addEventListener('message', handler);
                    gpuStackWorker.postMessage({
                        type: 'match-templates-batch',
                        requestId,
                        refGrayData,
                        frameGrayDatas,
                        width: cropSize,
                        height: cropSize,
                        alignmentPoints,
                        patchSize,
                        searchRadius,
                        searchOffset,
                        noiseRobustAlignment
                    });
                });
                stackingStats.templateMatchMs.push(performance.now() - t0Match);

                // Update cumulative drift from last frame's shifts (surface mode)
                if (surfaceMode && batchShifts.length > 0) {
                    const lastFrameShifts = batchShifts[batchShifts.length - 1];
                    const goodShifts = lastFrameShifts.filter(s => s.quality > 0.3);
                    if (goodShifts.length >= 3) {
                        // Use median of good shifts as current drift estimate
                        const dxValues = goodShifts.map(s => s.dx).sort((a, b) => a - b);
                        const dyValues = goodShifts.map(s => s.dy).sort((a, b) => a - b);
                        const medianIdx = Math.floor(goodShifts.length / 2);
                        cumulativeDrift = {
                            dx: dxValues[medianIdx],
                            dy: dyValues[medianIdx]
                        };
                    }
                }

                // Send batch to GPU stacker
                // 16-bit: Float32Array (0.0-1.0) with inputFormat=0
                // 8-bit: Uint8Array (0-255) with inputFormat=1 (GPU converts to float)
                const batchForStacker = gpuResults.map((r, i) => ({
                    rgbaBuffer: is16bit
                        ? new Float32Array(r.float32Buffer)
                        : new Uint8Array(r.uint8Buffer),
                    sharpness: batchFrames[i].sharpness
                }));
                const batchWeights = batchFrames.map(f => f.sharpness / totalSharpness * frameCount);

                const t0Accum = performance.now();
                await new Promise((resolve, reject) => {
                    const handler = (e) => {
                        if (e.data.type === 'stack-batch-done') {
                            gpuStackWorker.removeEventListener('message', handler);
                            resolve();
                        } else if (e.data.type === 'stack-frame-error') {
                            gpuStackWorker.removeEventListener('message', handler);
                            reject(new Error(e.data.error));
                        }
                    };
                    gpuStackWorker.addEventListener('message', handler);
                    gpuStackWorker.postMessage({
                        type: 'stack-frame-batch',
                        frames: batchForStacker,
                        shifts: batchShifts,
                        frameWeights: batchWeights
                    });
                });
                stackingStats.accumulateMs.push(performance.now() - t0Accum);

                processedCount += batchFrames.length;
                const progress = (processedCount / frameCount) * 90;
                emit('set-caption', 'Stacking...');
                emit('update-loading', { progress, current: processedCount, total: frameCount });

                batchStart = batchEnd;
            }

            // Step 5: Finalize stacking
            emit('set-caption', 'Finalizing...');
            const result = await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'stack-complete') {
                        gpuStackWorker.removeEventListener('message', handler);
                        resolve(e.data);
                    } else if (e.data.type === 'finalize-error') {
                        gpuStackWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuStackWorker.addEventListener('message', handler);
                gpuStackWorker.postMessage({ type: 'finalize-stacking' });
            });

            // Cleanup
            gpuStackWorker.postMessage({ type: 'cleanup' });
            gpuAnalyzeWorker.terminate();
            gpuStackWorker.terminate();

            // Log performance summary
            stackingStats.totalFrames = frameCount;
            logStackingStats();

            addLog(`Stacking complete: ${result.width}x${result.height}`);
            emit('set-caption', 'Stacking complete');

            captureUnstackedImage(result.blob);

            return {
                blob: result.blob,
                float32Data: result.float32Buffer ? new Float32Array(result.float32Buffer) : null,
                width: result.width,
                height: result.height
            };

        } catch (error) {
            gpuAnalyzeWorker.terminate();
            gpuStackWorker.terminate();

            // Check if this is a GPU unavailable error - throw specific error for user choice
            const gpuUnavailableErrors = ['No WebGPU adapter', 'WebGPU not available', 'Device', 'lost'];
            const isGpuUnavailable = gpuUnavailableErrors.some(msg => error.message?.includes(msg));

            if (isGpuUnavailable) {
                addLog(`GPU unavailable: ${error.message}`);
                throw new WebGPUUnavailableError(error.message);
            }

            addLog(`Pipelined stacking error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Stack frames using a web worker for local alignment
     * @param frames - Array of frame objects with float32Buffer (or rgbaBuffer for legacy), width, height, sharpness
     *                 For two-pass mode: frames may have only metadata (sharpness, centerX, centerY) with no buffer
     * @param existingWorker - Optional: reuse an existing initialized worker
     * @param drizzleScale - Output scale factor (1.0 = normal, 1.5 = drizzle)
     * @param noiseRobustAlignment - Enable noise-robust alignment
     * @param useWebGPU - Use WebGPU for stacking
     * @param frameReReader - Optional: two-pass mode - re-read frames on demand instead of using pre-loaded buffers
     * @param surfaceMode - If true, use larger search radius for Moon/Sun surface alignment
     */
    async function stackFramesLocally(frames, existingWorker = null, drizzleScale = 1.5, noiseRobustAlignment = false, useWebGPU = false, frameReReader = null, surfaceMode = false) {
        emit('set-caption', 'Preparing for stacking...');
        emit('update-loading', { progress: 0, current: 0, total: 0 });

        // TWO-PASS MODE: If frameReReader is provided and frames don't have buffers,
        // use pipelined stacking (load + stack concurrently)
        const hasTwoPassFrames = frames.length > 0 && !frames[0].uint8Buffer && !frames[0].float32Buffer && !frames[0].rgbaBuffer && frameReReader;

        if (hasTwoPassFrames && useWebGPU) {
            // Use pipelined approach: load batch → align → stack, while loading next batch
            // Will throw WebGPUUnavailableError if GPU not available - caller should handle
            return await stackWithGpuPipelined(frames, frameReReader, drizzleScale, addLog, emit, surfaceMode, noiseRobustAlignment);
        }

        // Filter frames that have valid buffer (uint8Buffer preferred, float32Buffer/rgbaBuffer for legacy) and sharpness
        // DEBUG: Log filtering stats
        const noBuffer = frames.filter(f => !f.uint8Buffer && !f.float32Buffer && !f.rgbaBuffer).length;
        const noWidth = frames.filter(f => !f.width).length;
        const noHeight = frames.filter(f => !f.height).length;
        const noSharpness = frames.filter(f => !f.sharpness || f.sharpness <= 0).length;
        addLog(`Stacker input: ${frames.length} frames, filtering: noBuffer=${noBuffer}, noWidth=${noWidth}, noHeight=${noHeight}, noSharpness=${noSharpness}`);

        const validFrames = frames.filter(f => (f.uint8Buffer || f.float32Buffer || f.rgbaBuffer) && f.width && f.height && f.sharpness > 0);
        addLog(`Stacker: ${validFrames.length} valid frames after filtering`);

        if (validFrames.length === 0) {
            addLog('No valid frames with RGBA data for stacking');
            return null;
        }

        // Select reference frame: for round planets, pick most circular from top 1% sharpest
        const sortedFrames = [...validFrames].sort((a, b) => b.sharpness - a.sharpness);

        // Take top 1% of frames (minimum 1)
        const topCount = Math.max(1, Math.ceil(sortedFrames.length * 0.01));
        const topFrames = sortedFrames.slice(0, topCount);

        // Calculate average circularity to detect planet type
        const avgCircularity = topFrames.reduce((sum, f) => sum + (f.circularity || 0), 0) / topFrames.length;

        let referenceFrame;
        if (avgCircularity > 0.7) {
            // Round planet (Jupiter, Mars, etc.) - pick most circular from top frames
            referenceFrame = topFrames.reduce((best, f) =>
                (f.circularity || 0) > (best.circularity || 0) ? f : best
            );
            addLog(`Round planet detected (circularity ${avgCircularity.toFixed(2)}), selecting most circular reference frame`);
        } else {
            // Non-round (Saturn) or unclear - stick with sharpest
            referenceFrame = sortedFrames[0];
            addLog(`Non-round planet detected (circularity ${avgCircularity.toFixed(2)}), selecting sharpest reference frame`);
        }

        // Ensure reference frame has a blob for preview display
        if (!referenceFrame.blob && referenceFrame.float32Buffer) {
            referenceFrame.blob = await float32ToBlob(referenceFrame.float32Buffer, referenceFrame.width, referenceFrame.height);
        } else if (!referenceFrame.blob && referenceFrame.uint8Buffer) {
            // Create blob from uint8Buffer
            const imageData = new ImageData(new Uint8ClampedArray(referenceFrame.uint8Buffer), referenceFrame.width, referenceFrame.height);
            const canvas = new OffscreenCanvas(referenceFrame.width, referenceFrame.height);
            const ctx = canvas.getContext('2d');
            ctx.putImageData(imageData, 0, 0);
            referenceFrame.blob = await canvas.convertToBlob({ type: 'image/png' });
        }
        emit('stacking-started', { referenceFrame });

        const drizzleStr = drizzleScale > 1 ? ` with ${drizzleScale}x drizzle` : '';
        addLog(`Sending ${validFrames.length} frames to stacking worker${drizzleStr}${useWebGPU ? ' (WebGPU)' : ''}`);

        // Prepare frame data - only include cloneable/transferable properties
        // Use uint8Buffer (GPU converts to Float32) - avoids slow JS conversion loops
        const frameData = [];
        for (let i = 0; i < validFrames.length; i++) {
            const f = validFrames[i];
            // Prefer uint8Buffer (new optimized path), fall back to float32Buffer or rgbaBuffer
            let buffer = f.uint8Buffer || f.float32Buffer || f.rgbaBuffer;
            const isUint8 = !!f.uint8Buffer || (!f.float32Buffer && !!f.rgbaBuffer);
            if (buffer && !(buffer instanceof ArrayBuffer)) {
                if (buffer.buffer instanceof ArrayBuffer) {
                    buffer = buffer.buffer;
                } else {
                    console.warn(`Frame ${i}: buffer is not an ArrayBuffer, skipping`);
                    continue;
                }
            }
            if (!buffer || buffer.byteLength === 0) {
                console.warn(`Frame ${i}: buffer is empty or detached, skipping`);
                continue;
            }
            frameData.push({
                uint8Buffer: isUint8 ? buffer : null,
                float32Buffer: isUint8 ? null : buffer,
                isUint8,
                width: f.width,
                height: f.height,
                sharpness: f.sharpness,
                subPixelOffset: { x: f.subPixelOffset?.x || 0, y: f.subPixelOffset?.y || 0 }
            });
        }

        if (frameData.length === 0) {
            addLog('Error: No valid frame buffers for stacking');
            return null;
        }
        addLog(`Prepared ${frameData.length} frames for stacking`);

        // WebGPU path: orchestrate GPU worker directly from main thread
        // Will throw WebGPUUnavailableError if GPU not available - caller should handle
        if (useWebGPU) {
            return await stackWithWebGPU(frameData, drizzleScale, addLog, emit, surfaceMode, noiseRobustAlignment);
        }

        // CPU path: send everything to unified_analyze_worker
        return await stackWithCPU(frameData, drizzleScale, noiseRobustAlignment, addLog, emit, surfaceMode);
    }

    /**
     * Stack using WebGPU for template matching (main thread orchestrates)
     * @param surfaceMode - If true, use larger search radius for Moon/Sun surface alignment
     * @param noiseRobustAlignment - If true, use two-phase alignment (coarse on blurred, fine on original)
     */
    async function stackWithWebGPU(frameData, drizzleScale, addLog, emit, surfaceMode = false, noiseRobustAlignment = false) {
        const { width, height } = frameData[0];
        resetStackingStats();

        // Step 1: Initialize GPU worker
        addLog('Initializing GPU worker...');
        emit('set-caption', 'Initializing GPU worker...');

        const gpuWorker = new Worker(workerUrl('/webgpu_worker.js'));

        try {
            // Init WebGPU worker
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('WebGPU worker timeout')), 10000);
                gpuWorker.onmessage = (e) => {
                    if (e.data.type === 'ready') { clearTimeout(timeout); resolve(); }
                    else if (e.data.type === 'init-error') { clearTimeout(timeout); reject(new Error(e.data.error)); }
                };
                gpuWorker.postMessage({ type: 'init' });
            });
            addLog('WebGPU worker ready');

            // Step 2: Prepare alignment points (pure JS, no OpenCV needed)
            emit('set-caption', 'Preparing alignment points...');

            // Find reference frame (highest sharpness) - only send this one frame
            const refIndex = frameData.reduce((bestIdx, f, idx, arr) =>
                f.sharpness > arr[bestIdx].sharpness ? idx : bestIdx, 0);
            const refFrame = frameData[refIndex];

            // Only clone the reference frame buffer for alignment preparation
            // Prefer uint8Buffer (new optimized path)
            let refBuffer = refFrame.uint8Buffer || refFrame.float32Buffer || refFrame.rgbaBuffer;
            if (!refBuffer) {
                throw new Error('Reference frame has no valid buffer');
            }
            refBuffer = refBuffer.slice(0);
            const isUint8Ref = !!refFrame.uint8Buffer || (!refFrame.float32Buffer && !!refFrame.rgbaBuffer);
            const refFrameData = {
                uint8Buffer: isUint8Ref ? refBuffer : undefined,
                float32Buffer: !isUint8Ref ? refBuffer : undefined,
                width: refFrame.width,
                height: refFrame.height,
                sharpness: refFrame.sharpness
            };

            // Prepare alignment data (pure JS, no OpenCV)
            const alignmentData = prepareAlignmentData(refFrameData, surfaceMode);
            const { alignmentPoints, refGrayData, patchSize, searchRadius } = alignmentData;
            addLog(`Alignment prepared: ${alignmentPoints.length} APs, reference frame ${refIndex}`);

            // Step 3: Run template matching on GPU in batches
            emit('set-caption', 'GPU template matching...');
            const frameCount = frameData.length;
            const frameShifts = new Array(frameCount);

            // Calculate batch size based on frame size and memory limits
            // Each frame needs width*height*4 bytes for grayscale float data
            // Start aggressive, OOM handling will scale back if needed
            const frameBytes = width * height * 4;
            const { isLiteMode: checkLiteModeStack } = useLiteMode();
            const inLiteModeStack = checkLiteModeStack();
            const maxBatchMemory = inLiteModeStack ? (256 * 1024 * 1024) : (512 * 1024 * 1024);
            let batchSize = Math.min(128, Math.max(8, Math.floor(maxBatchMemory / frameBytes)));
            addLog(`Using batch size ${batchSize} for GPU template matching${inLiteModeStack ? ' (Lite mode)' : ''}${noiseRobustAlignment ? ' (two-phase)' : ''}`);

            // Pre-fill reference frame with zero shifts
            frameShifts[refIndex] = alignmentPoints.map(() => ({ dx: 0, dy: 0, quality: 1 }));

            // Build list of frames to process (excluding reference)
            let framesToProcess = [];
            for (let f = 0; f < frameCount; f++) {
                if (f !== refIndex) {
                    framesToProcess.push(f);
                }
            }

            // Surface mode: sort frames by original index for proper drift tracking
            // Quality selector may pick frames out of temporal order
            if (surfaceMode) {
                framesToProcess.sort((a, b) => {
                    const idxA = frameData[a].index || a;
                    const idxB = frameData[b].index || b;
                    return idxA - idxB;
                });
                addLog('Surface mode: processing frames in temporal order for drift tracking');
            }

            // Surface mode: track cumulative drift across batches
            let cumulativeDrift = { dx: 0, dy: 0 };

            // Process in batches
            let processedCount = 0;
            for (let batchStart = 0; batchStart < framesToProcess.length; batchStart += batchSize) {
                const batchEnd = Math.min(batchStart + batchSize, framesToProcess.length);
                const batchIndices = framesToProcess.slice(batchStart, batchEnd);

                // Convert batch frames to grayscale (handle Uint8 and Float32)
                const t0Gray = performance.now();
                const frameGrayDatas = batchIndices.map(f => {
                    const frame = frameData[f];
                    const buffer = frame.uint8Buffer || frame.float32Buffer || frame.rgbaBuffer;
                    const isFloat32 = !frame.isUint8 && !!frame.float32Buffer;
                    return rgbaToGrayscale(buffer, width, height, isFloat32);
                });
                stackingStats.grayscaleMs.push(performance.now() - t0Gray);

                // Send batch to GPU with searchOffset for drift tracking
                // searchOffset tells GPU to search around expected drifted position while
                // keeping template extraction at original AP positions
                const searchOffset = surfaceMode && (cumulativeDrift.dx !== 0 || cumulativeDrift.dy !== 0)
                    ? { dx: cumulativeDrift.dx, dy: cumulativeDrift.dy }
                    : null;

                const t0Match = performance.now();
                const batchShifts = await new Promise((resolve, reject) => {
                    const requestId = batchStart;
                    const handler = (e) => {
                        if (e.data.requestId !== requestId) return;
                        gpuWorker.removeEventListener('message', handler);
                        if (e.data.type === 'batch-result') resolve(e.data.allShifts);
                        else if (e.data.type === 'batch-error') reject(new Error(e.data.error));
                    };
                    gpuWorker.addEventListener('message', handler);
                    gpuWorker.postMessage({
                        type: 'match-templates-batch',
                        requestId,
                        refGrayData,
                        frameGrayDatas,
                        width,
                        height,
                        alignmentPoints,
                        patchSize,
                        searchRadius,
                        searchOffset,
                        noiseRobustAlignment
                    });
                });
                stackingStats.templateMatchMs.push(performance.now() - t0Match);

                // Store results at correct indices
                for (let i = 0; i < batchIndices.length; i++) {
                    frameShifts[batchIndices[i]] = batchShifts[i];
                }

                // Surface mode: update cumulative drift from this batch's results
                if (surfaceMode && batchShifts.length > 0) {
                    // Use median of last frame's shifts as the drift update
                    const lastFrameShifts = batchShifts[batchShifts.length - 1];
                    const goodShifts = lastFrameShifts.filter(s => s.quality > 0.3);
                    if (goodShifts.length > 3) {
                        const sortedDx = goodShifts.map(s => s.dx).sort((a, b) => a - b);
                        const sortedDy = goodShifts.map(s => s.dy).sort((a, b) => a - b);
                        const medianIdx = Math.floor(goodShifts.length / 2);
                        cumulativeDrift = {
                            dx: sortedDx[medianIdx],
                            dy: sortedDy[medianIdx]
                        };
                    }
                }

                processedCount += batchIndices.length;
                const progress = 5 + (processedCount / framesToProcess.length) * 45;
                emit('set-caption', `Aligning frames...`);
                emit('update-loading', { progress, current: processedCount, total: framesToProcess.length });
            }

            if (surfaceMode) {
                addLog(`GPU batch alignment complete (total drift: ${cumulativeDrift.dx.toFixed(1)}, ${cumulativeDrift.dy.toFixed(1)} px)`);
            } else {
                addLog('GPU batch alignment complete');
            }

            // Step 4: GPU Stacking - stream frames in batches to avoid memory issues
            emit('set-caption', 'GPU stacking...');
            addLog('Starting GPU stacking');

            // Calculate total sharpness for weighting
            const totalSharpness = frameData.reduce((sum, f) => sum + f.sharpness, 0);

            // Calculate reference brightness (refFrame already defined above)
            // calcMeanBrightness returns 0-255 for Uint8, 0-1 for Float32
            const refFrameForBrightness = frameData[refIndex];
            const refBrightnessBuffer = refFrameForBrightness.uint8Buffer || refFrameForBrightness.float32Buffer || refFrameForBrightness.rgbaBuffer;
            const isFloat32Ref = !refFrameForBrightness.isUint8 && !!refFrameForBrightness.float32Buffer;
            let refBrightness = calcMeanBrightness(refBrightnessBuffer, width, height, isFloat32Ref);
            // Convert to 0-255 range if calculated from Float32 data (0-1 range)
            if (isFloat32Ref) {
                refBrightness *= 255;
            }

            // Initialize stacking
            await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'init-stacking-done') {
                        gpuWorker.removeEventListener('message', handler);
                        resolve(e.data);
                    } else if (e.data.type === 'init-stacking-error') {
                        gpuWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuWorker.addEventListener('message', handler);
                gpuWorker.postMessage({
                    type: 'init-stacking',
                    width, height, drizzleScale, alignmentPoints, patchSize, refBrightness, minApQuality: getMinApQuality()
                });
            });

            // Stream frames in batches
            const stackBatchSize = 20;
            let stackedCount = 0;

            for (let batchStart = 0; batchStart < frameCount; batchStart += stackBatchSize) {
                const batchEnd = Math.min(batchStart + stackBatchSize, frameCount);

                const batchFrames = [];
                const batchShifts = [];
                const batchWeights = [];

                for (let i = batchStart; i < batchEnd; i++) {
                    const frame = frameData[i];
                    // GPU stacker handles both Uint8 and Float32 input (converts Uint8→Float32 on GPU)
                    let rgbaBuffer;
                    if (frame.isUint8 && frame.uint8Buffer) {
                        // Uint8 input - GPU converts to Float32
                        rgbaBuffer = new Uint8Array(frame.uint8Buffer);
                    } else if (frame.float32Buffer) {
                        // Float32 input - pass directly
                        rgbaBuffer = new Float32Array(frame.float32Buffer);
                    }
                    batchFrames.push({
                        rgbaBuffer,
                        sharpness: frame.sharpness
                    });
                    batchShifts.push(frameShifts[i]);
                    batchWeights.push(frame.sharpness / totalSharpness * frameCount);
                }

                const t0Accum = performance.now();
                await new Promise((resolve, reject) => {
                    const handler = (e) => {
                        if (e.data.type === 'stack-batch-done') {
                            gpuWorker.removeEventListener('message', handler);
                            resolve();
                        } else if (e.data.type === 'stack-frame-error') {
                            gpuWorker.removeEventListener('message', handler);
                            reject(new Error(e.data.error));
                        }
                    };
                    gpuWorker.addEventListener('message', handler);
                    gpuWorker.postMessage({
                        type: 'stack-frame-batch',
                        frames: batchFrames,
                        shifts: batchShifts,
                        frameWeights: batchWeights
                    });
                });
                stackingStats.accumulateMs.push(performance.now() - t0Accum);

                stackedCount = batchEnd;
                const progress = 50 + (stackedCount / frameCount) * 40;
                emit('set-caption', 'Stacking...');
                emit('update-loading', { progress, current: stackedCount, total: frameCount });
            }

            addLog('GPU stacking complete, finalizing...');

            // Finalize and get result
            const result = await new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'stack-complete') {
                        gpuWorker.removeEventListener('message', handler);
                        resolve(e.data);
                    } else if (e.data.type === 'finalize-error') {
                        gpuWorker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                gpuWorker.addEventListener('message', handler);
                gpuWorker.postMessage({ type: 'finalize-stacking' });
            });

            // Cleanup and terminate
            gpuWorker.postMessage({ type: 'cleanup' });
            gpuWorker.terminate();

            // Log performance summary
            stackingStats.totalFrames = frameCount;
            logStackingStats();

            addLog(`Stacked image: ${result.width}x${result.height}, ${(result.blob.size / 1024).toFixed(1)} KB`);
            emit('set-caption', 'Stacking complete');

            // Capture unstacked image for comparison export
            captureUnstackedImage(result.blob);

            // Reconstruct Float32Array from transferred buffer
            const float32Data = result.float32Buffer ? new Float32Array(result.float32Buffer) : null;

            // Return full object with blob and float32Data for 16-bit post-processing
            return {
                blob: result.blob,
                float32Data,
                width: result.width,
                height: result.height
            };

        } catch (error) {
            gpuWorker.terminate();

            // Check if this is a GPU unavailable error - throw specific error for user choice
            const gpuUnavailableErrors = ['No WebGPU adapter', 'WebGPU not available', 'Device', 'lost'];
            const isGpuUnavailable = gpuUnavailableErrors.some(msg => error.message?.includes(msg));

            if (isGpuUnavailable) {
                addLog(`GPU unavailable: ${error.message}`);
                throw new WebGPUUnavailableError(error.message);
            }

            throw error;
        }
    }

    /**
     * Stack using CPU (OpenCV) for template matching
     * @param surfaceMode - If true, use larger search radius for Moon/Sun surface alignment
     */
    async function stackWithCPU(frameData, drizzleScale, noiseRobustAlignment, addLog, emit, surfaceMode = false) {
        return new Promise((resolve, reject) => {
            addLog('Creating fresh worker for stacking...');
            const worker = new Worker(workerUrl('/unified_analyze_worker.js'));

            const initHandler = (e) => {
                if (e.data.type === 'ready') {
                    addLog('Fresh stacking worker ready');
                    worker.removeEventListener('message', initHandler);
                    proceedWithStacking();
                } else if (e.data.type === 'error') {
                    addLog(`Fresh worker init error: ${e.data.message}`);
                    worker.removeEventListener('message', initHandler);
                    reject(new Error('Failed to initialize stacking worker'));
                }
            };
            worker.addEventListener('message', initHandler);
            worker.postMessage({ type: 'init' });

            function proceedWithStacking() {
                let lastLoggedStage = '';
                const messageHandler = (e) => {
                    const { type } = e.data;

                    if (type === 'stack-progress') {
                        emit('set-caption', e.data.stage);
                        emit('update-loading', {
                            progress: e.data.progress,
                            current: Math.round(e.data.progress),
                            total: 100
                        });
                        const stage = e.data.stage;
                        const stagePrefix = stage.replace(/\d+\/\d+/, '').trim();
                        if (stagePrefix !== lastLoggedStage) {
                            lastLoggedStage = stagePrefix;
                            addLog(stage);
                        }
                    }

                    if (type === 'stack-complete') {
                        const { blob, width, height, float32Buffer } = e.data;
                        addLog(`Stacked image: ${width}x${height}, ${(blob.size / 1024).toFixed(1)} KB`);
                        emit('set-caption', 'Stacking complete');

                        // Capture unstacked image for comparison export
                        captureUnstackedImage(blob);

                        // Reconstruct Float32Array from transferred buffer
                        const float32Data = float32Buffer ? new Float32Array(float32Buffer) : null;

                        worker.removeEventListener('message', messageHandler);
                        worker.terminate();
                        // Return object with blob and float32Data for 16-bit post-processing
                        resolve({ blob, float32Data, width, height });
                    }

                    if (type === 'stack-error') {
                        addLog(`Stacking error: ${e.data.error}`);
                        emit('set-caption', 'Stacking failed');
                        worker.removeEventListener('message', messageHandler);
                        worker.terminate();
                        reject(new Error(e.data.error));
                    }
                };

                worker.addEventListener('message', messageHandler);

                // Use Set to deduplicate - same buffer may be referenced by multiple frames
                // Include uint8Buffer, float32Buffer and rgbaBuffer for hybrid mode
                const transferables = [...new Set(
                    frameData.flatMap(f => [f.uint8Buffer, f.float32Buffer, f.rgbaBuffer]).filter(b => b instanceof ArrayBuffer && b.byteLength > 0)
                )];
                worker.postMessage({
                    type: 'stack-frames',
                    frames: frameData,
                    drizzleScale: drizzleScale,
                    noiseRobustAlignment: noiseRobustAlignment,
                    surfaceMode: surfaceMode
                }, transferables);
            }
        });
    }

    return { stackFramesLocally };
}

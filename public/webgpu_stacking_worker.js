// Dedicated WebGPU worker - no OpenCV, just GPU compute
// Supports: template matching (single/batch) and GPU stacking
// This is a module worker - use { type: 'module' } when creating

import {
    initWebGPU,
    matchTemplatesGPU,
    matchTemplatesBatchGPU,
    cleanupGPUBuffers
} from './webgpu_template_match.js';

import {
    initStackingGPU,
    getStackingBuffers,
    clearAccumulators,
    warpAndAccumulateBatch,
    readAccumulators,
    demosaicVngBatch,
    demosaicVngCropBatch,
    demosaicVngCropBatchGpu,
    warpAndAccumulateFromGpuBuffer,
    matchTemplatesFromGpuBuffer,
    extractGrayscale,
    cleanupStackingBuffers
} from './webgpu_stacking.js';

console.log('[StackWorker] Modules loaded');

let isReady = false;
let stackingReady = false;
let stackingContext = null;

// Initialize WebGPU on startup
async function init() {
    if (!navigator.gpu) {
        self.postMessage({ type: 'init-error', error: 'WebGPU not available in this browser' });
        return;
    }

    try {
        const ok = await initWebGPU();
        if (ok) {
            isReady = true;
            self.postMessage({ type: 'ready' });
        } else {
            self.postMessage({ type: 'init-error', error: 'WebGPU initialization failed' });
        }
    } catch (e) {
        self.postMessage({ type: 'init-error', error: e.message });
    }
}

self.addEventListener('message', async (e) => {
    const { type } = e.data;

    if (type === 'init') {
        await init();
        return;
    }

    // Single frame template matching (legacy, kept for compatibility)
    if (type === 'match-templates') {
        if (!isReady) {
            self.postMessage({
                type: 'match-error',
                requestId: e.data.requestId,
                error: 'WebGPU worker not initialized'
            });
            return;
        }

        const { requestId, refGrayData, frameGrayData, width, height, alignmentPoints, patchSize, searchRadius } = e.data;

        try {
            const shifts = await matchTemplatesGPU(
                refGrayData,
                frameGrayData,
                width,
                height,
                alignmentPoints,
                patchSize,
                searchRadius
            );

            if (shifts) {
                self.postMessage({
                    type: 'match-result',
                    requestId,
                    shifts
                });
            } else {
                self.postMessage({
                    type: 'match-error',
                    requestId,
                    error: 'GPU template matching returned null'
                });
            }
        } catch (err) {
            self.postMessage({
                type: 'match-error',
                requestId,
                error: err.message
            });
        }
    }

    // Batch template matching - process multiple frames at once
    if (type === 'match-templates-batch') {
        if (!isReady) {
            self.postMessage({
                type: 'batch-error',
                requestId: e.data.requestId,
                error: 'WebGPU worker not initialized'
            });
            return;
        }

        const { requestId, refGrayData, frameGrayDatas, width, height, alignmentPoints, patchSize, searchRadius, searchOffset, noiseRobustAlignment } = e.data;

        try {
            const allShifts = await matchTemplatesBatchGPU(
                refGrayData,
                frameGrayDatas,
                width,
                height,
                alignmentPoints,
                patchSize,
                searchRadius,
                searchOffset,
                noiseRobustAlignment
            );

            if (allShifts) {
                self.postMessage({
                    type: 'batch-result',
                    requestId,
                    allShifts
                });
            } else {
                self.postMessage({
                    type: 'batch-error',
                    requestId,
                    error: 'GPU batch template matching returned null'
                });
            }
        } catch (err) {
            self.postMessage({
                type: 'batch-error',
                requestId,
                error: err.message
            });
        }
    }

    // GPU Stacking - streaming approach to avoid memory issues
    // Step 1: Initialize stacking
    if (type === 'init-stacking') {
        const { width, height, srcWidth, srcHeight, drizzleScale, alignmentPoints, patchSize, refBrightness, minApQuality = 0.3,
                bayerPattern = -1, bitDepth = 8, bayerScale = 1.0 } = e.data;

        try {
            if (!stackingReady) {
                stackingReady = await initStackingGPU();
                if (!stackingReady) {
                    throw new Error('Failed to initialize GPU stacking');
                }
            }

            const outWidth = Math.round(width * drizzleScale);
            const outHeight = Math.round(height * drizzleScale);

            // Pre-allocate buffers
            getStackingBuffers(width, height, outWidth, outHeight, alignmentPoints.length);

            // Clear accumulators
            await clearAccumulators(outWidth, outHeight);

            // Store stacking context (including Bayer params for VNG demosaic)
            // width/height = crop size, srcWidth/srcHeight = full source size
            stackingContext = {
                width, height, srcWidth: srcWidth || width, srcHeight: srcHeight || height,
                outWidth, outHeight,
                alignmentPoints, patchSize, drizzleScale, refBrightness, minApQuality,
                bayerPattern, bitDepth, bayerScale
            };

            self.postMessage({ type: 'init-stacking-done', outWidth, outHeight });

        } catch (err) {
            self.postMessage({ type: 'init-stacking-error', error: err.message });
        }
    }

    // VNG demosaic reference frame - returns RGBA + grayscale for alignment
    // Used to ensure reference frame uses same demosaic as stacked frames
    // Accepts full-size frame + center for cropping
    if (type === 'vng-demosaic-ref') {
        const { bayerData, srcWidth, srcHeight, cropSize, center, bayerPattern, bitDepth, bayerScale = 1.0 } = e.data;

        try {
            if (!stackingReady) {
                stackingReady = await initStackingGPU();
                if (!stackingReady) {
                    throw new Error('Failed to initialize GPU stacking');
                }
            }

            // VNG demosaic + crop single frame
            const { rgbaData, grayData } = await demosaicVngCropBatch(
                [{ data: bayerData }],
                srcWidth, srcHeight,
                cropSize,
                [center],
                bayerPattern,
                bitDepth,
                bayerScale
            );

            // Transfer buffers
            self.postMessage({
                type: 'vng-demosaic-ref-done',
                rgbaBuffer: rgbaData.buffer,
                grayBuffer: grayData.buffer,
                width: cropSize,
                height: cropSize
            }, [rgbaData.buffer, grayData.buffer]);

        } catch (err) {
            self.postMessage({ type: 'vng-demosaic-ref-error', error: err.message });
        }
    }

    // Step 2: Stack a batch of frames with VNG demosaic + crop + template matching + accumulation
    // FULLY GPU-RESIDENT: RGBA and grayscale both stay on GPU, only small results read back
    // For raw Bayer: VNG demosaic → template match (GPU buffer) → warp + accumulate (GPU buffer)
    // Accepts:
    //   - frames[].data (Uint8Array or Uint16Array) - full-size raw Bayer
    //   - centers[] - per-frame crop centers {x, y}
    //   - refGrayData - reference frame grayscale for template matching
    //   - searchRadius, searchOffset, noiseRobustAlignment - template matching params
    if (type === 'stack-frame-batch') {
        const { frames, centers, frameWeights, refGrayData, searchRadius, searchOffset, noiseRobustAlignment } = e.data;
        const ctx = stackingContext;

        if (!ctx) {
            self.postMessage({ type: 'stack-frame-error', error: 'Stacking not initialized' });
            return;
        }

        try {
            // VNG demosaic + crop - BOTH RGBA and grayscale stay on GPU!
            // grayData is also returned for brightness calculation (small overhead)
            const { rgbaGpuBuffer, grayGpuBuffer, grayData, batchSize, cropSize } = await demosaicVngCropBatchGpu(
                frames.map(f => ({ data: f.data })),
                ctx.srcWidth, ctx.srcHeight,
                ctx.width,  // cropSize
                centers,
                ctx.bayerPattern,
                ctx.bitDepth,
                ctx.bayerScale
            );

            // Template matching directly from GPU buffer (zero-copy!)
            // Uses same GPU device as stacking
            const shifts = await matchTemplatesFromGpuBuffer(
                grayGpuBuffer,
                refGrayData,
                ctx.width,
                ctx.height,
                batchSize,
                ctx.alignmentPoints,
                ctx.patchSize,
                searchRadius,
                searchOffset
            );

            // Done with grayscale GPU buffer
            grayGpuBuffer.destroy();

            // Calculate brightness from CPU grayscale (needed for normalization)
            const pixelsPerFrame = ctx.width * ctx.height;
            const frameMetadata = frames.map((frame, i) => {
                const grayStart = i * pixelsPerFrame;
                const grayEnd = grayStart + pixelsPerFrame;
                const frameGray = grayData.subarray(grayStart, grayEnd);

                let sum = 0, count = 0;
                const step = 8;
                for (let y = 0; y < ctx.height; y += step) {
                    for (let x = 0; x < ctx.width; x += step) {
                        const val = frameGray[y * ctx.width + x];
                        if (val > 10) {
                            sum += val;
                            count++;
                        }
                    }
                }
                const frameBrightness = count > 0 ? sum / count : 1;
                const brightnessScale = ctx.refBrightness / frameBrightness;

                return {
                    sharpness: frame.sharpness,
                    brightnessScale,
                    frameWeight: frameWeights[i]
                };
            });

            // Warp and accumulate directly from GPU buffer (zero-copy!)
            await warpAndAccumulateFromGpuBuffer(
                rgbaGpuBuffer,
                batchSize,
                cropSize,
                frameMetadata,
                shifts,
                ctx.outWidth, ctx.outHeight,
                ctx.alignmentPoints,
                ctx.patchSize,
                ctx.drizzleScale,
                ctx.minApQuality
            );

            self.postMessage({ type: 'stack-batch-done', count: frames.length });

        } catch (err) {
            self.postMessage({ type: 'stack-frame-error', error: err.message });
        }
    }

    // Step 2b: Stack RGBA frames (already demosaiced - for MONO/image inputs)
    // Uses pre-computed shifts from template matching
    if (type === 'stack-frame-batch-rgba') {
        const { frames, shifts, frameWeights } = e.data;
        const ctx = stackingContext;

        if (!ctx) {
            self.postMessage({ type: 'stack-frame-error', error: 'Stacking not initialized' });
            return;
        }

        try {
            // Prepare all frames with brightness normalization
            const preparedFrames = frames.map((frame, i) => {
                const frameBrightness = calcMeanBrightness(frame.rgbaBuffer, ctx.width, ctx.height);
                const brightnessScale = ctx.refBrightness / frameBrightness;
                return {
                    rgbaBuffer: frame.rgbaBuffer,
                    brightnessScale,
                    frameWeight: frameWeights[i]
                };
            });

            // Warp and accumulate
            await warpAndAccumulateBatch(
                preparedFrames,
                shifts,
                ctx.width, ctx.height,
                ctx.outWidth, ctx.outHeight,
                ctx.alignmentPoints,
                ctx.patchSize,
                ctx.drizzleScale,
                ctx.minApQuality
            );

            self.postMessage({ type: 'stack-batch-done', count: frames.length });

        } catch (err) {
            self.postMessage({ type: 'stack-frame-error', error: err.message });
        }
    }

    // Step 3: Finalize stacking
    if (type === 'finalize-stacking') {
        const ctx = stackingContext;

        if (!ctx) {
            self.postMessage({ type: 'finalize-error', error: 'Stacking not initialized' });
            return;
        }

        try {
            // Read back accumulated results
            const { accumR, accumG, accumB, accumW } = await readAccumulators(ctx.outWidth, ctx.outHeight);

            // DEBUG: Full accumulator statistics
            const centerY = Math.floor(ctx.outHeight / 2);
            const centerX = Math.floor(ctx.outWidth / 2);
            const centerIdx = centerY * ctx.outWidth + centerX;

            // Find max values in accumulators
            let maxAccumR = 0, maxAccumW = 0, maxNormalized = 0;
            let sumW = 0, countW = 0;
            for (let i = 0; i < accumR.length; i++) {
                if (accumR[i] > maxAccumR) maxAccumR = accumR[i];
                if (accumW[i] > maxAccumW) maxAccumW = accumW[i];
                if (accumW[i] > 0) {
                    const norm = accumR[i] / accumW[i] / 255;
                    if (norm > maxNormalized) maxNormalized = norm;
                    sumW += accumW[i];
                    countW++;
                }
            }

            console.log(`[Finalize] Accumulator stats:`);
            console.log(`  - maxAccumR=${maxAccumR.toFixed(2)}, maxAccumW=${maxAccumW.toFixed(2)}, maxNormalized=${maxNormalized.toFixed(4)}`);
            console.log(`  - avgWeight=${(sumW/countW).toFixed(4)}, pixelsWithData=${countW}/${accumR.length}`);
            console.log(`  - Center (${centerX},${centerY}): accumR=${accumR[centerIdx].toFixed(2)}, accumW=${accumW[centerIdx].toFixed(4)}, normalized=${(accumR[centerIdx] / accumW[centerIdx] / 255).toFixed(4)}`);

            // Create final image
            const result = new Uint8ClampedArray(ctx.outWidth * ctx.outHeight * 4);
            // Also create Float32Array for 16-bit post-processing (RGBA, 0.0-1.0 range)
            const float32Data = new Float32Array(ctx.outWidth * ctx.outHeight * 4);

            for (let i = 0; i < ctx.outWidth * ctx.outHeight; i++) {
                const w = accumW[i];
                if (w > 0) {
                    // Normalized float values (0.0-1.0) - preserves full accumulator precision
                    const r = accumR[i] / w / 255.0;
                    const g = accumG[i] / w / 255.0;
                    const b = accumB[i] / w / 255.0;

                    // Float32 output (full precision)
                    float32Data[i * 4 + 0] = r;
                    float32Data[i * 4 + 1] = g;
                    float32Data[i * 4 + 2] = b;
                    float32Data[i * 4 + 3] = 1.0;

                    // 8-bit output (for preview/compatibility)
                    result[i * 4] = Math.min(255, Math.max(0, Math.round(r * 255)));
                    result[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(g * 255)));
                    result[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(b * 255)));
                } else {
                    float32Data[i * 4 + 0] = 0;
                    float32Data[i * 4 + 1] = 0;
                    float32Data[i * 4 + 2] = 0;
                    float32Data[i * 4 + 3] = 1.0;
                }
                result[i * 4 + 3] = 255;
            }

            // Convert to PNG
            const canvas = new OffscreenCanvas(ctx.outWidth, ctx.outHeight);
            const ctxCanvas = canvas.getContext('2d');
            ctxCanvas.putImageData(new ImageData(result, ctx.outWidth, ctx.outHeight), 0, 0);
            const blob = await canvas.convertToBlob({ type: 'image/png' });

            stackingContext = null;

            // Transfer float32Data buffer for zero-copy
            self.postMessage({
                type: 'stack-complete',
                blob,
                width: ctx.outWidth,
                height: ctx.outHeight,
                float32Buffer: float32Data.buffer
            }, [float32Data.buffer]);

        } catch (err) {
            self.postMessage({ type: 'finalize-error', error: err.message });
        }
    }

    // Cleanup buffers when done
    if (type === 'cleanup') {
        cleanupGPUBuffers();
        cleanupStackingBuffers();
        self.postMessage({ type: 'cleanup-done' });
    }
});

// Helper: calculate mean brightness (for normalization)
// Supports both Float32Array (0.0-1.0) and Uint8Array (0-255)
function calcMeanBrightness(rgbaBuffer, width, height) {
    const isFloat32 = rgbaBuffer instanceof Float32Array;
    const data = isFloat32 ? rgbaBuffer : new Uint8Array(rgbaBuffer);
    const blackCutoff = isFloat32 ? 10/255 : 10;
    let sum = 0;
    let count = 0;
    const step = 8;

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
    // Return in 0-255 scale for consistency with existing brightnessScale logic
    const avgBrightness = count > 0 ? sum / count : 1;
    return isFloat32 ? avgBrightness * 255 : avgBrightness;
}

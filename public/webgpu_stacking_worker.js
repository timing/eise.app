// Dedicated WebGPU worker - no OpenCV, just GPU compute
// Supports: template matching (single/batch) and GPU stacking

let isReady = false;
let stackingReady = false;

// Load WebGPU modules
self.importScripts('/webgpu_template_match.js');
self.importScripts('/webgpu_stacking.js');

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
        const { width, height, drizzleScale, alignmentPoints, patchSize, refBrightness, minApQuality = 0.3 } = e.data;

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

            // Store stacking context
            self.stackingContext = {
                width, height, outWidth, outHeight,
                alignmentPoints, patchSize, drizzleScale, refBrightness, minApQuality
            };

            self.postMessage({ type: 'init-stacking-done', outWidth, outHeight });

        } catch (err) {
            self.postMessage({ type: 'init-stacking-error', error: err.message });
        }
    }

    // Step 2: Stack a batch of frames (uses batched GPU dispatch for better throughput)
    if (type === 'stack-frame-batch') {
        const { frames, shifts, frameWeights } = e.data;
        const ctx = self.stackingContext;

        if (!ctx) {
            self.postMessage({ type: 'stack-frame-error', error: 'Stacking not initialized' });
            return;
        }

        try {
            // DEBUG: Log first frame's data with statistics
            if (frames.length > 0 && frames[0].rgbaBuffer) {
                const buf = frames[0].rgbaBuffer;
                const isFloat32 = buf instanceof Float32Array;
                const numPixels = buf.length / 4;
                const centerIdx = Math.floor(numPixels / 2) * 4;

                // Calculate statistics
                let maxR = 0, maxG = 0, maxB = 0, sumR = 0, count = 0;
                for (let i = 0; i < buf.length; i += 4) {
                    if (buf[i] > 0.01 || buf[i+1] > 0.01 || buf[i+2] > 0.01) {
                        sumR += buf[i];
                        count++;
                    }
                    if (buf[i] > maxR) maxR = buf[i];
                    if (buf[i+1] > maxG) maxG = buf[i+1];
                    if (buf[i+2] > maxB) maxB = buf[i+2];
                }
                const avgR = count > 0 ? sumR / count : 0;

                console.log(`[StackWorker] Frame stats: maxR=${maxR.toFixed(4)}, maxG=${maxG.toFixed(4)}, maxB=${maxB.toFixed(4)}, avgR=${avgR.toFixed(4)}`);
                console.log(`[StackWorker] Center pixel (idx ${centerIdx/4}): R=${buf[centerIdx].toFixed(4)}, G=${buf[centerIdx+1].toFixed(4)}, B=${buf[centerIdx+2].toFixed(4)}`);
            }

            // Prepare all frames with their brightness normalization
            const preparedFrames = frames.map((frame, i) => {
                const frameBrightness = calcMeanBrightness(frame.rgbaBuffer, ctx.width, ctx.height);
                const brightnessScale = ctx.refBrightness / frameBrightness;
                // DEBUG: Log brightness calculation for first frame
                if (i === 0) {
                    console.log(`[StackWorker] Brightness: frame=${frameBrightness.toFixed(4)}, ref=${ctx.refBrightness.toFixed(4)}, scale=${brightnessScale.toFixed(4)}`);
                }
                return {
                    rgbaBuffer: frame.rgbaBuffer,
                    brightnessScale,
                    frameWeight: frameWeights[i]
                };
            });

            // Use batched GPU dispatch (multiple frames per submit)
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
        const ctx = self.stackingContext;

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

            self.stackingContext = null;

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
        if (typeof cleanupGPUBuffers === 'function') {
            cleanupGPUBuffers();
        }
        if (typeof cleanupStackingBuffers === 'function') {
            cleanupStackingBuffers();
        }
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

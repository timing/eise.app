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

        const { requestId, refGrayData, frameGrayDatas, width, height, alignmentPoints, patchSize, searchRadius } = e.data;

        try {
            const allShifts = await matchTemplatesBatchGPU(
                refGrayData,
                frameGrayDatas,
                width,
                height,
                alignmentPoints,
                patchSize,
                searchRadius
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
        const { width, height, drizzleScale, alignmentPoints, patchSize, refBrightness } = e.data;

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
                alignmentPoints, patchSize, drizzleScale, refBrightness
            };

            self.postMessage({ type: 'init-stacking-done', outWidth, outHeight });

        } catch (err) {
            self.postMessage({ type: 'init-stacking-error', error: err.message });
        }
    }

    // Step 2: Stack a batch of frames
    if (type === 'stack-frame-batch') {
        const { frames, shifts, frameWeights } = e.data;
        const ctx = self.stackingContext;

        if (!ctx) {
            self.postMessage({ type: 'stack-frame-error', error: 'Stacking not initialized' });
            return;
        }

        try {
            for (let i = 0; i < frames.length; i++) {
                const frame = frames[i];

                // Calculate brightness normalization
                const frameBrightness = calcMeanBrightness(frame.rgbaBuffer, ctx.width, ctx.height);
                const brightnessScale = ctx.refBrightness / frameBrightness;

                // Warp and accumulate this frame
                await warpAndAccumulateFrame(
                    frame.rgbaBuffer,
                    ctx.width, ctx.height,
                    ctx.outWidth, ctx.outHeight,
                    ctx.alignmentPoints,
                    shifts[i],
                    ctx.patchSize,
                    ctx.drizzleScale,
                    frameWeights[i],
                    brightnessScale,
                    0, 0  // globalOffset disabled
                );
            }

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

            // Create final image
            const result = new Uint8ClampedArray(ctx.outWidth * ctx.outHeight * 4);

            for (let i = 0; i < ctx.outWidth * ctx.outHeight; i++) {
                const w = accumW[i];
                if (w > 0) {
                    result[i * 4] = Math.min(255, Math.max(0, Math.round(accumR[i] / w)));
                    result[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(accumG[i] / w)));
                    result[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(accumB[i] / w)));
                }
                result[i * 4 + 3] = 255;
            }

            // Convert to PNG
            const canvas = new OffscreenCanvas(ctx.outWidth, ctx.outHeight);
            const ctxCanvas = canvas.getContext('2d');
            ctxCanvas.putImageData(new ImageData(result, ctx.outWidth, ctx.outHeight), 0, 0);
            const blob = await canvas.convertToBlob({ type: 'image/png' });

            self.stackingContext = null;

            self.postMessage({
                type: 'stack-complete',
                blob,
                width: ctx.outWidth,
                height: ctx.outHeight
            });

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
function calcMeanBrightness(rgbaBuffer, width, height) {
    const data = new Uint8Array(rgbaBuffer);
    const blackCutoff = 10;
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
    return count > 0 ? sum / count : 1;
}

// WebGPU Batched Frame Analysis Worker
// Handles: Demosaic, Sharpness (Tenengrad), Circularity (Moments)

// Import WGSL shaders from separate module
import {
    demosaicBilinearShader,
    grayscaleShader,
    grayscaleFloat32Shader,
    tenengradShader,
    reductionShader,
    sharpnessFinalShader,
    blurShader,
    boundsShader,
    boundsReductionShader,
    centroidShader,
    momentsShader,
    momentsReductionShader,
    circularityFinalShader,
    demosaicGrayOnlyShader,
    offsetTenengradShader,
    rgbaCropShader,
    mono16CropFloat32Shader,
    demosaicCropShader,
    demosaicGrayShader
} from './gpu/shaders.js';

import {
    createBindGroup,
    addComputePass,
    imageWorkgroups,
    reductionWorkgroups,
    createPipeline,
    storageBuffer,
    uniformBuffer,
    readbackBuffer
} from './gpu/helpers.js';

console.log('webgpu_analyze_worker.js loaded (v4)');

let device = null;
let queue = null;
let isReady = false;
let deviceLost = false; // Track if GPU device was lost
let reinitializing = false; // Prevent concurrent reinit attempts
let reinitAttempts = 0;
const MAX_REINIT_ATTEMPTS = 3;

// Promise that rejects when GPU device is lost - raced against mapAsync to unblock hangs.
// Shared across all concurrent mapAsync calls for the same device lifetime.
// Reset on successful device recovery.
let deviceLostSignal = null;
let fireDeviceLost = null;
function resetDeviceLostSignal() {
    const signal = new Promise((_, reject) => { fireDeviceLost = reject; });
    signal.catch(() => {}); // Prevent unhandled rejection warning
    deviceLostSignal = signal;
}
resetDeviceLostSignal();

// Concurrency control for detectCropAnalyzeBatch (limit to match double-buffering)
const MAX_CONCURRENT_BATCHES = 2;
let activeBatchCount = 0;
let batchWaiters = [];

// Calculate circularity and tilt angle from image moments using eigenvalue ratio
// Returns object { circularity: 0-1 where 1 = perfect circle, tiltAngle: radians }
function calculateCircularityFromMoments(m00, m10, m01, m20, m11, m02) {
    if (m00 <= 0) return { circularity: 0, tiltAngle: 0 };

    const cx = m10 / m00;
    const cy = m01 / m00;

    // Central moments
    const mu20 = m20 / m00 - cx * cx;
    const mu02 = m02 / m00 - cy * cy;
    const mu11 = m11 / m00 - cx * cy;

    // Eigenvalues of covariance matrix
    const trace = mu20 + mu02;
    const det = mu20 * mu02 - mu11 * mu11;
    const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * det));
    const lambda1 = (trace + discriminant) / 2;
    const lambda2 = (trace - discriminant) / 2;

    // Tilt angle from principal axis orientation (radians)
    const tiltAngle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);

    // Circularity = ratio of eigenvalues (1 = perfect circle)
    if (lambda1 > 0) {
        return {
            circularity: Math.min(lambda2, lambda1) / Math.max(lambda2, lambda1),
            tiltAngle
        };
    }
    return { circularity: 0, tiltAngle };
}

// Forward declaration - will be set after init() is defined
let reinitializeGpu = null;

// Helper function to safely map GPU buffer with device lost detection and auto-recovery
async function safeMapAsync(buffer, mode) {
    if (deviceLost && !reinitializing) {
        // Try to recover
        if (reinitializeGpu && reinitAttempts < MAX_REINIT_ATTEMPTS) {
            console.log('GPU device lost, attempting auto-recovery...');
            const recovered = await reinitializeGpu();
            if (!recovered) {
                throw new Error('GPU device was lost and could not be recovered. Please reload the page.');
            }
            // Buffer is now invalid after reinit, caller needs to retry the operation
            throw new Error('GPU_DEVICE_RECOVERED');
        }
        throw new Error('GPU device was lost. Please reload the page to continue.');
    }
    try {
        // Race mapAsync against device-lost signal to unblock if GPU hangs on device loss
        await Promise.race([
            buffer.mapAsync(mode),
            deviceLostSignal
        ]);
    } catch (err) {
        // Detect device loss via any known error message shape.
        // "invalid due to a previous error" / "Invalid Buffer" appear on drivers where the
        // device-lost event never fired but the buffer was already invalidated by a prior GPU error.
        const msg = err && err.message || '';
        const looksLikeDeviceLost =
            msg.includes('Instance reference') ||
            (msg.includes('Device') && msg.includes('lost')) ||
            msg.includes('invalid due to a previous error') ||
            msg.includes('Invalid Buffer');
        if (looksLikeDeviceLost) {
            deviceLost = true;
            device = null;
            queue = null;
            isReady = false;

            // Try to recover
            if (reinitializeGpu && reinitAttempts < MAX_REINIT_ATTEMPTS) {
                console.log('GPU device lost during buffer operation, attempting auto-recovery...');
                const recovered = await reinitializeGpu();
                if (recovered) {
                    throw new Error('GPU_DEVICE_RECOVERED');
                }
            }
            throw new Error('GPU device was lost during buffer operation. Please reload the page.');
        }
        throw err;
    }
}

// Acquire a batch slot (waits if max concurrent batches reached)
async function acquireBatchSlot() {
    if (activeBatchCount < MAX_CONCURRENT_BATCHES) {
        activeBatchCount++;
        return;
    }
    // Max batches in flight - wait for one to complete
    return new Promise(resolve => {
        batchWaiters.push(resolve);
    });
}

// Release a batch slot
function releaseBatchSlot() {
    activeBatchCount--;
    // If someone is waiting, let them proceed
    if (batchWaiters.length > 0 && activeBatchCount < MAX_CONCURRENT_BATCHES) {
        activeBatchCount++;
        const resolve = batchWaiters.shift();
        resolve();
    }
}

// Separate semaphore for analyzeBatch (only allows 1 at a time since buffers aren't double-buffered)
let analyzeInProgress = false;
let analyzeWaiters = [];

async function acquireAnalyzeSlot() {
    if (!analyzeInProgress) {
        analyzeInProgress = true;
        return;
    }
    return new Promise(resolve => {
        analyzeWaiters.push(resolve);
    });
}

function releaseAnalyzeSlot() {
    if (analyzeWaiters.length > 0) {
        const resolve = analyzeWaiters.shift();
        resolve();
    } else {
        analyzeInProgress = false;
    }
}

// Wait for all batches to complete (for cleanup)
function waitForAllBatchesComplete() {
    if (activeBatchCount === 0) {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        // Add a special waiter that fires when count reaches 0
        const checkComplete = () => {
            if (activeBatchCount === 0) {
                resolve();
            } else {
                batchWaiters.push(checkComplete);
            }
        };
        batchWaiters.push(checkComplete);
    });
}

// ===== GPU TIMING INSTRUMENTATION =====
// Tracks time between GPU submissions to identify CPU bottlenecks
let gpuTimingEnabled = true;  // Set to false to disable logging
let lastGpuSubmit = 0;
let lastGpuPhase = '';
let gpuTimingStats = {
    submits: [],
    phases: {}
};

function logGpuSubmit(label) {
    if (!gpuTimingEnabled) return;
    const now = performance.now();
    if (lastGpuSubmit > 0) {
        const gap = now - lastGpuSubmit;
        console.log(`[GPU] ${label}: ${gap.toFixed(1)}ms since "${lastGpuPhase}"`);
        gpuTimingStats.submits.push({ from: lastGpuPhase, to: label, gap });
    }
    lastGpuSubmit = now;
    lastGpuPhase = label;
}

function logGpuPhase(phase, duration) {
    if (!gpuTimingEnabled) return;
    if (!gpuTimingStats.phases[phase]) {
        gpuTimingStats.phases[phase] = { count: 0, total: 0, max: 0 };
    }
    const stats = gpuTimingStats.phases[phase];
    stats.count++;
    stats.total += duration;
    stats.max = Math.max(stats.max, duration);
}

function printGpuTimingSummary() {
    if (!gpuTimingEnabled) return;
    console.log('\n===== GPU TIMING SUMMARY =====');

    // Analyze gaps (CPU bottlenecks)
    if (gpuTimingStats.submits.length > 0) {
        const gaps = gpuTimingStats.submits.map(s => s.gap);
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const maxGap = Math.max(...gaps);
        console.log(`Submit gaps: avg=${avgGap.toFixed(1)}ms, max=${maxGap.toFixed(1)}ms, count=${gaps.length}`);

        // Show worst offenders
        const sorted = [...gpuTimingStats.submits].sort((a, b) => b.gap - a.gap).slice(0, 3);
        console.log('Longest gaps:');
        sorted.forEach(s => console.log(`  ${s.gap.toFixed(1)}ms: ${s.from} → ${s.to}`));
    }

    // Show phase durations
    console.log('\nPhase durations:');
    for (const [phase, stats] of Object.entries(gpuTimingStats.phases)) {
        console.log(`  ${phase}: avg=${(stats.total/stats.count).toFixed(1)}ms, max=${stats.max.toFixed(1)}ms, count=${stats.count}`);
    }
    console.log('==============================\n');

    // Reset for next run
    gpuTimingStats = { submits: [], phases: {} };
    lastGpuSubmit = 0;
    lastGpuPhase = '';
}

// Helper to detect bit depth from frame data (fast check, no processing)
function detectBitDepth(frames) {
    const data = frames[0]?.data;
    const is16bit = data instanceof Uint16Array;
    // Debug logging for 16-bit detection issues
    if (data && !is16bit) {
        console.log(`[GPU] detectBitDepth: data type=${data.constructor?.name}, length=${data.length || data.byteLength}, instanceof Uint16Array=${is16bit}`);
    }
    return is16bit ? 16 : 8;
}

// Helper function to prepare Bayer data for GPU upload with auto-stretch for 16-bit
let prepareBayerDataTime = 0;
let prepareBayerDataCount = 0;

function prepareBayerData(frames, pixelCount, skipStretch = false) {
    const t0 = performance.now();
    const batchSize = frames.length;
    const is16bit = frames[0]?.data instanceof Uint16Array;

    let bayerData;

    if (is16bit) {
        // 16-bit: pack 2 pixels per u32 for fast copying
        const totalPixels = batchSize * pixelCount;
        const u32Count = Math.ceil(totalPixels / 2);
        bayerData = new Uint32Array(u32Count);

        // Calculate stretch scale (GPU will apply it during demosaic)
        // Conservative: only stretch if data is in lower half of 16-bit range
        let scale16bit = 1.0;
        if (!skipStretch) {
            const sampleSize = Math.min(10000, frames[0].data.length);
            const sample = [];
            for (let i = 0; i < batchSize && sample.length < sampleSize; i++) {
                const data = frames[i].data;
                const step = Math.max(1, Math.floor(data.length / (sampleSize / batchSize)));
                for (let j = 0; j < data.length && sample.length < sampleSize; j += step) {
                    sample.push(data[j]);
                }
            }
            sample.sort((a, b) => a - b);
            const p99 = sample[Math.floor(sample.length * 0.99)];
            // Conservative stretch: only if data is in lower half of 16-bit range, cap at 2x
            if (p99 > 0 && p99 < 32768) {
                scale16bit = Math.min(32768 / p99, 2.0);
            }
            // Debug: log stretch for first batch
            if (batchSize > 0) {
                const effectiveBits = p99 > 0 ? Math.ceil(Math.log2(p99 + 1)) : 0;
                console.log(`[GPU] 16-bit analyze stretch: p99=${p99}, effectiveBits=${effectiveBits}, scale=${scale16bit.toFixed(2)}`);
            }
        }

        // Always use fast path - GPU will apply scale
        const u16View = new Uint16Array(bayerData.buffer);
        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const u16Offset = i * pixelCount;
            u16View.set(frame.data, u16Offset);
        }

        prepareBayerDataTime += performance.now() - t0;
        prepareBayerDataCount++;
        if (prepareBayerDataCount % 10 === 0) {
            console.log(`[prepareBayerData] avg: ${(prepareBayerDataTime/prepareBayerDataCount).toFixed(1)}ms`);
        }
        return { data: bayerData, bitDepth: 16, scale: scale16bit };
    } else {
        // 8-bit: pack 4 pixels per u32, use fast TypedArray.set()
        const totalPixels = batchSize * pixelCount;
        const u32Count = Math.ceil(totalPixels / 4);
        bayerData = new Uint32Array(u32Count);

        // Create a Uint8Array view of the Uint32Array buffer for fast copying
        const byteView = new Uint8Array(bayerData.buffer);

        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const byteOffset = i * pixelCount;
            // Fast native copy using TypedArray.set()
            byteView.set(frame.data, byteOffset);
        }

        prepareBayerDataTime += performance.now() - t0;
        prepareBayerDataCount++;
        if (prepareBayerDataCount % 10 === 0) {
            console.log(`[prepareBayerData] avg: ${(prepareBayerDataTime/prepareBayerDataCount).toFixed(1)}ms`);
        }
        return { data: bayerData, bitDepth: 8, scale: 1.0 };
    }
}

// Pipelines
let demosaicPipeline = null;
let demosaicCropPipeline = null;
let demosaicGrayPipeline = null;  // Fused demosaic + grayscale
let demosaicGrayOnlyPipeline = null;  // Grayscale-only demosaic (fast, for analysis)
let rgbaCropPipeline = null;
let mono16CropFloat32Pipeline = null;  // 16-bit mono crop → Float32 RGBA output
let grayscalePipeline = null;
let grayscaleFloat32Pipeline = null;  // Grayscale for 16-bit Float32 RGBA input
let tenengradPipeline = null;
let offsetTenengradPipeline = null;  // Reads from full-frame with per-frame offsets (no crop needed)
let reductionPipeline = null;
let momentsPipeline = null;
let momentsReductionPipeline = null;
let circularityFinalPipeline = null;
let boundsPipeline = null;
let boundsReductionPipeline = null;
let centroidPipeline = null;
let blurPipeline = null;  // Gaussian blur for noise reduction before bounds detection
let sharpnessFinalPipeline = null;  // Final reduction: workgroup sums → 2 floats per frame

// Cached buffers for reuse across batches
let cachedAnalyzeBuffers = null;
let cachedAnalyzeConfig = null;

// Pipelined upload state - allows uploading next batch while GPU processes current
let pipelinedUpload = {
    ready: false,           // True if data is pre-uploaded in buffer
    bufferIndex: 0,         // Which buffer index has the pre-uploaded data (cycles 0 to N-1)
    bayerData: null,        // The prepared Bayer data (already packed)
    scale: 1.0,             // Scale factor for the pre-uploaded data
    batchSize: 0,           // Batch size of pre-uploaded data
};

// ============================================================
// INITIALIZATION
// ============================================================

async function init() {
    if (!navigator.gpu) {
        throw new Error('WebGPU not available');
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
        throw new Error('No WebGPU adapter found');
    }

    // Request higher buffer size limit for large frames/batches
    // Default is 256MB, but large SER files may need more
    const adapterLimits = adapter.limits;
    device = await adapter.requestDevice({
        requiredLimits: {
            maxBufferSize: adapterLimits.maxBufferSize,  // Use adapter's max (typically 4GB)
            maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize
        }
    });
    queue = device.queue;

    // Surface WebGPU validation errors to the main thread. Without this, allocations
    // that exceed maxBufferSize (or any other validation failure) return an invalid
    // buffer silently — downstream dispatches then no-op and readbacks come back as
    // zeros. See Sentry EISE-M2: on a Mac with maxBufferSize=2GB a 50-frame 1080p
    // batch requested a 2.98GB moments buffer, so every frame was reported as a
    // 1px "planet" at (0, 0).
    device.onuncapturederror = (event) => {
        const msg = event.error?.message || String(event.error);
        console.error('[GPU] Uncaptured WebGPU error:', msg);
        self.postMessage({ type: 'log', level: 'error', message: `WebGPU validation error: ${msg}` });
    };

    // Handle GPU device lost (tab suspended, driver crash, etc.)
    device.lost.then(async (info) => {
        console.error('WebGPU device lost:', info.message);
        deviceLost = true;
        device = null;
        queue = null;
        isReady = false;

        // Unblock any in-flight mapAsync calls that may be hung
        if (fireDeviceLost) {
            fireDeviceLost(new Error('GPU device was lost during operation. Please reload the page.'));
        }

        // Attempt automatic recovery
        if (reinitAttempts < MAX_REINIT_ATTEMPTS) {
            console.log(`Attempting GPU recovery (attempt ${reinitAttempts + 1}/${MAX_REINIT_ATTEMPTS})...`);
            self.postMessage({ type: 'device-lost-recovering', message: info.message });

            // Wait a moment for the GPU to stabilize
            await new Promise(resolve => setTimeout(resolve, 500));

            try {
                reinitializing = true;
                reinitAttempts++;
                await init();
                console.log('GPU device recovered successfully');
                self.postMessage({ type: 'device-recovered' });
            } catch (err) {
                console.error('GPU recovery failed:', err.message);
                const message = `GPU device lost and recovery failed: ${err.message}. Please reload the page.`;
                self.postMessage({ type: 'log', level: 'error', message });
                self.postMessage({ type: 'error', error: message });
            } finally {
                reinitializing = false;
            }
        } else {
            const message = `GPU device lost: ${info.message}. Max recovery attempts reached. Please reload the page.`;
            self.postMessage({ type: 'log', level: 'error', message });
            self.postMessage({ type: 'error', error: message });
        }
    });

    // Create all compute pipelines
    demosaicPipeline = await createPipeline(device, demosaicBilinearShader, 'demosaic');
    demosaicCropPipeline = await createPipeline(device, demosaicCropShader, 'demosaicCrop');
    demosaicGrayPipeline = await createPipeline(device, demosaicGrayShader, 'demosaicGray');
    demosaicGrayOnlyPipeline = await createPipeline(device, demosaicGrayOnlyShader, 'demosaicGrayOnly');
    rgbaCropPipeline = await createPipeline(device, rgbaCropShader, 'rgbaCrop');
    mono16CropFloat32Pipeline = await createPipeline(device, mono16CropFloat32Shader, 'mono16CropFloat32');
    grayscalePipeline = await createPipeline(device, grayscaleShader, 'grayscale');
    grayscaleFloat32Pipeline = await createPipeline(device, grayscaleFloat32Shader, 'grayscaleFloat32');
    tenengradPipeline = await createPipeline(device, tenengradShader, 'tenengrad');
    offsetTenengradPipeline = await createPipeline(device, offsetTenengradShader, 'offsetTenengrad');
    reductionPipeline = await createPipeline(device, reductionShader, 'reduction');
    momentsPipeline = await createPipeline(device, momentsShader, 'moments');
    momentsReductionPipeline = await createPipeline(device, momentsReductionShader, 'momentsReduction');
    circularityFinalPipeline = await createPipeline(device, circularityFinalShader, 'circularityFinal');
    boundsPipeline = await createPipeline(device, boundsShader, 'bounds');
    boundsReductionPipeline = await createPipeline(device, boundsReductionShader, 'boundsReduction');
    centroidPipeline = await createPipeline(device, centroidShader, 'centroid');
    blurPipeline = await createPipeline(device, blurShader, 'blur');
    sharpnessFinalPipeline = await createPipeline(device, sharpnessFinalShader, 'sharpnessFinal');

    isReady = true;
    deviceLost = false;
    resetDeviceLostSignal(); // Fresh signal for the new device
    console.log('WebGPU analyze worker initialized');
}

// Set up the reinitialize function for auto-recovery
reinitializeGpu = async function() {
    if (reinitializing) return false;
    reinitializing = true;
    try {
        await init();
        return true;
    } catch (err) {
        console.error('GPU reinitialization failed:', err);
        return false;
    } finally {
        reinitializing = false;
    }
};

// ============================================================
// ANALYSIS FUNCTIONS
// ============================================================

/**
 * Get or create cached buffers for frame analysis
 * Reuses buffers across batches to avoid allocation overhead
 */
/**
 * Get or create cached buffers for frame analysis.
 *
 * IMPORTANT: 16-bit SER files require 4x larger RGBA buffers.
 *
 * Why we preserve 16-bit through demosaic:
 * - 8-bit SER: demosaic outputs 8-bit packed RGBA (4 bytes/pixel) → stack in Float32 → 16-bit output
 * - 16-bit SER: demosaic outputs Float32 RGBA (16 bytes/pixel) → stack in Float32 → 16-bit output
 *
 * If we converted 16-bit to 8-bit at demosaic, we'd lose precision BEFORE stacking,
 * which defeats the purpose of capturing in 16-bit. The stacker accumulates in Float32,
 * so feeding it Float32 data preserves the full dynamic range from 16-bit sensors.
 *
 * @param {number} bitDepth - 8 or 16, determines RGBA buffer size
 */
/**
 * Calculate total GPU buffer bytes needed for a single frame at given dimensions/bitDepth.
 * Used by both the memory check and getAnalyzeBuffers to stay in sync.
 */
function calcPerFrameBufferBytes(width, height, bitDepth = 8) {
    const pixelCount = width * height;
    const numWorkgroups = Math.ceil(pixelCount / 256);
    const rgbaBpp = bitDepth === 16 ? 16 : 4;
    return (
        pixelCount * 4 +                    // pixelBufferSize (input)
        pixelCount * rgbaBpp +               // rgbaBufferSize
        pixelCount * 6 * 4 +                // momentsPixelSize
        pixelCount * 4 * 4 +                // boundsPixelSize
        numWorkgroups * 2 * 4 +             // reductionSize
        numWorkgroups * 6 * 4 +             // momentsReductionSize
        numWorkgroups * 4 * 4               // boundsReductionSize
    );
}

/**
 * Per-frame contribution to the LARGEST single buffer. maxBufferSize is a
 * per-buffer limit in WebGPU (not a total-memory budget), so batch sizing
 * should be constrained by the biggest buffer, not the sum. Reduction buffers
 * scale with numWorkgroups (not pixelCount) and are always tiny — skipped here.
 */
function calcLargestPerFrameBufferBytes(width, height, bitDepth = 8) {
    const pixelCount = width * height;
    const rgbaBpp = bitDepth === 16 ? 16 : 4;
    return pixelCount * Math.max(
        4,          // pixelBuffer
        rgbaBpp,    // rgbaBuffer (4 or 16 B/px)
        6 * 4,      // momentsPixelBuffer — usually the largest at 24 B/px
        4 * 4       // boundsPixelBuffer
    );
}

function getAnalyzeBuffers(batchSize, width, height, bitDepth = 8) {
    const pixelCount = width * height;
    const numWorkgroups = Math.ceil(pixelCount / 256);
    const rgbaBytesPerPixel = bitDepth === 16 ? 16 : 4;

    const requiredSizes = {
        batchSize,
        pixelCount,
        numWorkgroups,
        bitDepth,
        paramsSize: 16,
        pixelBufferSize: batchSize * pixelCount * 4,
        rgbaBufferSize: batchSize * pixelCount * rgbaBytesPerPixel,
        momentsPixelSize: batchSize * pixelCount * 6 * 4,
        boundsPixelSize: batchSize * pixelCount * 4 * 4,
        reductionSize: batchSize * numWorkgroups * 2 * 4,
        momentsReductionSize: batchSize * numWorkgroups * 6 * 4,
        boundsReductionSize: batchSize * numWorkgroups * 4 * 4,
        // 4 floats/frame for circularity (circ, cx, cy, tiltAngle). Untracked in
        // the cache-hit check previously — a later call with a larger batchSize
        // would reuse a too-small buffer and the copyBufferToBuffer readback
        // overflows (Sentry EISE-MS).
        circularitySize: batchSize * 4 * 4
    };

    // Check if we can reuse cached buffers
    // Note: rgbaBufferSize check ensures we have enough space for 16-bit Float32 output
    if (cachedAnalyzeBuffers && cachedAnalyzeConfig &&
        cachedAnalyzeConfig.pixelBufferSize >= requiredSizes.pixelBufferSize &&
        cachedAnalyzeConfig.rgbaBufferSize >= requiredSizes.rgbaBufferSize &&
        cachedAnalyzeConfig.momentsPixelSize >= requiredSizes.momentsPixelSize &&
        cachedAnalyzeConfig.boundsPixelSize >= requiredSizes.boundsPixelSize &&
        cachedAnalyzeConfig.reductionSize >= requiredSizes.reductionSize &&
        cachedAnalyzeConfig.momentsReductionSize >= requiredSizes.momentsReductionSize &&
        cachedAnalyzeConfig.boundsReductionSize >= requiredSizes.boundsReductionSize &&
        cachedAnalyzeConfig.circularitySize >= requiredSizes.circularitySize) {
        // Update config with current batch params
        cachedAnalyzeConfig.batchSize = batchSize;
        cachedAnalyzeConfig.pixelCount = pixelCount;
        cachedAnalyzeConfig.numWorkgroups = numWorkgroups;
        cachedAnalyzeConfig.bitDepth = bitDepth;
        return cachedAnalyzeBuffers;
    }

    // Destroy old buffers if they exist
    if (cachedAnalyzeBuffers) {
        Object.values(cachedAnalyzeBuffers).flat().forEach(buf => {
            if (buf && buf.destroy) buf.destroy();
        });
    }

    // Create new buffers with some headroom for slight size variations
    const headroom = 1.2; // 20% extra
    // Helper to align buffer sizes to multiple of 4 (WebGPU requirement)
    const align4 = (size) => Math.ceil(size / 4) * 4;
    const pixelBufferSize = align4(Math.ceil(requiredSizes.pixelBufferSize * headroom));
    const rgbaBufferSize = align4(Math.ceil(requiredSizes.rgbaBufferSize * headroom));  // 4x larger for 16-bit
    const momentsPixelSize = align4(Math.ceil(requiredSizes.momentsPixelSize * headroom));
    const boundsPixelSize = align4(Math.ceil(requiredSizes.boundsPixelSize * headroom));
    const reductionSize = align4(Math.ceil(requiredSizes.reductionSize * headroom));
    const momentsReductionSize = align4(Math.ceil(requiredSizes.momentsReductionSize * headroom));
    const boundsReductionSize = align4(Math.ceil(requiredSizes.boundsReductionSize * headroom));
    const circularitySize = align4(Math.ceil(requiredSizes.circularitySize * headroom));

    // Fail loudly if any single buffer would exceed maxBufferSize. WebGPU's own
    // failure mode is silent (invalid buffer + uncaptured validation error), which
    // masqueraded as "planet detected as 1px at (0,0)" — see Sentry EISE-M2.
    // Callers should use 'get-max-batch-size' to size batches; this is the guardrail.
    const maxBufferSize = device.limits.maxBufferSize;
    const oversized = [
        ['momentsPixelBuffer', momentsPixelSize],
        ['boundsPixelBuffer', boundsPixelSize],
        ['rgbaBuffer', rgbaBufferSize],
        ['pixelBuffer', pixelBufferSize]
    ].find(([, size]) => size > maxBufferSize);
    if (oversized) {
        const [name, size] = oversized;
        throw new Error(
            `GPU buffer '${name}' would be ${(size / 1024 / 1024).toFixed(0)}MB, ` +
            `exceeds device maxBufferSize ${(maxBufferSize / 1024 / 1024).toFixed(0)}MB ` +
            `(batchSize=${batchSize}, ${width}x${height}, bitDepth=${bitDepth}). ` +
            `Query 'get-max-batch-size' before calling analyzeBatch.`
        );
    }

    // Helper to create array of N identical buffers for concurrent batch support
    const createBufferArray = (size, usage) =>
        Array.from({ length: MAX_CONCURRENT_BATCHES }, () =>
            device.createBuffer({ size, usage })
        );

    cachedAnalyzeBuffers = {
        paramsBuffer: uniformBuffer(device, 32),  // 8 u32 values for demosaic params
        inputBuffers: createBufferArray(pixelBufferSize, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        // RGBA buffer: 4x larger for 16-bit to hold Float32 output (preserves precision for stacking)
        rgbaBuffer: storageBuffer(device, rgbaBufferSize, { copySrc: true, copyDst: true }),
        grayBuffer: storageBuffer(device, pixelBufferSize, { copySrc: true, copyDst: true }),
        grayReadback: readbackBuffer(device, pixelBufferSize),
        // Blurred grayscale for noise reduction before bounds detection
        blurredGrayBuffer: storageBuffer(device, pixelBufferSize),
        tenengradBuffer: storageBuffer(device, pixelBufferSize),
        laplacianBuffer: storageBuffer(device, pixelBufferSize),
        reductionBuffer: storageBuffer(device, reductionSize, { copySrc: true }),
        momentsBuffer: storageBuffer(device, momentsPixelSize),
        momentsReductionBuffer: storageBuffer(device, momentsReductionSize, { copySrc: true }),
        reductionParamsBuffer: uniformBuffer(device, 16),
        momentsParamsBuffer: uniformBuffer(device, 16),
        reductionReadback: readbackBuffer(device, reductionSize),
        momentsReadback: readbackBuffer(device, momentsReductionSize),
        // Circularity + centroid + tilt: computed on GPU from moments (4 floats per frame: circ, cx, cy, tiltAngle)
        circularityBuffer: storageBuffer(device, circularitySize, { copySrc: true }),
        circularityParamsBuffer: uniformBuffer(device, 16),
        circularityReadback: readbackBuffer(device, circularitySize),
        // RGBA readback: matches rgbaBuffer size for 16-bit Float32 support
        rgbaReadback: readbackBuffer(device, rgbaBufferSize),
        boundsBuffer: storageBuffer(device, boundsPixelSize),
        boundsReductionBuffer: storageBuffer(device, boundsReductionSize, { copySrc: true }),
        boundsParamsBuffer: uniformBuffer(device, 16),
        boundsReadback: readbackBuffer(device, boundsReductionSize)
    };

    cachedAnalyzeConfig = {
        batchSize,
        pixelCount,
        numWorkgroups,
        bitDepth,
        pixelBufferSize,
        rgbaBufferSize,  // Tracks 16-bit vs 8-bit output size
        momentsPixelSize,
        boundsPixelSize,
        reductionSize,
        momentsReductionSize,
        boundsReductionSize,
        circularitySize
    };

    return cachedAnalyzeBuffers;
}

/**
 * Cleanup cached analysis buffers
 */
function cleanupAnalyzeBuffers() {
    if (cachedAnalyzeBuffers) {
        Object.values(cachedAnalyzeBuffers).forEach(buf => {
            if (buf && buf.destroy) buf.destroy();
        });
        cachedAnalyzeBuffers = null;
        cachedAnalyzeConfig = null;
    }
}

async function analyzeBatch(frames, width, height, bayerPattern, threshold, metadataOnly = false, grayOnly = false) {
    if (!device || !queue) {
        throw new Error('WebGPU not initialized or device lost');
    }
    const batchSize = frames.length;
    const pixelCount = width * height;
    const numWorkgroups = Math.ceil(pixelCount / 256);

    // Determine if we need demosaic (bayerPattern >= 0 means Bayer data)
    const needsDemosaic = bayerPattern >= 0;

    // Memory safeguard using actual buffer sizes (single source of truth: calcPerFrameBufferBytes)
    // No artificial memory limit — the GPU will throw from createBuffer() if it truly can't allocate.
    // Callers should use get-max-batch-size to pick sensible batch sizes, but we don't block here.

    // Detect bit depth early so we allocate correct buffer sizes
    // 16-bit SER: needs 4x larger RGBA buffer for Float32 output (preserves precision)
    const bitDepth = needsDemosaic ? detectBitDepth(frames) : 8;
    console.log(`[GPU] analyzeBatch: bitDepth=${bitDepth}, batchSize=${batchSize}, needsDemosaic=${needsDemosaic}`);

    // Wait for analyze slot BEFORE getting buffers (only 1 analyzeBatch at a time since buffers aren't double-buffered)
    await acquireAnalyzeSlot();

    try {

    // Get cached buffers (creates if needed, reuses if possible)
    const buffers = getAnalyzeBuffers(batchSize, width, height, bitDepth);
    let grayAlreadyComputed = false;

    if (needsDemosaic) {
        // Upload Bayer data to input buffer (auto-stretch for 16-bit to handle dark data)
        const { data: bayerData, scale } = prepareBayerData(frames, pixelCount, false);
        queue.writeBuffer(buffers.inputBuffers[0], 0, bayerData);

        // Demosaic params (mixed u32/f32 for scale)
        // Note: bitDepth already determined above via detectBitDepth()
        // Always use bilinear (useVng=0) for analysis - VNG is done in stacking worker
        const paramsData = new ArrayBuffer(32);
        new Uint32Array(paramsData).set([width, height, batchSize, bayerPattern, 0, bitDepth, 0, 0]);
        new Float32Array(paramsData)[6] = scale;
        queue.writeBuffer(buffers.paramsBuffer, 0, paramsData);

        if (grayOnly) {
            // Grayscale-only demosaic (fast, no RGBA output)
            const demosaicGrayOnlyBindGroup = createBindGroup(device, demosaicGrayOnlyPipeline, [
                buffers.paramsBuffer, buffers.inputBuffers[0], buffers.grayBuffer
            ]);
            const encoder = device.createCommandEncoder();
            addComputePass(encoder, demosaicGrayOnlyPipeline, demosaicGrayOnlyBindGroup, imageWorkgroups(width, height, batchSize));
            logGpuSubmit('analyzeBatch:demosaic-grayOnly');
            queue.submit([encoder.finish()]);
        } else {
            // Run fused demosaic + grayscale (outputs both RGBA and grayscale in one pass)
            const demosaicGrayBindGroup = createBindGroup(device, demosaicGrayPipeline, [
                buffers.paramsBuffer, buffers.inputBuffers[0], buffers.rgbaBuffer, buffers.grayBuffer
            ]);
            const encoder = device.createCommandEncoder();
            addComputePass(encoder, demosaicGrayPipeline, demosaicGrayBindGroup, imageWorkgroups(width, height, batchSize));
            logGpuSubmit('analyzeBatch:demosaic+gray');
            queue.submit([encoder.finish()]);
        }
        grayAlreadyComputed = true;
    } else {
        // Input is RGBA (4 bytes/pixel), 8-bit mono (1 byte/pixel), or 16-bit mono (2 bytes/pixel)
        // Check first frame to determine format
        const firstFrame = frames[0];
        const isMono16 = firstFrame.data instanceof Uint16Array;
        let firstSrc;
        if (!isMono16) {
            if (firstFrame.data instanceof Uint8Array || firstFrame.data instanceof Uint8ClampedArray) {
                firstSrc = firstFrame.data;
            } else if (firstFrame.data instanceof ArrayBuffer) {
                firstSrc = new Uint8Array(firstFrame.data);
            } else if (firstFrame.data.buffer instanceof ArrayBuffer) {
                firstSrc = new Uint8Array(firstFrame.data.buffer, firstFrame.data.byteOffset, firstFrame.data.byteLength);
            }
        }
        const isMono8 = !isMono16 && firstSrc && firstSrc.length === pixelCount;
        const isMonoInput = isMono8 || isMono16;

        if (isMonoInput) {
            // Mono grayscale input - expand to Uint8 RGBA for GPU processing
            // Note: 16-bit mono is scaled to 8-bit here. The GPU shaders (grayscale, crop)
            // only support packed u32 (8-bit RGBA) for non-Bayer input. Full 16-bit precision
            // for mono would require Float32 RGBA shaders (like the Bayer demosaic path has).

            // For 16-bit mono, find max value for auto-stretch scaling
            let scale16 = 1;
            if (isMono16) {
                let maxVal = 0;
                for (let i = 0; i < batchSize; i++) {
                    const src16 = frames[i].data;
                    const step = Math.max(1, Math.floor(pixelCount / 5000));
                    for (let j = 0; j < pixelCount; j += step) {
                        if (src16[j] > maxVal) maxVal = src16[j];
                    }
                }
                scale16 = maxVal > 0 ? 255 / maxVal : 1;
            }

            for (let i = 0; i < batchSize; i++) {
                const frame = frames[i];
                const rgba = new Uint8Array(pixelCount * 4);

                if (isMono16) {
                    const src16 = frame.data;
                    for (let j = 0; j < pixelCount; j++) {
                        const v = Math.min(255, Math.round(src16[j] * scale16));
                        rgba[j * 4] = v;
                        rgba[j * 4 + 1] = v;
                        rgba[j * 4 + 2] = v;
                        rgba[j * 4 + 3] = 255;
                    }
                } else {
                    let src;
                    if (frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) {
                        src = frame.data;
                    } else if (frame.data instanceof ArrayBuffer) {
                        src = new Uint8Array(frame.data);
                    } else if (frame.data.buffer instanceof ArrayBuffer) {
                        src = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
                    } else {
                        console.error('Unknown frame data type:', typeof frame.data, frame.data);
                        continue;
                    }
                    for (let j = 0; j < pixelCount; j++) {
                        const v = src[j];
                        rgba[j * 4] = v;
                        rgba[j * 4 + 1] = v;
                        rgba[j * 4 + 2] = v;
                        rgba[j * 4 + 3] = 255;
                    }
                }

                const byteOffset = i * pixelCount * 4;
                queue.writeBuffer(buffers.rgbaBuffer, byteOffset, rgba);
            }
            // Let grayscale shader convert RGBA to float32 grayscale
            // (don't set grayAlreadyComputed - we need the shader to run)
        } else {
            // Input is already RGBA - write each frame directly to GPU buffer (no staging buffer)
            for (let i = 0; i < batchSize; i++) {
                const frame = frames[i];
                const byteOffset = i * pixelCount * 4;  // 4 bytes per RGBA pixel
                // Handle both Uint8Array and ArrayBuffer inputs
                let src;
                if (frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) {
                    src = frame.data;
                } else if (frame.data instanceof ArrayBuffer) {
                    src = new Uint8Array(frame.data);
                } else if (frame.data.buffer instanceof ArrayBuffer) {
                    // TypedArray - create Uint8Array view at correct offset
                    src = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
                } else {
                    console.error('Unknown frame data type:', typeof frame.data, frame.data);
                    continue;
                }

                if (src.length !== pixelCount * 4) {
                    console.error(`Frame ${i}: RGBA data size mismatch. Expected ${pixelCount * 4}, got ${src.length}`);
                    continue;
                }

                // Write directly to GPU buffer at offset
                queue.writeBuffer(buffers.rgbaBuffer, byteOffset, src);
            }
        }
    }

    // Update params for grayscale/tenengrad
    queue.writeBuffer(buffers.paramsBuffer, 0, new Uint32Array([width, height, batchSize, 0]));

    // Update reduction params
    queue.writeBuffer(buffers.reductionParamsBuffer, 0, new Uint32Array([width, height, batchSize, pixelCount]));

    // Update moments params (with threshold)
    const momentsParamsData = new ArrayBuffer(16);
    new Uint32Array(momentsParamsData, 0, 3).set([width, height, batchSize]);
    new Float32Array(momentsParamsData, 12, 1).set([threshold]);
    queue.writeBuffer(buffers.momentsParamsBuffer, 0, momentsParamsData);

    // Create bind groups (must recreate each time)
    // Use Float32 shader for 16-bit RGBA (4 floats per pixel), regular shader for 8-bit (packed u32)
    const grayPipeline = bitDepth === 16 ? grayscaleFloat32Pipeline : grayscalePipeline;
    const grayBindGroup = createBindGroup(device, grayPipeline, [
        buffers.paramsBuffer, buffers.rgbaBuffer, buffers.grayBuffer
    ]);
    const lapBindGroup = createBindGroup(device, tenengradPipeline, [
        buffers.paramsBuffer, buffers.grayBuffer, buffers.tenengradBuffer, buffers.laplacianBuffer
    ]);
    const reductionBindGroup = createBindGroup(device, reductionPipeline, [
        buffers.reductionParamsBuffer, buffers.tenengradBuffer, buffers.laplacianBuffer, buffers.reductionBuffer
    ]);
    const momentsBindGroup = createBindGroup(device, momentsPipeline, [
        buffers.momentsParamsBuffer, buffers.grayBuffer, buffers.momentsBuffer
    ]);
    const momentsReductionBindGroup = createBindGroup(device, momentsReductionPipeline, [
        buffers.reductionParamsBuffer, buffers.momentsBuffer, buffers.momentsReductionBuffer
    ]);

    // Circularity final pass: compute circularity from summed moments on GPU
    // Circularity params: numWorkgroups, batchSize, defaultCenterX, defaultCenterY
    const circularityParamsData = new ArrayBuffer(16);
    new Uint32Array(circularityParamsData, 0, 2).set([numWorkgroups, batchSize]);
    new Float32Array(circularityParamsData, 8, 2).set([width / 2, height / 2]);
    queue.writeBuffer(buffers.circularityParamsBuffer, 0, circularityParamsData);
    const circularityBindGroup = createBindGroup(device, circularityFinalPipeline, [
        buffers.circularityParamsBuffer, buffers.momentsReductionBuffer, buffers.circularityBuffer
    ]);

    // Update bounds params (same threshold as moments)
    const boundsParamsData = new ArrayBuffer(16);
    new Uint32Array(boundsParamsData, 0, 3).set([width, height, batchSize]);
    new Float32Array(boundsParamsData, 12, 1).set([threshold]);
    queue.writeBuffer(buffers.boundsParamsBuffer, 0, boundsParamsData);

    const boundsBindGroup = createBindGroup(device, boundsPipeline, [
        buffers.boundsParamsBuffer, buffers.grayBuffer, buffers.boundsBuffer
    ]);
    const boundsReductionBindGroup = createBindGroup(device, boundsReductionPipeline, [
        buffers.reductionParamsBuffer, buffers.boundsBuffer, buffers.boundsReductionBuffer
    ]);

    // Execute all passes in a single command encoder
    const encoder = device.createCommandEncoder();

    // Grayscale (skip if already computed by fused demosaic+gray)
    let pass;
    if (!grayAlreadyComputed) {
        pass = encoder.beginComputePass();
        pass.setPipeline(grayPipeline);
        pass.setBindGroup(0, grayBindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
        pass.end();
    }

    // Combined pass: Tenengrad + Moments + Bounds (all read from grayBuffer, independent outputs)
    pass = encoder.beginComputePass();
    pass.setPipeline(tenengradPipeline);
    pass.setBindGroup(0, lapBindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
    pass.setPipeline(momentsPipeline);
    pass.setBindGroup(0, momentsBindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
    pass.setPipeline(boundsPipeline);
    pass.setBindGroup(0, boundsBindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
    pass.end();

    // Combined pass: All reductions (independent of each other)
    pass = encoder.beginComputePass();
    pass.setPipeline(reductionPipeline);
    pass.setBindGroup(0, reductionBindGroup);
    pass.dispatchWorkgroups(numWorkgroups, batchSize, 1);
    pass.setPipeline(momentsReductionPipeline);
    pass.setBindGroup(0, momentsReductionBindGroup);
    pass.dispatchWorkgroups(numWorkgroups, batchSize, 1);
    pass.setPipeline(boundsReductionPipeline);
    pass.setBindGroup(0, boundsReductionBindGroup);
    pass.dispatchWorkgroups(numWorkgroups, batchSize, 1);
    pass.end();

    // Circularity final pass: must run after moments reduction completes
    pass = encoder.beginComputePass();
    pass.setPipeline(circularityFinalPipeline);
    pass.setBindGroup(0, circularityBindGroup);
    pass.dispatchWorkgroups(Math.ceil(batchSize / 64), 1, 1);
    pass.end();

    // Copy results for readback
    const reductionCopySize = batchSize * numWorkgroups * 2 * 4;
    const circularityCopySize = batchSize * 4 * 4;  // 4 floats per frame: circ, cx, cy, tiltAngle (computed on GPU)
    const boundsCopySize = batchSize * numWorkgroups * 4 * 4;
    // RGBA copy size: 4x larger for 16-bit (Float32 output vs packed Uint8)
    const rgbaBytesPerPixel = bitDepth === 16 ? 16 : 4;
    const rgbaCopySize = batchSize * pixelCount * rgbaBytesPerPixel;

    encoder.copyBufferToBuffer(buffers.reductionBuffer, 0, buffers.reductionReadback, 0, reductionCopySize);
    encoder.copyBufferToBuffer(buffers.circularityBuffer, 0, buffers.circularityReadback, 0, circularityCopySize);
    encoder.copyBufferToBuffer(buffers.boundsReductionBuffer, 0, buffers.boundsReadback, 0, boundsCopySize);
    // Skip RGBA and grayscale readback in grayOnly mode (saves significant bandwidth)
    // Grayscale buffer is always float32 (4 bytes per pixel)
    const grayCopySize = batchSize * pixelCount * 4;
    if (!grayOnly) {
        encoder.copyBufferToBuffer(buffers.rgbaBuffer, 0, buffers.rgbaReadback, 0, rgbaCopySize);
        encoder.copyBufferToBuffer(buffers.grayBuffer, 0, buffers.grayReadback, 0, grayCopySize);
    }

    logGpuSubmit(grayOnly ? 'analyzeBatch:analysis+readback(grayOnly)' : 'analyzeBatch:analysis+readback');
    queue.submit([encoder.finish()]);

    // Read back results
    await safeMapAsync(buffers.reductionReadback, GPUMapMode.READ);
    await safeMapAsync(buffers.circularityReadback, GPUMapMode.READ);
    await safeMapAsync(buffers.boundsReadback, GPUMapMode.READ);

    const reductionData = new Float32Array(buffers.reductionReadback.getMappedRange().slice(0, reductionCopySize));
    const circularityData = new Float32Array(buffers.circularityReadback.getMappedRange().slice(0, circularityCopySize));
    const boundsData = new Uint32Array(buffers.boundsReadback.getMappedRange().slice(0, boundsCopySize));

    // RGBA and grayscale readback only when not in grayOnly mode
    let rgbaData = null;
    let grayData = null;
    if (!grayOnly) {
        await safeMapAsync(buffers.rgbaReadback, GPUMapMode.READ);
        await safeMapAsync(buffers.grayReadback, GPUMapMode.READ);
        // RGBA data type depends on bit depth:
        // - 8-bit: Uint8Array (packed RGBA, 4 bytes/pixel)
        // - 16-bit: Float32Array (4 floats/pixel, values in 0-1 range)
        const rgbaRawBuffer = buffers.rgbaReadback.getMappedRange().slice(0, rgbaCopySize);
        rgbaData = bitDepth === 16 ? new Float32Array(rgbaRawBuffer) : new Uint8Array(rgbaRawBuffer);
        // Grayscale is always Float32 (sharpness values in 0-1 range)
        const grayRawBuffer = buffers.grayReadback.getMappedRange().slice(0, grayCopySize);
        grayData = new Float32Array(grayRawBuffer);
    }

    buffers.reductionReadback.unmap();
    buffers.circularityReadback.unmap();
    buffers.boundsReadback.unmap();
    if (!grayOnly) {
        buffers.rgbaReadback.unmap();
        buffers.grayReadback.unmap();
    }

    // Process results for each frame
    const results = [];

    for (let i = 0; i < batchSize; i++) {
        // Sum up partial reductions for both Tenengrad and Laplacian
        let tenengradSum = 0;
        let laplacianSum = 0;
        for (let w = 0; w < numWorkgroups; w++) {
            const idx = (i * numWorkgroups + w) * 2;
            tenengradSum += reductionData[idx];
            laplacianSum += reductionData[idx + 1];
        }

        // Scale by 255² = 65025 to match CPU which uses 0-255 grayscale (we use 0-1)
        const tenengradMean = (tenengradSum / pixelCount) * 65025;
        const laplacianMean = (laplacianSum / pixelCount) * 65025;

        // Combined sharpness = geometric mean of Tenengrad and Laplacian
        // Geometric mean naturally balances metrics regardless of their absolute scales
        const sharpness = Math.sqrt(tenengradMean * laplacianMean);

        // Get circularity, centroid, and tilt angle from GPU (computed in circularityFinalShader)
        const circIdx = i * 4;
        const circularity = circularityData[circIdx];
        const centroidX = circularityData[circIdx + 1];
        const centroidY = circularityData[circIdx + 2];
        const tiltAngle = circularityData[circIdx + 3];

        // Calculate bounds from partial reductions
        let minX = width, minY = height, maxX = 0, maxY = 0;
        for (let w = 0; w < numWorkgroups; w++) {
            const idx = (i * numWorkgroups + w) * 4;
            const wMinX = boundsData[idx];
            const wMinY = boundsData[idx + 1];
            const wMaxX = boundsData[idx + 2];
            const wMaxY = boundsData[idx + 3];
            if (wMinX < minX) minX = wMinX;
            if (wMinY < minY) minY = wMinY;
            if (wMaxX > maxX) maxX = wMaxX;
            if (wMaxY > maxY) maxY = wMaxY;
        }

        // Build bounds object (null if no bright pixels detected)
        let bounds = null;
        if (maxX >= minX && maxY >= minY && minX < width && minY < height) {
            bounds = {
                x: minX,
                y: minY,
                width: maxX - minX + 1,
                height: maxY - minY + 1,
                centroidX,
                centroidY
            };
        }

        // Build result object
        const result = {
            sharpness,
            tenengrad: tenengradMean,
            laplacian: laplacianMean,
            circularity,
            tiltAngle,
            bounds,
            width,
            height,
            index: frames[i].index
        };

        // Extract RGBA and grayscale for this frame (skip in grayOnly mode)
        if (!grayOnly && rgbaData) {
            // Size depends on bit depth: 4 bytes/pixel (8-bit) or 16 bytes/pixel (16-bit Float32)
            const elementsPerPixel = bitDepth === 16 ? 4 : 4;  // 4 floats or 4 bytes
            const frameRgba = rgbaData.slice(i * pixelCount * elementsPerPixel, (i + 1) * pixelCount * elementsPerPixel);

            // Return buffer in appropriate format for stacking
            // - 8-bit: uint8Buffer (packed RGBA) - GPU stacker converts to float32 on GPU
            // - 16-bit: float32Buffer (4 floats/pixel, 0-1 range) - preserves full precision for stacking
            if (bitDepth === 16) {
                // 16-bit: return Float32 buffer (preserves precision through stacking)
                result.float32Buffer = frameRgba.buffer.slice(frameRgba.byteOffset, frameRgba.byteOffset + frameRgba.byteLength);
            } else {
                // 8-bit: return Uint8 buffer (GPU stacker converts to float32 on GPU)
                result.uint8Buffer = frameRgba.buffer.slice(frameRgba.byteOffset, frameRgba.byteOffset + frameRgba.byteLength);
            }

            // Also extract grayscale for side-by-side preview
            if (grayData) {
                const frameGray = grayData.slice(i * pixelCount, (i + 1) * pixelCount);
                result.grayBuffer = frameGray.buffer.slice(frameGray.byteOffset, frameGray.byteOffset + frameGray.byteLength);
            }
        }

        results.push(result);
    }

    // Buffers are cached and reused - no cleanup here
    return results;

    } finally {
        // Release analyze slot to allow next analyzeBatch to proceed (even on error)
        releaseAnalyzeSlot();
    }
}

// Cached buffers for crop+analyze
let cachedCropBuffers = null;
let cachedCropConfig = null;

/**
 * Get or create buffers for crop+analyze operation.
 *
 * IMPORTANT: Like getAnalyzeBuffers, 16-bit SER files need 4x larger RGBA buffers
 * to hold Float32 output and preserve precision through stacking.
 *
 * @param {number} bitDepth - 8 or 16, determines cropped RGBA buffer size
 */
async function getCropAnalyzeBuffers(batchSize, srcWidth, srcHeight, cropSize, bitDepth = 8) {
    const srcPixelCount = srcWidth * srcHeight;
    const cropPixelCount = cropSize * cropSize;
    const numWorkgroups = Math.ceil(cropPixelCount / 256);

    // Cropped RGBA size: 4x larger for 16-bit (Float32 output)
    const croppedRgbaBytesPerPixel = bitDepth === 16 ? 16 : 4;

    // Packed grayscale for template matching: 4 pixels per u32
    const packedGraySize = Math.ceil(batchSize * cropPixelCount / 4) * 4;

    const requiredSizes = {
        inputSize: batchSize * srcPixelCount * 4,       // Raw Bayer (u32 per pixel)
        centersSize: batchSize * 8,                     // 2 floats per frame (x, y)
        boundsOutputSize: batchSize * 16,               // 4 u32 per frame (minX, minY, maxX, maxY)
        croppedRgbaSize: batchSize * cropPixelCount * croppedRgbaBytesPerPixel, // Cropped RGBA output (16-bit = 4x)
        packedGraySize: packedGraySize,                 // Packed u8 grayscale for template matching (4 pixels per u32)
        graySize: batchSize * cropPixelCount * 4,       // Grayscale float (always f32)
        tenengradSize: batchSize * cropPixelCount * 4,
        laplacianSize: batchSize * cropPixelCount * 4,
        reductionSize: batchSize * numWorkgroups * 8,
        momentsSize: batchSize * cropPixelCount * 6 * 4,      // 6 floats per pixel
        momentsReductionSize: batchSize * numWorkgroups * 6 * 4,  // 6 floats per workgroup
        sharpnessFinalSize: batchSize * 2 * 4,          // 2 floats per frame (tenengrad, laplacian)
        bitDepth,
        numWorkgroups  // Store for use in shader params
    };

    // Validate cache - EVERY batch-sized buffer must be checked. Missing checks
    // caused Sentry EISE-MS: a later call with a larger batchSize reused an
    // too-small buffer and the readback copyBufferToBuffer overflowed.
    if (cachedCropBuffers && cachedCropConfig &&
        cachedCropConfig.inputSize >= requiredSizes.inputSize &&
        cachedCropConfig.centersSize >= requiredSizes.centersSize &&
        cachedCropConfig.croppedRgbaSize >= requiredSizes.croppedRgbaSize &&
        cachedCropConfig.packedGraySize >= requiredSizes.packedGraySize &&
        cachedCropConfig.graySize >= requiredSizes.graySize &&
        cachedCropConfig.tenengradSize >= requiredSizes.tenengradSize &&
        cachedCropConfig.laplacianSize >= requiredSizes.laplacianSize &&
        cachedCropConfig.momentsSize >= requiredSizes.momentsSize &&
        cachedCropConfig.reductionSize >= requiredSizes.reductionSize &&
        cachedCropConfig.momentsReductionSize >= requiredSizes.momentsReductionSize &&
        cachedCropConfig.boundsOutputSize >= requiredSizes.boundsOutputSize &&
        cachedCropConfig.sharpnessFinalSize >= requiredSizes.sharpnessFinalSize) {
        cachedCropConfig.bitDepth = bitDepth;
        return cachedCropBuffers;
    }

    // Need to recreate buffers - wait for other batches to finish first
    // (current batch already has a slot, so activeBatchCount >= 1)
    while (activeBatchCount > 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Cleanup old buffers (safe now - only current batch is active)
    if (cachedCropBuffers) {
        Object.values(cachedCropBuffers).flat().forEach(buf => {
            if (buf && buf.destroy) buf.destroy();
        });
        // Keep activeBatchCount at 1 (current batch still has its slot)
        batchWaiters = [];
    }

    // Helper to create array of N identical buffers for concurrent batch support
    const createBufferArray = (size, usage) =>
        Array.from({ length: MAX_CONCURRENT_BATCHES }, () =>
            device.createBuffer({ size, usage })
        );

    cachedCropBuffers = {
        paramsBuffer: uniformBuffer(device, 32),  // 8 u32s for params
        inputBuffers: createBufferArray(requiredSizes.inputSize, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        centersBuffer: storageBuffer(device, requiredSizes.centersSize, { copyDst: true }),
        boundsOutputBuffer: storageBuffer(device, requiredSizes.boundsOutputSize, { copySrc: true }),
        // N-buffering for readback (matches MAX_CONCURRENT_BATCHES)
        boundsOutputReadbacks: createBufferArray(requiredSizes.boundsOutputSize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        centroidParamsBuffer: uniformBuffer(device, 16),  // 4 u32s: srcWidth, srcHeight, batchSize, numWorkgroups
        croppedRgbaBuffer: storageBuffer(device, requiredSizes.croppedRgbaSize, { copySrc: true }),
        // Packed grayscale for template matching (output by demosaic shader)
        packedGrayBuffer: storageBuffer(device, requiredSizes.packedGraySize, { copySrc: true, copyDst: true }),
        packedGrayReadbacks: createBufferArray(requiredSizes.packedGraySize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        grayBuffer: storageBuffer(device, requiredSizes.graySize, { copySrc: true }),
        grayReadbacks: createBufferArray(requiredSizes.graySize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        tenengradBuffer: storageBuffer(device, requiredSizes.tenengradSize),
        laplacianBuffer: storageBuffer(device, requiredSizes.laplacianSize),
        reductionBuffer: storageBuffer(device, requiredSizes.reductionSize, { copySrc: true }),
        readbackBuffers: createBufferArray(requiredSizes.reductionSize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        momentsBuffer: storageBuffer(device, requiredSizes.momentsSize),
        momentsReductionBuffer: storageBuffer(device, requiredSizes.momentsReductionSize, { copySrc: true }),
        momentsReadbackBuffers: createBufferArray(requiredSizes.momentsReductionSize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        croppedReadbackBuffers: createBufferArray(requiredSizes.croppedRgbaSize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        grayParamsBuffer: uniformBuffer(device, 16),
        reductionParamsBuffer: uniformBuffer(device, 16),
        momentsParamsBuffer: uniformBuffer(device, 16),
        // Final sharpness reduction: 2 floats per frame (tenengrad, laplacian)
        sharpnessFinalBuffer: storageBuffer(device, requiredSizes.sharpnessFinalSize, { copySrc: true }),
        sharpnessFinalReadbacks: createBufferArray(requiredSizes.sharpnessFinalSize, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
        sharpnessFinalParamsBuffer: uniformBuffer(device, 16)
    };

    cachedCropConfig = { ...requiredSizes, bufferGen: 0 };
    return cachedCropBuffers;
}

// Toggle buffer generation for double-buffering
function rotateCropBuffers() {
    if (cachedCropConfig) {
        cachedCropConfig.bufferGen = (cachedCropConfig.bufferGen || 0) + 1;
    }
}

/**
 * Crop + Analyze batch: demosaic+crop raw frames, then analyze cropped output
 * @param {Array} frames - Array of {data: Uint8Array|Uint16Array, index: number}
 * @param {number} srcWidth - Source frame width
 * @param {number} srcHeight - Source frame height
 * @param {number} cropSize - Output crop size (square)
 * @param {Array} centers - Array of {x, y} per-frame centers
 * @param {number} bayerPattern - Bayer pattern (0-3, or -1 for mono)
 * @param {number} threshold - Threshold for moments (default 0.1)
 * @param {boolean} metadataOnly - If true, skip float32 buffer readback
 */
async function cropAndAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, centers, bayerPattern, threshold = 0.1, metadataOnly = false) {
    if (!device || !queue) {
        throw new Error('WebGPU not initialized or device lost');
    }
    const batchSize = frames.length;
    const srcPixelCount = srcWidth * srcHeight;
    const cropPixelCount = cropSize * cropSize;
    const numWorkgroups = Math.ceil(cropPixelCount / 256);

    const needsDemosaic = bayerPattern >= 0;

    // Detect bitDepth FIRST so we allocate correct buffer sizes
    // 16-bit sources (Bayer or mono) need 4x larger RGBA buffers for Float32 output
    const bitDepth = detectBitDepth(frames);
    console.log(`[GPU] cropAndAnalyzeBatch: bitDepth=${bitDepth}, batchSize=${batchSize}, needsDemosaic=${needsDemosaic}`);

    // Wait for a batch slot BEFORE getting buffers (prevents buffer destruction while in use)
    await acquireBatchSlot();

    try {

    const buffers = await getCropAnalyzeBuffers(batchSize, srcWidth, srcHeight, cropSize, bitDepth);

    // Upload centers
    const centersData = new Float32Array(batchSize * 2);
    for (let i = 0; i < batchSize; i++) {
        centersData[i * 2] = centers[i].x;
        centersData[i * 2 + 1] = centers[i].y;
    }
    queue.writeBuffer(buffers.centersBuffer, 0, centersData);

    // Prepare Bayer data (we already know bitDepth)
    let bayerData = null;
    let scale = 1.0;
    if (needsDemosaic) {
        // DEBUG: Check raw input values
        if (frames[0]?.data) {
            const rawData = frames[0].data;
            const midIdx = Math.floor(rawData.length / 2);
            console.log(`[GPU] cropAndAnalyzeBatch raw input: type=${rawData.constructor?.name}, midValue=${rawData[midIdx]}, sample=[${rawData[midIdx]}, ${rawData[midIdx+1]}, ${rawData[midIdx+2]}]`);
        }
        const prepared = prepareBayerData(frames, srcPixelCount, false);
        bayerData = prepared.data;
        scale = prepared.scale;
    }

    // Set crop params (always bilinear demosaic - VNG is done in stacking worker)
    const cropParams = new ArrayBuffer(32);
    new Uint32Array(cropParams).set([srcWidth, srcHeight, cropSize, bayerPattern >= 0 ? bayerPattern : 0, batchSize, 0, bitDepth, 0]);
    new Float32Array(cropParams)[7] = scale;
    queue.writeBuffer(buffers.paramsBuffer, 0, cropParams);

    // DEBUG: Log shader params
    console.log(`[GPU] cropAndAnalyzeBatch shader params: srcWidth=${srcWidth}, srcHeight=${srcHeight}, cropSize=${cropSize}, bayerPattern=${bayerPattern}, batchSize=${batchSize}, bitDepth=${bitDepth}, scale=${scale}`);

    // Prepare all bind groups and parameters upfront
    queue.writeBuffer(buffers.grayParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, 0]));
    queue.writeBuffer(buffers.reductionParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, cropPixelCount]));

    const momentsParamsData = new ArrayBuffer(16);
    new Uint32Array(momentsParamsData, 0, 3).set([cropSize, cropSize, batchSize]);
    new Float32Array(momentsParamsData, 12, 1).set([threshold]);
    queue.writeBuffer(buffers.momentsParamsBuffer, 0, momentsParamsData);

    // Create bind groups for analysis passes
    // Use Float32 shader for 16-bit RGBA (4 floats per pixel), regular shader for 8-bit (packed u32)
    const grayPipeline = bitDepth === 16 ? grayscaleFloat32Pipeline : grayscalePipeline;
    const grayBindGroup = createBindGroup(device, grayPipeline, [
        buffers.grayParamsBuffer, buffers.croppedRgbaBuffer, buffers.grayBuffer
    ]);
    const lapBindGroup = createBindGroup(device, tenengradPipeline, [
        buffers.grayParamsBuffer, buffers.grayBuffer, buffers.tenengradBuffer, buffers.laplacianBuffer
    ]);
    const reduceBindGroup = createBindGroup(device, reductionPipeline, [
        buffers.reductionParamsBuffer, buffers.tenengradBuffer, buffers.laplacianBuffer, buffers.reductionBuffer
    ]);
    const momentsBindGroup = createBindGroup(device, momentsPipeline, [
        buffers.momentsParamsBuffer, buffers.grayBuffer, buffers.momentsBuffer
    ]);
    const momentsReduceBindGroup = createBindGroup(device, momentsReductionPipeline, [
        buffers.reductionParamsBuffer, buffers.momentsBuffer, buffers.momentsReductionBuffer
    ]);

    // Execute all passes in a single command encoder
    const encoder = device.createCommandEncoder();

    // Clear packed gray buffer before demosaic (atomicOr needs zeros)
    const packedGraySize = Math.ceil(batchSize * cropPixelCount / 4) * 4;
    encoder.clearBuffer(buffers.packedGrayBuffer, 0, packedGraySize);

    if (needsDemosaic) {
        // Upload Bayer data (already prepared above)
        queue.writeBuffer(buffers.inputBuffers[0], 0, bayerData);

        const demosaicCropBindGroup = createBindGroup(device, demosaicCropPipeline, [
            buffers.paramsBuffer, buffers.inputBuffers[0], buffers.centersBuffer,
            buffers.croppedRgbaBuffer, buffers.packedGrayBuffer
        ]);

        // Demosaic + crop pass (also outputs packed grayscale)
        let pass = encoder.beginComputePass();
        pass.setPipeline(demosaicCropPipeline);
        pass.setBindGroup(0, demosaicCropBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();
    } else if (bitDepth === 16) {
        // 16-bit mono: upload raw u16 data, GPU shader crops and outputs Float32 RGBA
        // Pack all frames into a single buffer (2 bytes/pixel, same as Bayer 16-bit input layout)
        const bytesPerPixel = 2;
        const mono16Data = new Uint8Array(batchSize * srcPixelCount * bytesPerPixel);
        let maxVal = 0;
        for (let i = 0; i < batchSize; i++) {
            const src16 = frames[i].data;
            const srcBytes = new Uint8Array(src16.buffer, src16.byteOffset, src16.byteLength);
            mono16Data.set(srcBytes, i * srcPixelCount * bytesPerPixel);
            // Sample max for auto-stretch
            const step = Math.max(1, Math.floor(srcPixelCount / 5000));
            for (let j = 0; j < srcPixelCount; j += step) {
                if (src16[j] > maxVal) maxVal = src16[j];
            }
        }
        const scale = maxVal > 0 ? 1.0 / maxVal : 1.0;
        queue.writeBuffer(buffers.inputBuffers[0], 0, mono16Data);

        // Set params with scale for auto-stretch (same layout as rgbaCropShader, scale in slot 5)
        const paramsData = new ArrayBuffer(32);
        new Uint32Array(paramsData).set([srcWidth, srcHeight, cropSize, 0, batchSize, 0, 0, 0]);
        new Float32Array(paramsData)[5] = scale;
        queue.writeBuffer(buffers.paramsBuffer, 0, paramsData);

        const mono16CropBindGroup = createBindGroup(device, mono16CropFloat32Pipeline, [
            buffers.paramsBuffer, buffers.inputBuffers[0], buffers.centersBuffer,
            buffers.croppedRgbaBuffer, buffers.packedGrayBuffer
        ]);

        // Mono16 crop pass: reads packed u16, outputs Float32 RGBA + packed grayscale
        let pass = encoder.beginComputePass();
        pass.setPipeline(mono16CropFloat32Pipeline);
        pass.setBindGroup(0, mono16CropBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();
    } else {
        // 8-bit input: RGBA (4 bytes/pixel) or 8-bit mono (1 byte/pixel)
        const firstFrame = frames[0];
        let firstSrc;
        if (firstFrame.data instanceof Uint8Array || firstFrame.data instanceof Uint8ClampedArray) {
            firstSrc = firstFrame.data;
        } else if (firstFrame.data instanceof ArrayBuffer) {
            firstSrc = new Uint8Array(firstFrame.data);
        } else if (firstFrame.data.buffer instanceof ArrayBuffer) {
            firstSrc = new Uint8Array(firstFrame.data.buffer, firstFrame.data.byteOffset, firstFrame.data.byteLength);
        }
        const isMonoInput = firstSrc && firstSrc.length === srcPixelCount;

        // Write each frame to GPU buffer (expand mono to RGBA if needed)
        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const byteOffset = i * srcPixelCount * 4;

            if (isMonoInput) {
                let src;
                if (frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) {
                    src = frame.data;
                } else if (frame.data instanceof ArrayBuffer) {
                    src = new Uint8Array(frame.data);
                } else if (frame.data.buffer instanceof ArrayBuffer) {
                    src = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
                } else {
                    console.error('Unknown frame data type:', typeof frame.data);
                    continue;
                }
                const rgba = new Uint8Array(srcPixelCount * 4);
                for (let j = 0; j < srcPixelCount; j++) {
                    const v = src[j];
                    rgba[j * 4] = v;
                    rgba[j * 4 + 1] = v;
                    rgba[j * 4 + 2] = v;
                    rgba[j * 4 + 3] = 255;
                }
                queue.writeBuffer(buffers.inputBuffers[0], byteOffset, rgba);
            } else {
                // RGBA input - write directly
                let src;
                if (frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) {
                    src = frame.data;
                } else if (frame.data instanceof ArrayBuffer) {
                    src = new Uint8Array(frame.data);
                } else if (frame.data.buffer instanceof ArrayBuffer) {
                    src = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
                } else {
                    console.error('Unknown frame data type:', typeof frame.data);
                    continue;
                }
                queue.writeBuffer(buffers.inputBuffers[0], byteOffset, src);
            }
        }

        const rgbaCropBindGroup = createBindGroup(device, rgbaCropPipeline, [
            buffers.paramsBuffer, buffers.inputBuffers[0], buffers.centersBuffer,
            buffers.croppedRgbaBuffer, buffers.packedGrayBuffer
        ]);

        // RGBA crop pass (also outputs packed grayscale)
        let pass = encoder.beginComputePass();
        pass.setPipeline(rgbaCropPipeline);
        pass.setBindGroup(0, rgbaCropBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();
    }

    // Grayscale pass
    let pass = encoder.beginComputePass();
    pass.setPipeline(grayPipeline);
    pass.setBindGroup(0, grayBindGroup);
    pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
    pass.end();

    // Combined pass: Tenengrad + Moments (both read from grayBuffer, independent outputs)
    pass = encoder.beginComputePass();
    pass.setPipeline(tenengradPipeline);
    pass.setBindGroup(0, lapBindGroup);
    pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
    pass.setPipeline(momentsPipeline);
    pass.setBindGroup(0, momentsBindGroup);
    pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
    pass.end();

    // Combined pass: Both reductions (independent of each other)
    pass = encoder.beginComputePass();
    pass.setPipeline(reductionPipeline);
    pass.setBindGroup(0, reduceBindGroup);
    pass.dispatchWorkgroups(numWorkgroups, batchSize, 1);
    pass.setPipeline(momentsReductionPipeline);
    pass.setBindGroup(0, momentsReduceBindGroup);
    pass.dispatchWorkgroups(numWorkgroups, batchSize, 1);
    pass.end();

    // Select readback buffers based on generation (N-buffering for concurrent batches)
    const bufferIdx = (cachedCropConfig?.bufferGen || 0) % MAX_CONCURRENT_BATCHES;
    const readbackBuf = buffers.readbackBuffers[bufferIdx];
    const momentsReadbackBuf = buffers.momentsReadbackBuffers[bufferIdx];
    const croppedReadbackBuf = buffers.croppedReadbackBuffers[bufferIdx];
    const packedGrayReadbackBuf = buffers.packedGrayReadbacks[bufferIdx];

    // Copy results to readback buffers
    // 16-bit needs 4x more bytes per pixel (4 floats vs 1 packed u32)
    const croppedRgbaCopySize = batchSize * cropPixelCount * (bitDepth === 16 ? 16 : 4);
    encoder.copyBufferToBuffer(buffers.reductionBuffer, 0, readbackBuf, 0, batchSize * numWorkgroups * 8);
    encoder.copyBufferToBuffer(buffers.momentsReductionBuffer, 0, momentsReadbackBuf, 0, batchSize * numWorkgroups * 6 * 4);
    encoder.copyBufferToBuffer(buffers.croppedRgbaBuffer, 0, croppedReadbackBuf, 0, croppedRgbaCopySize);
    encoder.copyBufferToBuffer(buffers.packedGrayBuffer, 0, packedGrayReadbackBuf, 0, packedGraySize);

    // Single submit for all passes
    logGpuSubmit('cropAnalyzeBatch:all+readback');
    queue.submit([encoder.finish()]);

    // Rotate buffers for next batch (so next batch uses alternate set)
    rotateCropBuffers();

    // Map all readback buffers in parallel for better throughput
    await Promise.all([
        safeMapAsync(readbackBuf, GPUMapMode.READ),
        safeMapAsync(momentsReadbackBuf, GPUMapMode.READ),
        safeMapAsync(croppedReadbackBuf, GPUMapMode.READ),
        safeMapAsync(packedGrayReadbackBuf, GPUMapMode.READ)
    ]);

    // Read data from mapped buffers
    const reductionData = new Float32Array(readbackBuf.getMappedRange().slice(0));
    readbackBuf.unmap();

    const momentsData = new Float32Array(momentsReadbackBuf.getMappedRange().slice(0));
    momentsReadbackBuf.unmap();

    // Cropped RGBA data type depends on bit depth:
    // - 8-bit: Uint8Array (packed RGBA, 4 bytes/pixel)
    // - 16-bit: Float32Array (4 floats/pixel, 0-1 range)
    const croppedRawBuffer = croppedReadbackBuf.getMappedRange().slice(0);
    const croppedData = bitDepth === 16 ? new Float32Array(croppedRawBuffer) : new Uint8Array(croppedRawBuffer);
    croppedReadbackBuf.unmap();

    // DEBUG: Sample cropped data with full statistics
    if (bitDepth === 16 && batchSize > 0) {
        const framePixels = cropPixelCount;
        const centerIdx = Math.floor(framePixels / 2) * 4;

        // Calculate statistics for first frame
        let maxR = 0, maxG = 0, maxB = 0, sumR = 0, count = 0;
        for (let i = 0; i < framePixels * 4; i += 4) {
            if (croppedData[i] > 0.01 || croppedData[i+1] > 0.01 || croppedData[i+2] > 0.01) {
                sumR += croppedData[i];
                count++;
            }
            if (croppedData[i] > maxR) maxR = croppedData[i];
            if (croppedData[i+1] > maxG) maxG = croppedData[i+1];
            if (croppedData[i+2] > maxB) maxB = croppedData[i+2];
        }
        const avgR = count > 0 ? sumR / count : 0;

        console.log(`[GPU] Demosaic output stats: maxR=${maxR.toFixed(4)}, maxG=${maxG.toFixed(4)}, maxB=${maxB.toFixed(4)}, avgR=${avgR.toFixed(4)}`);
        console.log(`[GPU] Center pixel: R=${croppedData[centerIdx].toFixed(4)}, G=${croppedData[centerIdx+1].toFixed(4)}, B=${croppedData[centerIdx+2].toFixed(4)}`);
    }

    // Packed grayscale for template matching and preview (8-bit, 1 byte per pixel)
    const packedGrayData = new Uint8Array(packedGrayReadbackBuf.getMappedRange().slice(0));
    packedGrayReadbackBuf.unmap();

    // Process results
    const results = [];
    for (let i = 0; i < batchSize; i++) {
        // Sum both Tenengrad and Laplacian from workgroups
        let tenengradSum = 0, laplacianSum = 0;
        for (let w = 0; w < numWorkgroups; w++) {
            const idx = (i * numWorkgroups + w) * 2;
            tenengradSum += reductionData[idx];
            laplacianSum += reductionData[idx + 1];
        }
        // Scale by 255² = 65025 to match CPU which uses 0-255 grayscale (GPU uses 0-1)
        const tenengradMean = (tenengradSum / cropPixelCount) * 65025;
        const laplacianMean = (laplacianSum / cropPixelCount) * 65025;
        // Combined sharpness = geometric mean of both metrics
        const sharpness = Math.sqrt(tenengradMean * laplacianMean);

        // Sum moments for circularity (6 values per workgroup: m00, m10, m01, m20, m11, m02)
        let m00 = 0, m10 = 0, m01 = 0, m20 = 0, m11 = 0, m02 = 0;
        for (let w = 0; w < numWorkgroups; w++) {
            const idx = (i * numWorkgroups + w) * 6;
            m00 += momentsData[idx];
            m10 += momentsData[idx + 1];
            m01 += momentsData[idx + 2];
            m20 += momentsData[idx + 3];
            m11 += momentsData[idx + 4];
            m02 += momentsData[idx + 5];
        }

        let circularity = 0;
        if (m00 > 0) {
            const cx = m10 / m00;
            const cy = m01 / m00;

            // Central moments
            const mu20 = m20 / m00 - cx * cx;
            const mu02 = m02 / m00 - cy * cy;
            const mu11 = m11 / m00 - cx * cy;

            // Eigenvalues of covariance matrix
            const trace = mu20 + mu02;
            const det = mu20 * mu02 - mu11 * mu11;
            const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * det));
            const lambda1 = (trace + discriminant) / 2;
            const lambda2 = (trace - discriminant) / 2;

            // Circularity = ratio of eigenvalues (1 = perfect circle)
            if (lambda1 > 0) {
                circularity = Math.min(lambda2, lambda1) / Math.max(lambda2, lambda1);
            }
        }

        // Return buffer in appropriate format for stacking
        // - 8-bit: uint8Buffer (packed RGBA) - stacker converts to Float32 on GPU
        // - 16-bit: float32Buffer (4 floats/pixel) - preserves precision
        const elementsPerPixel = bitDepth === 16 ? 4 : 4;  // 4 floats or 4 bytes
        const frameRgba = croppedData.slice(i * cropPixelCount * elementsPerPixel, (i + 1) * cropPixelCount * elementsPerPixel);

        // Extract packed grayscale for this frame (8-bit, 1 byte per pixel)
        const grayBytesPerFrame = cropPixelCount;
        const framePackedGray = packedGrayData.slice(i * grayBytesPerFrame, (i + 1) * grayBytesPerFrame);

        const result = {
            sharpness,
            tenengrad: tenengradMean,
            laplacian: laplacianMean,
            circularity,
            index: frames[i].index,
            width: cropSize,
            height: cropSize,
            // 8-bit grayscale for template matching and preview
            packedGrayBuffer: framePackedGray.buffer.slice(framePackedGray.byteOffset, framePackedGray.byteOffset + framePackedGray.byteLength)
        };

        if (bitDepth === 16) {
            result.float32Buffer = frameRgba.buffer.slice(frameRgba.byteOffset, frameRgba.byteOffset + frameRgba.byteLength);
        } else {
            result.uint8Buffer = frameRgba.buffer.slice(frameRgba.byteOffset, frameRgba.byteOffset + frameRgba.byteLength);
        }

        results.push(result);
    }

    return results;

    } finally {
        releaseBatchSlot();  // Allow next batch to proceed (even on error)
    }
}

/**
 * Combined detect + crop + analyze in ONE pass (single demosaic)
 * This is 2x faster than separate analyzeBatch + cropAndAnalyzeBatch
 *
 * Flow:
 * 1. Demosaic full frame to RGBA
 * 2. Detect bounds on full frame
 * 3. Read bounds to get centers
 * 4. Crop from already-demosaiced RGBA
 * 5. Calculate sharpness on cropped
 */
// Timing stats for detectCropAnalyzeBatch
let dcaBatchCount = 0;
let dcaPrepTime = 0;
let dcaGpuSubmitTime = 0;
let dcaMapAsyncTime = 0;
let dcaResultBuildTime = 0;
// Detailed per-step timing
let dcaUploadTime = 0;      // prepareBayerData + writeBuffer
let dcaDemosaicTime = 0;    // demosaic shader submit
let dcaBlurTime = 0;        // Gaussian blur for noise reduction
let dcaBoundsTime = 0;      // bounds detection + centroid submit
let dcaCropTime = 0;        // crop submit (non-grayOnly)
let dcaSharpnessTime = 0;   // sharpness + reduction submit

async function detectCropAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold = 0.1, metadataOnly = false, grayOnly = false, nextBatchFrames = null) {
    if (!device || !queue) {
        throw new Error('WebGPU not initialized or device lost');
    }
    const t0 = performance.now();
    const batchSize = frames.length;
    const srcPixelCount = srcWidth * srcHeight;
    const cropPixelCount = cropSize * cropSize;
    const numWorkgroupsFull = Math.ceil(srcPixelCount / 256);
    const numWorkgroupsCrop = Math.ceil(cropPixelCount / 256);

    const needsDemosaic = bayerPattern >= 0;

    // Detect bit depth early for correct buffer allocation
    // 16-bit SER: needs 4x larger RGBA buffer for Float32 output (preserves precision)
    const bitDepth = needsDemosaic ? detectBitDepth(frames) : 8;
    console.log(`[GPU] detectCropAnalyzeBatch: bitDepth=${bitDepth}, batchSize=${batchSize}, needsDemosaic=${needsDemosaic}, grayOnly=${grayOnly}, threshold=${threshold}`);

    // Wait for a batch slot BEFORE getting buffers (prevents buffer destruction while in use)
    await acquireBatchSlot();

    try {

    // Get buffers for full-frame analysis
    const analyzeBuffers = getAnalyzeBuffers(batchSize, srcWidth, srcHeight, bitDepth);

    // Get buffers for cropped analysis (reuses some, creates others)
    const cropBuffers = await getCropAnalyzeBuffers(batchSize, srcWidth, srcHeight, cropSize, bitDepth);

    // ===== STEP 1: Upload raw data and demosaic =====
    // When grayOnly: demosaic directly to grayscale (fast path)
    // When !grayOnly: demosaic to RGBA (need color for stacking)
    const tUploadStart = performance.now();

    // Check if we have pre-uploaded data from previous batch's pipeline
    const usePipelinedData = pipelinedUpload.ready && pipelinedUpload.batchSize === batchSize && needsDemosaic;
    const currentInputBuffer = usePipelinedData
        ? analyzeBuffers.inputBuffers[pipelinedUpload.bufferIndex]
        : analyzeBuffers.inputBuffers[0];

    if (needsDemosaic) {
        let scale;
        if (usePipelinedData) {
            // Data already uploaded to alternate buffer - just use it
            scale = pipelinedUpload.scale;
            pipelinedUpload.ready = false;  // Consume the pre-uploaded data
        } else {
            // Normal path: prepare and upload data
            const prepared = prepareBayerData(frames, srcPixelCount, false);
            scale = prepared.scale;
            queue.writeBuffer(currentInputBuffer, 0, prepared.data);
        }

        // Always use bilinear (useVng=0) for analysis - VNG is done in stacking worker
        const paramsData = new ArrayBuffer(32);
        new Uint32Array(paramsData).set([srcWidth, srcHeight, batchSize, bayerPattern, 0, bitDepth, 0, 0]);
        new Float32Array(paramsData)[6] = scale;
        queue.writeBuffer(analyzeBuffers.paramsBuffer, 0, paramsData);
        dcaUploadTime += (performance.now() - tUploadStart);

        const tDemosaicStart = performance.now();
        if (grayOnly) {
            // Fast path: demosaic directly to grayscale (no RGBA)
            const demosaicGrayOnlyBindGroup = createBindGroup(device, demosaicGrayOnlyPipeline, [
                analyzeBuffers.paramsBuffer, currentInputBuffer, analyzeBuffers.grayBuffer
            ]);
            const encoder = device.createCommandEncoder();
            addComputePass(encoder, demosaicGrayOnlyPipeline, demosaicGrayOnlyBindGroup, imageWorkgroups(srcWidth, srcHeight, batchSize));
            logGpuSubmit('detectCropAnalyze:demosaic-grayOnly');
            queue.submit([encoder.finish()]);
            dcaDemosaicTime += (performance.now() - tDemosaicStart);
        } else {
            // Full path: demosaic to RGBA (for cropping and stacking)
            const demosaicBindGroup = createBindGroup(device, demosaicPipeline, [
                analyzeBuffers.paramsBuffer, currentInputBuffer, analyzeBuffers.rgbaBuffer
            ]);
            const encoder = device.createCommandEncoder();
            addComputePass(encoder, demosaicPipeline, demosaicBindGroup, imageWorkgroups(srcWidth, srcHeight, batchSize));
            logGpuSubmit('detectCropAnalyze:demosaic');
            queue.submit([encoder.finish()]);
            dcaDemosaicTime += (performance.now() - tDemosaicStart);
        }
    } else {
        // Input is RGBA (4 bytes/pixel), 8-bit mono (1 byte/pixel), or 16-bit mono (Uint16Array)
        // Note: 16-bit mono is scaled to 8-bit — GPU shaders only support packed u32 for non-Bayer input.
        const firstFrame = frames[0];
        const isMono16 = firstFrame.data instanceof Uint16Array;
        let firstSrc;
        if (!isMono16) {
            firstSrc = firstFrame.data instanceof Uint8Array || firstFrame.data instanceof Uint8ClampedArray
                ? firstFrame.data
                : new Uint8Array(firstFrame.data.buffer || firstFrame.data);
        }
        const isMono8 = !isMono16 && firstSrc && firstSrc.length === srcPixelCount;
        const isMonoInput = isMono8 || isMono16;

        // For 16-bit mono, find max value for auto-stretch scaling
        let scale16 = 1;
        if (isMono16) {
            let maxVal = 0;
            for (let i = 0; i < batchSize; i++) {
                const src16 = frames[i].data;
                const step = Math.max(1, Math.floor(srcPixelCount / 5000));
                for (let j = 0; j < srcPixelCount; j += step) {
                    if (src16[j] > maxVal) maxVal = src16[j];
                }
            }
            scale16 = maxVal > 0 ? 255 / maxVal : 1;
        }

        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const byteOffset = i * srcPixelCount * 4;

            if (isMono16) {
                const src16 = frame.data;
                const rgba = new Uint8Array(srcPixelCount * 4);
                for (let j = 0; j < srcPixelCount; j++) {
                    const v = Math.min(255, Math.round(src16[j] * scale16));
                    rgba[j * 4] = v;
                    rgba[j * 4 + 1] = v;
                    rgba[j * 4 + 2] = v;
                    rgba[j * 4 + 3] = 255;
                }
                queue.writeBuffer(analyzeBuffers.rgbaBuffer, byteOffset, rgba);
            } else if (isMono8) {
                let src = frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray
                    ? frame.data
                    : new Uint8Array(frame.data.buffer || frame.data);
                const rgba = new Uint8Array(srcPixelCount * 4);
                for (let j = 0; j < srcPixelCount; j++) {
                    const v = src[j];
                    rgba[j * 4] = v;
                    rgba[j * 4 + 1] = v;
                    rgba[j * 4 + 2] = v;
                    rgba[j * 4 + 3] = 255;
                }
                queue.writeBuffer(analyzeBuffers.rgbaBuffer, byteOffset, rgba);
            } else {
                let src = frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray
                    ? frame.data
                    : new Uint8Array(frame.data.buffer || frame.data);
                queue.writeBuffer(analyzeBuffers.rgbaBuffer, byteOffset, src);
            }
        }
        dcaUploadTime += (performance.now() - tUploadStart);
    }

    // ===== STEP 2a: Grayscale conversion =====
    const tBoundsStart = performance.now();
    // When grayOnly AND needsDemosaic: grayscale already computed by demosaic shader
    // Otherwise: need to compute grayscale from RGBA (includes mono input expanded to RGBA)
    queue.writeBuffer(analyzeBuffers.paramsBuffer, 0, new Uint32Array([srcWidth, srcHeight, batchSize, 0]));
    queue.writeBuffer(analyzeBuffers.reductionParamsBuffer, 0, new Uint32Array([srcWidth, srcHeight, batchSize, srcPixelCount]));

    let encoder = device.createCommandEncoder();

    // Run grayscale pass unless demosaic shader already computed it (grayOnly + needsDemosaic)
    const needsGrayscalePass = !grayOnly || !needsDemosaic;
    if (needsGrayscalePass) {
        // Use Float32 shader for 16-bit RGBA (4 floats per pixel), regular shader for 8-bit (packed u32)
        const grayPipeline = bitDepth === 16 ? grayscaleFloat32Pipeline : grayscalePipeline;
        const grayBindGroup = createBindGroup(device, grayPipeline, [
            analyzeBuffers.paramsBuffer, analyzeBuffers.rgbaBuffer, analyzeBuffers.grayBuffer
        ]);
        addComputePass(encoder, grayPipeline, grayBindGroup, imageWorkgroups(srcWidth, srcHeight, batchSize));
    }

    // ===== STEP 2b: Gaussian blur for noise reduction (matches CPU GaussianBlur) =====
    const tBlurStart = performance.now();
    const blurBindGroup = createBindGroup(device, blurPipeline, [
        analyzeBuffers.paramsBuffer, analyzeBuffers.grayBuffer, analyzeBuffers.blurredGrayBuffer
    ]);
    addComputePass(encoder, blurPipeline, blurBindGroup, imageWorkgroups(srcWidth, srcHeight, batchSize));
    dcaBlurTime += (performance.now() - tBlurStart);

    // ===== STEP 2c: Bounds detection on blurred grayscale =====
    const boundsParamsData = new ArrayBuffer(16);
    new Uint32Array(boundsParamsData, 0, 3).set([srcWidth, srcHeight, batchSize]);
    new Float32Array(boundsParamsData, 12, 1).set([threshold]);
    queue.writeBuffer(analyzeBuffers.boundsParamsBuffer, 0, boundsParamsData);

    const boundsBindGroup = createBindGroup(device, boundsPipeline, [
        analyzeBuffers.boundsParamsBuffer, analyzeBuffers.blurredGrayBuffer, analyzeBuffers.boundsBuffer
    ]);
    const boundsReductionBindGroup = createBindGroup(device, boundsReductionPipeline, [
        analyzeBuffers.reductionParamsBuffer, analyzeBuffers.boundsBuffer, analyzeBuffers.boundsReductionBuffer
    ]);

    addComputePass(encoder, boundsPipeline, boundsBindGroup, imageWorkgroups(srcWidth, srcHeight, batchSize));
    addComputePass(encoder, boundsReductionPipeline, boundsReductionBindGroup, reductionWorkgroups(numWorkgroupsFull, batchSize));

    // ===== STEP 3: Compute centroids on GPU (no CPU sync) =====
    queue.writeBuffer(cropBuffers.centroidParamsBuffer, 0, new Uint32Array([srcWidth, srcHeight, batchSize, numWorkgroupsFull]));

    const centroidBindGroup = createBindGroup(device, centroidPipeline, [
        cropBuffers.centroidParamsBuffer, analyzeBuffers.boundsReductionBuffer,
        cropBuffers.centersBuffer, cropBuffers.boundsOutputBuffer
    ]);
    addComputePass(encoder, centroidPipeline, centroidBindGroup, [Math.ceil(batchSize / 64), 1, 1]);

    logGpuSubmit('detectCropAnalyze:centroid');
    queue.submit([encoder.finish()]);
    dcaBoundsTime += (performance.now() - tBoundsStart);

    // ===== STEP 4: Crop from demosaiced RGBA using GPU-computed centers =====
    const tCropStart = performance.now();
    // Skip crop when grayOnly - offset Tenengrad reads directly from full-frame grayscale
    if (!grayOnly) {
        const cropParams = new Uint32Array([srcWidth, srcHeight, cropSize, 0, batchSize, 0, 0, 0]);
        queue.writeBuffer(cropBuffers.paramsBuffer, 0, cropParams);

        // Clear packed gray buffer before crop (atomicOr requires zeroed memory)
        const packedGraySize = Math.ceil(batchSize * cropPixelCount / 4) * 4;
        encoder = device.createCommandEncoder();
        encoder.clearBuffer(cropBuffers.packedGrayBuffer, 0, packedGraySize);

        // Crop from the already-demosaiced rgbaBuffer
        const rgbaCropBindGroup = createBindGroup(device, rgbaCropPipeline, [
            cropBuffers.paramsBuffer, analyzeBuffers.rgbaBuffer, cropBuffers.centersBuffer,
            cropBuffers.croppedRgbaBuffer, cropBuffers.packedGrayBuffer
        ]);
        addComputePass(encoder, rgbaCropPipeline, rgbaCropBindGroup, imageWorkgroups(cropSize, cropSize, batchSize));
        logGpuSubmit('detectCropAnalyze:crop');
        queue.submit([encoder.finish()]);
        dcaCropTime += (performance.now() - tCropStart);
    }

    // ===== STEP 5: Sharpness calculation =====
    const tSharpnessStart = performance.now();
    // grayOnly: offset Tenengrad reads directly from full-frame grayscale with per-frame centers
    // !grayOnly: grayscale from cropped RGBA + tenengrad on cropped
    queue.writeBuffer(cropBuffers.reductionParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, cropPixelCount]));

    encoder = device.createCommandEncoder();

    if (grayOnly) {
        // Offset Tenengrad: reads from full-frame grayscale with per-frame center offsets
        queue.writeBuffer(cropBuffers.paramsBuffer, 0, new Uint32Array([srcWidth, srcHeight, cropSize, batchSize]));
        const offsetLapBindGroup = createBindGroup(device, offsetTenengradPipeline, [
            cropBuffers.paramsBuffer, analyzeBuffers.grayBuffer, cropBuffers.centersBuffer,
            cropBuffers.tenengradBuffer, cropBuffers.laplacianBuffer
        ]);
        addComputePass(encoder, offsetTenengradPipeline, offsetLapBindGroup, imageWorkgroups(cropSize, cropSize, batchSize));
    } else {
        // Standard path: grayscale from cropped RGBA + tenengrad on cropped
        // Use Float32 shader for 16-bit RGBA (4 floats per pixel), regular shader for 8-bit (packed u32)
        const cropGrayPipeline = bitDepth === 16 ? grayscaleFloat32Pipeline : grayscalePipeline;
        queue.writeBuffer(cropBuffers.grayParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, 0]));
        const cropGrayBindGroup = createBindGroup(device, cropGrayPipeline, [
            cropBuffers.grayParamsBuffer, cropBuffers.croppedRgbaBuffer, cropBuffers.grayBuffer
        ]);
        const lapBindGroup = createBindGroup(device, tenengradPipeline, [
            cropBuffers.grayParamsBuffer, cropBuffers.grayBuffer, cropBuffers.tenengradBuffer, cropBuffers.laplacianBuffer
        ]);
        addComputePass(encoder, cropGrayPipeline, cropGrayBindGroup, imageWorkgroups(cropSize, cropSize, batchSize));
        addComputePass(encoder, tenengradPipeline, lapBindGroup, imageWorkgroups(cropSize, cropSize, batchSize));
    }

    // Reduction is the same for both paths (reads from tenengradBuffer)
    const reductionBindGroup = createBindGroup(device, reductionPipeline, [
        cropBuffers.reductionParamsBuffer, cropBuffers.tenengradBuffer, cropBuffers.laplacianBuffer, cropBuffers.reductionBuffer
    ]);
    addComputePass(encoder, reductionPipeline, reductionBindGroup, reductionWorkgroups(numWorkgroupsCrop, batchSize));

    // Final sharpness reduction: sum all workgroup partials into 2 floats per frame
    // This reduces readback from ~1.1MB to 800 bytes per batch
    queue.writeBuffer(cropBuffers.sharpnessFinalParamsBuffer, 0, new Uint32Array([numWorkgroupsCrop, batchSize, cropPixelCount, 0]));
    const sharpnessFinalBindGroup = createBindGroup(device, sharpnessFinalPipeline, [
        cropBuffers.sharpnessFinalParamsBuffer, cropBuffers.reductionBuffer, cropBuffers.sharpnessFinalBuffer
    ]);
    addComputePass(encoder, sharpnessFinalPipeline, sharpnessFinalBindGroup, [Math.ceil(batchSize / 64), 1, 1]);

    // Select readback buffers based on generation (N-buffering for concurrent batches)
    const bufferGen = cachedCropConfig?.bufferGen || 0;
    const bufferIdx = bufferGen % MAX_CONCURRENT_BATCHES;
    const sharpnessReadbackBuf = cropBuffers.sharpnessFinalReadbacks[bufferIdx];
    const croppedReadbackBuf = cropBuffers.croppedReadbackBuffers[bufferIdx];
    const boundsReadbackBuf = cropBuffers.boundsOutputReadbacks[bufferIdx];
    const grayReadbackBuf = cropBuffers.grayReadbacks[bufferIdx];

    // Copy results for readback (sharpnessFinal is only 800 bytes vs 1.1MB for partial sums)
    encoder.copyBufferToBuffer(cropBuffers.sharpnessFinalBuffer, 0, sharpnessReadbackBuf, 0, batchSize * 2 * 4);
    encoder.copyBufferToBuffer(cropBuffers.boundsOutputBuffer, 0, boundsReadbackBuf, 0, batchSize * 16);
    // Copy cropped RGBA and grayscale only when not in grayOnly mode (saves significant bandwidth)
    if (!grayOnly) {
        const croppedRgbaBytesPerPixel = bitDepth === 16 ? 16 : 4;
        const grayCopySize = batchSize * cropPixelCount * 4;  // Float32 grayscale
        encoder.copyBufferToBuffer(cropBuffers.croppedRgbaBuffer, 0, croppedReadbackBuf, 0, batchSize * cropPixelCount * croppedRgbaBytesPerPixel);
        encoder.copyBufferToBuffer(cropBuffers.grayBuffer, 0, grayReadbackBuf, 0, grayCopySize);
    }
    logGpuSubmit('detectCropAnalyze:sharpness+readback');
    queue.submit([encoder.finish()]);
    dcaSharpnessTime += (performance.now() - tSharpnessStart);
    const tAfterSubmit = performance.now();
    dcaPrepTime += (tAfterSubmit - t0);

    // Rotate buffers for next batch
    rotateCropBuffers();

    // ===== STEP 6: Read back results (including bounds from GPU centroid shader) =====
    // Skip cropped RGBA and grayscale readback in grayOnly mode (saves significant bandwidth)
    const mapPromises = [
        safeMapAsync(sharpnessReadbackBuf, GPUMapMode.READ),
        safeMapAsync(boundsReadbackBuf, GPUMapMode.READ)
    ];
    if (!grayOnly) {
        mapPromises.push(safeMapAsync(croppedReadbackBuf, GPUMapMode.READ));
        mapPromises.push(safeMapAsync(grayReadbackBuf, GPUMapMode.READ));
    }

    // ===== PIPELINING: Prepare next batch while waiting for GPU =====
    // While GPU processes current batch, prepare and upload next batch to next buffer
    if (nextBatchFrames && nextBatchFrames.length > 0 && needsDemosaic) {
        const nextSrcPixelCount = srcWidth * srcHeight;  // Same dimensions
        const nextPrepared = prepareBayerData(nextBatchFrames, nextSrcPixelCount, false);

        // Upload to the next buffer in rotation
        const nextBufferIndex = (pipelinedUpload.bufferIndex + 1) % MAX_CONCURRENT_BATCHES;
        const nextInputBuffer = analyzeBuffers.inputBuffers[nextBufferIndex];

        queue.writeBuffer(nextInputBuffer, 0, nextPrepared.data);

        // Mark as ready for next batch
        pipelinedUpload.ready = true;
        pipelinedUpload.bufferIndex = nextBufferIndex;
        pipelinedUpload.scale = nextPrepared.scale;
        pipelinedUpload.batchSize = nextBatchFrames.length;
    }

    await Promise.all(mapPromises);
    const tAfterMapAsync = performance.now();
    dcaMapAsyncTime += (tAfterMapAsync - tAfterSubmit);

    // Read final sharpness values (2 floats per frame: tenengrad, laplacian)
    const sharpnessData = new Float32Array(sharpnessReadbackBuf.getMappedRange().slice(0));
    // Read bounds computed by GPU centroid shader
    const boundsData = new Uint32Array(boundsReadbackBuf.getMappedRange().slice(0));

    // Cropped RGBA and grayscale readback only when not in grayOnly mode
    let croppedData = null;
    let grayData = null;
    if (!grayOnly) {
        // Cropped RGBA type depends on bit depth:
        // - 8-bit: Uint8Array (packed RGBA)
        // - 16-bit: Float32Array (4 floats/pixel, 0-1 range)
        const croppedRawBuffer = croppedReadbackBuf.getMappedRange().slice(0);
        croppedData = bitDepth === 16 ? new Float32Array(croppedRawBuffer) : new Uint8Array(croppedRawBuffer);
        // Grayscale is always Float32
        grayData = new Float32Array(grayReadbackBuf.getMappedRange().slice(0));
    }

    sharpnessReadbackBuf.unmap();
    boundsReadbackBuf.unmap();
    if (!grayOnly) {
        croppedReadbackBuf.unmap();
        grayReadbackBuf.unmap();
    }

    // Build bounds and centers arrays from GPU output
    // Check for cut-off frames (object touching edge) - matches CPU behavior
    const edgeMargin = Math.max(srcWidth, srcHeight) * 0.01;
    const bounds = [];
    const centers = [];
    for (let i = 0; i < batchSize; i++) {
        const minX = boundsData[i * 4];
        const minY = boundsData[i * 4 + 1];
        const maxX = boundsData[i * 4 + 2];
        const maxY = boundsData[i * 4 + 3];

        // DEBUG: Log bounds for first frame
        if (i === 0) {
            const centroidX = (minX + maxX) / 2;
            const centroidY = (minY + maxY) / 2;
            console.log(`[GPU] detectCropAnalyzeBatch bounds[0]: minX=${minX}, minY=${minY}, maxX=${maxX}, maxY=${maxY}, centroid=(${centroidX}, ${centroidY}), srcSize=${srcWidth}x${srcHeight}`);
        }

        if (maxX > minX && maxY > minY) {
            // Check if object is cut off at the edges (1% margin like CPU)
            const isCutOff = minX < edgeMargin || minY < edgeMargin ||
                             maxX > srcWidth - edgeMargin || maxY > srcHeight - edgeMargin;

            if (isCutOff) {
                // Object is cut off - mark as invalid
                console.log(`[GPU] Frame ${i} CUT-OFF: bounds (${minX},${minY})-(${maxX},${maxY}), frame ${srcWidth}x${srcHeight}`);
                centers.push(null);
                bounds.push({ cutOff: true });
            } else {
                const centroidX = (minX + maxX) / 2;
                const centroidY = (minY + maxY) / 2;
                const bboxWidth = maxX - minX;
                const bboxHeight = maxY - minY;
                const circularity = Math.min(bboxWidth, bboxHeight) / Math.max(bboxWidth, bboxHeight);
                centers.push({ x: centroidX, y: centroidY });
                bounds.push({
                    x: minX, y: minY,
                    width: bboxWidth, height: bboxHeight,
                    centroidX, centroidY,
                    size: Math.max(bboxWidth, bboxHeight),
                    circularity
                });
            }
        } else {
            centers.push(null);
            bounds.push(null);
        }
    }

    // Summary of bounds detection
    const cutOffCount = bounds.filter(b => b?.cutOff).length;
    const nullCount = bounds.filter(b => b === null).length;
    const validCount = bounds.filter(b => b && !b.cutOff).length;
    if (cutOffCount > 0 || nullCount > 0) {
        console.log(`[GPU] Bounds summary: ${validCount} valid, ${cutOffCount} cut-off, ${nullCount} no-detection (out of ${batchSize})`);
    }

    // Build results
    const results = [];
    for (let i = 0; i < batchSize; i++) {
        // Read final sharpness values from GPU (already scaled and averaged by sharpnessFinalShader)
        const tenengradMean = sharpnessData[i * 2];
        const laplacianMean = sharpnessData[i * 2 + 1];
        // Combined sharpness = geometric mean of both metrics
        const sharpness = Math.sqrt(tenengradMean * laplacianMean);

        const result = {
            sharpness,
            tenengrad: tenengradMean,
            laplacian: laplacianMean,
            circularity: bounds[i]?.circularity || 0,
            index: frames[i].index,
            bounds: bounds[i],
            centerX: centers[i]?.x,
            centerY: centers[i]?.y,
            width: cropSize,
            height: cropSize,
            cutOff: bounds[i]?.cutOff || false
        };

        // Extract cropped RGBA and grayscale only when not in grayOnly mode
        if (!grayOnly && croppedData) {
            // Return buffer in appropriate format for stacking
            // - 8-bit: uint8Buffer (packed RGBA) - stacker converts to Float32 on GPU
            // - 16-bit: float32Buffer (4 floats/pixel) - preserves precision
            const elementsPerPixel = 4;  // 4 floats or 4 bytes
            const frameRgba = croppedData.slice(i * cropPixelCount * elementsPerPixel, (i + 1) * cropPixelCount * elementsPerPixel);

            if (bitDepth === 16) {
                result.float32Buffer = frameRgba.buffer.slice(frameRgba.byteOffset, frameRgba.byteOffset + frameRgba.byteLength);
            } else {
                result.uint8Buffer = frameRgba.buffer.slice(frameRgba.byteOffset, frameRgba.byteOffset + frameRgba.byteLength);
            }

            // Also extract grayscale for side-by-side preview
            if (grayData) {
                const frameGray = grayData.slice(i * cropPixelCount, (i + 1) * cropPixelCount);
                result.grayBuffer = frameGray.buffer.slice(frameGray.byteOffset, frameGray.byteOffset + frameGray.byteLength);
            }
        }

        results.push(result);
    }

    // Timing stats
    const tEnd = performance.now();
    dcaResultBuildTime += (tEnd - tAfterMapAsync);
    dcaBatchCount++;

    // Log every 10 batches
    if (dcaBatchCount % 10 === 0) {
        console.log(`[GPU Timing] ${dcaBatchCount} batches: upload=${(dcaUploadTime/dcaBatchCount).toFixed(1)}ms, demosaic=${(dcaDemosaicTime/dcaBatchCount).toFixed(1)}ms, blur=${(dcaBlurTime/dcaBatchCount).toFixed(1)}ms, bounds=${(dcaBoundsTime/dcaBatchCount).toFixed(1)}ms, crop=${(dcaCropTime/dcaBatchCount).toFixed(1)}ms, sharpness=${(dcaSharpnessTime/dcaBatchCount).toFixed(1)}ms, mapAsync=${(dcaMapAsyncTime/dcaBatchCount).toFixed(1)}ms`);
    }

    return results;

    } finally {
        releaseBatchSlot();  // Allow next batch to proceed (even on error)
    }
}

// ============================================================
// THUMBNAIL GENERATION (for Bayer pattern selection)
// ============================================================

/**
 * Generate thumbnails for all Bayer patterns from a single raw frame
 * Used by ColorProfileSelector to show demosaic options without loading OpenCV
 */
async function generateBayerThumbnails(rawData, srcWidth, srcHeight, pixelDepth, thumbWidth, thumbHeight) {
    if (!device || !queue) {
        throw new Error('WebGPU not initialized or device lost');
    }
    const patterns = [
        { id: 'COLOR_BayerBG2RGB', pattern: 0 },  // Industry RGGB (OpenCV BG)
        { id: 'COLOR_BayerRG2RGB', pattern: 1 },  // Industry BGGR (OpenCV RG)
        { id: 'COLOR_BayerGB2RGB', pattern: 2 },  // Industry GRBG (OpenCV GB)
        { id: 'COLOR_BayerGR2RGB', pattern: 3 },  // Industry GBRG (OpenCV GR)
        { id: 'MONO', pattern: -1 }
    ];

    const pixelCount = srcWidth * srcHeight;

    // Convert raw data to packed Uint32Array (2 pixels per u32 for 16-bit)
    const u32Count = Math.ceil(pixelCount / 2);
    let inputData = new Uint32Array(u32Count);
    const u16View = new Uint16Array(inputData.buffer);

    if (pixelDepth > 8) {
        // 16-bit: direct copy using TypedArray.set
        const src = new Uint16Array(rawData);
        u16View.set(src);
    } else {
        // 8-bit: scale to 16-bit range
        const src = new Uint8Array(rawData);
        for (let i = 0; i < pixelCount; i++) {
            u16View[i] = src[i] << 8;
        }
    }

    // Create GPU buffers
    // Note: Demosaic outputs Float32 RGBA (16 bytes/pixel) when bitDepth=16
    // We use bitDepth=16 for input reading, so output is Float32
    const outputBytesPerPixel = 16;  // Float32 RGBA

    const inputBuffer = storageBuffer(device, u32Count * 4, { copyDst: true });
    queue.writeBuffer(inputBuffer, 0, inputData);

    const outputBuffer = storageBuffer(device, pixelCount * outputBytesPerPixel, { copySrc: true });  // Float32 RGBA output
    const readbackBuf = readbackBuffer(device, pixelCount * outputBytesPerPixel);
    const paramsBuffer = uniformBuffer(device, 32);  // 8 u32 values for demosaic params

    const results = [];

    for (const { id, pattern } of patterns) {
        let fullRgba;

        if (pattern === -1) {
            // Mono: convert raw to grayscale RGBA directly
            fullRgba = new Uint8ClampedArray(pixelCount * 4);
            const src = pixelDepth > 8 ? new Uint16Array(rawData) : new Uint8Array(rawData);
            const scale = pixelDepth > 8 ? 1/256 : 1;
            for (let i = 0; i < pixelCount; i++) {
                const v = Math.min(255, Math.max(0, Math.round(src[i] * scale)));
                fullRgba[i * 4] = v;
                fullRgba[i * 4 + 1] = v;
                fullRgba[i * 4 + 2] = v;
                fullRgba[i * 4 + 3] = 255;
            }
        } else {
            // Demosaic with GPU (use bilinear for thumbnails for speed)
            // bitDepth=16 since 8-bit data was already scaled to 16-bit range above, scale=1.0
            const paramsData = new ArrayBuffer(32);
            new Uint32Array(paramsData).set([srcWidth, srcHeight, 1, pattern, 0, 16, 0, 0]);
            new Float32Array(paramsData)[6] = 1.0;  // No stretch needed
            queue.writeBuffer(paramsBuffer, 0, paramsData);

            const bindGroup = createBindGroup(device, demosaicPipeline, [paramsBuffer, inputBuffer, outputBuffer]);
            const encoder = device.createCommandEncoder();
            addComputePass(encoder, demosaicPipeline, bindGroup, imageWorkgroups(srcWidth, srcHeight, 1));
            encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuf, 0, pixelCount * outputBytesPerPixel);
            logGpuSubmit('singleFrame:demosaic');
            queue.submit([encoder.finish()]);

            await safeMapAsync(readbackBuf, GPUMapMode.READ);
            // Demosaic outputs Float32 RGBA (4 floats per pixel, values 0-1)
            // Convert to Uint8 for thumbnail display
            const float32Data = new Float32Array(readbackBuf.getMappedRange().slice(0));
            readbackBuf.unmap();

            fullRgba = new Uint8ClampedArray(pixelCount * 4);
            for (let i = 0; i < pixelCount; i++) {
                const srcIdx = i * 4;
                const dstIdx = i * 4;
                fullRgba[dstIdx] = Math.min(255, Math.max(0, Math.round(float32Data[srcIdx] * 255)));
                fullRgba[dstIdx + 1] = Math.min(255, Math.max(0, Math.round(float32Data[srcIdx + 1] * 255)));
                fullRgba[dstIdx + 2] = Math.min(255, Math.max(0, Math.round(float32Data[srcIdx + 2] * 255)));
                fullRgba[dstIdx + 3] = 255;
            }
        }

        // Auto-stretch: find min/max and normalize
        let minVal = 255, maxVal = 0;
        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 4;
            const lum = (fullRgba[idx] + fullRgba[idx + 1] + fullRgba[idx + 2]) / 3;
            minVal = Math.min(minVal, lum);
            maxVal = Math.max(maxVal, lum);
        }
        const range = maxVal - minVal || 1;
        const scale = 255 / range;

        // Resize to thumbnail (simple bilinear)
        const thumbRgba = new Uint8ClampedArray(thumbWidth * thumbHeight * 4);
        const xRatio = srcWidth / thumbWidth;
        const yRatio = srcHeight / thumbHeight;

        for (let ty = 0; ty < thumbHeight; ty++) {
            for (let tx = 0; tx < thumbWidth; tx++) {
                const srcX = tx * xRatio;
                const srcY = ty * yRatio;
                const x0 = Math.floor(srcX);
                const y0 = Math.floor(srcY);
                const x1 = Math.min(x0 + 1, srcWidth - 1);
                const y1 = Math.min(y0 + 1, srcHeight - 1);
                const xFrac = srcX - x0;
                const yFrac = srcY - y0;

                const tidx = (ty * thumbWidth + tx) * 4;

                for (let c = 0; c < 3; c++) {
                    const i00 = (y0 * srcWidth + x0) * 4 + c;
                    const i01 = (y0 * srcWidth + x1) * 4 + c;
                    const i10 = (y1 * srcWidth + x0) * 4 + c;
                    const i11 = (y1 * srcWidth + x1) * 4 + c;

                    // Bilinear interpolation
                    const v = (fullRgba[i00] * (1 - xFrac) * (1 - yFrac) +
                               fullRgba[i01] * xFrac * (1 - yFrac) +
                               fullRgba[i10] * (1 - xFrac) * yFrac +
                               fullRgba[i11] * xFrac * yFrac);

                    // Auto-stretch
                    thumbRgba[tidx + c] = Math.min(255, Math.max(0, Math.round((v - minVal) * scale)));
                }
                thumbRgba[tidx + 3] = 255;
            }
        }

        results.push({ id, rgba: thumbRgba.buffer });
    }

    // Cleanup
    inputBuffer.destroy();
    outputBuffer.destroy();
    readbackBuf.destroy();
    paramsBuffer.destroy();

    return results;
}

// Demosaic a single frame and scale to target size (for comparison video pre-crop frames)
// Reuses the thumbnail scaling logic from generateBayerThumbnails
async function demosaicAndScale(rawData, srcWidth, srcHeight, targetWidth, targetHeight, bayerPattern) {
    // Call generateBayerThumbnails with just the one pattern we need
    const results = await generateBayerThumbnails(
        rawData, srcWidth, srcHeight,
        rawData.byteLength / (srcWidth * srcHeight) > 1 ? 16 : 8,  // pixelDepth
        targetWidth, targetHeight
    );

    // Find the result for our pattern (indices: 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG)
    const patternIds = ['COLOR_BayerBG2RGB', 'COLOR_BayerRG2RGB', 'COLOR_BayerGB2RGB', 'COLOR_BayerGR2RGB', 'MONO'];
    const patternId = bayerPattern < 0 ? 'MONO' : patternIds[bayerPattern] || patternIds[0];
    const result = results.find(r => r.id === patternId);

    return result ? result.rgba : results[0].rgba;
}

// ============================================================
// MESSAGE HANDLING
// ============================================================

self.addEventListener('message', async (e) => {
    const { type } = e.data;

    if (type === 'init') {
        try {
            await init();
            self.postMessage({ type: 'ready' });
        } catch (err) {
            self.postMessage({ type: 'init-error', error: err.message });
        }
        return;
    }

    if (type === 'print-gpu-timing') {
        printGpuTimingSummary();
        self.postMessage({ type: 'gpu-timing-printed' });
        return;
    }

    if (type === 'set-gpu-timing') {
        gpuTimingEnabled = e.data.enabled;
        console.log(`[GPU] Timing ${gpuTimingEnabled ? 'enabled' : 'disabled'}`);
        return;
    }

    if (type === 'get-max-batch-size') {
        const { width, height, bitDepth = 8 } = e.data;
        // maxBufferSize applies to each buffer individually, not the total. Bound
        // batchSize by the largest per-frame buffer only, otherwise we're over-
        // conservative by ~2× and force needless chunking on capable devices.
        const largestPerFrame = calcLargestPerFrameBufferBytes(width, height, bitDepth);
        const perFrameBytes = calcPerFrameBufferBytes(width, height, bitDepth);  // reported for diagnostics
        const maxBufferSize = device ? device.limits.maxBufferSize : (256 * 1024 * 1024);
        const maxBatch = Math.max(1, Math.floor(maxBufferSize / (largestPerFrame * 1.2)));
        self.postMessage({ type: 'max-batch-size', maxBatch, perFrameBytes, maxBufferSize });
        return;
    }

    if (type === 'analyze-batch') {
        if (!isReady) {
            self.postMessage({ type: 'analyze-error', error: 'Not initialized' });
            return;
        }

        const { frames, width, height, bayerPattern, threshold, requestId, metadataOnly, grayOnly = false } = e.data;

        try {
            const results = await analyzeBatch(frames, width, height, bayerPattern, threshold, metadataOnly, grayOnly);
            // Transfer uint8Buffer or float32Buffer depending on mode (none in grayOnly mode)
            const transferables = results.map(r => r.uint8Buffer || r.float32Buffer).filter(b => b);
            self.postMessage({ type: 'analyze-result', requestId, results }, transferables);
        } catch (err) {
            console.error(`[GPU] analyze-batch error:`, err);
            // analyze-error is already routed to reportError in the composable — don't
            // double-report via the log listener.
            self.postMessage({ type: 'analyze-error', requestId, error: err.message });
        }
        return;
    }

    if (type === 'crop-analyze-batch') {
        if (!isReady) {
            self.postMessage({ type: 'crop-analyze-error', error: 'Not initialized', requestId: e.data.requestId });
            return;
        }

        const { frames, srcWidth, srcHeight, cropSize, centers, bayerPattern, threshold, requestId, metadataOnly } = e.data;

        try {
            const results = await cropAndAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, centers, bayerPattern, threshold, metadataOnly);
            // Transfer uint8Buffer or float32Buffer depending on mode
            const transferables = results.map(r => r.uint8Buffer || r.float32Buffer).filter(b => b);
            self.postMessage({ type: 'crop-analyze-result', requestId, results }, transferables);
        } catch (err) {
            console.error(`[GPU] crop-analyze-batch error:`, err);
            self.postMessage({ type: 'crop-analyze-error', requestId, error: err.message });
        }
        return;
    }

    if (type === 'detect-crop-analyze-batch') {
        if (!isReady) {
            self.postMessage({ type: 'detect-crop-analyze-error', error: 'Not initialized', requestId: e.data.requestId });
            return;
        }

        const { frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold, requestId, metadataOnly, grayOnly = false, nextBatchFrames = null } = e.data;

        try {
            const results = await detectCropAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold, metadataOnly, grayOnly, nextBatchFrames);
            // Transfer uint8Buffer or float32Buffer depending on mode (none in grayOnly mode)
            const transferables = results.map(r => r.uint8Buffer || r.float32Buffer).filter(b => b);
            self.postMessage({ type: 'detect-crop-analyze-result', requestId, results }, transferables);
        } catch (err) {
            console.error(`[GPU] detect-crop-analyze-batch error:`, err);
            self.postMessage({ type: 'detect-crop-analyze-error', requestId, error: err.message });
        }
        return;
    }

    if (type === 'demosaic-thumbnails') {
        if (!isReady) {
            self.postMessage({ type: 'demosaic-thumbnails-error', error: 'Not initialized' });
            return;
        }

        const { rawData, width, height, pixelDepth, thumbWidth, thumbHeight } = e.data;

        try {
            const results = await generateBayerThumbnails(rawData, width, height, pixelDepth, thumbWidth, thumbHeight);
            self.postMessage({ type: 'demosaic-thumbnails-result', results },
                results.map(r => r.rgba));
        } catch (err) {
            console.error('[GPU] demosaic-thumbnails error:', err);
            // No composable listens for demosaic-thumbnails-error — route through
            // the log listener so it still reaches the user log and Sentry.
            self.postMessage({ type: 'log', level: 'error', message: `GPU demosaic-thumbnails failed: ${err.message}` });
            self.postMessage({ type: 'demosaic-thumbnails-error', error: err.message });
        }
        return;
    }

    // Demosaic a single frame and scale to target size (for comparison video pre-crop frames)
    if (type === 'demosaic-scaled') {
        if (!isReady) {
            self.postMessage({ type: 'demosaic-scaled-error', error: 'Not initialized', requestId: e.data.requestId });
            return;
        }

        const { rawData, srcWidth, srcHeight, targetWidth, targetHeight, bayerPattern, requestId } = e.data;

        try {
            const result = await demosaicAndScale(rawData, srcWidth, srcHeight, targetWidth, targetHeight, bayerPattern);
            self.postMessage({ type: 'demosaic-scaled-result', requestId, rgba: result }, [result]);
        } catch (err) {
            console.error('[GPU] demosaic-scaled error:', err);
            self.postMessage({ type: 'demosaic-scaled-error', requestId, error: err.message });
        }
        return;
    }

    if (type === 'cleanup') {
        cleanupAnalyzeBuffers();
        if (cachedCropBuffers) {
            Object.values(cachedCropBuffers).forEach(buf => {
                if (buf && buf.destroy) buf.destroy();
            });
            cachedCropBuffers = null;
            cachedCropConfig = null;
        }
        // Reset batch concurrency state
        activeBatchCount = 0;
        batchWaiters = [];
        self.postMessage({ type: 'cleanup-done' });
        return;
    }
});

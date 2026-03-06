// WebGPU Batched Frame Analysis Worker
// Handles: Demosaic, Sharpness (Tenengrad), Circularity (Moments)
console.log('webgpu_analyze_worker.js loaded (v1)');

let device = null;
let queue = null;
let isReady = false;
let deviceLost = false; // Track if GPU device was lost
let reinitializing = false; // Prevent concurrent reinit attempts
let reinitAttempts = 0;
const MAX_REINIT_ATTEMPTS = 3;

// Concurrency control for detectCropAnalyzeBatch (limit to match double-buffering)
const MAX_CONCURRENT_BATCHES = 2;
let activeBatchCount = 0;
let batchWaiters = [];

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
        await buffer.mapAsync(mode);
    } catch (err) {
        // Check for device lost errors (various error messages from different browsers/drivers)
        if (err.message && (err.message.includes('Instance reference') || err.message.includes('Device') && err.message.includes('lost'))) {
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
    return frames[0]?.data instanceof Uint16Array ? 16 : 8;
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

        // Calculate stretch scale (GPU will apply it)
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
            if (p99 > 0 && p99 < 32768) {
                scale16bit = Math.min(32768 / p99, 2.0);
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
let grayscalePipeline = null;
let tenengradPipeline = null;
let offsetTenengradPipeline = null;  // Reads from full-frame with per-frame offsets (no crop needed)
let reductionPipeline = null;
let momentsPipeline = null;
let momentsReductionPipeline = null;
let boundsPipeline = null;
let boundsReductionPipeline = null;
let centroidPipeline = null;

// Cached buffers for reuse across batches
let cachedAnalyzeBuffers = null;
let cachedAnalyzeConfig = null;

// Pipelined upload state - allows uploading next batch while GPU processes current
let pipelinedUpload = {
    ready: false,           // True if data is pre-uploaded in alternate buffer
    useAltBuffer: false,    // Which buffer has the pre-uploaded data
    bayerData: null,        // The prepared Bayer data (already packed)
    scale: 1.0,             // Scale factor for the pre-uploaded data
    batchSize: 0,           // Batch size of pre-uploaded data
};

// ============================================================
// WGSL SHADERS
// ============================================================

// Demosaic shader - converts Bayer pattern to RGB (supports bilinear and VNG)
const demosaicShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    bayerPattern: u32,  // 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
    useVng: u32,        // 0=bilinear, 1=VNG
    bitDepth: u32,      // 8 or 16
    scale: f32,         // stretch scale for 16-bit (1.0 = no stretch)
    _pad3: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;  // Raw Bayer data (packed: 4 pixels/u32 for 8-bit, 2 pixels/u32 for 16-bit)
@group(0) @binding(2) var<storage, read_write> output: array<u32>;  // RGBA output

fn getBayerValue(frameIdx: u32, x: u32, y: u32) -> f32 {
    let pixelIdx = frameIdx * params.width * params.height + y * params.width + x;
    if (params.bitDepth == 8u) {
        // 8-bit packed: 4 pixels per u32
        let u32Idx = pixelIdx / 4u;
        let bytePos = pixelIdx % 4u;
        let packed = input[u32Idx];
        let rawValue = (packed >> (bytePos * 8u)) & 0xFFu;
        return f32(rawValue) / 255.0;
    } else {
        // 16-bit packed: 2 pixels per u32, with GPU-side stretch
        let u32Idx = pixelIdx / 2u;
        let halfPos = pixelIdx % 2u;
        let packed = input[u32Idx];
        let rawValue = select(packed & 0xFFFFu, packed >> 16u, halfPos == 1u);
        return min(1.0, f32(rawValue) * params.scale / 65535.0);
    }
}

fn sampleBayer(frameIdx: u32, x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(params.width) - 1);
    let cy = clamp(y, 0, i32(params.height) - 1);
    return getBayerValue(frameIdx, u32(cx), u32(cy));
}

// VNG gradient computation - computes gradient in a given direction
fn computeGradient(frameIdx: u32, x: i32, y: i32, dx: i32, dy: i32) -> f32 {
    // Gradient = sum of absolute differences along the direction
    var grad: f32 = 0.0;
    grad += abs(sampleBayer(frameIdx, x, y) - sampleBayer(frameIdx, x + dx, y + dy));
    grad += abs(sampleBayer(frameIdx, x + dx, y + dy) - sampleBayer(frameIdx, x + dx * 2, y + dy * 2));
    return grad;
}

// VNG interpolation for missing colors
// Returns (r, g, b) using gradient-weighted interpolation
fn vngInterpolate(frameIdx: u32, x: i32, y: i32, bx: u32, by: u32, pattern: u32) -> vec3<f32> {
    // Compute gradients in 8 directions: N, S, E, W, NE, NW, SE, SW
    let gN = computeGradient(frameIdx, x, y, 0, -1);
    let gS = computeGradient(frameIdx, x, y, 0, 1);
    let gE = computeGradient(frameIdx, x, y, 1, 0);
    let gW = computeGradient(frameIdx, x, y, -1, 0);
    let gNE = computeGradient(frameIdx, x, y, 1, -1);
    let gNW = computeGradient(frameIdx, x, y, -1, -1);
    let gSE = computeGradient(frameIdx, x, y, 1, 1);
    let gSW = computeGradient(frameIdx, x, y, -1, 1);

    // Find minimum gradient and set threshold
    var minGrad = min(min(min(gN, gS), min(gE, gW)), min(min(gNE, gNW), min(gSE, gSW)));
    let threshold = minGrad * 1.5 + 0.001;  // Small epsilon to avoid division issues

    // Current pixel value
    let center = sampleBayer(frameIdx, x, y);

    var r: f32 = 0.0;
    var g: f32 = 0.0;
    var b: f32 = 0.0;

    // Determine what color the current pixel is and interpolate missing colors
    // using gradient-weighted averaging

    // Sample neighbors for interpolation
    let n = sampleBayer(frameIdx, x, y - 1);
    let s = sampleBayer(frameIdx, x, y + 1);
    let e = sampleBayer(frameIdx, x + 1, y);
    let w = sampleBayer(frameIdx, x - 1, y);
    let ne = sampleBayer(frameIdx, x + 1, y - 1);
    let nw = sampleBayer(frameIdx, x - 1, y - 1);
    let se = sampleBayer(frameIdx, x + 1, y + 1);
    let sw = sampleBayer(frameIdx, x - 1, y + 1);

    // Gradient weights (inverse, so low gradient = high weight)
    let wN = select(0.0, 1.0 / (gN + 0.001), gN <= threshold);
    let wS = select(0.0, 1.0 / (gS + 0.001), gS <= threshold);
    let wE = select(0.0, 1.0 / (gE + 0.001), gE <= threshold);
    let wW = select(0.0, 1.0 / (gW + 0.001), gW <= threshold);
    let wNE = select(0.0, 1.0 / (gNE + 0.001), gNE <= threshold);
    let wNW = select(0.0, 1.0 / (gNW + 0.001), gNW <= threshold);
    let wSE = select(0.0, 1.0 / (gSE + 0.001), gSE <= threshold);
    let wSW = select(0.0, 1.0 / (gSW + 0.001), gSW <= threshold);

    // Use pattern-specific VNG interpolation
    // For each pixel type, we interpolate missing colors using gradient-weighted neighbors

    if (pattern == 0u) { // RGGB
        if (bx == 0u && by == 0u) { // R pixel
            r = center;
            // Green: use weighted average of NSEW green neighbors
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            // Blue: use weighted average of diagonal blue neighbors
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 1u && by == 1u) { // B pixel
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 1u && by == 0u) { // G pixel (R row)
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        } else { // G pixel (B row)
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        }
    } else if (pattern == 1u) { // BGGR
        if (bx == 0u && by == 0u) { // B pixel
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 1u && by == 1u) { // R pixel
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 1u && by == 0u) { // G pixel (B row)
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        } else { // G pixel (R row)
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        }
    } else if (pattern == 2u) { // GRBG
        if (bx == 1u && by == 0u) { // R pixel
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 0u && by == 1u) { // B pixel
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 0u && by == 0u) { // G pixel (R row)
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        } else { // G pixel (B row)
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        }
    } else { // GBRG (pattern == 3)
        if (bx == 0u && by == 1u) { // R pixel
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 1u && by == 0u) { // B pixel
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 0u && by == 0u) { // G pixel (B row)
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        } else { // G pixel (R row)
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        }
    }

    return vec3<f32>(r, g, b);
}

// Bilinear interpolation (original simple demosaic)
fn bilinearInterpolate(frameIdx: u32, x: i32, y: i32, bx: u32, by: u32, pattern: u32) -> vec3<f32> {
    var r: f32 = 0.0;
    var g: f32 = 0.0;
    var b: f32 = 0.0;

    if (pattern == 0u) { // RGGB
        if (bx == 0u && by == 0u) { // R pixel
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 1u) { // B pixel
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 0u) { // G pixel (R row)
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else { // G pixel (B row)
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    } else if (pattern == 1u) { // BGGR
        if (bx == 0u && by == 0u) { // B pixel
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 1u) { // R pixel
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 0u) { // G pixel (B row)
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else { // G pixel (R row)
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    } else if (pattern == 2u) { // GRBG
        if (bx == 1u && by == 0u) { // R pixel
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 0u && by == 1u) { // B pixel
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 0u && by == 0u) { // G pixel (R row)
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else { // G pixel (B row)
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    } else { // GBRG (pattern == 3)
        if (bx == 0u && by == 1u) { // R pixel
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 0u) { // B pixel
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 0u && by == 0u) { // G pixel (B row)
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else { // G pixel (R row)
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    }

    return vec3<f32>(r, g, b);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let frameIdx = gid.z;

    if (x >= params.width || y >= params.height || frameIdx >= params.batchSize) {
        return;
    }

    // Determine pixel position in Bayer pattern
    let bx = x % 2u;
    let by = y % 2u;
    let ix = i32(x);
    let iy = i32(y);

    let pattern = params.bayerPattern;

    // Use VNG or bilinear interpolation based on params
    var rgb: vec3<f32>;
    if (params.useVng == 1u) {
        rgb = vngInterpolate(frameIdx, ix, iy, bx, by, pattern);
    } else {
        rgb = bilinearInterpolate(frameIdx, ix, iy, bx, by, pattern);
    }

    let outIdx = frameIdx * params.width * params.height + y * params.width + x;

    if (params.bitDepth == 16u) {
        // 16-bit input: output Float32 RGBA to preserve precision through stacking
        // Stacker receives Float32 directly (inputFormat=0)
        let baseIdx = outIdx * 4u;
        output[baseIdx] = bitcast<u32>(rgb.x);
        output[baseIdx + 1u] = bitcast<u32>(rgb.y);
        output[baseIdx + 2u] = bitcast<u32>(rgb.z);
        output[baseIdx + 3u] = bitcast<u32>(1.0);
    } else {
        // 8-bit input: pack as Uint8 RGBA (saves memory, stacker converts to Float32 on GPU)
        // Stacker receives Uint8 and converts via inputFormat=1
        let ri = u32(clamp(rgb.x * 255.0, 0.0, 255.0));
        let gi = u32(clamp(rgb.y * 255.0, 0.0, 255.0));
        let bi = u32(clamp(rgb.z * 255.0, 0.0, 255.0));
        let rgba = ri | (gi << 8u) | (bi << 16u) | (255u << 24u);
        output[outIdx] = rgba;
    }
}
`;

// Demosaic + Crop shader - crops around per-frame centers during demosaic (supports bilinear and VNG)
const demosaicCropShader = `
struct Params {
    srcWidth: u32,      // Source frame width
    srcHeight: u32,     // Source frame height
    cropSize: u32,      // Output crop size (square)
    bayerPattern: u32,  // 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
    batchSize: u32,
    useVng: u32,        // 0=bilinear, 1=VNG
    bitDepth: u32,      // 8 or 16
    scale: f32,         // stretch scale for 16-bit (1.0 = no stretch)
}

struct CropCenter {
    x: f32,
    y: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;      // Raw Bayer data
@group(0) @binding(2) var<storage, read> centers: array<CropCenter>;  // Per-frame centers
@group(0) @binding(3) var<storage, read_write> output: array<u32>;    // Cropped RGBA output
@group(0) @binding(4) var<storage, read_write> grayOutput: array<atomic<u32>>;  // Packed grayscale (4 pixels per u32)

fn getBayerValue(frameIdx: u32, x: u32, y: u32) -> f32 {
    let pixelIdx = frameIdx * params.srcWidth * params.srcHeight + y * params.srcWidth + x;
    if (params.bitDepth == 8u) {
        // 8-bit packed: 4 pixels per u32
        let u32Idx = pixelIdx / 4u;
        let bytePos = pixelIdx % 4u;
        let packed = input[u32Idx];
        let rawValue = (packed >> (bytePos * 8u)) & 0xFFu;
        return f32(rawValue) / 255.0;
    } else {
        // 16-bit packed: 2 pixels per u32, with GPU-side stretch
        let u32Idx = pixelIdx / 2u;
        let halfPos = pixelIdx % 2u;
        let packed = input[u32Idx];
        let rawValue = select(packed & 0xFFFFu, packed >> 16u, halfPos == 1u);
        return min(1.0, f32(rawValue) * params.scale / 65535.0);
    }
}

fn sampleBayer(frameIdx: u32, x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(params.srcWidth) - 1);
    let cy = clamp(y, 0, i32(params.srcHeight) - 1);
    return getBayerValue(frameIdx, u32(cx), u32(cy));
}

// VNG gradient computation
fn computeGradient(frameIdx: u32, x: i32, y: i32, dx: i32, dy: i32) -> f32 {
    var grad: f32 = 0.0;
    grad += abs(sampleBayer(frameIdx, x, y) - sampleBayer(frameIdx, x + dx, y + dy));
    grad += abs(sampleBayer(frameIdx, x + dx, y + dy) - sampleBayer(frameIdx, x + dx * 2, y + dy * 2));
    return grad;
}

// VNG interpolation
fn vngInterpolate(frameIdx: u32, x: i32, y: i32, bx: u32, by: u32, pattern: u32) -> vec3<f32> {
    let gN = computeGradient(frameIdx, x, y, 0, -1);
    let gS = computeGradient(frameIdx, x, y, 0, 1);
    let gE = computeGradient(frameIdx, x, y, 1, 0);
    let gW = computeGradient(frameIdx, x, y, -1, 0);
    let gNE = computeGradient(frameIdx, x, y, 1, -1);
    let gNW = computeGradient(frameIdx, x, y, -1, -1);
    let gSE = computeGradient(frameIdx, x, y, 1, 1);
    let gSW = computeGradient(frameIdx, x, y, -1, 1);

    var minGrad = min(min(min(gN, gS), min(gE, gW)), min(min(gNE, gNW), min(gSE, gSW)));
    let threshold = minGrad * 1.5 + 0.001;

    let center = sampleBayer(frameIdx, x, y);
    var r: f32 = 0.0;
    var g: f32 = 0.0;
    var b: f32 = 0.0;

    let n = sampleBayer(frameIdx, x, y - 1);
    let s = sampleBayer(frameIdx, x, y + 1);
    let e = sampleBayer(frameIdx, x + 1, y);
    let w = sampleBayer(frameIdx, x - 1, y);
    let ne = sampleBayer(frameIdx, x + 1, y - 1);
    let nw = sampleBayer(frameIdx, x - 1, y - 1);
    let se = sampleBayer(frameIdx, x + 1, y + 1);
    let sw = sampleBayer(frameIdx, x - 1, y + 1);

    let wN = select(0.0, 1.0 / (gN + 0.001), gN <= threshold);
    let wS = select(0.0, 1.0 / (gS + 0.001), gS <= threshold);
    let wE = select(0.0, 1.0 / (gE + 0.001), gE <= threshold);
    let wW = select(0.0, 1.0 / (gW + 0.001), gW <= threshold);
    let wNE = select(0.0, 1.0 / (gNE + 0.001), gNE <= threshold);
    let wNW = select(0.0, 1.0 / (gNW + 0.001), gNW <= threshold);
    let wSE = select(0.0, 1.0 / (gSE + 0.001), gSE <= threshold);
    let wSW = select(0.0, 1.0 / (gSW + 0.001), gSW <= threshold);

    if (pattern == 0u) { // RGGB
        if (bx == 0u && by == 0u) {
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 1u && by == 1u) {
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 1u && by == 0u) {
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        } else {
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        }
    } else if (pattern == 1u) { // BGGR
        if (bx == 0u && by == 0u) {
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 1u && by == 1u) {
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 1u && by == 0u) {
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        } else {
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        }
    } else if (pattern == 2u) { // GRBG
        if (bx == 1u && by == 0u) {
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 0u && by == 1u) {
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 0u && by == 0u) {
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        } else {
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        }
    } else { // GBRG
        if (bx == 0u && by == 1u) {
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 1u && by == 0u) {
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 0u && by == 0u) {
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        } else {
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        }
    }
    return vec3<f32>(r, g, b);
}

// Bilinear interpolation
fn bilinearInterpolate(frameIdx: u32, x: i32, y: i32, bx: u32, by: u32, pattern: u32) -> vec3<f32> {
    var r: f32 = 0.0;
    var g: f32 = 0.0;
    var b: f32 = 0.0;

    if (pattern == 0u) { // RGGB
        if (bx == 0u && by == 0u) {
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 1u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 0u) {
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    } else if (pattern == 1u) { // BGGR
        if (bx == 0u && by == 0u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 1u) {
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 0u) {
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    } else if (pattern == 2u) { // GRBG
        if (bx == 1u && by == 0u) {
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 0u && by == 1u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 0u && by == 0u) {
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    } else { // GBRG
        if (bx == 0u && by == 1u) {
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 0u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 0u && by == 0u) {
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    }
    return vec3<f32>(r, g, b);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let outX = gid.x;
    let outY = gid.y;
    let frameIdx = gid.z;

    if (outX >= params.cropSize || outY >= params.cropSize || frameIdx >= params.batchSize) {
        return;
    }

    let center = centers[frameIdx];
    let halfSize = f32(params.cropSize) / 2.0;
    let cropStartX = i32(floor(center.x - halfSize)) & ~1;
    let cropStartY = i32(floor(center.y - halfSize)) & ~1;

    let srcX = cropStartX + i32(outX);
    let srcY = cropStartY + i32(outY);

    let x = u32(clamp(srcX, 0, i32(params.srcWidth) - 1));
    let y = u32(clamp(srcY, 0, i32(params.srcHeight) - 1));
    let ix = i32(x);
    let iy = i32(y);

    let bx = x % 2u;
    let by = y % 2u;
    let pattern = params.bayerPattern;

    // Use VNG or bilinear interpolation based on params
    var rgb: vec3<f32>;
    if (params.useVng == 1u) {
        rgb = vngInterpolate(frameIdx, ix, iy, bx, by, pattern);
    } else {
        rgb = bilinearInterpolate(frameIdx, ix, iy, bx, by, pattern);
    }

    let outIdx = frameIdx * params.cropSize * params.cropSize + outY * params.cropSize + outX;

    // Compute grayscale (Rec. 601 luma) - used for template matching
    let gray = u32(clamp((0.299 * rgb.x + 0.587 * rgb.y + 0.114 * rgb.z) * 255.0, 0.0, 255.0));

    // Pack grayscale: 4 pixels per u32, use atomic OR since threads write to same u32
    let grayPackedIdx = outIdx >> 2u;           // outIdx / 4
    let grayByteOffset = (outIdx & 3u) << 3u;   // (outIdx % 4) * 8
    atomicOr(&grayOutput[grayPackedIdx], gray << grayByteOffset);

    if (params.bitDepth == 16u) {
        // 16-bit: output Float32 RGBA (4 u32s per pixel via bitcast)
        let baseIdx = outIdx * 4u;
        output[baseIdx] = bitcast<u32>(rgb.x);
        output[baseIdx + 1u] = bitcast<u32>(rgb.y);
        output[baseIdx + 2u] = bitcast<u32>(rgb.z);
        output[baseIdx + 3u] = bitcast<u32>(1.0);
    } else {
        // 8-bit: pack as RGBA (1 u32 per pixel)
        let ri = u32(clamp(rgb.x * 255.0, 0.0, 255.0));
        let gi = u32(clamp(rgb.y * 255.0, 0.0, 255.0));
        let bi = u32(clamp(rgb.z * 255.0, 0.0, 255.0));
        let rgba = ri | (gi << 8u) | (bi << 16u) | (255u << 24u);
        output[outIdx] = rgba;
    }
}
`;

// RGBA Crop shader - crops RGBA images without demosaicing (for PNG/JPEG input)
const rgbaCropShader = `
struct Params {
    srcWidth: u32,
    srcHeight: u32,
    cropSize: u32,
    _pad1: u32,
    batchSize: u32,
    _pad2: u32,
    _pad3: u32,
    _pad4: u32,
}

struct CropCenter {
    x: f32,
    y: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;       // Source RGBA
@group(0) @binding(2) var<storage, read> centers: array<CropCenter>;
@group(0) @binding(3) var<storage, read_write> output: array<u32>; // Cropped RGBA
@group(0) @binding(4) var<storage, read_write> grayOutput: array<atomic<u32>>;  // Packed grayscale (4 pixels per u32)

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let outX = gid.x;
    let outY = gid.y;
    let frameIdx = gid.z;

    if (outX >= params.cropSize || outY >= params.cropSize || frameIdx >= params.batchSize) {
        return;
    }

    let center = centers[frameIdx];
    let halfSize = f32(params.cropSize) / 2.0;
    let cropStartX = i32(floor(center.x - halfSize));
    let cropStartY = i32(floor(center.y - halfSize));

    let srcX = u32(clamp(cropStartX + i32(outX), 0, i32(params.srcWidth) - 1));
    let srcY = u32(clamp(cropStartY + i32(outY), 0, i32(params.srcHeight) - 1));

    let srcIdx = frameIdx * params.srcWidth * params.srcHeight + srcY * params.srcWidth + srcX;
    let outIdx = frameIdx * params.cropSize * params.cropSize + outY * params.cropSize + outX;

    let rgba = input[srcIdx];
    output[outIdx] = rgba;

    // Compute grayscale and pack (4 pixels per u32, use atomic OR)
    let r = f32(rgba & 0xFFu);
    let g = f32((rgba >> 8u) & 0xFFu);
    let b = f32((rgba >> 16u) & 0xFFu);
    let gray = u32(clamp(0.299 * r + 0.587 * g + 0.114 * b, 0.0, 255.0));

    let grayPackedIdx = outIdx >> 2u;
    let grayByteOffset = (outIdx & 3u) << 3u;
    atomicOr(&grayOutput[grayPackedIdx], gray << grayByteOffset);
}
`;

// Grayscale conversion shader
const grayscaleShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;  // RGBA
@group(0) @binding(2) var<storage, read_write> output: array<f32>;  // Grayscale float

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let frameIdx = gid.z;

    if (x >= params.width || y >= params.height || frameIdx >= params.batchSize) {
        return;
    }

    let idx = frameIdx * params.width * params.height + y * params.width + x;
    let rgba = input[idx];

    let r = f32(rgba & 0xFFu) / 255.0;
    let g = f32((rgba >> 8u) & 0xFFu) / 255.0;
    let b = f32((rgba >> 16u) & 0xFFu) / 255.0;

    // Standard grayscale weights
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    output[idx] = gray;
}
`;

// Fused demosaic + grayscale shader - outputs both RGBA and grayscale in one pass (supports bilinear and VNG)
const demosaicGrayShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    bayerPattern: u32,
    useVng: u32,        // 0=bilinear, 1=VNG
    bitDepth: u32,      // 8 or 16
    scale: f32,         // stretch scale for 16-bit (1.0 = no stretch)
    _pad3: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read_write> rgbaOutput: array<u32>;
@group(0) @binding(3) var<storage, read_write> grayOutput: array<f32>;

fn getBayerValue(frameIdx: u32, x: u32, y: u32) -> f32 {
    let pixelIdx = frameIdx * params.width * params.height + y * params.width + x;
    if (params.bitDepth == 8u) {
        // 8-bit packed: 4 pixels per u32
        let u32Idx = pixelIdx / 4u;
        let bytePos = pixelIdx % 4u;
        let packed = input[u32Idx];
        let rawValue = (packed >> (bytePos * 8u)) & 0xFFu;
        return f32(rawValue) / 255.0;
    } else {
        // 16-bit packed: 2 pixels per u32, with GPU-side stretch
        let u32Idx = pixelIdx / 2u;
        let halfPos = pixelIdx % 2u;
        let packed = input[u32Idx];
        let rawValue = select(packed & 0xFFFFu, packed >> 16u, halfPos == 1u);
        return min(1.0, f32(rawValue) * params.scale / 65535.0);
    }
}

fn sampleBayer(frameIdx: u32, x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(params.width) - 1);
    let cy = clamp(y, 0, i32(params.height) - 1);
    return getBayerValue(frameIdx, u32(cx), u32(cy));
}

fn computeGradient(frameIdx: u32, x: i32, y: i32, dx: i32, dy: i32) -> f32 {
    var grad: f32 = 0.0;
    grad += abs(sampleBayer(frameIdx, x, y) - sampleBayer(frameIdx, x + dx, y + dy));
    grad += abs(sampleBayer(frameIdx, x + dx, y + dy) - sampleBayer(frameIdx, x + dx * 2, y + dy * 2));
    return grad;
}

fn vngInterpolate(frameIdx: u32, x: i32, y: i32, bx: u32, by: u32, pattern: u32) -> vec3<f32> {
    let gN = computeGradient(frameIdx, x, y, 0, -1);
    let gS = computeGradient(frameIdx, x, y, 0, 1);
    let gE = computeGradient(frameIdx, x, y, 1, 0);
    let gW = computeGradient(frameIdx, x, y, -1, 0);
    let gNE = computeGradient(frameIdx, x, y, 1, -1);
    let gNW = computeGradient(frameIdx, x, y, -1, -1);
    let gSE = computeGradient(frameIdx, x, y, 1, 1);
    let gSW = computeGradient(frameIdx, x, y, -1, 1);

    var minGrad = min(min(min(gN, gS), min(gE, gW)), min(min(gNE, gNW), min(gSE, gSW)));
    let threshold = minGrad * 1.5 + 0.001;
    let center = sampleBayer(frameIdx, x, y);
    var r: f32 = 0.0;
    var g: f32 = 0.0;
    var b: f32 = 0.0;

    let n = sampleBayer(frameIdx, x, y - 1);
    let s = sampleBayer(frameIdx, x, y + 1);
    let e = sampleBayer(frameIdx, x + 1, y);
    let w = sampleBayer(frameIdx, x - 1, y);
    let ne = sampleBayer(frameIdx, x + 1, y - 1);
    let nw = sampleBayer(frameIdx, x - 1, y - 1);
    let se = sampleBayer(frameIdx, x + 1, y + 1);
    let sw = sampleBayer(frameIdx, x - 1, y + 1);

    let wN = select(0.0, 1.0 / (gN + 0.001), gN <= threshold);
    let wS = select(0.0, 1.0 / (gS + 0.001), gS <= threshold);
    let wE = select(0.0, 1.0 / (gE + 0.001), gE <= threshold);
    let wW = select(0.0, 1.0 / (gW + 0.001), gW <= threshold);
    let wNE = select(0.0, 1.0 / (gNE + 0.001), gNE <= threshold);
    let wNW = select(0.0, 1.0 / (gNW + 0.001), gNW <= threshold);
    let wSE = select(0.0, 1.0 / (gSE + 0.001), gSE <= threshold);
    let wSW = select(0.0, 1.0 / (gSW + 0.001), gSW <= threshold);

    if (pattern == 0u) {
        if (bx == 0u && by == 0u) {
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 1u && by == 1u) {
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 1u && by == 0u) {
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        } else {
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        }
    } else if (pattern == 1u) {
        if (bx == 0u && by == 0u) {
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 1u && by == 1u) {
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 1u && by == 0u) {
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        } else {
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        }
    } else if (pattern == 2u) {
        if (bx == 1u && by == 0u) {
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 0u && by == 1u) {
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 0u && by == 0u) {
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        } else {
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        }
    } else {
        if (bx == 0u && by == 1u) {
            r = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let bSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let bWeight = wNE + wNW + wSE + wSW;
            b = select((ne + nw + se + sw) * 0.25, bSum / bWeight, bWeight > 0.0);
        } else if (bx == 1u && by == 0u) {
            b = center;
            let gSum = (n * wN + s * wS + e * wE + w * wW);
            let gWeight = wN + wS + wE + wW;
            g = select((n + s + e + w) * 0.25, gSum / gWeight, gWeight > 0.0);
            let rSum = (ne * wNE + nw * wNW + se * wSE + sw * wSW);
            let rWeight = wNE + wNW + wSE + wSW;
            r = select((ne + nw + se + sw) * 0.25, rSum / rWeight, rWeight > 0.0);
        } else if (bx == 0u && by == 0u) {
            g = center;
            let bSum = (e * wE + w * wW);
            let bWeight = wE + wW;
            b = select((e + w) * 0.5, bSum / bWeight, bWeight > 0.0);
            let rSum = (n * wN + s * wS);
            let rWeight = wN + wS;
            r = select((n + s) * 0.5, rSum / rWeight, rWeight > 0.0);
        } else {
            g = center;
            let rSum = (e * wE + w * wW);
            let rWeight = wE + wW;
            r = select((e + w) * 0.5, rSum / rWeight, rWeight > 0.0);
            let bSum = (n * wN + s * wS);
            let bWeight = wN + wS;
            b = select((n + s) * 0.5, bSum / bWeight, bWeight > 0.0);
        }
    }
    return vec3<f32>(r, g, b);
}

fn bilinearInterpolate(frameIdx: u32, x: i32, y: i32, bx: u32, by: u32, pattern: u32) -> vec3<f32> {
    var r: f32 = 0.0;
    var g: f32 = 0.0;
    var b: f32 = 0.0;

    if (pattern == 0u) {
        if (bx == 0u && by == 0u) {
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 1u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 0u) {
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    } else if (pattern == 1u) {
        if (bx == 0u && by == 0u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 1u) {
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 0u) {
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    } else if (pattern == 2u) {
        if (bx == 1u && by == 0u) {
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 0u && by == 1u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 0u && by == 0u) {
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    } else {
        if (bx == 0u && by == 1u) {
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 0u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) +
                 sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) +
                 sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 0u && by == 0u) {
            g = sampleBayer(frameIdx, x, y);
            b = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            r = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, x, y);
            r = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y)) * 0.5;
            b = (sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.5;
        }
    }
    return vec3<f32>(r, g, b);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let frameIdx = gid.z;

    if (x >= params.width || y >= params.height || frameIdx >= params.batchSize) {
        return;
    }

    let bx = x % 2u;
    let by = y % 2u;
    let ix = i32(x);
    let iy = i32(y);
    let pattern = params.bayerPattern;

    var rgb: vec3<f32>;
    if (params.useVng == 1u) {
        rgb = vngInterpolate(frameIdx, ix, iy, bx, by, pattern);
    } else {
        rgb = bilinearInterpolate(frameIdx, ix, iy, bx, by, pattern);
    }

    let r = rgb.x;
    let g = rgb.y;
    let b = rgb.z;

    let idx = frameIdx * params.width * params.height + y * params.width + x;

    // Output RGBA - format depends on bit depth
    if (params.bitDepth == 16u) {
        // 16-bit: output Float32 RGBA (4 u32s per pixel via bitcast)
        let baseIdx = idx * 4u;
        rgbaOutput[baseIdx] = bitcast<u32>(r);
        rgbaOutput[baseIdx + 1u] = bitcast<u32>(g);
        rgbaOutput[baseIdx + 2u] = bitcast<u32>(b);
        rgbaOutput[baseIdx + 3u] = bitcast<u32>(1.0);
    } else {
        // 8-bit: pack as RGBA (1 u32 per pixel)
        let ri = u32(clamp(r * 255.0, 0.0, 255.0));
        let gi = u32(clamp(g * 255.0, 0.0, 255.0));
        let bi = u32(clamp(b * 255.0, 0.0, 255.0));
        let rgba = ri | (gi << 8u) | (bi << 16u) | (255u << 24u);
        rgbaOutput[idx] = rgba;
    }

    // Output grayscale (fused - avoids separate pass)
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    grayOutput[idx] = gray;
}
`;

// Grayscale-only demosaic shader - fast analysis without color output
// Averages 2x2 Bayer blocks to get luminance - no pattern knowledge needed
const demosaicGrayOnlyShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    bayerPattern: u32,
    _pad0: u32,
    bitDepth: u32,
    scale: f32,
    _pad3: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read_write> grayOutput: array<f32>;

fn sampleRaw(frameIdx: u32, x: u32, y: u32) -> f32 {
    let cx = min(x, params.width - 1u);
    let cy = min(y, params.height - 1u);
    let pixelIdx = frameIdx * params.width * params.height + cy * params.width + cx;

    if (params.bitDepth == 8u) {
        let u32Idx = pixelIdx / 4u;
        let bytePos = pixelIdx % 4u;
        let packed = input[u32Idx];
        let rawValue = (packed >> (bytePos * 8u)) & 0xFFu;
        return f32(rawValue) / 255.0;
    } else {
        let u32Idx = pixelIdx / 2u;
        let halfPos = pixelIdx % 2u;
        let packed = input[u32Idx];
        let rawValue = select(packed & 0xFFFFu, packed >> 16u, halfPos == 1u);
        return min(1.0, f32(rawValue) * params.scale / 65535.0);
    }
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let frameIdx = gid.z;

    if (x >= params.width || y >= params.height || frameIdx >= params.batchSize) {
        return;
    }

    // Average local 2x2 neighborhood: always contains 1R + 2G + 1B = approximate luminance
    // Each pixel gets its own average (not block-aligned) to preserve detail
    let gray = (sampleRaw(frameIdx, x, y) + sampleRaw(frameIdx, x+1u, y) +
                sampleRaw(frameIdx, x, y+1u) + sampleRaw(frameIdx, x+1u, y+1u)) * 0.25;

    let outIdx = frameIdx * params.width * params.height + y * params.width + x;
    grayOutput[outIdx] = gray;
}
`;

// Combined sharpness shader - computes both Tenengrad and Laplacian
// Tenengrad: Sobel Gx² + Gy² (first derivative, good for edges)
// Laplacian: Second derivative (good for fine texture/detail)
// Combined via geometric mean for robust sharpness ranking
const tenengradShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;  // Grayscale
@group(0) @binding(2) var<storage, read_write> tenengrad: array<f32>;  // Sobel gradient magnitude squared
@group(0) @binding(3) var<storage, read_write> laplacian: array<f32>;  // Laplacian response

fn sampleGray(frameIdx: u32, x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(params.width) - 1);
    let cy = clamp(y, 0, i32(params.height) - 1);
    let idx = frameIdx * params.width * params.height + u32(cy) * params.width + u32(cx);
    return input[idx];
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let frameIdx = gid.z;

    if (x >= params.width || y >= params.height || frameIdx >= params.batchSize) {
        return;
    }

    let ix = i32(x);
    let iy = i32(y);

    // Sobel X: [-1,0,1], [-2,0,2], [-1,0,1]
    let gx = -1.0 * sampleGray(frameIdx, ix-1, iy-1) + 1.0 * sampleGray(frameIdx, ix+1, iy-1)
           + -2.0 * sampleGray(frameIdx, ix-1, iy)   + 2.0 * sampleGray(frameIdx, ix+1, iy)
           + -1.0 * sampleGray(frameIdx, ix-1, iy+1) + 1.0 * sampleGray(frameIdx, ix+1, iy+1);

    // Sobel Y: [-1,-2,-1], [0,0,0], [1,2,1]
    let gy = -1.0 * sampleGray(frameIdx, ix-1, iy-1) - 2.0 * sampleGray(frameIdx, ix, iy-1) - 1.0 * sampleGray(frameIdx, ix+1, iy-1)
           +  1.0 * sampleGray(frameIdx, ix-1, iy+1) + 2.0 * sampleGray(frameIdx, ix, iy+1) + 1.0 * sampleGray(frameIdx, ix+1, iy+1);

    // Tenengrad = Gx² + Gy² (gradient magnitude squared)
    let tenengradVal = gx * gx + gy * gy;

    // Laplacian kernel: [0,1,0], [1,-4,1], [0,1,0]
    let lap = sampleGray(frameIdx, ix, iy-1)
            + sampleGray(frameIdx, ix-1, iy) - 4.0 * sampleGray(frameIdx, ix, iy) + sampleGray(frameIdx, ix+1, iy)
            + sampleGray(frameIdx, ix, iy+1);

    let idx = frameIdx * params.width * params.height + y * params.width + x;
    tenengrad[idx] = tenengradVal;
    laplacian[idx] = lap * lap;  // Square for variance calculation (always positive)
}
`;

// Offset sharpness shader - reads from full-frame buffer with per-frame center offsets
// Computes both Tenengrad and Laplacian, eliminates need for separate crop pass
const offsetTenengradShader = `
struct Params {
    srcWidth: u32,      // Full frame width
    srcHeight: u32,     // Full frame height
    cropSize: u32,      // Output crop size
    batchSize: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;      // Full-frame grayscale
@group(0) @binding(2) var<storage, read> centers: array<f32>;    // Per-frame centers [x0,y0,x1,y1,...]
@group(0) @binding(3) var<storage, read_write> tenengrad: array<f32>;
@group(0) @binding(4) var<storage, read_write> laplacian: array<f32>;

fn sampleGray(frameIdx: u32, x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(params.srcWidth) - 1);
    let cy = clamp(y, 0, i32(params.srcHeight) - 1);
    let idx = frameIdx * params.srcWidth * params.srcHeight + u32(cy) * params.srcWidth + u32(cx);
    return input[idx];
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let localX = gid.x;
    let localY = gid.y;
    let frameIdx = gid.z;

    if (localX >= params.cropSize || localY >= params.cropSize || frameIdx >= params.batchSize) {
        return;
    }

    // Get per-frame center
    let centerX = i32(centers[frameIdx * 2u]);
    let centerY = i32(centers[frameIdx * 2u + 1u]);
    let halfCrop = i32(params.cropSize / 2u);

    // Compute source coordinates in full-frame buffer
    let srcX = centerX - halfCrop + i32(localX);
    let srcY = centerY - halfCrop + i32(localY);

    // Sobel X: [-1,0,1], [-2,0,2], [-1,0,1]
    let gx = -1.0 * sampleGray(frameIdx, srcX-1, srcY-1) + 1.0 * sampleGray(frameIdx, srcX+1, srcY-1)
           + -2.0 * sampleGray(frameIdx, srcX-1, srcY)   + 2.0 * sampleGray(frameIdx, srcX+1, srcY)
           + -1.0 * sampleGray(frameIdx, srcX-1, srcY+1) + 1.0 * sampleGray(frameIdx, srcX+1, srcY+1);

    // Sobel Y: [-1,-2,-1], [0,0,0], [1,2,1]
    let gy = -1.0 * sampleGray(frameIdx, srcX-1, srcY-1) - 2.0 * sampleGray(frameIdx, srcX, srcY-1) - 1.0 * sampleGray(frameIdx, srcX+1, srcY-1)
           +  1.0 * sampleGray(frameIdx, srcX-1, srcY+1) + 2.0 * sampleGray(frameIdx, srcX, srcY+1) + 1.0 * sampleGray(frameIdx, srcX+1, srcY+1);

    // Tenengrad = Gx² + Gy² (gradient magnitude squared)
    let tenengradVal = gx * gx + gy * gy;

    // Laplacian kernel: [0,1,0], [1,-4,1], [0,1,0]
    let lap = sampleGray(frameIdx, srcX, srcY-1)
            + sampleGray(frameIdx, srcX-1, srcY) - 4.0 * sampleGray(frameIdx, srcX, srcY) + sampleGray(frameIdx, srcX+1, srcY)
            + sampleGray(frameIdx, srcX, srcY+1);

    // Output to crop-sized buffer (contiguous for reduction)
    let outIdx = frameIdx * params.cropSize * params.cropSize + localY * params.cropSize + localX;
    tenengrad[outIdx] = tenengradVal;
    laplacian[outIdx] = lap * lap;  // Square for variance calculation
}
`;

// Reduction shader - sums Tenengrad and Laplacian values across frame
const reductionShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    inputSize: u32,  // Total pixels per frame
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> tenengrad: array<f32>;
@group(0) @binding(2) var<storage, read> laplacian: array<f32>;
@group(0) @binding(3) var<storage, read_write> results: array<f32>;  // [tenengradSum, laplacianSum] per frame

var<workgroup> sharedTenengrad: array<f32, 256>;
var<workgroup> sharedLaplacian: array<f32, 256>;

@compute @workgroup_size(256, 1, 1)
fn main(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
    @builtin(workgroup_id) wid: vec3<u32>
) {
    let frameIdx = wid.y;
    let localIdx = lid.x;
    let pixelsPerWorkgroup = 256u;
    let startPixel = wid.x * pixelsPerWorkgroup + localIdx;

    if (frameIdx >= params.batchSize) {
        return;
    }

    // Load values from both sharpness metrics
    var tenVal: f32 = 0.0;
    var lapVal: f32 = 0.0;

    if (startPixel < params.inputSize) {
        let idx = frameIdx * params.inputSize + startPixel;
        tenVal = tenengrad[idx];
        lapVal = laplacian[idx];
    }

    sharedTenengrad[localIdx] = tenVal;
    sharedLaplacian[localIdx] = lapVal;
    workgroupBarrier();

    // Parallel reduction
    for (var stride = 128u; stride > 0u; stride = stride >> 1u) {
        if (localIdx < stride) {
            sharedTenengrad[localIdx] += sharedTenengrad[localIdx + stride];
            sharedLaplacian[localIdx] += sharedLaplacian[localIdx + stride];
        }
        workgroupBarrier();
    }

    // Write partial result
    if (localIdx == 0u) {
        // Calculate actual number of workgroups based on input size
        let numWorkgroups = (params.inputSize + 255u) / 256u;
        let resultIdx = frameIdx * numWorkgroups + wid.x;
        results[resultIdx * 2u] = sharedTenengrad[0];
        results[resultIdx * 2u + 1u] = sharedLaplacian[0];
    }
}
`;

// Moments shader - calculates image moments for circularity
const momentsShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    threshold: f32,  // For binarization
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> grayscale: array<f32>;
@group(0) @binding(2) var<storage, read_write> moments: array<f32>;  // Per-pixel contributions

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let frameIdx = gid.z;

    if (x >= params.width || y >= params.height || frameIdx >= params.batchSize) {
        return;
    }

    let idx = frameIdx * params.width * params.height + y * params.width + x;
    let val = grayscale[idx];

    // Binary threshold
    let binary = select(0.0, 1.0, val > params.threshold);

    let fx = f32(x);
    let fy = f32(y);

    // Store moments contributions: m00, m10, m01, m20, m11, m02
    let momIdx = idx * 6u;
    moments[momIdx + 0u] = binary;           // m00
    moments[momIdx + 1u] = binary * fx;      // m10
    moments[momIdx + 2u] = binary * fy;      // m01
    moments[momIdx + 3u] = binary * fx * fx; // m20
    moments[momIdx + 4u] = binary * fx * fy; // m11
    moments[momIdx + 5u] = binary * fy * fy; // m02
}
`;

// Moments reduction shader
const momentsReductionShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    inputSize: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> moments: array<f32>;
@group(0) @binding(2) var<storage, read_write> results: array<f32>;  // 6 moments per frame

var<workgroup> sharedData: array<f32, 1536>;  // 256 * 6

@compute @workgroup_size(256, 1, 1)
fn main(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
    @builtin(workgroup_id) wid: vec3<u32>
) {
    let frameIdx = wid.y;
    let localIdx = lid.x;
    let startPixel = wid.x * 256u + localIdx;

    if (frameIdx >= params.batchSize) {
        return;
    }

    // Load 6 moment values per thread
    for (var m = 0u; m < 6u; m++) {
        var val: f32 = 0.0;
        if (startPixel < params.inputSize) {
            val = moments[(frameIdx * params.inputSize + startPixel) * 6u + m];
        }
        sharedData[localIdx * 6u + m] = val;
    }
    workgroupBarrier();

    // Parallel reduction for all 6 moments
    for (var stride = 128u; stride > 0u; stride = stride >> 1u) {
        if (localIdx < stride) {
            for (var m = 0u; m < 6u; m++) {
                sharedData[localIdx * 6u + m] += sharedData[(localIdx + stride) * 6u + m];
            }
        }
        workgroupBarrier();
    }

    // Write partial results
    if (localIdx == 0u) {
        let numWorkgroups = (params.inputSize + 255u) / 256u;
        let resultIdx = (frameIdx * numWorkgroups + wid.x) * 6u;
        for (var m = 0u; m < 6u; m++) {
            results[resultIdx + m] = sharedData[m];
        }
    }
}
`;

// Bounding box shader - finds min/max x,y of bright pixels for planet detection
const boundsShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    threshold: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> grayscale: array<f32>;
@group(0) @binding(2) var<storage, read_write> bounds: array<u32>;  // Per-pixel: minX, minY, maxX, maxY

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let frameIdx = gid.z;

    if (x >= params.width || y >= params.height || frameIdx >= params.batchSize) {
        return;
    }

    let idx = frameIdx * params.width * params.height + y * params.width + x;
    let val = grayscale[idx];

    let boundsIdx = idx * 4u;

    // If pixel is bright (above threshold), set bounds to this pixel's coords
    // Otherwise set to invalid values that won't affect min/max
    if (val > params.threshold) {
        bounds[boundsIdx + 0u] = x;      // minX candidate
        bounds[boundsIdx + 1u] = y;      // minY candidate
        bounds[boundsIdx + 2u] = x;      // maxX candidate
        bounds[boundsIdx + 3u] = y;      // maxY candidate
    } else {
        bounds[boundsIdx + 0u] = 0xFFFFFFFFu;  // Large value for min
        bounds[boundsIdx + 1u] = 0xFFFFFFFFu;
        bounds[boundsIdx + 2u] = 0u;           // Small value for max
        bounds[boundsIdx + 3u] = 0u;
    }
}
`;

// Bounding box reduction shader - finds min/max across all pixels
const boundsReductionShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    inputSize: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bounds: array<u32>;
@group(0) @binding(2) var<storage, read_write> results: array<u32>;  // 4 values per frame: minX, minY, maxX, maxY

var<workgroup> sharedBounds: array<u32, 1024>;  // 256 * 4

@compute @workgroup_size(256, 1, 1)
fn main(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
    @builtin(workgroup_id) wid: vec3<u32>
) {
    let frameIdx = wid.y;
    let localIdx = lid.x;
    let startPixel = wid.x * 256u + localIdx;

    if (frameIdx >= params.batchSize) {
        return;
    }

    // Load 4 bound values per thread (minX, minY, maxX, maxY)
    if (startPixel < params.inputSize) {
        let boundsIdx = (frameIdx * params.inputSize + startPixel) * 4u;
        sharedBounds[localIdx * 4u + 0u] = bounds[boundsIdx + 0u];
        sharedBounds[localIdx * 4u + 1u] = bounds[boundsIdx + 1u];
        sharedBounds[localIdx * 4u + 2u] = bounds[boundsIdx + 2u];
        sharedBounds[localIdx * 4u + 3u] = bounds[boundsIdx + 3u];
    } else {
        sharedBounds[localIdx * 4u + 0u] = 0xFFFFFFFFu;
        sharedBounds[localIdx * 4u + 1u] = 0xFFFFFFFFu;
        sharedBounds[localIdx * 4u + 2u] = 0u;
        sharedBounds[localIdx * 4u + 3u] = 0u;
    }
    workgroupBarrier();

    // Parallel reduction - min for indices 0,1 and max for indices 2,3
    for (var stride = 128u; stride > 0u; stride = stride >> 1u) {
        if (localIdx < stride) {
            let idx1 = localIdx * 4u;
            let idx2 = (localIdx + stride) * 4u;
            // Min for minX, minY
            sharedBounds[idx1 + 0u] = min(sharedBounds[idx1 + 0u], sharedBounds[idx2 + 0u]);
            sharedBounds[idx1 + 1u] = min(sharedBounds[idx1 + 1u], sharedBounds[idx2 + 1u]);
            // Max for maxX, maxY
            sharedBounds[idx1 + 2u] = max(sharedBounds[idx1 + 2u], sharedBounds[idx2 + 2u]);
            sharedBounds[idx1 + 3u] = max(sharedBounds[idx1 + 3u], sharedBounds[idx2 + 3u]);
        }
        workgroupBarrier();
    }

    // Write partial results
    if (localIdx == 0u) {
        let numWorkgroups = (params.inputSize + 255u) / 256u;
        let resultIdx = (frameIdx * numWorkgroups + wid.x) * 4u;
        results[resultIdx + 0u] = sharedBounds[0u];
        results[resultIdx + 1u] = sharedBounds[1u];
        results[resultIdx + 2u] = sharedBounds[2u];
        results[resultIdx + 3u] = sharedBounds[3u];
    }
}
`;

// Centroid computation shader - reduces partial bounds to final centroids
// This eliminates the need to read back bounds to CPU before cropping
const centroidShader = `
struct Params {
    srcWidth: u32,
    srcHeight: u32,
    batchSize: u32,
    numWorkgroups: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> boundsPartial: array<u32>;  // 4 values per workgroup per frame
@group(0) @binding(2) var<storage, read_write> centers: array<f32>;  // 2 floats per frame (x, y)
@group(0) @binding(3) var<storage, read_write> boundsOutput: array<u32>;  // 4 u32 per frame: minX, minY, maxX, maxY

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let frameIdx = gid.x;
    if (frameIdx >= params.batchSize) {
        return;
    }

    // Reduce all workgroup results for this frame
    var minX: u32 = params.srcWidth;
    var minY: u32 = params.srcHeight;
    var maxX: u32 = 0u;
    var maxY: u32 = 0u;

    for (var w: u32 = 0u; w < params.numWorkgroups; w = w + 1u) {
        let idx = (frameIdx * params.numWorkgroups + w) * 4u;
        let wMinX = boundsPartial[idx + 0u];
        let wMinY = boundsPartial[idx + 1u];
        let wMaxX = boundsPartial[idx + 2u];
        let wMaxY = boundsPartial[idx + 3u];

        minX = min(minX, wMinX);
        minY = min(minY, wMinY);
        maxX = max(maxX, wMaxX);
        maxY = max(maxY, wMaxY);
    }

    // Write final bounds for later CPU readback
    let boundsIdx = frameIdx * 4u;
    boundsOutput[boundsIdx + 0u] = minX;
    boundsOutput[boundsIdx + 1u] = minY;
    boundsOutput[boundsIdx + 2u] = maxX;
    boundsOutput[boundsIdx + 3u] = maxY;

    // Compute and write centroid
    let centerIdx = frameIdx * 2u;
    if (maxX > minX && maxY > minY) {
        centers[centerIdx + 0u] = f32(minX + maxX) / 2.0;
        centers[centerIdx + 1u] = f32(minY + maxY) / 2.0;
    } else {
        // No valid object found - use frame center
        centers[centerIdx + 0u] = f32(params.srcWidth) / 2.0;
        centers[centerIdx + 1u] = f32(params.srcHeight) / 2.0;
    }
}
`;

// ============================================================
// INITIALIZATION
// ============================================================

async function init() {
    if (!navigator.gpu) {
        throw new Error('WebGPU not available');
    }

    const adapter = await navigator.gpu.requestAdapter();
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

    // Handle GPU device lost (tab suspended, driver crash, etc.)
    device.lost.then(async (info) => {
        console.error('WebGPU device lost:', info.message);
        deviceLost = true;
        device = null;
        queue = null;
        isReady = false;

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
                self.postMessage({ type: 'error', error: `GPU device lost and recovery failed: ${err.message}. Please reload the page.` });
            } finally {
                reinitializing = false;
            }
        } else {
            self.postMessage({ type: 'error', error: `GPU device lost: ${info.message}. Max recovery attempts reached. Please reload the page.` });
        }
    });

    // Helper to create shader module with error checking
    async function createShader(code, name) {
        const module = device.createShaderModule({ code });
        const info = await module.getCompilationInfo();
        for (const msg of info.messages) {
            if (msg.type === 'error') {
                throw new Error(`Shader ${name} error: ${msg.message} at line ${msg.lineNum}`);
            }
            if (msg.type === 'warning') {
                console.warn(`Shader ${name} warning: ${msg.message}`);
            }
        }
        return module;
    }

    // Create pipelines with error checking
    const demosaicModule = await createShader(demosaicShader, 'demosaic');
    demosaicPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: demosaicModule, entryPoint: 'main' }
    });

    const demosaicCropModule = await createShader(demosaicCropShader, 'demosaicCrop');
    demosaicCropPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: demosaicCropModule, entryPoint: 'main' }
    });

    const demosaicGrayModule = await createShader(demosaicGrayShader, 'demosaicGray');
    demosaicGrayPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: demosaicGrayModule, entryPoint: 'main' }
    });

    const demosaicGrayOnlyModule = await createShader(demosaicGrayOnlyShader, 'demosaicGrayOnly');
    demosaicGrayOnlyPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: demosaicGrayOnlyModule, entryPoint: 'main' }
    });

    const rgbaCropModule = await createShader(rgbaCropShader, 'rgbaCrop');
    rgbaCropPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: rgbaCropModule, entryPoint: 'main' }
    });

    const grayscaleModule = await createShader(grayscaleShader, 'grayscale');
    grayscalePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: grayscaleModule, entryPoint: 'main' }
    });

    const tenengradModule = await createShader(tenengradShader, 'tenengrad');
    tenengradPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: tenengradModule, entryPoint: 'main' }
    });

    const offsetTenengradModule = await createShader(offsetTenengradShader, 'offsetTenengrad');
    offsetTenengradPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: offsetTenengradModule, entryPoint: 'main' }
    });

    const reductionModule = await createShader(reductionShader, 'reduction');
    reductionPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: reductionModule, entryPoint: 'main' }
    });

    const momentsModule = await createShader(momentsShader, 'moments');
    momentsPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: momentsModule, entryPoint: 'main' }
    });

    const momentsReductionModule = await createShader(momentsReductionShader, 'momentsReduction');
    momentsReductionPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: momentsReductionModule, entryPoint: 'main' }
    });

    const boundsModule = await createShader(boundsShader, 'bounds');
    boundsPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: boundsModule, entryPoint: 'main' }
    });

    const boundsReductionModule = await createShader(boundsReductionShader, 'boundsReduction');
    boundsReductionPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: boundsReductionModule, entryPoint: 'main' }
    });

    const centroidModule = await createShader(centroidShader, 'centroid');
    centroidPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: centroidModule, entryPoint: 'main' }
    });

    isReady = true;
    deviceLost = false;
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
function getAnalyzeBuffers(batchSize, width, height, bitDepth = 8) {
    const pixelCount = width * height;
    const numWorkgroups = Math.ceil(pixelCount / 256);

    // RGBA buffer size depends on bit depth:
    // - 8-bit: 4 bytes/pixel (packed RGBA as u32)
    // - 16-bit: 16 bytes/pixel (4 floats as 4 u32s via bitcast)
    const rgbaBytesPerPixel = bitDepth === 16 ? 16 : 4;

    // Calculate required buffer sizes
    const requiredSizes = {
        batchSize,
        pixelCount,
        numWorkgroups,
        bitDepth,
        paramsSize: 16,
        pixelBufferSize: batchSize * pixelCount * 4,  // Input: always 4 bytes/pixel max
        rgbaBufferSize: batchSize * pixelCount * rgbaBytesPerPixel,  // Output: depends on bitDepth
        momentsPixelSize: batchSize * pixelCount * 6 * 4,
        boundsPixelSize: batchSize * pixelCount * 4 * 4,  // 4 u32 per pixel
        reductionSize: batchSize * numWorkgroups * 2 * 4,
        momentsReductionSize: batchSize * numWorkgroups * 6 * 4,
        boundsReductionSize: batchSize * numWorkgroups * 4 * 4  // 4 u32 per workgroup
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
        cachedAnalyzeConfig.boundsReductionSize >= requiredSizes.boundsReductionSize) {
        // Update config with current batch params
        cachedAnalyzeConfig.batchSize = batchSize;
        cachedAnalyzeConfig.pixelCount = pixelCount;
        cachedAnalyzeConfig.numWorkgroups = numWorkgroups;
        cachedAnalyzeConfig.bitDepth = bitDepth;
        return cachedAnalyzeBuffers;
    }

    // Destroy old buffers if they exist
    if (cachedAnalyzeBuffers) {
        Object.values(cachedAnalyzeBuffers).forEach(buf => {
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

    cachedAnalyzeBuffers = {
        paramsBuffer: device.createBuffer({
            size: 32,  // 8 u32 values for demosaic params including useVng
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        inputBuffer: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        inputBufferAlt: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        // RGBA buffer: 4x larger for 16-bit to hold Float32 output (preserves precision for stacking)
        rgbaBuffer: device.createBuffer({
            size: rgbaBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        }),
        grayBuffer: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        grayReadback: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        tenengradBuffer: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.STORAGE
        }),
        laplacianBuffer: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.STORAGE
        }),
        reductionBuffer: device.createBuffer({
            size: reductionSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        momentsBuffer: device.createBuffer({
            size: momentsPixelSize,
            usage: GPUBufferUsage.STORAGE
        }),
        momentsReductionBuffer: device.createBuffer({
            size: momentsReductionSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        reductionParamsBuffer: device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        momentsParamsBuffer: device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        reductionReadback: device.createBuffer({
            size: reductionSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        momentsReadback: device.createBuffer({
            size: momentsReductionSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        // RGBA readback: matches rgbaBuffer size for 16-bit Float32 support
        rgbaReadback: device.createBuffer({
            size: rgbaBufferSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        boundsBuffer: device.createBuffer({
            size: boundsPixelSize,
            usage: GPUBufferUsage.STORAGE
        }),
        boundsReductionBuffer: device.createBuffer({
            size: boundsReductionSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        boundsParamsBuffer: device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        boundsReadback: device.createBuffer({
            size: boundsReductionSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        })
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
        boundsReductionSize
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

async function analyzeBatch(frames, width, height, bayerPattern, threshold, metadataOnly = false, useVng = true, grayOnly = false) {
    if (!device || !queue) {
        throw new Error('WebGPU not initialized or device lost');
    }
    const batchSize = frames.length;
    const pixelCount = width * height;
    const numWorkgroups = Math.ceil(pixelCount / 256);

    // Memory safeguard: prevent allocations that would likely fail
    // metadataOnly: Uint8 RGBA only (4 bytes/px)
    // full mode: Float32 RGBA (16 bytes/px) + Uint8 RGBA copy (4 bytes/px) = 20 bytes/px
    const bytesPerPixel = metadataOnly ? 4 : 20;
    const estimatedMemory = batchSize * pixelCount * bytesPerPixel;
    const maxMemory = 512 * 1024 * 1024; // 512MB hard limit (allow some headroom over 256MB target)
    if (estimatedMemory > maxMemory) {
        const neededMB = Math.round(estimatedMemory / 1024 / 1024);
        const maxFrames = Math.max(1, Math.floor(maxMemory / (pixelCount * bytesPerPixel)));
        throw new Error(`Memory limit: ${batchSize} frames of ${width}x${height} needs ${neededMB}MB (limit: 512MB). Try processing fewer frames or use smaller resolution. Max batch: ${maxFrames} frames.`);
    }

    // Determine if we need demosaic (bayerPattern >= 0 means Bayer data)
    const needsDemosaic = bayerPattern >= 0;

    // Detect bit depth early so we allocate correct buffer sizes
    // 16-bit SER: needs 4x larger RGBA buffer for Float32 output (preserves precision)
    const bitDepth = needsDemosaic ? detectBitDepth(frames) : 8;

    // Get cached buffers (creates if needed, reuses if possible)
    const buffers = getAnalyzeBuffers(batchSize, width, height, bitDepth);
    let grayAlreadyComputed = false;

    if (needsDemosaic) {
        // Upload Bayer data to input buffer (auto-stretch for 16-bit to handle dark data)
        const { data: bayerData, scale } = prepareBayerData(frames, pixelCount, false);
        queue.writeBuffer(buffers.inputBuffer, 0, bayerData);

        // Demosaic params (mixed u32/f32 for scale)
        // Note: bitDepth already determined above via detectBitDepth()
        const paramsData = new ArrayBuffer(32);
        new Uint32Array(paramsData).set([width, height, batchSize, bayerPattern, useVng ? 1 : 0, bitDepth, 0, 0]);
        new Float32Array(paramsData)[6] = scale;
        queue.writeBuffer(buffers.paramsBuffer, 0, paramsData);

        if (grayOnly) {
            // Grayscale-only demosaic (fast, no RGBA output)
            const demosaicGrayOnlyBindGroup = device.createBindGroup({
                layout: demosaicGrayOnlyPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: buffers.paramsBuffer } },
                    { binding: 1, resource: { buffer: buffers.inputBuffer } },
                    { binding: 2, resource: { buffer: buffers.grayBuffer } }
                ]
            });

            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(demosaicGrayOnlyPipeline);
            pass.setBindGroup(0, demosaicGrayOnlyBindGroup);
            pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
            pass.end();
            logGpuSubmit('analyzeBatch:demosaic-grayOnly');
            queue.submit([encoder.finish()]);
        } else {
            // Run fused demosaic + grayscale (outputs both RGBA and grayscale in one pass)
            const demosaicGrayBindGroup = device.createBindGroup({
                layout: demosaicGrayPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: buffers.paramsBuffer } },
                    { binding: 1, resource: { buffer: buffers.inputBuffer } },
                    { binding: 2, resource: { buffer: buffers.rgbaBuffer } },
                    { binding: 3, resource: { buffer: buffers.grayBuffer } }
                ]
            });

            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(demosaicGrayPipeline);
            pass.setBindGroup(0, demosaicGrayBindGroup);
            pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
            pass.end();
            logGpuSubmit('analyzeBatch:demosaic+gray');
            queue.submit([encoder.finish()]);
        }
        grayAlreadyComputed = true;
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
    const grayBindGroup = device.createBindGroup({
        layout: grayscalePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.paramsBuffer } },
            { binding: 1, resource: { buffer: buffers.rgbaBuffer } },
            { binding: 2, resource: { buffer: buffers.grayBuffer } }
        ]
    });

    const lapBindGroup = device.createBindGroup({
        layout: tenengradPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.paramsBuffer } },
            { binding: 1, resource: { buffer: buffers.grayBuffer } },
            { binding: 2, resource: { buffer: buffers.tenengradBuffer } },
            { binding: 3, resource: { buffer: buffers.laplacianBuffer } }
        ]
    });

    const reductionBindGroup = device.createBindGroup({
        layout: reductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.tenengradBuffer } },
            { binding: 2, resource: { buffer: buffers.laplacianBuffer } },
            { binding: 3, resource: { buffer: buffers.reductionBuffer } }
        ]
    });

    const momentsBindGroup = device.createBindGroup({
        layout: momentsPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.momentsParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.grayBuffer } },
            { binding: 2, resource: { buffer: buffers.momentsBuffer } }
        ]
    });

    const momentsReductionBindGroup = device.createBindGroup({
        layout: momentsReductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.momentsBuffer } },
            { binding: 2, resource: { buffer: buffers.momentsReductionBuffer } }
        ]
    });

    // Update bounds params (same threshold as moments)
    const boundsParamsData = new ArrayBuffer(16);
    new Uint32Array(boundsParamsData, 0, 3).set([width, height, batchSize]);
    new Float32Array(boundsParamsData, 12, 1).set([threshold]);
    queue.writeBuffer(buffers.boundsParamsBuffer, 0, boundsParamsData);

    const boundsBindGroup = device.createBindGroup({
        layout: boundsPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.boundsParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.grayBuffer } },
            { binding: 2, resource: { buffer: buffers.boundsBuffer } }
        ]
    });

    const boundsReductionBindGroup = device.createBindGroup({
        layout: boundsReductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.boundsBuffer } },
            { binding: 2, resource: { buffer: buffers.boundsReductionBuffer } }
        ]
    });

    // Execute all passes in a single command encoder
    const encoder = device.createCommandEncoder();

    // Grayscale (skip if already computed by fused demosaic+gray)
    let pass;
    if (!grayAlreadyComputed) {
        pass = encoder.beginComputePass();
        pass.setPipeline(grayscalePipeline);
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

    // Copy results for readback
    const reductionCopySize = batchSize * numWorkgroups * 2 * 4;
    const momentsCopySize = batchSize * numWorkgroups * 6 * 4;
    const boundsCopySize = batchSize * numWorkgroups * 4 * 4;
    // RGBA copy size: 4x larger for 16-bit (Float32 output vs packed Uint8)
    const rgbaBytesPerPixel = bitDepth === 16 ? 16 : 4;
    const rgbaCopySize = batchSize * pixelCount * rgbaBytesPerPixel;

    encoder.copyBufferToBuffer(buffers.reductionBuffer, 0, buffers.reductionReadback, 0, reductionCopySize);
    encoder.copyBufferToBuffer(buffers.momentsReductionBuffer, 0, buffers.momentsReadback, 0, momentsCopySize);
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
    await safeMapAsync(buffers.momentsReadback, GPUMapMode.READ);
    await safeMapAsync(buffers.boundsReadback, GPUMapMode.READ);

    const reductionData = new Float32Array(buffers.reductionReadback.getMappedRange().slice(0, reductionCopySize));
    const momentsData = new Float32Array(buffers.momentsReadback.getMappedRange().slice(0, momentsCopySize));
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
    buffers.momentsReadback.unmap();
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

        // Sum up moments
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

        // Calculate circularity from moments
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

        // Calculate centroid from moments (more accurate than bbox center)
        let centroidX = width / 2, centroidY = height / 2;
        if (m00 > 0) {
            centroidX = m10 / m00;
            centroidY = m01 / m00;
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
        bitDepth
    };

    // Validate cache - check sizes that determine buffer requirements
    if (cachedCropBuffers && cachedCropConfig &&
        cachedCropConfig.inputSize >= requiredSizes.inputSize &&
        cachedCropConfig.croppedRgbaSize >= requiredSizes.croppedRgbaSize &&
        cachedCropConfig.packedGraySize >= requiredSizes.packedGraySize &&
        cachedCropConfig.momentsSize >= requiredSizes.momentsSize &&
        cachedCropConfig.reductionSize >= requiredSizes.reductionSize &&
        cachedCropConfig.momentsReductionSize >= requiredSizes.momentsReductionSize &&
        cachedCropConfig.boundsOutputSize >= requiredSizes.boundsOutputSize) {
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
        Object.values(cachedCropBuffers).forEach(buf => {
            if (buf && buf.destroy) buf.destroy();
        });
        // Keep activeBatchCount at 1 (current batch still has its slot)
        batchWaiters = [];
    }

    cachedCropBuffers = {
        paramsBuffer: device.createBuffer({
            size: 32, // 8 u32s for params
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        inputBuffer: device.createBuffer({
            size: requiredSizes.inputSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        inputBufferAlt: device.createBuffer({
            size: requiredSizes.inputSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        centersBuffer: device.createBuffer({
            size: requiredSizes.centersSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        boundsOutputBuffer: device.createBuffer({
            size: requiredSizes.boundsOutputSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        // Double-buffering for bounds readback (matches concurrency limit)
        boundsOutputReadback: device.createBuffer({
            size: requiredSizes.boundsOutputSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        boundsOutputReadbackAlt: device.createBuffer({
            size: requiredSizes.boundsOutputSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        centroidParamsBuffer: device.createBuffer({
            size: 16,  // 4 u32s: srcWidth, srcHeight, batchSize, numWorkgroups
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        croppedRgbaBuffer: device.createBuffer({
            size: requiredSizes.croppedRgbaSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        // Packed grayscale for template matching (output by demosaic shader)
        packedGrayBuffer: device.createBuffer({
            size: requiredSizes.packedGraySize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        }),
        packedGrayReadback: device.createBuffer({
            size: requiredSizes.packedGraySize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        packedGrayReadbackAlt: device.createBuffer({
            size: requiredSizes.packedGraySize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        grayBuffer: device.createBuffer({
            size: requiredSizes.graySize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        // Grayscale readback for side-by-side preview (double-buffered)
        grayReadback: device.createBuffer({
            size: requiredSizes.graySize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        grayReadbackAlt: device.createBuffer({
            size: requiredSizes.graySize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        tenengradBuffer: device.createBuffer({
            size: requiredSizes.tenengradSize,
            usage: GPUBufferUsage.STORAGE
        }),
        laplacianBuffer: device.createBuffer({
            size: requiredSizes.laplacianSize,
            usage: GPUBufferUsage.STORAGE
        }),
        reductionBuffer: device.createBuffer({
            size: requiredSizes.reductionSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        readbackBuffer: device.createBuffer({
            size: requiredSizes.reductionSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        readbackBufferAlt: device.createBuffer({
            size: requiredSizes.reductionSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        momentsBuffer: device.createBuffer({
            size: requiredSizes.momentsSize,
            usage: GPUBufferUsage.STORAGE
        }),
        momentsReductionBuffer: device.createBuffer({
            size: requiredSizes.momentsReductionSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        momentsReadbackBuffer: device.createBuffer({
            size: requiredSizes.momentsReductionSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        momentsReadbackBufferAlt: device.createBuffer({
            size: requiredSizes.momentsReductionSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        croppedReadbackBuffer: device.createBuffer({
            size: requiredSizes.croppedRgbaSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        croppedReadbackBufferAlt: device.createBuffer({
            size: requiredSizes.croppedRgbaSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        grayParamsBuffer: device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        reductionParamsBuffer: device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        momentsParamsBuffer: device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        })
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
 * @param {boolean} useVng - If true, use VNG demosaic; otherwise bilinear
 */
async function cropAndAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, centers, bayerPattern, threshold = 0.1, metadataOnly = false, useVng = true) {
    if (!device || !queue) {
        throw new Error('WebGPU not initialized or device lost');
    }
    const batchSize = frames.length;
    const srcPixelCount = srcWidth * srcHeight;
    const cropPixelCount = cropSize * cropSize;
    const numWorkgroups = Math.ceil(cropPixelCount / 256);

    const needsDemosaic = bayerPattern >= 0;

    // Detect bitDepth FIRST so we allocate correct buffer sizes
    // 16-bit SER needs 4x larger RGBA buffers for Float32 output
    const bitDepth = needsDemosaic ? detectBitDepth(frames) : 8;

    // Wait for a batch slot BEFORE getting buffers (prevents buffer destruction while in use)
    await acquireBatchSlot();

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
        const prepared = prepareBayerData(frames, srcPixelCount, false);
        bayerData = prepared.data;
        scale = prepared.scale;
    }

    // Set crop params (including useVng for demosaic, bitDepth, and scale)
    const cropParams = new ArrayBuffer(32);
    new Uint32Array(cropParams).set([srcWidth, srcHeight, cropSize, bayerPattern >= 0 ? bayerPattern : 0, batchSize, useVng ? 1 : 0, bitDepth, 0]);
    new Float32Array(cropParams)[7] = scale;
    queue.writeBuffer(buffers.paramsBuffer, 0, cropParams);

    // Prepare all bind groups and parameters upfront
    queue.writeBuffer(buffers.grayParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, 0]));
    queue.writeBuffer(buffers.reductionParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, cropPixelCount]));

    const momentsParamsData = new ArrayBuffer(16);
    new Uint32Array(momentsParamsData, 0, 3).set([cropSize, cropSize, batchSize]);
    new Float32Array(momentsParamsData, 12, 1).set([threshold]);
    queue.writeBuffer(buffers.momentsParamsBuffer, 0, momentsParamsData);

    // Create bind groups for analysis passes
    const grayBindGroup = device.createBindGroup({
        layout: grayscalePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.grayParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.croppedRgbaBuffer } },
            { binding: 2, resource: { buffer: buffers.grayBuffer } }
        ]
    });

    const lapBindGroup = device.createBindGroup({
        layout: tenengradPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.grayParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.grayBuffer } },
            { binding: 2, resource: { buffer: buffers.tenengradBuffer } },
            { binding: 3, resource: { buffer: buffers.laplacianBuffer } }
        ]
    });

    const reduceBindGroup = device.createBindGroup({
        layout: reductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.tenengradBuffer } },
            { binding: 2, resource: { buffer: buffers.laplacianBuffer } },
            { binding: 3, resource: { buffer: buffers.reductionBuffer } }
        ]
    });

    const momentsBindGroup = device.createBindGroup({
        layout: momentsPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.momentsParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.grayBuffer } },
            { binding: 2, resource: { buffer: buffers.momentsBuffer } }
        ]
    });

    const momentsReduceBindGroup = device.createBindGroup({
        layout: momentsReductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.momentsBuffer } },
            { binding: 2, resource: { buffer: buffers.momentsReductionBuffer } }
        ]
    });

    // Execute all passes in a single command encoder
    const encoder = device.createCommandEncoder();

    // Clear packed gray buffer before demosaic (atomicOr needs zeros)
    const packedGraySize = Math.ceil(batchSize * cropPixelCount / 4) * 4;
    encoder.clearBuffer(buffers.packedGrayBuffer, 0, packedGraySize);

    if (needsDemosaic) {
        // Upload Bayer data (already prepared above)
        queue.writeBuffer(buffers.inputBuffer, 0, bayerData);

        const demosaicCropBindGroup = device.createBindGroup({
            layout: demosaicCropPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: buffers.paramsBuffer } },
                { binding: 1, resource: { buffer: buffers.inputBuffer } },
                { binding: 2, resource: { buffer: buffers.centersBuffer } },
                { binding: 3, resource: { buffer: buffers.croppedRgbaBuffer } },
                { binding: 4, resource: { buffer: buffers.packedGrayBuffer } }
            ]
        });

        // Demosaic + crop pass (also outputs packed grayscale)
        let pass = encoder.beginComputePass();
        pass.setPipeline(demosaicCropPipeline);
        pass.setBindGroup(0, demosaicCropBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();
    } else {
        // RGBA input - write each frame directly to GPU buffer at offset (no staging buffer)
        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const byteOffset = i * srcPixelCount * 4;  // 4 bytes per RGBA pixel
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
            // Write directly to GPU buffer at offset
            queue.writeBuffer(buffers.inputBuffer, byteOffset, src);
        }

        const rgbaCropBindGroup = device.createBindGroup({
            layout: rgbaCropPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: buffers.paramsBuffer } },
                { binding: 1, resource: { buffer: buffers.inputBuffer } },
                { binding: 2, resource: { buffer: buffers.centersBuffer } },
                { binding: 3, resource: { buffer: buffers.croppedRgbaBuffer } },
                { binding: 4, resource: { buffer: buffers.packedGrayBuffer } }
            ]
        });

        // RGBA crop pass (also outputs packed grayscale)
        let pass = encoder.beginComputePass();
        pass.setPipeline(rgbaCropPipeline);
        pass.setBindGroup(0, rgbaCropBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();
    }

    // Grayscale pass
    let pass = encoder.beginComputePass();
    pass.setPipeline(grayscalePipeline);
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

    // Select readback buffers based on generation (double-buffering)
    const useAlt = (cachedCropConfig?.bufferGen || 0) % 2 === 1;
    const readbackBuf = useAlt ? buffers.readbackBufferAlt : buffers.readbackBuffer;
    const momentsReadbackBuf = useAlt ? buffers.momentsReadbackBufferAlt : buffers.momentsReadbackBuffer;
    const croppedReadbackBuf = useAlt ? buffers.croppedReadbackBufferAlt : buffers.croppedReadbackBuffer;
    const packedGrayReadbackBuf = useAlt ? buffers.packedGrayReadbackAlt : buffers.packedGrayReadback;

    // Copy results to readback buffers
    encoder.copyBufferToBuffer(buffers.reductionBuffer, 0, readbackBuf, 0, batchSize * numWorkgroups * 8);
    encoder.copyBufferToBuffer(buffers.momentsReductionBuffer, 0, momentsReadbackBuf, 0, batchSize * numWorkgroups * 6 * 4);
    encoder.copyBufferToBuffer(buffers.croppedRgbaBuffer, 0, croppedReadbackBuf, 0, batchSize * cropPixelCount * 4);
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

    // Packed grayscale for template matching and preview (8-bit, 1 byte per pixel)
    const packedGrayData = new Uint8Array(packedGrayReadbackBuf.getMappedRange().slice(0));
    packedGrayReadbackBuf.unmap();

    releaseBatchSlot();  // Allow next batch to proceed

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
 * @param {boolean} useVng - If true, use VNG demosaic; otherwise bilinear
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
let dcaBoundsTime = 0;      // bounds detection + centroid submit
let dcaCropTime = 0;        // crop submit (non-grayOnly)
let dcaSharpnessTime = 0;   // sharpness + reduction submit

async function detectCropAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold = 0.1, metadataOnly = false, useVng = true, grayOnly = false, nextBatchFrames = null) {
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

    // Wait for a batch slot BEFORE getting buffers (prevents buffer destruction while in use)
    await acquireBatchSlot();

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
    const currentInputBuffer = usePipelinedData && pipelinedUpload.useAltBuffer
        ? analyzeBuffers.inputBufferAlt
        : analyzeBuffers.inputBuffer;

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

        const paramsData = new ArrayBuffer(32);
        new Uint32Array(paramsData).set([srcWidth, srcHeight, batchSize, bayerPattern, useVng ? 1 : 0, bitDepth, 0, 0]);
        new Float32Array(paramsData)[6] = scale;
        queue.writeBuffer(analyzeBuffers.paramsBuffer, 0, paramsData);
        dcaUploadTime += (performance.now() - tUploadStart);

        const tDemosaicStart = performance.now();
        if (grayOnly) {
            // Fast path: demosaic directly to grayscale (no RGBA)
            const demosaicGrayOnlyBindGroup = device.createBindGroup({
                layout: demosaicGrayOnlyPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: analyzeBuffers.paramsBuffer } },
                    { binding: 1, resource: { buffer: currentInputBuffer } },
                    { binding: 2, resource: { buffer: analyzeBuffers.grayBuffer } }
                ]
            });

            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(demosaicGrayOnlyPipeline);
            pass.setBindGroup(0, demosaicGrayOnlyBindGroup);
            pass.dispatchWorkgroups(Math.ceil(srcWidth / 16), Math.ceil(srcHeight / 16), batchSize);
            pass.end();
            logGpuSubmit('detectCropAnalyze:demosaic-grayOnly');
            queue.submit([encoder.finish()]);
            dcaDemosaicTime += (performance.now() - tDemosaicStart);
        } else {
            // Full path: demosaic to RGBA (for cropping and stacking)
            const demosaicBindGroup = device.createBindGroup({
                layout: demosaicPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: analyzeBuffers.paramsBuffer } },
                    { binding: 1, resource: { buffer: currentInputBuffer } },
                    { binding: 2, resource: { buffer: analyzeBuffers.rgbaBuffer } }
                ]
            });

            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(demosaicPipeline);
            pass.setBindGroup(0, demosaicBindGroup);
            pass.dispatchWorkgroups(Math.ceil(srcWidth / 16), Math.ceil(srcHeight / 16), batchSize);
            pass.end();
            logGpuSubmit('detectCropAnalyze:demosaic');
            queue.submit([encoder.finish()]);
            dcaDemosaicTime += (performance.now() - tDemosaicStart);
        }
    } else {
        // RGBA input - write each frame directly to GPU buffer at offset
        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const byteOffset = i * srcPixelCount * 4;
            let src = frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray
                ? frame.data
                : new Uint8Array(frame.data.buffer || frame.data);
            queue.writeBuffer(analyzeBuffers.rgbaBuffer, byteOffset, src);
        }
        dcaUploadTime += (performance.now() - tUploadStart);
    }

    // ===== STEP 2: Bounds detection on full frame =====
    const tBoundsStart = performance.now();
    // When grayOnly: grayscale already computed by demosaic, skip grayscale pass
    // When !grayOnly: need to compute grayscale from RGBA
    queue.writeBuffer(analyzeBuffers.paramsBuffer, 0, new Uint32Array([srcWidth, srcHeight, batchSize, 0]));
    queue.writeBuffer(analyzeBuffers.reductionParamsBuffer, 0, new Uint32Array([srcWidth, srcHeight, batchSize, srcPixelCount]));

    const boundsParamsData = new ArrayBuffer(16);
    new Uint32Array(boundsParamsData, 0, 3).set([srcWidth, srcHeight, batchSize]);
    new Float32Array(boundsParamsData, 12, 1).set([threshold]);
    queue.writeBuffer(analyzeBuffers.boundsParamsBuffer, 0, boundsParamsData);

    const boundsBindGroup = device.createBindGroup({
        layout: boundsPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: analyzeBuffers.boundsParamsBuffer } },
            { binding: 1, resource: { buffer: analyzeBuffers.grayBuffer } },
            { binding: 2, resource: { buffer: analyzeBuffers.boundsBuffer } }
        ]
    });

    const boundsReductionBindGroup = device.createBindGroup({
        layout: boundsReductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: analyzeBuffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: analyzeBuffers.boundsBuffer } },
            { binding: 2, resource: { buffer: analyzeBuffers.boundsReductionBuffer } }
        ]
    });

    let encoder = device.createCommandEncoder();

    // Only run grayscale pass if we have RGBA (not grayOnly)
    if (!grayOnly) {
        const grayBindGroup = device.createBindGroup({
            layout: grayscalePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: analyzeBuffers.paramsBuffer } },
                { binding: 1, resource: { buffer: analyzeBuffers.rgbaBuffer } },
                { binding: 2, resource: { buffer: analyzeBuffers.grayBuffer } }
            ]
        });
        let pass = encoder.beginComputePass();
        pass.setPipeline(grayscalePipeline);
        pass.setBindGroup(0, grayBindGroup);
        pass.dispatchWorkgroups(Math.ceil(srcWidth / 16), Math.ceil(srcHeight / 16), batchSize);
        pass.end();
    }

    let pass = encoder.beginComputePass();
    pass.setPipeline(boundsPipeline);
    pass.setBindGroup(0, boundsBindGroup);
    pass.dispatchWorkgroups(Math.ceil(srcWidth / 16), Math.ceil(srcHeight / 16), batchSize);
    pass.end();

    pass = encoder.beginComputePass();
    pass.setPipeline(boundsReductionPipeline);
    pass.setBindGroup(0, boundsReductionBindGroup);
    pass.dispatchWorkgroups(numWorkgroupsFull, batchSize, 1);
    pass.end();

    // ===== STEP 3: Compute centroids on GPU (no CPU sync) =====
    queue.writeBuffer(cropBuffers.centroidParamsBuffer, 0, new Uint32Array([srcWidth, srcHeight, batchSize, numWorkgroupsFull]));

    const centroidBindGroup = device.createBindGroup({
        layout: centroidPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: cropBuffers.centroidParamsBuffer } },
            { binding: 1, resource: { buffer: analyzeBuffers.boundsReductionBuffer } },
            { binding: 2, resource: { buffer: cropBuffers.centersBuffer } },
            { binding: 3, resource: { buffer: cropBuffers.boundsOutputBuffer } }
        ]
    });

    pass = encoder.beginComputePass();
    pass.setPipeline(centroidPipeline);
    pass.setBindGroup(0, centroidBindGroup);
    pass.dispatchWorkgroups(Math.ceil(batchSize / 64), 1, 1);
    pass.end();

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
        const rgbaCropBindGroup = device.createBindGroup({
            layout: rgbaCropPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: cropBuffers.paramsBuffer } },
                { binding: 1, resource: { buffer: analyzeBuffers.rgbaBuffer } },  // Source: full demosaiced
                { binding: 2, resource: { buffer: cropBuffers.centersBuffer } },
                { binding: 3, resource: { buffer: cropBuffers.croppedRgbaBuffer } },  // Dest: cropped
                { binding: 4, resource: { buffer: cropBuffers.packedGrayBuffer } }  // Grayscale output (unused in detection)
            ]
        });
        pass = encoder.beginComputePass();
        pass.setPipeline(rgbaCropPipeline);
        pass.setBindGroup(0, rgbaCropBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();
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
        // Params: srcWidth, srcHeight, cropSize, batchSize
        queue.writeBuffer(cropBuffers.paramsBuffer, 0, new Uint32Array([srcWidth, srcHeight, cropSize, batchSize]));

        const offsetLapBindGroup = device.createBindGroup({
            layout: offsetTenengradPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: cropBuffers.paramsBuffer } },
                { binding: 1, resource: { buffer: analyzeBuffers.grayBuffer } },  // Full-frame grayscale
                { binding: 2, resource: { buffer: cropBuffers.centersBuffer } },  // Per-frame centers
                { binding: 3, resource: { buffer: cropBuffers.tenengradBuffer } },
                { binding: 4, resource: { buffer: cropBuffers.laplacianBuffer } }
            ]
        });

        pass = encoder.beginComputePass();
        pass.setPipeline(offsetTenengradPipeline);
        pass.setBindGroup(0, offsetLapBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();
    } else {
        // Standard path: grayscale from cropped RGBA + tenengrad on cropped
        queue.writeBuffer(cropBuffers.grayParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, 0]));

        const cropGrayBindGroup = device.createBindGroup({
            layout: grayscalePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: cropBuffers.grayParamsBuffer } },
                { binding: 1, resource: { buffer: cropBuffers.croppedRgbaBuffer } },
                { binding: 2, resource: { buffer: cropBuffers.grayBuffer } }
            ]
        });

        const lapBindGroup = device.createBindGroup({
            layout: tenengradPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: cropBuffers.grayParamsBuffer } },
                { binding: 1, resource: { buffer: cropBuffers.grayBuffer } },
                { binding: 2, resource: { buffer: cropBuffers.tenengradBuffer } },
                { binding: 3, resource: { buffer: cropBuffers.laplacianBuffer } }
            ]
        });

        pass = encoder.beginComputePass();
        pass.setPipeline(grayscalePipeline);
        pass.setBindGroup(0, cropGrayBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();

        pass = encoder.beginComputePass();
        pass.setPipeline(tenengradPipeline);
        pass.setBindGroup(0, lapBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();
    }

    // Reduction is the same for both paths (reads from tenengradBuffer)
    const reductionBindGroup = device.createBindGroup({
        layout: reductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: cropBuffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: cropBuffers.tenengradBuffer } },
            { binding: 2, resource: { buffer: cropBuffers.laplacianBuffer } },
            { binding: 3, resource: { buffer: cropBuffers.reductionBuffer } }
        ]
    });

    pass = encoder.beginComputePass();
    pass.setPipeline(reductionPipeline);
    pass.setBindGroup(0, reductionBindGroup);
    pass.dispatchWorkgroups(numWorkgroupsCrop, batchSize, 1);
    pass.end();

    // Select readback buffers based on generation (double-buffering)
    const bufferGen = cachedCropConfig?.bufferGen || 0;
    const useAlt = bufferGen % 2 === 1;
    const readbackBuf = useAlt ? cropBuffers.readbackBufferAlt : cropBuffers.readbackBuffer;
    const croppedReadbackBuf = useAlt ? cropBuffers.croppedReadbackBufferAlt : cropBuffers.croppedReadbackBuffer;
    const boundsReadbackBuf = useAlt ? cropBuffers.boundsOutputReadbackAlt : cropBuffers.boundsOutputReadback;
    const grayReadbackBuf = useAlt ? cropBuffers.grayReadbackAlt : cropBuffers.grayReadback;

    // Copy results for readback
    encoder.copyBufferToBuffer(cropBuffers.reductionBuffer, 0, readbackBuf, 0, batchSize * numWorkgroupsCrop * 8);
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
        safeMapAsync(readbackBuf, GPUMapMode.READ),
        safeMapAsync(boundsReadbackBuf, GPUMapMode.READ)
    ];
    if (!grayOnly) {
        mapPromises.push(safeMapAsync(croppedReadbackBuf, GPUMapMode.READ));
        mapPromises.push(safeMapAsync(grayReadbackBuf, GPUMapMode.READ));
    }

    // ===== PIPELINING: Prepare next batch while waiting for GPU =====
    // While GPU processes current batch, prepare and upload next batch to alternate buffer
    if (nextBatchFrames && nextBatchFrames.length > 0 && needsDemosaic) {
        const nextSrcPixelCount = srcWidth * srcHeight;  // Same dimensions
        const nextPrepared = prepareBayerData(nextBatchFrames, nextSrcPixelCount, false);

        // Upload to the buffer we're NOT currently using
        const nextInputBuffer = usePipelinedData && pipelinedUpload.useAltBuffer
            ? analyzeBuffers.inputBuffer      // Current used alt, so next uses primary
            : analyzeBuffers.inputBufferAlt;  // Current used primary, so next uses alt

        queue.writeBuffer(nextInputBuffer, 0, nextPrepared.data);

        // Mark as ready for next batch
        pipelinedUpload.ready = true;
        pipelinedUpload.useAltBuffer = !pipelinedUpload.useAltBuffer;  // Toggle
        pipelinedUpload.scale = nextPrepared.scale;
        pipelinedUpload.batchSize = nextBatchFrames.length;
    }

    await Promise.all(mapPromises);
    const tAfterMapAsync = performance.now();
    dcaMapAsyncTime += (tAfterMapAsync - tAfterSubmit);

    const reductionData = new Float32Array(readbackBuf.getMappedRange().slice(0));
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

    readbackBuf.unmap();
    boundsReadbackBuf.unmap();
    if (!grayOnly) {
        croppedReadbackBuf.unmap();
        grayReadbackBuf.unmap();
    }
    releaseBatchSlot();  // Allow next batch to proceed

    // Build bounds and centers arrays from GPU output
    const bounds = [];
    const centers = [];
    for (let i = 0; i < batchSize; i++) {
        const minX = boundsData[i * 4];
        const minY = boundsData[i * 4 + 1];
        const maxX = boundsData[i * 4 + 2];
        const maxY = boundsData[i * 4 + 3];

        if (maxX > minX && maxY > minY) {
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
        } else {
            centers.push(null);
            bounds.push(null);
        }
    }

    // Build results
    const results = [];
    for (let i = 0; i < batchSize; i++) {
        // Sum both Tenengrad and Laplacian from workgroups
        let tenengradSum = 0, laplacianSum = 0;
        for (let w = 0; w < numWorkgroupsCrop; w++) {
            const idx = (i * numWorkgroupsCrop + w) * 2;
            tenengradSum += reductionData[idx];
            laplacianSum += reductionData[idx + 1];
        }
        // Scale by 255² = 65025 to match CPU which uses 0-255 grayscale (GPU uses 0-1)
        const tenengradMean = (tenengradSum / cropPixelCount) * 65025;
        const laplacianMean = (laplacianSum / cropPixelCount) * 65025;
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
            height: cropSize
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
        console.log(`[GPU Timing] ${dcaBatchCount} batches: upload=${(dcaUploadTime/dcaBatchCount).toFixed(1)}ms, demosaic=${(dcaDemosaicTime/dcaBatchCount).toFixed(1)}ms, bounds=${(dcaBoundsTime/dcaBatchCount).toFixed(1)}ms, crop=${(dcaCropTime/dcaBatchCount).toFixed(1)}ms, sharpness=${(dcaSharpnessTime/dcaBatchCount).toFixed(1)}ms, mapAsync=${(dcaMapAsyncTime/dcaBatchCount).toFixed(1)}ms`);
    }

    return results;
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

    const inputBuffer = device.createBuffer({
        size: u32Count * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    queue.writeBuffer(inputBuffer, 0, inputData);

    const outputBuffer = device.createBuffer({
        size: pixelCount * outputBytesPerPixel,  // Float32 RGBA output
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    const readbackBuffer = device.createBuffer({
        size: pixelCount * outputBytesPerPixel,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    const paramsBuffer = device.createBuffer({
        size: 32,  // 8 u32 values for demosaic params
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

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

            const bindGroup = device.createBindGroup({
                layout: demosaicPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: paramsBuffer } },
                    { binding: 1, resource: { buffer: inputBuffer } },
                    { binding: 2, resource: { buffer: outputBuffer } }
                ]
            });

            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(demosaicPipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(Math.ceil(srcWidth / 16), Math.ceil(srcHeight / 16), 1);
            pass.end();
            encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, pixelCount * outputBytesPerPixel);
            logGpuSubmit('singleFrame:demosaic');
            queue.submit([encoder.finish()]);

            await safeMapAsync(readbackBuffer, GPUMapMode.READ);
            // Demosaic outputs Float32 RGBA (4 floats per pixel, values 0-1)
            // Convert to Uint8 for thumbnail display
            const float32Data = new Float32Array(readbackBuffer.getMappedRange().slice(0));
            readbackBuffer.unmap();

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
    readbackBuffer.destroy();
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

    if (type === 'analyze-batch') {
        if (!isReady) {
            self.postMessage({ type: 'analyze-error', error: 'Not initialized' });
            return;
        }

        const { frames, width, height, bayerPattern, threshold, requestId, metadataOnly, useVng = false, grayOnly = false } = e.data;

        try {
            const results = await analyzeBatch(frames, width, height, bayerPattern, threshold, metadataOnly, useVng, grayOnly);
            // Transfer uint8Buffer or float32Buffer depending on mode (none in grayOnly mode)
            const transferables = results.map(r => r.uint8Buffer || r.float32Buffer).filter(b => b);
            self.postMessage({ type: 'analyze-result', requestId, results }, transferables);
        } catch (err) {
            console.error(`[GPU] analyze-batch error:`, err);
            self.postMessage({ type: 'analyze-error', requestId, error: err.message });
        }
        return;
    }

    if (type === 'crop-analyze-batch') {
        if (!isReady) {
            self.postMessage({ type: 'crop-analyze-error', error: 'Not initialized', requestId: e.data.requestId });
            return;
        }

        const { frames, srcWidth, srcHeight, cropSize, centers, bayerPattern, threshold, requestId, metadataOnly, useVng = false } = e.data;

        try {
            const results = await cropAndAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, centers, bayerPattern, threshold, metadataOnly, useVng);
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

        const { frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold, requestId, metadataOnly, useVng = false, grayOnly = false, nextBatchFrames = null } = e.data;

        try {
            const results = await detectCropAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold, metadataOnly, useVng, grayOnly, nextBatchFrames);
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

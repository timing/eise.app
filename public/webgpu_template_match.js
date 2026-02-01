// WebGPU Template Matching for Alignment Points
// Uses normalized cross-correlation (NCC) computed on GPU
// Optimized with buffer reuse and multi-frame batching
//
// MEMORY OPTIMIZATION: Frame grayscale data uses packed u8 format (4 pixels per u32)
// instead of f32, providing 4x memory savings. This is safe because:
// - NCC normalizes by mean/variance, so relative patterns matter, not absolute precision
// - 256 intensity levels capture planetary features well (high contrast against dark sky)
// - 20x20 patches (400 pixels) provide statistical robustness for reliable correlation
// - Industry standard: AutoStakkert, PIPP, Registax all use 8-bit for alignment
// - The NCC computation itself still uses f32 internally for accumulation precision
// Reference templates remain f32 (small and reused across all frames, negligible savings)

let gpuDevice = null;
let gpuQueue = null;
let nccPipeline = null;
let batchPipeline = null;
let isInitialized = false;
let matchDeviceLost = false; // Track if GPU device was lost
let matchReinitializing = false;
let matchReinitAttempts = 0;
const MATCH_MAX_REINIT_ATTEMPTS = 3;

// Forward declaration for auto-recovery
let reinitializeMatchGpu = null;

// Helper function to safely map GPU buffer with device lost detection and auto-recovery
async function safeMatchMapAsync(buffer, mode) {
    if (matchDeviceLost && !matchReinitializing) {
        // Try to recover
        if (reinitializeMatchGpu && matchReinitAttempts < MATCH_MAX_REINIT_ATTEMPTS) {
            console.log('Template match GPU device lost, attempting auto-recovery...');
            const recovered = await reinitializeMatchGpu();
            if (!recovered) {
                throw new Error('GPU device was lost and could not be recovered. Please reload the page.');
            }
            throw new Error('GPU_DEVICE_RECOVERED');
        }
        throw new Error('GPU device was lost. Please reload the page to continue.');
    }
    try {
        await buffer.mapAsync(mode);
    } catch (err) {
        if (err.message && (err.message.includes('Instance reference') || err.message.includes('Device') && err.message.includes('lost'))) {
            matchDeviceLost = true;
            gpuDevice = null;
            gpuQueue = null;
            isInitialized = false;

            // Try to recover
            if (reinitializeMatchGpu && matchReinitAttempts < MATCH_MAX_REINIT_ATTEMPTS) {
                console.log('Template match GPU device lost during buffer operation, attempting auto-recovery...');
                const recovered = await reinitializeMatchGpu();
                if (recovered) {
                    throw new Error('GPU_DEVICE_RECOVERED');
                }
            }
            throw new Error('GPU device was lost during buffer operation. Please reload the page.');
        }
        throw err;
    }
}

// Cached buffers for reuse (single-frame matching)
let cachedBuffers = null;
let cachedConfig = null;

// Cached buffers for batch matching
let cachedBatchBuffers = null;
let cachedBatchConfig = null;

// WGSL shader for normalized cross-correlation (single frame)
const nccShaderCode = `
struct Params {
    templateWidth: u32,
    templateHeight: u32,
    searchWidth: u32,
    searchHeight: u32,
    numAPs: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> templates: array<f32>;
@group(0) @binding(2) var<storage, read> searchAreas: array<f32>;
@group(0) @binding(3) var<storage, read_write> results: array<f32>;

fn computeNCC(apIdx: u32, offsetX: i32, offsetY: i32) -> f32 {
    let tw = params.templateWidth;
    let th = params.templateHeight;
    let sw = params.searchWidth;
    let sh = params.searchHeight;

    let templateStart = apIdx * tw * th;
    let searchStart = apIdx * sw * sh;

    var templateSum: f32 = 0.0;
    var searchSum: f32 = 0.0;
    let n = f32(tw * th);

    for (var y: u32 = 0u; y < th; y++) {
        for (var x: u32 = 0u; x < tw; x++) {
            templateSum += templates[templateStart + y * tw + x];
            let sx = i32(x) + offsetX;
            let sy = i32(y) + offsetY;
            if (sx >= 0 && sx < i32(sw) && sy >= 0 && sy < i32(sh)) {
                searchSum += searchAreas[searchStart + u32(sy) * sw + u32(sx)];
            }
        }
    }

    let templateMean = templateSum / n;
    let searchMean = searchSum / n;

    var numerator: f32 = 0.0;
    var templateVar: f32 = 0.0;
    var searchVar: f32 = 0.0;

    for (var y: u32 = 0u; y < th; y++) {
        for (var x: u32 = 0u; x < tw; x++) {
            let tVal = templates[templateStart + y * tw + x] - templateMean;
            templateVar += tVal * tVal;

            let sx = i32(x) + offsetX;
            let sy = i32(y) + offsetY;
            if (sx >= 0 && sx < i32(sw) && sy >= 0 && sy < i32(sh)) {
                let sVal = searchAreas[searchStart + u32(sy) * sw + u32(sx)] - searchMean;
                searchVar += sVal * sVal;
                numerator += tVal * sVal;
            }
        }
    }

    let denominator = sqrt(templateVar * searchVar);
    if (denominator < 0.0001) {
        return 0.0;
    }
    return numerator / denominator;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let apIdx = gid.z;
    if (apIdx >= params.numAPs) {
        return;
    }

    let searchRadius = (params.searchWidth - params.templateWidth) / 2u;
    let offsetX = i32(gid.x);
    let offsetY = i32(gid.y);

    let maxOffset = i32(searchRadius * 2u + 1u);
    if (offsetX >= maxOffset || offsetY >= maxOffset) {
        return;
    }

    let score = computeNCC(apIdx, offsetX, offsetY);
    let resultIdx = apIdx * (searchRadius * 2u + 1u) * (searchRadius * 2u + 1u) + u32(offsetY) * (searchRadius * 2u + 1u) + u32(offsetX);
    results[resultIdx] = score;
}
`;

// Batch shader with GPU-side max reduction - outputs only (dx, dy, quality) per (frame, AP)
// Uses workgroup shared memory for parallel reduction
//
// PRECISION NOTE: Frame grayscale data is stored as packed u8 (4 pixels per u32) for memory efficiency.
// This is sufficient for alignment because:
// 1. NCC normalizes by mean/variance - relative patterns matter, not absolute precision
// 2. 256 intensity levels capture planetary features well (good contrast against dark sky)
// 3. The 20x20 patch size (400 pixels) provides statistical robustness
// 4. Professional stacking software (AutoStakkert, PIPP, Registax) all use 8-bit for alignment
// 5. The NCC math still uses f32 internally for accumulation precision
// Reference templates remain f32 for simplicity since they're small and reused across all frames.
const batchShaderCode = `
struct Params {
    templateWidth: u32,
    templateHeight: u32,
    searchWidth: u32,
    searchHeight: u32,
    numAPs: u32,
    numFrames: u32,
    frameWidth: u32,
    frameHeight: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> refTemplates: array<f32>;     // Reference templates for all APs (f32 - small, reused)
@group(0) @binding(2) var<storage, read> frameGraysPacked: array<u32>; // Packed u8 grayscale (4 pixels per u32, 4x memory savings)
@group(0) @binding(3) var<storage, read> apPositions: array<u32>;      // AP x,y positions (packed)
@group(0) @binding(4) var<storage, read_write> results: array<f32>;    // Results: numFrames * numAPs * 3 (dx, dy, score)

// Shared memory for workgroup reduction (256 threads max)
var<workgroup> sharedScores: array<f32, 256>;
var<workgroup> sharedOffsets: array<u32, 256>;  // Packed (dx << 16) | dy

// Sample a pixel from packed u8 grayscale data, returns 0.0-255.0
fn sampleFrame(frameIdx: u32, x: i32, y: i32) -> f32 {
    if (x < 0 || y < 0 || u32(x) >= params.frameWidth || u32(y) >= params.frameHeight) {
        return 0.0;
    }
    let frameSize = params.frameWidth * params.frameHeight;
    let pixelIdx = frameIdx * frameSize + u32(y) * params.frameWidth + u32(x);
    // Unpack: 4 u8 values stored in each u32
    let packedIdx = pixelIdx >> 2u;           // Divide by 4
    let byteOffset = (pixelIdx & 3u) << 3u;   // (pixelIdx % 4) * 8
    let packed = frameGraysPacked[packedIdx];
    return f32((packed >> byteOffset) & 0xFFu);
}

fn computeBatchNCC(frameIdx: u32, apIdx: u32, offsetX: i32, offsetY: i32) -> f32 {
    let tw = params.templateWidth;
    let th = params.templateHeight;
    let templateSize = tw * th;
    let templateStart = apIdx * templateSize;

    // Get AP position
    let apPos = apPositions[apIdx];
    let apX = i32(apPos & 0xFFFFu);
    let apY = i32(apPos >> 16u);
    let halfPatch = i32(tw / 2u);

    // Search area top-left in frame
    let sx0 = apX - halfPatch + offsetX;
    let sy0 = apY - halfPatch + offsetY;

    var templateSum: f32 = 0.0;
    var searchSum: f32 = 0.0;
    let n = f32(templateSize);

    for (var y: u32 = 0u; y < th; y++) {
        for (var x: u32 = 0u; x < tw; x++) {
            templateSum += refTemplates[templateStart + y * tw + x];
            searchSum += sampleFrame(frameIdx, sx0 + i32(x), sy0 + i32(y));
        }
    }

    let templateMean = templateSum / n;
    let searchMean = searchSum / n;

    var numerator: f32 = 0.0;
    var templateVar: f32 = 0.0;
    var searchVar: f32 = 0.0;

    for (var y: u32 = 0u; y < th; y++) {
        for (var x: u32 = 0u; x < tw; x++) {
            let tVal = refTemplates[templateStart + y * tw + x] - templateMean;
            templateVar += tVal * tVal;
            let sVal = sampleFrame(frameIdx, sx0 + i32(x), sy0 + i32(y)) - searchMean;
            searchVar += sVal * sVal;
            numerator += tVal * sVal;
        }
    }

    let denominator = sqrt(templateVar * searchVar);
    if (denominator < 0.0001) {
        return 0.0;
    }
    return numerator / denominator;
}

// One workgroup per (frame, AP) pair - 256 threads handle all search positions and reduce
@compute @workgroup_size(256, 1, 1)
fn main(
    @builtin(local_invocation_id) lid: vec3<u32>,
    @builtin(workgroup_id) wid: vec3<u32>
) {
    let frameIdx = wid.x / params.numAPs;
    let apIdx = wid.x % params.numAPs;
    let threadIdx = lid.x;

    if (frameIdx >= params.numFrames || apIdx >= params.numAPs) {
        return;
    }

    let searchRadius = i32((params.searchWidth - params.templateWidth) / 2u);
    let gridSize = u32(2 * searchRadius + 1);
    let totalPositions = gridSize * gridSize;

    // Each thread may handle multiple search positions
    var bestScore: f32 = -1.0;
    var bestDx: i32 = 0;
    var bestDy: i32 = 0;

    // Loop over positions assigned to this thread
    var pos = threadIdx;
    while (pos < totalPositions) {
        let dy = i32(pos / gridSize);
        let dx = i32(pos % gridSize);
        let offsetX = dx - searchRadius;
        let offsetY = dy - searchRadius;

        let score = computeBatchNCC(frameIdx, apIdx, offsetX, offsetY);
        if (score > bestScore) {
            bestScore = score;
            bestDx = offsetX;
            bestDy = offsetY;
        }
        pos += 256u;
    }

    // Store local best in shared memory (offset by searchRadius to make positive for packing)
    sharedScores[threadIdx] = bestScore;
    let packedOffset = u32(bestDx + searchRadius) | (u32(bestDy + searchRadius) << 16u);
    sharedOffsets[threadIdx] = packedOffset;
    workgroupBarrier();

    // Parallel reduction to find global best in workgroup
    for (var stride: u32 = 128u; stride > 0u; stride = stride >> 1u) {
        if (threadIdx < stride) {
            let other = threadIdx + stride;
            if (sharedScores[other] > sharedScores[threadIdx]) {
                sharedScores[threadIdx] = sharedScores[other];
                sharedOffsets[threadIdx] = sharedOffsets[other];
            }
        }
        workgroupBarrier();
    }

    // Thread 0 writes final result: (dx, dy, score) for this (frame, AP)
    if (threadIdx == 0u) {
        let finalOffset = sharedOffsets[0];
        let finalDx = i32(finalOffset & 0xFFFFu) - searchRadius;
        let finalDy = i32(finalOffset >> 16u) - searchRadius;
        let finalScore = sharedScores[0];

        let resultIdx = (frameIdx * params.numAPs + apIdx) * 3u;
        results[resultIdx] = f32(finalDx);
        results[resultIdx + 1u] = f32(finalDy);
        results[resultIdx + 2u] = finalScore;
    }
}
`;

async function initWebGPU() {
    if (isInitialized) return true;

    if (!navigator.gpu) {
        console.log('WebGPU not available');
        return false;
    }

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            console.log('No WebGPU adapter found');
            return false;
        }

        // Request higher buffer limits for batching
        const adapterLimits = adapter.limits;
        gpuDevice = await adapter.requestDevice({
            requiredLimits: {
                maxBufferSize: adapterLimits.maxBufferSize,
                maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize
            }
        });
        gpuQueue = gpuDevice.queue;

        // Handle device lost - attempt auto-recovery
        gpuDevice.lost.then(async (info) => {
            console.warn('Template match GPU device lost:', info.message);
            matchDeviceLost = true;
            gpuDevice = null;
            gpuQueue = null;
            nccPipeline = null;
            batchPipeline = null;
            isInitialized = false;
            cachedBuffers = null;
            cachedConfig = null;
            cachedBatchBuffers = null;
            cachedBatchConfig = null;

            // Attempt automatic recovery
            if (matchReinitAttempts < MATCH_MAX_REINIT_ATTEMPTS) {
                console.log(`Template match GPU auto-recovery attempt ${matchReinitAttempts + 1}/${MATCH_MAX_REINIT_ATTEMPTS}...`);
                await new Promise(resolve => setTimeout(resolve, 500));
                matchReinitializing = true;
                matchReinitAttempts++;
                try {
                    const success = await initWebGPU();
                    if (success) {
                        matchDeviceLost = false;
                        console.log('Template match GPU device recovered successfully');
                    }
                } finally {
                    matchReinitializing = false;
                }
            } else {
                console.error('Template match GPU device lost - max recovery attempts exceeded');
            }
        });

        // Create single-frame pipeline
        const shaderModule = gpuDevice.createShaderModule({
            code: nccShaderCode
        });
        nccPipeline = gpuDevice.createComputePipeline({
            layout: 'auto',
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        // Create batch pipeline
        const batchShaderModule = gpuDevice.createShaderModule({
            code: batchShaderCode
        });
        batchPipeline = gpuDevice.createComputePipeline({
            layout: 'auto',
            compute: { module: batchShaderModule, entryPoint: 'main' }
        });

        isInitialized = true;
        matchDeviceLost = false;
        console.log('WebGPU initialized for template matching (with batching)');
        return true;
    } catch (e) {
        console.error('WebGPU init error:', e);
        return false;
    }
}

// Assign the reinitialization function for auto-recovery
reinitializeMatchGpu = async function() {
    if (matchReinitializing) return false;
    matchReinitializing = true;
    try {
        // Clean up any remaining cached buffers (single-frame)
        if (cachedBuffers) {
            try {
                Object.values(cachedBuffers).forEach(buf => {
                    if (buf && buf.destroy) buf.destroy();
                });
            } catch (e) {
                // Ignore cleanup errors
            }
            cachedBuffers = null;
            cachedConfig = null;
        }
        // Clean up batch buffers
        if (cachedBatchBuffers) {
            try {
                Object.values(cachedBatchBuffers).forEach(buf => {
                    if (buf && buf.destroy) buf.destroy();
                });
            } catch (e) {
                // Ignore cleanup errors
            }
            cachedBatchBuffers = null;
            cachedBatchConfig = null;
        }
        isInitialized = false;
        matchReinitAttempts++;
        const success = await initWebGPU();
        if (success) {
            matchDeviceLost = false;
        }
        return success;
    } finally {
        matchReinitializing = false;
    }
};

/**
 * Match templates for a batch of frames at once
 * Much more efficient than calling matchTemplatesGPU for each frame
 * @param searchOffset - Optional {dx, dy} to offset search region in frames (for drift tracking)
 *                       Templates are always extracted from original AP positions in reference
 */
async function matchTemplatesBatchGPU(refGrayData, frameGrayDatas, width, height, alignmentPoints, patchSize, searchRadius, searchOffset = null) {
    if (!isInitialized) {
        const ok = await initWebGPU();
        if (!ok) return null;
    }

    const numFrames = frameGrayDatas.length;
    const numAPs = alignmentPoints.length;

    // WebGPU limit: max workgroups per dimension is 65535
    // We dispatch (numFrames * numAPs) workgroups in X dimension
    const MAX_WORKGROUPS_X = 65535;
    const maxFramesPerBatch = Math.floor(MAX_WORKGROUPS_X / numAPs);

    // If we can fit all frames in one batch, use the simple path
    if (numFrames * numAPs <= MAX_WORKGROUPS_X) {
        return await matchTemplatesBatchGPUSimple(refGrayData, frameGrayDatas, width, height, alignmentPoints, patchSize, searchRadius, searchOffset);
    }

    // Need to batch frames to stay within workgroup limits
    console.log(`Template matching: batching ${numFrames} frames into chunks of ${maxFramesPerBatch} (${numAPs} APs)`);

    const allShifts = [];

    for (let batchStart = 0; batchStart < numFrames; batchStart += maxFramesPerBatch) {
        const batchEnd = Math.min(batchStart + maxFramesPerBatch, numFrames);
        const batchFrames = frameGrayDatas.slice(batchStart, batchEnd);

        const batchShifts = await matchTemplatesBatchGPUSimple(
            refGrayData, batchFrames, width, height, alignmentPoints, patchSize, searchRadius, searchOffset
        );

        allShifts.push(...batchShifts);
    }

    return allShifts;
}

/**
 * Get or create cached buffers for batch matching
 * Note: framesBuffer uses packed u8 format (4 pixels per u32) for 4x memory savings
 */
function getBatchBuffers(numFrames, numAPs, templateSize, frameSize) {
    const align4 = (size) => Math.ceil(size / 4) * 4;

    // Packed u8: 4 pixels per u32, so size = ceil(pixels/4) * 4 bytes
    const packedFrameBytes = Math.ceil(numFrames * frameSize / 4) * 4;

    const requiredSizes = {
        templatesSize: align4(numAPs * templateSize * 4),  // f32 templates (small, reused)
        framesSize: align4(packedFrameBytes),               // packed u8 grayscale (4x savings)
        apPosSize: align4(numAPs * 4),
        resultsSize: align4(numFrames * numAPs * 3 * 4)
    };

    // Check if cached buffers are large enough
    if (cachedBatchBuffers && cachedBatchConfig &&
        cachedBatchConfig.templatesSize >= requiredSizes.templatesSize &&
        cachedBatchConfig.framesSize >= requiredSizes.framesSize &&
        cachedBatchConfig.apPosSize >= requiredSizes.apPosSize &&
        cachedBatchConfig.resultsSize >= requiredSizes.resultsSize) {
        return cachedBatchBuffers;
    }

    // Destroy old buffers
    if (cachedBatchBuffers) {
        Object.values(cachedBatchBuffers).forEach(buf => {
            if (buf && buf.destroy) buf.destroy();
        });
    }

    // Create new buffers with headroom
    const headroom = 1.2;
    const templatesSize = align4(Math.ceil(requiredSizes.templatesSize * headroom));
    const framesSize = align4(Math.ceil(requiredSizes.framesSize * headroom));
    const apPosSize = align4(Math.ceil(requiredSizes.apPosSize * headroom));
    const resultsSize = align4(Math.ceil(requiredSizes.resultsSize * headroom));

    cachedBatchBuffers = {
        paramsBuffer: gpuDevice.createBuffer({
            size: 8 * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        templatesBuffer: gpuDevice.createBuffer({
            size: templatesSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        framesBuffer: gpuDevice.createBuffer({
            size: framesSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        apPosBuffer: gpuDevice.createBuffer({
            size: apPosSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        resultsBuffer: gpuDevice.createBuffer({
            size: resultsSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        readbackBuffer: gpuDevice.createBuffer({
            size: resultsSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        })
    };

    cachedBatchConfig = { templatesSize, framesSize, apPosSize, resultsSize };
    return cachedBatchBuffers;
}

/**
 * Simple implementation that processes all frames at once (must fit within workgroup limits)
 * Uses GPU-side max reduction - only reads back (dx, dy, quality) per (frame, AP)
 */
async function matchTemplatesBatchGPUSimple(refGrayData, frameGrayDatas, width, height, alignmentPoints, patchSize, searchRadius, searchOffset = null) {
    const numFrames = frameGrayDatas.length;
    const numAPs = alignmentPoints.length;
    const templateSize = patchSize * patchSize;
    const frameSize = width * height;

    // Get cached buffers (creates if needed, reuses if large enough)
    const buffers = getBatchBuffers(numFrames, numAPs, templateSize, frameSize);

    // Extract reference templates (once for all frames) - always from original AP positions
    const refTemplates = new Float32Array(numAPs * templateSize);
    const apPositions = new Uint32Array(numAPs);
    const halfPatch = Math.floor(patchSize / 2);

    // Apply search offset for drift tracking (shifts where we search in frames, not where templates come from)
    const offsetX = searchOffset ? Math.round(searchOffset.dx) : 0;
    const offsetY = searchOffset ? Math.round(searchOffset.dy) : 0;

    for (let i = 0; i < numAPs; i++) {
        const ap = alignmentPoints[i];
        // Search positions are offset by drift, templates are extracted from original positions
        const searchX = ap.x + offsetX;
        const searchY = ap.y + offsetY;
        apPositions[i] = (searchX & 0xFFFF) | ((searchY & 0xFFFF) << 16);

        // Extract template from ORIGINAL position (not offset)
        const tx0 = ap.x - halfPatch;
        const ty0 = ap.y - halfPatch;
        for (let py = 0; py < patchSize; py++) {
            for (let px = 0; px < patchSize; px++) {
                const sx = tx0 + px;
                const sy = ty0 + py;
                if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
                    refTemplates[i * templateSize + py * patchSize + px] = refGrayData[sy * width + sx];
                }
            }
        }
    }

    // Pack all frame grayscale data as u8 into u32 (4 pixels per u32)
    // This gives 4x memory savings compared to f32 - see shader comment for why 8-bit is sufficient
    const packedSize = Math.ceil(numFrames * frameSize / 4);
    const allFrameGraysPacked = new Uint32Array(packedSize);
    for (let f = 0; f < numFrames; f++) {
        const gray = frameGrayDatas[f];
        const frameOffset = f * frameSize;
        for (let i = 0; i < frameSize; i += 4) {
            const packedIdx = (frameOffset + i) >> 2;
            // Pack 4 u8 values into one u32 (handle boundary case)
            const v0 = gray[i] || 0;
            const v1 = (i + 1 < frameSize) ? (gray[i + 1] || 0) : 0;
            const v2 = (i + 2 < frameSize) ? (gray[i + 2] || 0) : 0;
            const v3 = (i + 3 < frameSize) ? (gray[i + 3] || 0) : 0;
            allFrameGraysPacked[packedIdx] = v0 | (v1 << 8) | (v2 << 16) | (v3 << 24);
        }
    }

    // Results size for this batch
    const resultsSize = numFrames * numAPs * 3 * 4;

    // Upload data
    const searchSize = patchSize + 2 * searchRadius;
    const paramsData = new Uint32Array([patchSize, patchSize, searchSize, searchSize, numAPs, numFrames, width, height]);
    gpuQueue.writeBuffer(buffers.paramsBuffer, 0, paramsData);
    gpuQueue.writeBuffer(buffers.templatesBuffer, 0, refTemplates);
    gpuQueue.writeBuffer(buffers.framesBuffer, 0, allFrameGraysPacked);
    gpuQueue.writeBuffer(buffers.apPosBuffer, 0, apPositions);

    // Create bind group
    const bindGroup = gpuDevice.createBindGroup({
        layout: batchPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.paramsBuffer } },
            { binding: 1, resource: { buffer: buffers.templatesBuffer } },
            { binding: 2, resource: { buffer: buffers.framesBuffer } },
            { binding: 3, resource: { buffer: buffers.apPosBuffer } },
            { binding: 4, resource: { buffer: buffers.resultsBuffer } }
        ]
    });

    // Dispatch - one workgroup (256 threads) per (frame, AP) pair
    const commandEncoder = gpuDevice.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(batchPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.dispatchWorkgroups(numFrames * numAPs, 1, 1);
    passEncoder.end();

    commandEncoder.copyBufferToBuffer(buffers.resultsBuffer, 0, buffers.readbackBuffer, 0, resultsSize);
    gpuQueue.submit([commandEncoder.finish()]);

    // Read results - already reduced on GPU, just (dx, dy, score) per (frame, AP)
    await safeMatchMapAsync(buffers.readbackBuffer, GPUMapMode.READ);
    const resultsData = new Float32Array(buffers.readbackBuffer.getMappedRange().slice(0));
    buffers.readbackBuffer.unmap();

    // Unpack results - GPU already found the best match
    const allShifts = [];
    for (let f = 0; f < numFrames; f++) {
        const frameShifts = [];
        for (let ap = 0; ap < numAPs; ap++) {
            const baseIdx = (f * numAPs + ap) * 3;
            const dx = resultsData[baseIdx];
            const dy = resultsData[baseIdx + 1];
            const quality = resultsData[baseIdx + 2];
            // Add search offset to get shift relative to original AP position
            frameShifts.push({ dx: dx + offsetX, dy: dy + offsetY, quality });
        }
        allShifts.push(frameShifts);
    }

    // Buffers are cached and reused - no cleanup here
    return allShifts;
}

/**
 * Get or create cached buffers for given configuration (single-frame matching)
 */
function getBuffers(numAPs, patchSize, searchRadius) {
    const templateSize = patchSize * patchSize;
    const searchSize = patchSize + 2 * searchRadius;
    const searchAreaSize = searchSize * searchSize;
    const numSearchPositions = (2 * searchRadius + 1) * (2 * searchRadius + 1);

    const templatesBytes = numAPs * templateSize * 4;
    const searchBytes = numAPs * searchAreaSize * 4;
    const resultsBytes = numAPs * numSearchPositions * 4;

    if (cachedBuffers && cachedConfig &&
        cachedConfig.templatesBytes >= templatesBytes &&
        cachedConfig.searchBytes >= searchBytes &&
        cachedConfig.resultsBytes >= resultsBytes) {
        return cachedBuffers;
    }

    if (cachedBuffers) {
        cachedBuffers.paramsBuffer.destroy();
        cachedBuffers.templatesBuffer.destroy();
        cachedBuffers.searchBuffer.destroy();
        cachedBuffers.resultsBuffer.destroy();
        cachedBuffers.readbackBuffer.destroy();
    }

    cachedBuffers = {
        paramsBuffer: gpuDevice.createBuffer({
            size: 5 * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        templatesBuffer: gpuDevice.createBuffer({
            size: templatesBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        searchBuffer: gpuDevice.createBuffer({
            size: searchBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        resultsBuffer: gpuDevice.createBuffer({
            size: resultsBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        readbackBuffer: gpuDevice.createBuffer({
            size: resultsBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        })
    };

    cachedConfig = { templatesBytes, searchBytes, resultsBytes };
    return cachedBuffers;
}

/**
 * Perform template matching for a single frame (kept for compatibility)
 */
async function matchTemplatesGPU(refGrayData, frameGrayData, width, height, alignmentPoints, patchSize, searchRadius) {
    if (!isInitialized) {
        const ok = await initWebGPU();
        if (!ok) return null;
    }

    const numAPs = alignmentPoints.length;
    const templateSize = patchSize * patchSize;
    const searchSize = (patchSize + 2 * searchRadius);
    const searchAreaSize = searchSize * searchSize;
    const numSearchPositions = (2 * searchRadius + 1) * (2 * searchRadius + 1);

    const buffers = getBuffers(numAPs, patchSize, searchRadius);

    const templates = new Float32Array(numAPs * templateSize);
    const searchAreas = new Float32Array(numAPs * searchAreaSize);
    const halfPatch = Math.floor(patchSize / 2);

    for (let i = 0; i < numAPs; i++) {
        const ap = alignmentPoints[i];
        const tx0 = ap.x - halfPatch;
        const ty0 = ap.y - halfPatch;
        for (let py = 0; py < patchSize; py++) {
            for (let px = 0; px < patchSize; px++) {
                const sx = tx0 + px;
                const sy = ty0 + py;
                if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
                    templates[i * templateSize + py * patchSize + px] = refGrayData[sy * width + sx];
                }
            }
        }

        const sx0 = ap.x - halfPatch - searchRadius;
        const sy0 = ap.y - halfPatch - searchRadius;
        for (let py = 0; py < searchSize; py++) {
            for (let px = 0; px < searchSize; px++) {
                const sx = sx0 + px;
                const sy = sy0 + py;
                if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
                    searchAreas[i * searchAreaSize + py * searchSize + px] = frameGrayData[sy * width + sx];
                }
            }
        }
    }

    const paramsData = new Uint32Array([patchSize, patchSize, searchSize, searchSize, numAPs]);
    gpuQueue.writeBuffer(buffers.paramsBuffer, 0, paramsData);
    gpuQueue.writeBuffer(buffers.templatesBuffer, 0, templates);
    gpuQueue.writeBuffer(buffers.searchBuffer, 0, searchAreas);

    const bindGroup = gpuDevice.createBindGroup({
        layout: nccPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.paramsBuffer } },
            { binding: 1, resource: { buffer: buffers.templatesBuffer } },
            { binding: 2, resource: { buffer: buffers.searchBuffer } },
            { binding: 3, resource: { buffer: buffers.resultsBuffer } }
        ]
    });

    const commandEncoder = gpuDevice.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(nccPipeline);
    passEncoder.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil((2 * searchRadius + 1) / 8);
    const workgroupsY = Math.ceil((2 * searchRadius + 1) / 8);
    passEncoder.dispatchWorkgroups(workgroupsX, workgroupsY, numAPs);
    passEncoder.end();

    const resultsSize = numAPs * numSearchPositions * 4;
    commandEncoder.copyBufferToBuffer(buffers.resultsBuffer, 0, buffers.readbackBuffer, 0, resultsSize);
    gpuQueue.submit([commandEncoder.finish()]);

    await safeMatchMapAsync(buffers.readbackBuffer, GPUMapMode.READ);
    const resultsData = new Float32Array(buffers.readbackBuffer.getMappedRange().slice(0));
    buffers.readbackBuffer.unmap();

    const shifts = [];
    const gridSize = 2 * searchRadius + 1;

    for (let i = 0; i < numAPs; i++) {
        let bestScore = -1;
        let bestDx = 0;
        let bestDy = 0;

        for (let dy = 0; dy < gridSize; dy++) {
            for (let dx = 0; dx < gridSize; dx++) {
                const score = resultsData[i * numSearchPositions + dy * gridSize + dx];
                if (score > bestScore) {
                    bestScore = score;
                    bestDx = dx - searchRadius;
                    bestDy = dy - searchRadius;
                }
            }
        }
        shifts.push({ dx: bestDx, dy: bestDy, quality: bestScore });
    }

    return shifts;
}

function cleanupGPUBuffers() {
    if (cachedBuffers) {
        cachedBuffers.paramsBuffer.destroy();
        cachedBuffers.templatesBuffer.destroy();
        cachedBuffers.searchBuffer.destroy();
        cachedBuffers.resultsBuffer.destroy();
        cachedBuffers.readbackBuffer.destroy();
        cachedBuffers = null;
        cachedConfig = null;
    }
}

// Export for use in worker
if (typeof self !== 'undefined') {
    self.initWebGPU = initWebGPU;
    self.matchTemplatesGPU = matchTemplatesGPU;
    self.matchTemplatesBatchGPU = matchTemplatesBatchGPU;
    self.cleanupGPUBuffers = cleanupGPUBuffers;
}

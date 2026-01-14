// WebGPU Template Matching for Alignment Points
// Uses normalized cross-correlation (NCC) computed on GPU
// Optimized with buffer reuse and multi-frame batching

let gpuDevice = null;
let gpuQueue = null;
let nccPipeline = null;
let batchPipeline = null;
let isInitialized = false;

// Cached buffers for reuse
let cachedBuffers = null;
let cachedConfig = null;

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

// Batch shader - processes multiple frames at once
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
@group(0) @binding(1) var<storage, read> refTemplates: array<f32>;     // Reference templates for all APs
@group(0) @binding(2) var<storage, read> frameGrays: array<f32>;       // All frames' grayscale data
@group(0) @binding(3) var<storage, read> apPositions: array<u32>;      // AP x,y positions (packed)
@group(0) @binding(4) var<storage, read_write> results: array<f32>;    // Results: numFrames * numAPs * 3 (dx, dy, score)

fn sampleFrame(frameIdx: u32, x: i32, y: i32) -> f32 {
    if (x < 0 || y < 0 || u32(x) >= params.frameWidth || u32(y) >= params.frameHeight) {
        return 0.0;
    }
    let frameSize = params.frameWidth * params.frameHeight;
    return frameGrays[frameIdx * frameSize + u32(y) * params.frameWidth + u32(x)];
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

// Each workgroup handles one (frame, AP) pair, threads search different offsets
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
    let frameIdx = wid.z / params.numAPs;
    let apIdx = wid.z % params.numAPs;

    if (frameIdx >= params.numFrames || apIdx >= params.numAPs) {
        return;
    }

    let searchRadius = i32((params.searchWidth - params.templateWidth) / 2u);
    let gridSize = u32(2 * searchRadius + 1);

    let offsetX = i32(gid.x) - searchRadius;
    let offsetY = i32(gid.y) - searchRadius;

    if (gid.x >= gridSize || gid.y >= gridSize) {
        return;
    }

    let score = computeBatchNCC(frameIdx, apIdx, offsetX, offsetY);

    // Store in results array: each AP gets gridSize*gridSize scores, find best on CPU
    let resultsPerAP = gridSize * gridSize;
    let resultIdx = (frameIdx * params.numAPs + apIdx) * resultsPerAP + gid.y * gridSize + gid.x;
    results[resultIdx] = score;
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
        console.log('WebGPU initialized for template matching (with batching)');
        return true;
    } catch (e) {
        console.error('WebGPU init error:', e);
        return false;
    }
}

/**
 * Match templates for a batch of frames at once
 * Much more efficient than calling matchTemplatesGPU for each frame
 */
async function matchTemplatesBatchGPU(refGrayData, frameGrayDatas, width, height, alignmentPoints, patchSize, searchRadius) {
    if (!isInitialized) {
        const ok = await initWebGPU();
        if (!ok) return null;
    }

    const numFrames = frameGrayDatas.length;
    const numAPs = alignmentPoints.length;
    const templateSize = patchSize * patchSize;
    const gridSize = 2 * searchRadius + 1;
    const resultsPerAP = gridSize * gridSize;
    const frameSize = width * height;

    // Extract reference templates (once for all frames)
    const refTemplates = new Float32Array(numAPs * templateSize);
    const apPositions = new Uint32Array(numAPs);
    const halfPatch = Math.floor(patchSize / 2);

    for (let i = 0; i < numAPs; i++) {
        const ap = alignmentPoints[i];
        apPositions[i] = (ap.x & 0xFFFF) | ((ap.y & 0xFFFF) << 16);

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

    // Pack all frame grayscale data
    const allFrameGrays = new Float32Array(numFrames * frameSize);
    for (let f = 0; f < numFrames; f++) {
        const gray = frameGrayDatas[f];
        for (let i = 0; i < frameSize; i++) {
            allFrameGrays[f * frameSize + i] = gray[i];
        }
    }

    // Create buffers
    const paramsBuffer = gpuDevice.createBuffer({
        size: 8 * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const templatesBuffer = gpuDevice.createBuffer({
        size: refTemplates.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const framesBuffer = gpuDevice.createBuffer({
        size: allFrameGrays.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const apPosBuffer = gpuDevice.createBuffer({
        size: apPositions.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const resultsSize = numFrames * numAPs * resultsPerAP * 4;
    const resultsBuffer = gpuDevice.createBuffer({
        size: resultsSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    const readbackBuffer = gpuDevice.createBuffer({
        size: resultsSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    // Upload data
    const searchSize = patchSize + 2 * searchRadius;
    const paramsData = new Uint32Array([patchSize, patchSize, searchSize, searchSize, numAPs, numFrames, width, height]);
    gpuQueue.writeBuffer(paramsBuffer, 0, paramsData);
    gpuQueue.writeBuffer(templatesBuffer, 0, refTemplates);
    gpuQueue.writeBuffer(framesBuffer, 0, allFrameGrays);
    gpuQueue.writeBuffer(apPosBuffer, 0, apPositions);

    // Create bind group
    const bindGroup = gpuDevice.createBindGroup({
        layout: batchPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: { buffer: templatesBuffer } },
            { binding: 2, resource: { buffer: framesBuffer } },
            { binding: 3, resource: { buffer: apPosBuffer } },
            { binding: 4, resource: { buffer: resultsBuffer } }
        ]
    });

    // Dispatch - one workgroup per (frame, AP) pair
    const commandEncoder = gpuDevice.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(batchPipeline);
    passEncoder.setBindGroup(0, bindGroup);

    const workgroupsX = Math.ceil(gridSize / 8);
    const workgroupsY = Math.ceil(gridSize / 8);
    const workgroupsZ = numFrames * numAPs;
    passEncoder.dispatchWorkgroups(workgroupsX, workgroupsY, workgroupsZ);
    passEncoder.end();

    commandEncoder.copyBufferToBuffer(resultsBuffer, 0, readbackBuffer, 0, resultsSize);
    gpuQueue.submit([commandEncoder.finish()]);

    // Read results
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const resultsData = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();

    // Find best match for each (frame, AP)
    const allShifts = [];
    for (let f = 0; f < numFrames; f++) {
        const frameShifts = [];
        for (let ap = 0; ap < numAPs; ap++) {
            let bestScore = -1;
            let bestDx = 0;
            let bestDy = 0;

            const baseIdx = (f * numAPs + ap) * resultsPerAP;
            for (let dy = 0; dy < gridSize; dy++) {
                for (let dx = 0; dx < gridSize; dx++) {
                    const score = resultsData[baseIdx + dy * gridSize + dx];
                    if (score > bestScore) {
                        bestScore = score;
                        bestDx = dx - searchRadius;
                        bestDy = dy - searchRadius;
                    }
                }
            }
            frameShifts.push({ dx: bestDx, dy: bestDy, quality: bestScore });
        }
        allShifts.push(frameShifts);
    }

    // Cleanup
    paramsBuffer.destroy();
    templatesBuffer.destroy();
    framesBuffer.destroy();
    apPosBuffer.destroy();
    resultsBuffer.destroy();
    readbackBuffer.destroy();

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

    await buffers.readbackBuffer.mapAsync(GPUMapMode.READ);
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

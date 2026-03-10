// WebGPU-accelerated frame stacking with local de-warping
// Handles: displacement map generation, frame warping, and accumulation
// Now also handles template matching on same device for zero-copy pipeline

// Import VNG demosaic shaders for stacking (always high quality)
// demosaicVngCropShader: VNG + crop in one pass (for batch stacking)
// rgbaToGrayU8Shader: grayscale extraction for template matching
import { demosaicVngShader, demosaicVngCropShader, rgbaToGrayU8Shader } from './gpu/shaders.js';

// NCC batch template matching shader (moved from webgpu_template_match.js for single-device pipeline)
const nccBatchShaderCode = `
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
@group(0) @binding(1) var<storage, read> refTemplates: array<f32>;
@group(0) @binding(2) var<storage, read> frameGraysPacked: array<u32>;
@group(0) @binding(3) var<storage, read> apPositions: array<u32>;
@group(0) @binding(4) var<storage, read_write> results: array<f32>;

var<workgroup> sharedScores: array<f32, 256>;
var<workgroup> sharedOffsets: array<u32, 256>;

fn sampleFrame(frameIdx: u32, x: i32, y: i32) -> f32 {
    if (x < 0 || y < 0 || u32(x) >= params.frameWidth || u32(y) >= params.frameHeight) {
        return 0.0;
    }
    let frameSize = params.frameWidth * params.frameHeight;
    let pixelIdx = frameIdx * frameSize + u32(y) * params.frameWidth + u32(x);
    let packedIdx = pixelIdx >> 2u;
    let byteOffset = (pixelIdx & 3u) << 3u;
    let packed = frameGraysPacked[packedIdx];
    return f32((packed >> byteOffset) & 0xFFu);
}

fn computeBatchNCC(frameIdx: u32, apIdx: u32, offsetX: i32, offsetY: i32) -> f32 {
    let tw = params.templateWidth;
    let th = params.templateHeight;
    let templateSize = tw * th;
    let templateStart = apIdx * templateSize;

    let apPos = apPositions[apIdx];
    let apX = i32(apPos & 0xFFFFu);
    let apY = i32(apPos >> 16u);
    let halfPatch = i32(tw / 2u);

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

    var bestScore: f32 = -1.0;
    var bestDx: i32 = 0;
    var bestDy: i32 = 0;

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

    sharedScores[threadIdx] = bestScore;
    let packedOffset = u32(bestDx + searchRadius) | (u32(bestDy + searchRadius) << 16u);
    sharedOffsets[threadIdx] = packedOffset;
    workgroupBarrier();

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

    if (threadIdx == 0u) {
        let finalOffset = sharedOffsets[0];
        let intDx = i32(finalOffset & 0xFFFFu) - searchRadius;
        let intDy = i32(finalOffset >> 16u) - searchRadius;
        let centerScore = sharedScores[0];

        var subDx: f32 = 0.0;
        var subDy: f32 = 0.0;

        if (intDx > -searchRadius && intDx < searchRadius) {
            let scoreLeft = computeBatchNCC(frameIdx, apIdx, intDx - 1, intDy);
            let scoreRight = computeBatchNCC(frameIdx, apIdx, intDx + 1, intDy);
            let denom = scoreLeft - 2.0 * centerScore + scoreRight;
            if (abs(denom) > 0.0001) {
                subDx = clamp(0.5 * (scoreLeft - scoreRight) / denom, -0.5, 0.5);
            }
        }

        if (intDy > -searchRadius && intDy < searchRadius) {
            let scoreUp = computeBatchNCC(frameIdx, apIdx, intDx, intDy - 1);
            let scoreDown = computeBatchNCC(frameIdx, apIdx, intDx, intDy + 1);
            let denom = scoreUp - 2.0 * centerScore + scoreDown;
            if (abs(denom) > 0.0001) {
                subDy = clamp(0.5 * (scoreUp - scoreDown) / denom, -0.5, 0.5);
            }
        }

        let resultIdx = (frameIdx * params.numAPs + apIdx) * 3u;
        results[resultIdx] = f32(intDx) + subDx;
        results[resultIdx + 1u] = f32(intDy) + subDy;
        results[resultIdx + 2u] = centerScore;
    }
}
`;

let stackDevice = null;
let stackQueue = null;
let warpPipeline = null;
let accumulatePipeline = null;
let nccBatchPipeline = null;  // Template matching on same device
let isStackingReady = false;
let stackDeviceLost = false; // Track if GPU device was lost
let stackReinitializing = false;
let stackReinitAttempts = 0;
const STACK_MAX_REINIT_ATTEMPTS = 3;

// Forward declaration for auto-recovery
let reinitializeStackingGpu = null;

// Helper function to safely map GPU buffer with device lost detection and auto-recovery
async function safeStackMapAsync(buffer, mode) {
    if (stackDeviceLost && !stackReinitializing) {
        // Try to recover
        if (reinitializeStackingGpu && stackReinitAttempts < STACK_MAX_REINIT_ATTEMPTS) {
            console.log('Stacking GPU device lost, attempting auto-recovery...');
            const recovered = await reinitializeStackingGpu();
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
            stackDeviceLost = true;
            stackDevice = null;
            stackQueue = null;
            isStackingReady = false;

            // Try to recover
            if (reinitializeStackingGpu && stackReinitAttempts < STACK_MAX_REINIT_ATTEMPTS) {
                console.log('Stacking GPU device lost during buffer operation, attempting auto-recovery...');
                const recovered = await reinitializeStackingGpu();
                if (recovered) {
                    throw new Error('GPU_DEVICE_RECOVERED');
                }
            }
            throw new Error('GPU device was lost during buffer operation. Please reload the page.');
        }
        throw err;
    }
}

// Cached buffers
let cachedStackBuffers = null;
let cachedStackConfig = null;

// Number of frame buffers for batched processing
// Allows N frames to be uploaded and dispatched in a single submit
// Keep at 2 to match analysis phase tuning (3+ caused slowdown due to memory pressure)
const NUM_FRAME_BUFFERS = 2;

// Warp + accumulate shader - computes displacement and accumulates in one pass
const warpAccumulateShader = `
struct Params {
    inWidth: u32,
    inHeight: u32,
    outWidth: u32,
    outHeight: u32,
    numAPs: u32,
    patchSize: u32,
    drizzleScale: f32,
    frameWeight: f32,
    brightnessScale: f32,
    globalOffsetX: f32,
    globalOffsetY: f32,
    minQuality: f32,
    inputFormat: u32,    // 0 = Float32 (4 floats/pixel), 1 = packed Uint8 (1 u32/pixel)
    _pad: u32,
}

struct AP {
    x: f32,
    y: f32,
    dx: f32,
    dy: f32,
    quality: f32,
    _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> frameData: array<u32>;     // Input: packed Uint8 (1 u32/pixel) or Float32 (reinterpreted)
@group(0) @binding(2) var<storage, read> apData: array<AP>;         // AP positions + shifts
@group(0) @binding(3) var<storage, read_write> accumR: array<f32>;
@group(0) @binding(4) var<storage, read_write> accumG: array<f32>;
@group(0) @binding(5) var<storage, read_write> accumB: array<f32>;
@group(0) @binding(6) var<storage, read_write> accumW: array<f32>;

// Read a pixel as vec4<f32> in 0-255 range
fn readPixel(pixelIdx: u32) -> vec4<f32> {
    if (params.inputFormat == 1u) {
        // Packed Uint8: 4 bytes per pixel stored as 1 u32 (RGBA little-endian)
        let packed = frameData[pixelIdx];
        let r = f32(packed & 0xFFu);
        let g = f32((packed >> 8u) & 0xFFu);
        let b = f32((packed >> 16u) & 0xFFu);
        let a = f32((packed >> 24u) & 0xFFu);
        return vec4<f32>(r, g, b, a);
    } else {
        // Float32: 4 floats per pixel, stored as 4 u32s (bitcast)
        let baseIdx = pixelIdx * 4u;
        let r = bitcast<f32>(frameData[baseIdx]);
        let g = bitcast<f32>(frameData[baseIdx + 1u]);
        let b = bitcast<f32>(frameData[baseIdx + 2u]);
        let a = bitcast<f32>(frameData[baseIdx + 3u]);
        // Float32 is 0.0-1.0 range, scale to 0-255
        return vec4<f32>(r, g, b, a) * 255.0;
    }
}

// Cubic interpolation weight (Catmull-Rom spline, a = -0.5)
fn cubicWeight(t: f32) -> f32 {
    let at = abs(t);
    if (at <= 1.0) {
        return (1.5 * at - 2.5) * at * at + 1.0;
    } else if (at < 2.0) {
        return ((-0.5 * at + 2.5) * at - 4.0) * at + 2.0;
    }
    return 0.0;
}

fn sampleFrame(x: f32, y: f32) -> vec4<f32> {
    // Bicubic interpolation (16 samples, Catmull-Rom)
    let x0 = i32(floor(x));
    let y0 = i32(floor(y));
    let fx = x - f32(x0);
    let fy = y - f32(y0);

    let w = i32(params.inWidth);
    let h = i32(params.inHeight);

    // Compute cubic weights for x and y
    let wx0 = cubicWeight(fx + 1.0);
    let wx1 = cubicWeight(fx);
    let wx2 = cubicWeight(fx - 1.0);
    let wx3 = cubicWeight(fx - 2.0);

    let wy0 = cubicWeight(fy + 1.0);
    let wy1 = cubicWeight(fy);
    let wy2 = cubicWeight(fy - 1.0);
    let wy3 = cubicWeight(fy - 2.0);

    var result = vec4<f32>(0.0);
    var totalWeight: f32 = 0.0;

    // Sample 4x4 grid
    for (var j: i32 = -1; j <= 2; j++) {
        let cy = clamp(y0 + j, 0, h - 1);
        let wy = select(select(select(wy3, wy2, j == 1), wy1, j == 0), wy0, j == -1);

        for (var i: i32 = -1; i <= 2; i++) {
            let cx = clamp(x0 + i, 0, w - 1);
            let wx = select(select(select(wx3, wx2, i == 1), wx1, i == 0), wx0, i == -1);

            let idx = u32(cy * w + cx);
            let pixel = readPixel(idx);
            let weight = wx * wy;

            result += pixel * weight;
            totalWeight += weight;
        }
    }

    // Normalize (weights should sum to 1, but clamp can affect this at edges)
    if (totalWeight > 0.0) {
        result = result / totalWeight;
    }

    return result;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;

    if (ox >= params.outWidth || oy >= params.outHeight) {
        return;
    }

    let idx = oy * params.outWidth + ox;
    let invScale = 1.0 / params.drizzleScale;

    // Map output pixel to input coordinate space
    let inX = f32(ox) * invScale;
    let inY = f32(oy) * invScale;

    // Gaussian parameters for displacement interpolation
    let patchSize = f32(params.patchSize);
    let influenceRadius = patchSize * 4.0;
    let influenceRadius2 = influenceRadius * influenceRadius;
    let sigma = patchSize * 1.5;
    let sigma2 = sigma * sigma * 2.0;

    // Interpolate displacement from nearby APs
    var totalWeight: f32 = 0.0;
    var weightedDx: f32 = 0.0;
    var weightedDy: f32 = 0.0;

    for (var i: u32 = 0u; i < params.numAPs; i++) {
        let ap = apData[i];

        if (ap.quality < params.minQuality) {
            continue;
        }

        let dx = inX - ap.x;
        let dy = inY - ap.y;
        let dist2 = dx * dx + dy * dy;

        if (dist2 < influenceRadius2) {
            let gaussWeight = exp(-dist2 / sigma2);
            let weight = gaussWeight * ap.quality;

            weightedDx += ap.dx * weight;
            weightedDy += ap.dy * weight;
            totalWeight += weight;
        }
    }

    // Compute source coordinates
    var srcX: f32;
    var srcY: f32;
    if (totalWeight > 0.0) {
        srcX = inX + params.globalOffsetX + weightedDx / totalWeight;
        srcY = inY + params.globalOffsetY + weightedDy / totalWeight;
    } else {
        srcX = inX + params.globalOffsetX;
        srcY = inY + params.globalOffsetY;
    }

    // Check bounds
    if (srcX < 0.0 || srcX >= f32(params.inWidth) - 1.0 ||
        srcY < 0.0 || srcY >= f32(params.inHeight) - 1.0) {
        return;
    }

    // Sample and accumulate
    let color = sampleFrame(srcX, srcY);

    // Skip black pixels
    if (color.r < 1.0 && color.g < 1.0 && color.b < 1.0) {
        return;
    }

    let w = params.frameWeight;
    let b = params.brightnessScale;

    accumR[idx] += color.r * b * w;
    accumG[idx] += color.g * b * w;
    accumB[idx] += color.b * b * w;
    accumW[idx] += w;
}
`;

// VNG demosaic pipeline and buffers
let vngDemosaicPipeline = null;
let vngCropPipeline = null;  // VNG + crop in one pass
let rgbaToGrayPipeline = null;
let cachedDemosaicBuffers = null;
let cachedDemosaicConfig = null;

async function initStackingGPU() {
    if (isStackingReady) return true;

    if (!navigator.gpu) {
        console.log('WebGPU not available for stacking');
        return false;
    }

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            console.log('No WebGPU adapter for stacking');
            return false;
        }

        const adapterLimits = adapter.limits;
        stackDevice = await adapter.requestDevice({
            requiredLimits: {
                maxBufferSize: adapterLimits.maxBufferSize,
                maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize
            }
        });
        stackQueue = stackDevice.queue;

        // Handle GPU device lost with auto-recovery
        stackDevice.lost.then(async (info) => {
            console.error('Stacking GPU device lost:', info.message);
            stackDeviceLost = true;
            stackDevice = null;
            stackQueue = null;
            isStackingReady = false;
            cachedStackBuffers = null;
            cachedStackConfig = null;

            // Attempt automatic recovery
            if (stackReinitAttempts < STACK_MAX_REINIT_ATTEMPTS) {
                console.log(`Attempting stacking GPU recovery (attempt ${stackReinitAttempts + 1}/${STACK_MAX_REINIT_ATTEMPTS})...`);
                await new Promise(resolve => setTimeout(resolve, 500));
                try {
                    stackReinitializing = true;
                    stackReinitAttempts++;
                    const success = await initStackingGPU();
                    if (success) {
                        console.log('Stacking GPU device recovered successfully');
                    }
                } catch (err) {
                    console.error('Stacking GPU recovery failed:', err.message);
                } finally {
                    stackReinitializing = false;
                }
            }
        });

        const shaderModule = stackDevice.createShaderModule({
            code: warpAccumulateShader
        });

        warpPipeline = stackDevice.createComputePipeline({
            layout: 'auto',
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        // VNG demosaic pipeline for stacking
        const vngShaderModule = stackDevice.createShaderModule({
            code: demosaicVngShader
        });

        vngDemosaicPipeline = stackDevice.createComputePipeline({
            layout: 'auto',
            compute: { module: vngShaderModule, entryPoint: 'main' }
        });

        // VNG demosaic + crop pipeline (reads full frame, outputs cropped)
        const vngCropShaderModule = stackDevice.createShaderModule({
            code: demosaicVngCropShader
        });

        vngCropPipeline = stackDevice.createComputePipeline({
            layout: 'auto',
            compute: { module: vngCropShaderModule, entryPoint: 'main' }
        });

        // RGBA to u8 grayscale pipeline for template matching
        const grayShaderModule = stackDevice.createShaderModule({
            code: rgbaToGrayU8Shader
        });

        rgbaToGrayPipeline = stackDevice.createComputePipeline({
            layout: 'auto',
            compute: { module: grayShaderModule, entryPoint: 'main' }
        });

        // NCC batch template matching pipeline (same device for zero-copy)
        const nccShaderModule = stackDevice.createShaderModule({
            code: nccBatchShaderCode
        });

        nccBatchPipeline = stackDevice.createComputePipeline({
            layout: 'auto',
            compute: { module: nccShaderModule, entryPoint: 'main' }
        });

        isStackingReady = true;
        stackDeviceLost = false;
        console.log('WebGPU stacking initialized (with VNG demosaic + NCC matching)');
        return true;
    } catch (e) {
        console.error('WebGPU stacking init error:', e);
        return false;
    }
}

// Set up the reinitialize function for auto-recovery
reinitializeStackingGpu = async function() {
    if (stackReinitializing) return false;
    stackReinitializing = true;
    try {
        return await initStackingGPU();
    } catch (err) {
        console.error('Stacking GPU reinitialization failed:', err);
        return false;
    } finally {
        stackReinitializing = false;
    }
};

// Get or create demosaic buffers for VNG demosaicing
function getDemosaicBuffers(width, height, batchSize, bitDepth) {
    const pixelCount = width * height;
    // Input: raw Bayer (1 byte/pixel for 8-bit, 2 bytes/pixel for 16-bit)
    const inputBytesPerPixel = bitDepth > 8 ? 2 : 1;
    const inputSize = pixelCount * batchSize * inputBytesPerPixel;
    // Output: Float32 RGBA (16 bytes/pixel)
    const outputSize = pixelCount * batchSize * 16;

    const requiredConfig = { inputSize, outputSize, batchSize };

    if (cachedDemosaicBuffers && cachedDemosaicConfig &&
        cachedDemosaicConfig.inputSize >= inputSize &&
        cachedDemosaicConfig.outputSize >= outputSize) {
        return cachedDemosaicBuffers;
    }

    // Cleanup old buffers
    if (cachedDemosaicBuffers) {
        Object.values(cachedDemosaicBuffers).forEach(buf => {
            if (buf && buf.destroy) buf.destroy();
        });
    }

    const align4 = (size) => Math.ceil(size / 4) * 4;
    const headroom = 1.1;

    cachedDemosaicBuffers = {
        paramsBuffer: stackDevice.createBuffer({
            size: 32,  // 8 u32/f32
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        inputBuffer: stackDevice.createBuffer({
            size: align4(Math.ceil(inputSize * headroom)),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        outputBuffer: stackDevice.createBuffer({
            size: align4(Math.ceil(outputSize * headroom)),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        })
    };

    cachedDemosaicConfig = requiredConfig;
    return cachedDemosaicBuffers;
}

/**
 * VNG demosaic a batch of raw Bayer frames
 * @param {Array} frames - Array of {data: Uint8Array|Uint16Array} raw Bayer frames
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @param {number} bayerPattern - Bayer pattern (0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG)
 * @param {number} bitDepth - Bit depth (8 or 16)
 * @param {number} scale - Stretch scale for 16-bit data (default 1.0)
 * @returns {Float32Array} - Demosaiced RGBA data (all frames concatenated)
 */
async function demosaicVngBatch(frames, width, height, bayerPattern, bitDepth, scale = 1.0) {
    if (!stackDevice || !vngDemosaicPipeline) {
        throw new Error('Stacking GPU not initialized for VNG demosaic');
    }

    const batchSize = frames.length;
    const pixelCount = width * height;
    const buffers = getDemosaicBuffers(width, height, batchSize, bitDepth);

    // Pack raw Bayer data into input buffer
    const bytesPerPixel = bitDepth > 8 ? 2 : 1;
    const inputData = new Uint8Array(pixelCount * batchSize * bytesPerPixel);
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const offset = i * pixelCount * bytesPerPixel;
        if (frame.data instanceof Uint16Array) {
            inputData.set(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), offset);
        } else {
            inputData.set(frame.data, offset);
        }
    }
    stackQueue.writeBuffer(buffers.inputBuffer, 0, inputData);

    // Set params
    const paramsData = new ArrayBuffer(32);
    new Uint32Array(paramsData).set([width, height, batchSize, bayerPattern, bitDepth, 0, 0, 0]);
    new Float32Array(paramsData)[5] = scale;
    stackQueue.writeBuffer(buffers.paramsBuffer, 0, paramsData);

    // Create bind group and run shader
    const bindGroup = stackDevice.createBindGroup({
        layout: vngDemosaicPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.paramsBuffer } },
            { binding: 1, resource: { buffer: buffers.inputBuffer } },
            { binding: 2, resource: { buffer: buffers.outputBuffer } }
        ]
    });

    const encoder = stackDevice.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(vngDemosaicPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
        Math.ceil(width / 16),
        Math.ceil(height / 16),
        batchSize
    );
    pass.end();

    // Readback
    const readbackBuffer = stackDevice.createBuffer({
        size: pixelCount * batchSize * 16,  // Float32 RGBA
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    encoder.copyBufferToBuffer(buffers.outputBuffer, 0, readbackBuffer, 0, pixelCount * batchSize * 16);

    stackQueue.submit([encoder.finish()]);

    await safeStackMapAsync(readbackBuffer, GPUMapMode.READ);
    const result = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();
    readbackBuffer.destroy();

    return result;
}

/**
 * VNG demosaic + crop a batch of raw Bayer frames in one GPU pass
 * Reads from full-size source, outputs cropped region with VNG quality
 * Also outputs packed u8 grayscale for template matching
 * @param {Array} frames - Array of {data: Uint8Array|Uint16Array} raw Bayer frames (full size)
 * @param {number} srcWidth - Full source frame width
 * @param {number} srcHeight - Full source frame height
 * @param {number} cropSize - Output crop size (square)
 * @param {Array} centers - Array of {x, y} per-frame crop centers
 * @param {number} bayerPattern - Bayer pattern (0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG)
 * @param {number} bitDepth - Bit depth (8 or 16)
 * @param {number} scale - Stretch scale for 16-bit data (default 1.0)
 * @returns {{rgbaData: Float32Array, grayData: Uint8Array}} - Cropped RGBA and grayscale
 */
async function demosaicVngCropBatch(frames, srcWidth, srcHeight, cropSize, centers, bayerPattern, bitDepth, scale = 1.0) {
    if (!stackDevice || !vngCropPipeline) {
        throw new Error('Stacking GPU not initialized for VNG crop');
    }

    const batchSize = frames.length;
    const srcPixelCount = srcWidth * srcHeight;
    const cropPixelCount = cropSize * cropSize;

    // Input buffer size depends on bit depth
    const bytesPerPixel = bitDepth > 8 ? 2 : 1;
    const inputSize = srcPixelCount * batchSize * bytesPerPixel;
    // Output: Float32 RGBA (16 bytes/pixel) + packed u8 grayscale
    const rgbaOutputSize = cropPixelCount * batchSize * 16;
    const grayOutputSize = Math.ceil(cropPixelCount * batchSize / 4) * 4;

    // Create buffers
    const paramsBuffer = stackDevice.createBuffer({
        size: 32,  // 8 u32/f32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const inputBuffer = stackDevice.createBuffer({
        size: Math.ceil(inputSize / 4) * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const centersBuffer = stackDevice.createBuffer({
        size: batchSize * 8,  // 2 f32 per center
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const rgbaOutputBuffer = stackDevice.createBuffer({
        size: rgbaOutputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    const grayOutputBuffer = stackDevice.createBuffer({
        size: grayOutputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });

    // Pack raw Bayer data into input buffer
    const inputData = new Uint8Array(srcPixelCount * batchSize * bytesPerPixel);
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const offset = i * srcPixelCount * bytesPerPixel;
        if (frame.data instanceof Uint16Array) {
            inputData.set(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), offset);
        } else {
            inputData.set(frame.data, offset);
        }
    }
    stackQueue.writeBuffer(inputBuffer, 0, inputData);

    // Upload centers
    const centersData = new Float32Array(batchSize * 2);
    for (let i = 0; i < centers.length; i++) {
        centersData[i * 2] = centers[i].x;
        centersData[i * 2 + 1] = centers[i].y;
    }
    stackQueue.writeBuffer(centersBuffer, 0, centersData);

    // Set params: srcWidth, srcHeight, cropSize, bayerPattern, batchSize, bitDepth, scale, pad
    const paramsData = new ArrayBuffer(32);
    new Uint32Array(paramsData).set([srcWidth, srcHeight, cropSize, bayerPattern, batchSize, bitDepth, 0, 0]);
    new Float32Array(paramsData)[6] = scale;
    stackQueue.writeBuffer(paramsBuffer, 0, paramsData);

    // Create encoder and clear gray buffer (atomicOr needs zeros)
    const encoder = stackDevice.createCommandEncoder();
    encoder.clearBuffer(grayOutputBuffer, 0, grayOutputSize);

    // Create bind group
    const bindGroup = stackDevice.createBindGroup({
        layout: vngCropPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: { buffer: inputBuffer } },
            { binding: 2, resource: { buffer: centersBuffer } },
            { binding: 3, resource: { buffer: rgbaOutputBuffer } },
            { binding: 4, resource: { buffer: grayOutputBuffer } }
        ]
    });

    // Dispatch
    const pass = encoder.beginComputePass();
    pass.setPipeline(vngCropPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
        Math.ceil(cropSize / 16),
        Math.ceil(cropSize / 16),
        batchSize
    );
    pass.end();

    // Readback both buffers
    const rgbaReadback = stackDevice.createBuffer({
        size: rgbaOutputSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    const grayReadback = stackDevice.createBuffer({
        size: grayOutputSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    encoder.copyBufferToBuffer(rgbaOutputBuffer, 0, rgbaReadback, 0, rgbaOutputSize);
    encoder.copyBufferToBuffer(grayOutputBuffer, 0, grayReadback, 0, grayOutputSize);

    stackQueue.submit([encoder.finish()]);

    // Map and read results
    await Promise.all([
        safeStackMapAsync(rgbaReadback, GPUMapMode.READ),
        safeStackMapAsync(grayReadback, GPUMapMode.READ)
    ]);

    const rgbaData = new Float32Array(rgbaReadback.getMappedRange().slice(0));
    const grayData = new Uint8Array(grayReadback.getMappedRange().slice(0));

    rgbaReadback.unmap();
    grayReadback.unmap();

    // Cleanup
    paramsBuffer.destroy();
    inputBuffer.destroy();
    centersBuffer.destroy();
    rgbaOutputBuffer.destroy();
    grayOutputBuffer.destroy();
    rgbaReadback.destroy();
    grayReadback.destroy();

    return { rgbaData, grayData };
}

/**
 * Extract u8 grayscale from Float32 RGBA for template matching
 * @param {Float32Array} rgbaData - VNG-demosaiced RGBA data (all frames concatenated)
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @param {number} batchSize - Number of frames
 * @returns {Uint8Array} - Grayscale data (one byte per pixel, all frames concatenated)
 */
async function extractGrayscale(rgbaData, width, height, batchSize) {
    if (!stackDevice || !rgbaToGrayPipeline) {
        throw new Error('Stacking GPU not initialized for grayscale extraction');
    }

    const pixelCount = width * height;
    const totalPixels = pixelCount * batchSize;
    // Buffer size must be multiple of 4 for u32 storage
    const bufferSize = Math.ceil(totalPixels / 4) * 4;

    // Create buffers
    const rgbaBuffer = stackDevice.createBuffer({
        size: rgbaData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const grayBuffer = stackDevice.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });

    const paramsBuffer = stackDevice.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Upload RGBA data
    stackQueue.writeBuffer(rgbaBuffer, 0, rgbaData);

    // Set params
    const paramsData = new Uint32Array([width, height, batchSize, 0]);
    stackQueue.writeBuffer(paramsBuffer, 0, paramsData);

    // Clear buffer (atomicOr needs zeros)
    const zeroData = new Uint8Array(bufferSize);
    stackQueue.writeBuffer(grayBuffer, 0, zeroData);

    // Create bind group and run shader
    const bindGroup = stackDevice.createBindGroup({
        layout: rgbaToGrayPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: { buffer: rgbaBuffer } },
            { binding: 2, resource: { buffer: grayBuffer } }
        ]
    });

    const encoder = stackDevice.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(rgbaToGrayPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
        Math.ceil(width / 16),
        Math.ceil(height / 16),
        batchSize
    );
    pass.end();

    // Readback
    const readbackBuffer = stackDevice.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    encoder.copyBufferToBuffer(grayBuffer, 0, readbackBuffer, 0, bufferSize);

    stackQueue.submit([encoder.finish()]);

    await safeStackMapAsync(readbackBuffer, GPUMapMode.READ);
    // Return only the actual pixels (trim padding)
    const fullResult = new Uint8Array(readbackBuffer.getMappedRange());
    const result = new Uint8Array(fullResult.slice(0, totalPixels));
    readbackBuffer.unmap();

    // Cleanup
    rgbaBuffer.destroy();
    grayBuffer.destroy();
    paramsBuffer.destroy();
    readbackBuffer.destroy();

    return result;
}

function getStackingBuffers(inWidth, inHeight, outWidth, outHeight, numAPs) {
    const inPixels = inWidth * inHeight;
    const outPixels = outWidth * outHeight;

    const requiredSizes = {
        frameSize: inPixels * 16,  // Float32 RGBA: 4 floats * 4 bytes = 16 bytes per pixel
        apSize: numAPs * 6 * 4,  // 6 floats per AP
        accumSize: outPixels * 4
    };

    if (cachedStackBuffers && cachedStackConfig &&
        cachedStackConfig.frameSize >= requiredSizes.frameSize &&
        cachedStackConfig.apSize >= requiredSizes.apSize &&
        cachedStackConfig.accumSize >= requiredSizes.accumSize) {
        return cachedStackBuffers;
    }

    if (cachedStackBuffers) {
        Object.values(cachedStackBuffers).forEach(buf => {
            if (buf && buf.destroy) buf.destroy();
        });
    }

    const headroom = 1.1;
    // Helper to align buffer sizes to multiple of 4 (WebGPU requirement)
    const align4 = (size) => Math.ceil(size / 4) * 4;

    const frameSizeAligned = align4(Math.ceil(requiredSizes.frameSize * headroom));
    const apSizeAligned = align4(Math.ceil(requiredSizes.apSize * headroom));
    const accumSizeAligned = align4(Math.ceil(requiredSizes.accumSize * headroom));

    // Create buffer pools for batched processing
    const frameBuffers = [];
    const apBuffers = [];
    const paramsBuffers = [];
    for (let i = 0; i < NUM_FRAME_BUFFERS; i++) {
        frameBuffers.push(stackDevice.createBuffer({
            size: frameSizeAligned,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }));
        apBuffers.push(stackDevice.createBuffer({
            size: apSizeAligned,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }));
        paramsBuffers.push(stackDevice.createBuffer({
            size: 56,  // 14 u32/f32
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }));
    }

    cachedStackBuffers = {
        // Legacy single-buffer references (point to first buffer for compatibility)
        paramsBuffer: paramsBuffers[0],
        frameBuffer: frameBuffers[0],
        apBuffer: apBuffers[0],
        // Buffer pools for batched processing
        frameBuffers,
        apBuffers,
        paramsBuffers,
        accumR: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        }),
        accumG: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        }),
        accumB: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        }),
        accumW: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        }),
        readbackR: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        readbackG: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        readbackB: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        readbackW: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        // Alternate readback buffers for double-buffering
        readbackRAlt: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        readbackGAlt: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        readbackBAlt: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        }),
        readbackWAlt: stackDevice.createBuffer({
            size: accumSizeAligned,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        })
    };

    cachedStackConfig = {
        frameSize: frameSizeAligned,
        apSize: apSizeAligned,
        accumSize: accumSizeAligned,
        bufferGen: 0
    };

    return cachedStackBuffers;
}

/**
 * Process a single frame: warp and accumulate
 * @param {Float32Array|Uint8Array|Uint8ClampedArray} frameData - Frame RGBA data
 *        Float32Array: 4 floats per pixel (0.0-1.0 range) - 16-bit sources
 *        Uint8Array/Uint8ClampedArray: 4 bytes per pixel (0-255) - 8-bit sources, GPU converts
 */
async function warpAndAccumulateFrame(frameData, width, height, outWidth, outHeight,
    alignmentPoints, shifts, patchSize, drizzleScale, frameWeight, brightnessScale,
    globalOffsetX, globalOffsetY, minApQuality = 0.3) {

    if (!isStackingReady) {
        const initialized = await initStackingGPU();
        if (!initialized) {
            throw new Error('WebGPU stacking not available');
        }
    }

    const buffers = getStackingBuffers(width, height, outWidth, outHeight, alignmentPoints.length);
    const numAPs = alignmentPoints.length;

    // Detect input format: 0 = Float32, 1 = Uint8
    const isUint8 = frameData instanceof Uint8Array || frameData instanceof Uint8ClampedArray;
    const inputFormat = isUint8 ? 1 : 0;

    // Write frame data to GPU
    if (isUint8) {
        // Uint8: write directly (4 bytes per pixel = 1 u32 per pixel, GPU converts to float)
        stackQueue.writeBuffer(buffers.frameBuffer, 0, frameData);
    } else {
        // Float32: write directly (4 floats per pixel)
        const float32Data = frameData instanceof Float32Array ? frameData : new Float32Array(frameData);
        stackQueue.writeBuffer(buffers.frameBuffer, 0, float32Data);
    }

    // Pack AP data (x, y, dx, dy, quality, pad)
    const apData = new Float32Array(numAPs * 6);
    for (let i = 0; i < numAPs; i++) {
        apData[i * 6] = alignmentPoints[i].x;
        apData[i * 6 + 1] = alignmentPoints[i].y;
        apData[i * 6 + 2] = shifts[i].dx;
        apData[i * 6 + 3] = shifts[i].dy;
        apData[i * 6 + 4] = shifts[i].quality;
        apData[i * 6 + 5] = 0;  // padding
    }
    stackQueue.writeBuffer(buffers.apBuffer, 0, apData);

    // Pack params (56 bytes: 14 x u32/f32)
    const paramsData = new ArrayBuffer(56);
    const paramsU32 = new Uint32Array(paramsData);
    const paramsF32 = new Float32Array(paramsData);
    paramsU32[0] = width;
    paramsU32[1] = height;
    paramsU32[2] = outWidth;
    paramsU32[3] = outHeight;
    paramsU32[4] = numAPs;
    paramsU32[5] = patchSize;
    paramsF32[6] = drizzleScale;
    paramsF32[7] = frameWeight;
    paramsF32[8] = brightnessScale;
    paramsF32[9] = globalOffsetX;
    paramsF32[10] = globalOffsetY;
    paramsF32[11] = minApQuality;  // minQuality
    paramsU32[12] = inputFormat;  // 0 = Float32, 1 = Uint8
    paramsU32[13] = 0;  // padding
    stackQueue.writeBuffer(buffers.paramsBuffer, 0, paramsData);

    // Create bind group
    const bindGroup = stackDevice.createBindGroup({
        layout: warpPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.paramsBuffer } },
            { binding: 1, resource: { buffer: buffers.frameBuffer } },
            { binding: 2, resource: { buffer: buffers.apBuffer } },
            { binding: 3, resource: { buffer: buffers.accumR } },
            { binding: 4, resource: { buffer: buffers.accumG } },
            { binding: 5, resource: { buffer: buffers.accumB } },
            { binding: 6, resource: { buffer: buffers.accumW } }
        ]
    });

    // Dispatch
    const encoder = stackDevice.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(warpPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(outWidth / 16), Math.ceil(outHeight / 16), 1);
    pass.end();
    stackQueue.submit([encoder.finish()]);
}

/**
 * Process multiple frames in a single GPU submission (pipelined batching)
 * Uploads all frames, creates all bind groups, dispatches all warps, single submit.
 * This reduces per-frame overhead from encoder creation and submit calls.
 *
 * @param {Array<{rgbaBuffer: Float32Array|Uint8Array, brightnessScale: number, frameWeight: number}>} frames
 * @param {Array<Array<{dx, dy, quality}>>} allShifts - shifts[frameIdx][apIdx]
 * @param {number} width - Input frame width
 * @param {number} height - Input frame height
 * @param {number} outWidth - Output width (with drizzle)
 * @param {number} outHeight - Output height (with drizzle)
 * @param {Array<{x, y}>} alignmentPoints
 * @param {number} patchSize
 * @param {number} drizzleScale
 * @param {number} minApQuality
 */
async function warpAndAccumulateBatch(frames, allShifts, width, height, outWidth, outHeight,
    alignmentPoints, patchSize, drizzleScale, minApQuality = 0.3) {

    if (!isStackingReady) {
        const initialized = await initStackingGPU();
        if (!initialized) {
            throw new Error('WebGPU stacking not available');
        }
    }

    if (frames.length === 0) return;

    const buffers = getStackingBuffers(width, height, outWidth, outHeight, alignmentPoints.length);
    const numAPs = alignmentPoints.length;
    const workgroupsX = Math.ceil(outWidth / 16);
    const workgroupsY = Math.ceil(outHeight / 16);

    // Process frames in chunks of NUM_FRAME_BUFFERS
    for (let chunkStart = 0; chunkStart < frames.length; chunkStart += NUM_FRAME_BUFFERS) {
        const chunkEnd = Math.min(chunkStart + NUM_FRAME_BUFFERS, frames.length);
        const chunkSize = chunkEnd - chunkStart;

        // Upload all frames in this chunk to their respective buffers
        const bindGroups = [];

        for (let i = 0; i < chunkSize; i++) {
            const frameIdx = chunkStart + i;
            const frame = frames[frameIdx];
            const shifts = allShifts[frameIdx];
            const bufferIdx = i;  // Use buffer pool index

            const frameData = frame.rgbaBuffer;
            const isUint8 = frameData instanceof Uint8Array || frameData instanceof Uint8ClampedArray;
            const inputFormat = isUint8 ? 1 : 0;

            // Debug: log input format for first frame
            if (frameIdx === 0) {
                console.log(`[Stacker] First frame: inputFormat=${inputFormat}, isUint8=${isUint8}, dataType=${frameData?.constructor?.name}, length=${frameData?.length}`);
                if (frameData && frameData.length > 0) {
                    console.log(`[Stacker] First pixel values: R=${frameData[0]}, G=${frameData[1]}, B=${frameData[2]}, A=${frameData[3]}`);
                }
            }

            // Upload frame data
            if (isUint8) {
                stackQueue.writeBuffer(buffers.frameBuffers[bufferIdx], 0, frameData);
            } else {
                const float32Data = frameData instanceof Float32Array ? frameData : new Float32Array(frameData);
                stackQueue.writeBuffer(buffers.frameBuffers[bufferIdx], 0, float32Data);
            }

            // Pack and upload AP data
            const apData = new Float32Array(numAPs * 6);
            for (let a = 0; a < numAPs; a++) {
                apData[a * 6] = alignmentPoints[a].x;
                apData[a * 6 + 1] = alignmentPoints[a].y;
                apData[a * 6 + 2] = shifts[a].dx;
                apData[a * 6 + 3] = shifts[a].dy;
                apData[a * 6 + 4] = shifts[a].quality;
                apData[a * 6 + 5] = 0;
            }
            stackQueue.writeBuffer(buffers.apBuffers[bufferIdx], 0, apData);

            // Pack and upload params
            const paramsData = new ArrayBuffer(56);
            const paramsU32 = new Uint32Array(paramsData);
            const paramsF32 = new Float32Array(paramsData);
            paramsU32[0] = width;
            paramsU32[1] = height;
            paramsU32[2] = outWidth;
            paramsU32[3] = outHeight;
            paramsU32[4] = numAPs;
            paramsU32[5] = patchSize;
            paramsF32[6] = drizzleScale;
            paramsF32[7] = frame.frameWeight;
            paramsF32[8] = frame.brightnessScale;
            paramsF32[9] = 0;  // globalOffsetX
            paramsF32[10] = 0; // globalOffsetY
            paramsF32[11] = minApQuality;
            paramsU32[12] = inputFormat;
            paramsU32[13] = 0;
            stackQueue.writeBuffer(buffers.paramsBuffers[bufferIdx], 0, paramsData);

            // Create bind group for this frame
            bindGroups.push(stackDevice.createBindGroup({
                layout: warpPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: buffers.paramsBuffers[bufferIdx] } },
                    { binding: 1, resource: { buffer: buffers.frameBuffers[bufferIdx] } },
                    { binding: 2, resource: { buffer: buffers.apBuffers[bufferIdx] } },
                    { binding: 3, resource: { buffer: buffers.accumR } },
                    { binding: 4, resource: { buffer: buffers.accumG } },
                    { binding: 5, resource: { buffer: buffers.accumB } },
                    { binding: 6, resource: { buffer: buffers.accumW } }
                ]
            }));
        }

        // Create single encoder with all dispatches for this chunk
        const encoder = stackDevice.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(warpPipeline);

        for (let i = 0; i < chunkSize; i++) {
            pass.setBindGroup(0, bindGroups[i]);
            pass.dispatchWorkgroups(workgroupsX, workgroupsY, 1);
        }

        pass.end();
        stackQueue.submit([encoder.finish()]);
    }
}

/**
 * Clear accumulation buffers
 */
async function clearAccumulators(outWidth, outHeight) {
    const buffers = cachedStackBuffers;
    if (!buffers || !stackQueue) return;

    const size = outWidth * outHeight * 4;
    const zeros = new Float32Array(outWidth * outHeight);
    stackQueue.writeBuffer(buffers.accumR, 0, zeros);
    stackQueue.writeBuffer(buffers.accumG, 0, zeros);
    stackQueue.writeBuffer(buffers.accumB, 0, zeros);
    stackQueue.writeBuffer(buffers.accumW, 0, zeros);
}

/**
 * Read back final accumulated result
 */
async function readAccumulators(outWidth, outHeight) {
    const buffers = cachedStackBuffers;
    if (!buffers || !stackDevice || !stackQueue) {
        throw new Error('WebGPU stacking not initialized');
    }
    const pixelCount = outWidth * outHeight;
    const size = Math.ceil(pixelCount * 4 / 4) * 4;  // Align to 4 bytes

    // Select readback buffers based on generation (double-buffering)
    const useAlt = (cachedStackConfig?.bufferGen || 0) % 2 === 1;
    const readbackR = useAlt ? buffers.readbackRAlt : buffers.readbackR;
    const readbackG = useAlt ? buffers.readbackGAlt : buffers.readbackG;
    const readbackB = useAlt ? buffers.readbackBAlt : buffers.readbackB;
    const readbackW = useAlt ? buffers.readbackWAlt : buffers.readbackW;

    const encoder = stackDevice.createCommandEncoder();
    encoder.copyBufferToBuffer(buffers.accumR, 0, readbackR, 0, size);
    encoder.copyBufferToBuffer(buffers.accumG, 0, readbackG, 0, size);
    encoder.copyBufferToBuffer(buffers.accumB, 0, readbackB, 0, size);
    encoder.copyBufferToBuffer(buffers.accumW, 0, readbackW, 0, size);
    stackQueue.submit([encoder.finish()]);

    // Rotate buffer generation for next call
    if (cachedStackConfig) {
        cachedStackConfig.bufferGen = (cachedStackConfig.bufferGen || 0) + 1;
    }

    // Map all readback buffers in parallel for better throughput
    await Promise.all([
        safeStackMapAsync(readbackR, GPUMapMode.READ),
        safeStackMapAsync(readbackG, GPUMapMode.READ),
        safeStackMapAsync(readbackB, GPUMapMode.READ),
        safeStackMapAsync(readbackW, GPUMapMode.READ)
    ]);

    const accumR = new Float32Array(readbackR.getMappedRange().slice(0, size));
    const accumG = new Float32Array(readbackG.getMappedRange().slice(0, size));
    const accumB = new Float32Array(readbackB.getMappedRange().slice(0, size));
    const accumW = new Float32Array(readbackW.getMappedRange().slice(0, size));

    readbackR.unmap();
    readbackG.unmap();
    readbackB.unmap();
    readbackW.unmap();

    return { accumR, accumG, accumB, accumW };
}

function cleanupStackingBuffers() {
    if (cachedStackBuffers) {
        Object.values(cachedStackBuffers).forEach(buf => {
            if (buf && buf.destroy) buf.destroy();
        });
        cachedStackBuffers = null;
        cachedStackConfig = null;
    }
    if (cachedDemosaicBuffers) {
        Object.values(cachedDemosaicBuffers).forEach(buf => {
            if (buf && buf.destroy) buf.destroy();
        });
        cachedDemosaicBuffers = null;
        cachedDemosaicConfig = null;
    }
}

/**
 * VNG demosaic + crop keeping BOTH RGBA and grayscale on GPU (fully zero-copy pipeline)
 * Also returns CPU grayscale for brightness calculation (small overhead, needed for normalization)
 * @returns {{rgbaGpuBuffer: GPUBuffer, grayGpuBuffer: GPUBuffer, grayData: Uint8Array, batchSize: number, cropSize: number}}
 */
async function demosaicVngCropBatchGpu(frames, srcWidth, srcHeight, cropSize, centers, bayerPattern, bitDepth, scale = 1.0) {
    if (!stackDevice || !vngCropPipeline) {
        throw new Error('Stacking GPU not initialized for VNG crop');
    }

    const batchSize = frames.length;
    const srcPixelCount = srcWidth * srcHeight;
    const cropPixelCount = cropSize * cropSize;

    const bytesPerPixel = bitDepth > 8 ? 2 : 1;
    const inputSize = srcPixelCount * batchSize * bytesPerPixel;
    const rgbaOutputSize = cropPixelCount * batchSize * 16;  // Float32 RGBA
    const grayOutputSize = Math.ceil(cropPixelCount * batchSize / 4) * 4;

    // Create buffers
    const paramsBuffer = stackDevice.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const inputBuffer = stackDevice.createBuffer({
        size: Math.ceil(inputSize / 4) * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const centersBuffer = stackDevice.createBuffer({
        size: batchSize * 8,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    // RGBA stays on GPU for warp+accumulate
    const rgbaGpuBuffer = stackDevice.createBuffer({
        size: rgbaOutputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    // Grayscale stays on GPU for template matching (same device!)
    const grayGpuBuffer = stackDevice.createBuffer({
        size: grayOutputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });

    // Pack and upload raw Bayer data
    const inputData = new Uint8Array(srcPixelCount * batchSize * bytesPerPixel);
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const offset = i * srcPixelCount * bytesPerPixel;
        if (frame.data instanceof Uint16Array) {
            inputData.set(new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), offset);
        } else {
            inputData.set(frame.data, offset);
        }
    }
    stackQueue.writeBuffer(inputBuffer, 0, inputData);

    // Upload centers
    const centersData = new Float32Array(batchSize * 2);
    for (let i = 0; i < centers.length; i++) {
        centersData[i * 2] = centers[i].x;
        centersData[i * 2 + 1] = centers[i].y;
    }
    stackQueue.writeBuffer(centersBuffer, 0, centersData);

    // Set params
    const paramsData = new ArrayBuffer(32);
    new Uint32Array(paramsData).set([srcWidth, srcHeight, cropSize, bayerPattern, batchSize, bitDepth, 0, 0]);
    new Float32Array(paramsData)[6] = scale;
    stackQueue.writeBuffer(paramsBuffer, 0, paramsData);

    // Run VNG demosaic
    const encoder = stackDevice.createCommandEncoder();
    encoder.clearBuffer(grayGpuBuffer, 0, grayOutputSize);

    const bindGroup = stackDevice.createBindGroup({
        layout: vngCropPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: { buffer: inputBuffer } },
            { binding: 2, resource: { buffer: centersBuffer } },
            { binding: 3, resource: { buffer: rgbaGpuBuffer } },
            { binding: 4, resource: { buffer: grayGpuBuffer } }
        ]
    });

    const pass = encoder.beginComputePass();
    pass.setPipeline(vngCropPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
        Math.ceil(cropSize / 16),
        Math.ceil(cropSize / 16),
        batchSize
    );
    pass.end();

    // Read back grayscale for brightness calculation (still needed for normalization)
    // This is the only readback - template matching uses GPU buffer directly
    const grayReadback = stackDevice.createBuffer({
        size: grayOutputSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    encoder.copyBufferToBuffer(grayGpuBuffer, 0, grayReadback, 0, grayOutputSize);

    stackQueue.submit([encoder.finish()]);

    await safeStackMapAsync(grayReadback, GPUMapMode.READ);
    const grayData = new Uint8Array(grayReadback.getMappedRange().slice(0));
    grayReadback.unmap();
    grayReadback.destroy();

    // Cleanup temp buffers (but keep rgbaGpuBuffer and grayGpuBuffer!)
    paramsBuffer.destroy();
    inputBuffer.destroy();
    centersBuffer.destroy();

    // Return GPU buffer handles + CPU grayscale for brightness - caller must destroy GPU buffers after use
    return { rgbaGpuBuffer, grayGpuBuffer, grayData, batchSize, cropSize };
}

/**
 * Warp and accumulate frames from GPU buffer (zero-copy from VNG demosaic)
 * @param {GPUBuffer} rgbaGpuBuffer - GPU buffer with batch of Float32 RGBA frames
 * @param {Array} frameMetadata - Array of {sharpness, brightnessScale, frameWeight} per frame
 * @param {Array} allShifts - Shifts from template matching
 */
async function warpAndAccumulateFromGpuBuffer(rgbaGpuBuffer, batchSize, cropSize,
    frameMetadata, allShifts, outWidth, outHeight, alignmentPoints, patchSize, drizzleScale, minApQuality = 0.3) {

    if (!isStackingReady) {
        throw new Error('WebGPU stacking not available');
    }

    const buffers = getStackingBuffers(cropSize, cropSize, outWidth, outHeight, alignmentPoints.length);
    const numAPs = alignmentPoints.length;
    const pixelsPerFrame = cropSize * cropSize;
    const bytesPerFrame = pixelsPerFrame * 16;  // Float32 RGBA = 16 bytes/pixel
    const workgroupsX = Math.ceil(outWidth / 16);
    const workgroupsY = Math.ceil(outHeight / 16);

    // Process frames in chunks of NUM_FRAME_BUFFERS (2)
    for (let chunkStart = 0; chunkStart < batchSize; chunkStart += NUM_FRAME_BUFFERS) {
        const chunkEnd = Math.min(chunkStart + NUM_FRAME_BUFFERS, batchSize);
        const chunkSize = chunkEnd - chunkStart;

        const encoder = stackDevice.createCommandEncoder();
        const bindGroups = [];

        for (let i = 0; i < chunkSize; i++) {
            const frameIdx = chunkStart + i;
            const meta = frameMetadata[frameIdx];
            const shifts = allShifts[frameIdx];
            const bufferIdx = i;

            // Copy frame slice from VNG output buffer to frame buffer (GPU → GPU, no CPU!)
            const srcOffset = frameIdx * bytesPerFrame;
            encoder.copyBufferToBuffer(rgbaGpuBuffer, srcOffset, buffers.frameBuffers[bufferIdx], 0, bytesPerFrame);

            // Upload AP data
            const apData = new Float32Array(numAPs * 6);
            for (let a = 0; a < numAPs; a++) {
                apData[a * 6] = alignmentPoints[a].x;
                apData[a * 6 + 1] = alignmentPoints[a].y;
                apData[a * 6 + 2] = shifts[a].dx;
                apData[a * 6 + 3] = shifts[a].dy;
                apData[a * 6 + 4] = shifts[a].quality;
                apData[a * 6 + 5] = 0;
            }
            stackQueue.writeBuffer(buffers.apBuffers[bufferIdx], 0, apData);

            // Upload params (inputFormat=0 for Float32)
            const paramsData = new ArrayBuffer(56);
            const paramsU32 = new Uint32Array(paramsData);
            const paramsF32 = new Float32Array(paramsData);
            paramsU32[0] = cropSize;
            paramsU32[1] = cropSize;
            paramsU32[2] = outWidth;
            paramsU32[3] = outHeight;
            paramsU32[4] = numAPs;
            paramsU32[5] = patchSize;
            paramsF32[6] = drizzleScale;
            paramsF32[7] = meta.frameWeight;
            paramsF32[8] = meta.brightnessScale;
            paramsF32[9] = 0;
            paramsF32[10] = 0;
            paramsF32[11] = minApQuality;
            paramsU32[12] = 0;  // inputFormat = Float32
            paramsU32[13] = 0;
            stackQueue.writeBuffer(buffers.paramsBuffers[bufferIdx], 0, paramsData);

            bindGroups.push(stackDevice.createBindGroup({
                layout: warpPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: buffers.paramsBuffers[bufferIdx] } },
                    { binding: 1, resource: { buffer: buffers.frameBuffers[bufferIdx] } },
                    { binding: 2, resource: { buffer: buffers.apBuffers[bufferIdx] } },
                    { binding: 3, resource: { buffer: buffers.accumR } },
                    { binding: 4, resource: { buffer: buffers.accumG } },
                    { binding: 5, resource: { buffer: buffers.accumB } },
                    { binding: 6, resource: { buffer: buffers.accumW } }
                ]
            }));
        }

        // Run warp+accumulate for this chunk
        const pass = encoder.beginComputePass();
        pass.setPipeline(warpPipeline);
        for (let i = 0; i < chunkSize; i++) {
            pass.setBindGroup(0, bindGroups[i]);
            pass.dispatchWorkgroups(workgroupsX, workgroupsY);
        }
        pass.end();

        stackQueue.submit([encoder.finish()]);
    }

    // Destroy the VNG output buffer now that we're done with it
    rgbaGpuBuffer.destroy();
}

/**
 * Template matching from GPU buffer (zero-copy from VNG demosaic)
 * Uses same GPU device as stacking for fully GPU-resident pipeline
 * @param {GPUBuffer} grayGpuBuffer - Packed u8 grayscale from VNG demosaic (stays on GPU)
 * @param {Uint8Array} refGrayData - Reference frame grayscale (CPU - uploaded once)
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @param {number} batchSize - Number of frames in buffer
 * @param {Array} alignmentPoints - Array of {x, y} alignment points
 * @param {number} patchSize - Template patch size
 * @param {number} searchRadius - Search radius in pixels
 * @param {Object} searchOffset - Optional {dx, dy} for drift tracking
 * @returns {Array} Array of shifts per frame, each containing shifts per AP
 */
async function matchTemplatesFromGpuBuffer(grayGpuBuffer, refGrayData, width, height, batchSize,
    alignmentPoints, patchSize, searchRadius, searchOffset = null) {

    if (!stackDevice || !nccBatchPipeline) {
        throw new Error('Stacking GPU not initialized for template matching');
    }

    const numAPs = alignmentPoints.length;
    const templateSize = patchSize * patchSize;
    const frameSize = width * height;

    // Extract reference templates (once per stack, small data)
    const refTemplates = new Float32Array(numAPs * templateSize);
    const apPositions = new Uint32Array(numAPs);
    const halfPatch = Math.floor(patchSize / 2);

    const offsetX = searchOffset ? Math.round(searchOffset.dx) : 0;
    const offsetY = searchOffset ? Math.round(searchOffset.dy) : 0;

    for (let i = 0; i < numAPs; i++) {
        const ap = alignmentPoints[i];
        const searchX = ap.x + offsetX;
        const searchY = ap.y + offsetY;
        apPositions[i] = (searchX & 0xFFFF) | ((searchY & 0xFFFF) << 16);

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

    // Create buffers for template matching
    const paramsBuffer = stackDevice.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const templatesBuffer = stackDevice.createBuffer({
        size: refTemplates.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const apPosBuffer = stackDevice.createBuffer({
        size: apPositions.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const resultsSize = batchSize * numAPs * 3 * 4;  // 3 floats per AP per frame
    const resultsBuffer = stackDevice.createBuffer({
        size: resultsSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    const readbackBuffer = stackDevice.createBuffer({
        size: resultsSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    // Upload data
    const searchSize = patchSize + 2 * searchRadius;
    const paramsData = new Uint32Array([patchSize, patchSize, searchSize, searchSize, numAPs, batchSize, width, height]);
    stackQueue.writeBuffer(paramsBuffer, 0, paramsData);
    stackQueue.writeBuffer(templatesBuffer, 0, refTemplates);
    stackQueue.writeBuffer(apPosBuffer, 0, apPositions);

    // Create bind group - grayGpuBuffer is directly used (zero-copy!)
    const bindGroup = stackDevice.createBindGroup({
        layout: nccBatchPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: { buffer: templatesBuffer } },
            { binding: 2, resource: { buffer: grayGpuBuffer } },  // Direct GPU buffer!
            { binding: 3, resource: { buffer: apPosBuffer } },
            { binding: 4, resource: { buffer: resultsBuffer } }
        ]
    });

    // Run NCC
    const encoder = stackDevice.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(nccBatchPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(batchSize * numAPs, 1, 1);
    pass.end();

    encoder.copyBufferToBuffer(resultsBuffer, 0, readbackBuffer, 0, resultsSize);
    stackQueue.submit([encoder.finish()]);

    // Read results (small - only shifts, not image data)
    await safeStackMapAsync(readbackBuffer, GPUMapMode.READ);
    const resultsData = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();

    // Cleanup
    paramsBuffer.destroy();
    templatesBuffer.destroy();
    apPosBuffer.destroy();
    resultsBuffer.destroy();
    readbackBuffer.destroy();

    // Unpack results
    const allShifts = [];
    for (let f = 0; f < batchSize; f++) {
        const frameShifts = [];
        for (let ap = 0; ap < numAPs; ap++) {
            const baseIdx = (f * numAPs + ap) * 3;
            const dx = resultsData[baseIdx];
            const dy = resultsData[baseIdx + 1];
            const quality = resultsData[baseIdx + 2];
            frameShifts.push({ dx: dx + offsetX, dy: dy + offsetY, quality });
        }
        allShifts.push(frameShifts);
    }

    return allShifts;
}

// ES6 exports for module worker
export {
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
};

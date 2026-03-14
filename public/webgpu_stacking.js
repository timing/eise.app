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

// Brightness reduction shader - computes mean brightness per frame from packed grayscale
// Uses sparse sampling (every 8th pixel) matching CPU approach
// One workgroup per frame, outputs one f32 per frame
const brightnessShaderCode = `
struct Params {
    width: u32,
    height: u32,
    numFrames: u32,
    sampleStep: u32,  // Sampling stride (8 = every 8th pixel)
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> grayPacked: array<u32>;  // Packed u8 grayscale
@group(0) @binding(2) var<storage, read_write> brightness: array<f32>;  // Output: one f32 per frame

var<workgroup> sharedSum: array<f32, 256>;
var<workgroup> sharedCount: array<u32, 256>;

fn sampleGray(frameIdx: u32, x: u32, y: u32) -> u32 {
    let frameSize = params.width * params.height;
    let pixelIdx = frameIdx * frameSize + y * params.width + x;
    let packedIdx = pixelIdx >> 2u;
    let byteOffset = (pixelIdx & 3u) << 3u;
    return (grayPacked[packedIdx] >> byteOffset) & 0xFFu;
}

@compute @workgroup_size(256, 1, 1)
fn main(
    @builtin(local_invocation_id) lid: vec3<u32>,
    @builtin(workgroup_id) wid: vec3<u32>
) {
    let frameIdx = wid.x;
    let threadIdx = lid.x;

    if (frameIdx >= params.numFrames) {
        return;
    }

    // Calculate sample grid dimensions
    let samplesX = (params.width + params.sampleStep - 1u) / params.sampleStep;
    let samplesY = (params.height + params.sampleStep - 1u) / params.sampleStep;
    let totalSamples = samplesX * samplesY;

    // Each thread accumulates multiple samples
    var localSum: f32 = 0.0;
    var localCount: u32 = 0u;

    var sampleIdx = threadIdx;
    while (sampleIdx < totalSamples) {
        let sy = sampleIdx / samplesX;
        let sx = sampleIdx % samplesX;
        let x = sx * params.sampleStep;
        let y = sy * params.sampleStep;

        let val = sampleGray(frameIdx, x, y);
        if (val > 10u) {  // Skip near-black pixels (same as CPU)
            localSum += f32(val);
            localCount += 1u;
        }
        sampleIdx += 256u;
    }

    // Store in shared memory
    sharedSum[threadIdx] = localSum;
    sharedCount[threadIdx] = localCount;
    workgroupBarrier();

    // Parallel reduction
    for (var stride: u32 = 128u; stride > 0u; stride = stride >> 1u) {
        if (threadIdx < stride) {
            sharedSum[threadIdx] += sharedSum[threadIdx + stride];
            sharedCount[threadIdx] += sharedCount[threadIdx + stride];
        }
        workgroupBarrier();
    }

    // Thread 0 writes final result
    if (threadIdx == 0u) {
        let totalSum = sharedSum[0];
        let totalCount = sharedCount[0];
        brightness[frameIdx] = select(1.0, totalSum / f32(totalCount), totalCount > 0u);
    }
}
`;

// Gaussian blur shader for packed u8 grayscale - suppresses demosaic artifacts before template matching
// 5x5 Gaussian kernel applied to packed u8 data (4 pixels per u32)
// Skips blur near black pixels to preserve limb edges
const blurPackedShaderCode = `
struct BlurParams {
    width: u32,
    height: u32,
    numFrames: u32,
    padding: u32,
}

const BLACK_THRESHOLD: u32 = 12u;  // Skip blur if any neighbor is below this

@group(0) @binding(0) var<uniform> params: BlurParams;
@group(0) @binding(1) var<storage, read> inputPacked: array<u32>;
@group(0) @binding(2) var<storage, read_write> outputPacked: array<u32>;

fn sampleInput(frameIdx: u32, x: i32, y: i32) -> u32 {
    let cx = clamp(x, 0, i32(params.width) - 1);
    let cy = clamp(y, 0, i32(params.height) - 1);
    let frameSize = params.width * params.height;
    let pixelIdx = frameIdx * frameSize + u32(cy) * params.width + u32(cx);
    let packedIdx = pixelIdx >> 2u;
    let byteOffset = (pixelIdx & 3u) << 3u;
    return (inputPacked[packedIdx] >> byteOffset) & 0xFFu;
}

// Check if 5x5 neighborhood has any near-black pixels
fn hasNearBlack(frameIdx: u32, x: i32, y: i32) -> bool {
    for (var dy: i32 = -2; dy <= 2; dy++) {
        for (var dx: i32 = -2; dx <= 2; dx++) {
            if (sampleInput(frameIdx, x + dx, y + dy) < BLACK_THRESHOLD) {
                return true;
            }
        }
    }
    return false;
}

// Apply 5x5 Gaussian blur at a single pixel
fn blurPixel(frameIdx: u32, x: i32, y: i32) -> u32 {
    // Skip blur near black pixels (preserves limb edges)
    if (hasNearBlack(frameIdx, x, y)) {
        return sampleInput(frameIdx, x, y);
    }

    var sum: u32 = 0u;
    // Row -2: [1, 4, 6, 4, 1]
    sum += sampleInput(frameIdx, x - 2, y - 2) * 1u;
    sum += sampleInput(frameIdx, x - 1, y - 2) * 4u;
    sum += sampleInput(frameIdx, x,     y - 2) * 6u;
    sum += sampleInput(frameIdx, x + 1, y - 2) * 4u;
    sum += sampleInput(frameIdx, x + 2, y - 2) * 1u;
    // Row -1: [4, 16, 24, 16, 4]
    sum += sampleInput(frameIdx, x - 2, y - 1) * 4u;
    sum += sampleInput(frameIdx, x - 1, y - 1) * 16u;
    sum += sampleInput(frameIdx, x,     y - 1) * 24u;
    sum += sampleInput(frameIdx, x + 1, y - 1) * 16u;
    sum += sampleInput(frameIdx, x + 2, y - 1) * 4u;
    // Row 0: [6, 24, 36, 24, 6]
    sum += sampleInput(frameIdx, x - 2, y) * 6u;
    sum += sampleInput(frameIdx, x - 1, y) * 24u;
    sum += sampleInput(frameIdx, x,     y) * 36u;
    sum += sampleInput(frameIdx, x + 1, y) * 24u;
    sum += sampleInput(frameIdx, x + 2, y) * 6u;
    // Row +1: [4, 16, 24, 16, 4]
    sum += sampleInput(frameIdx, x - 2, y + 1) * 4u;
    sum += sampleInput(frameIdx, x - 1, y + 1) * 16u;
    sum += sampleInput(frameIdx, x,     y + 1) * 24u;
    sum += sampleInput(frameIdx, x + 1, y + 1) * 16u;
    sum += sampleInput(frameIdx, x + 2, y + 1) * 4u;
    // Row +2: [1, 4, 6, 4, 1]
    sum += sampleInput(frameIdx, x - 2, y + 2) * 1u;
    sum += sampleInput(frameIdx, x - 1, y + 2) * 4u;
    sum += sampleInput(frameIdx, x,     y + 2) * 6u;
    sum += sampleInput(frameIdx, x + 1, y + 2) * 4u;
    sum += sampleInput(frameIdx, x + 2, y + 2) * 1u;
    return sum >> 8u;  // Divide by 256
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let totalPacked = (params.width * params.height * params.numFrames + 3u) / 4u;
    let packedIdx = gid.x;

    if (packedIdx >= totalPacked) {
        return;
    }

    let frameSize = params.width * params.height;
    let pixelIdx0 = packedIdx * 4u;
    let frameIdx = pixelIdx0 / frameSize;
    let localIdx0 = pixelIdx0 % frameSize;

    var result: u32 = 0u;
    for (var i: u32 = 0u; i < 4u; i++) {
        let localIdx = localIdx0 + i;
        if (localIdx < frameSize) {
            let x = i32(localIdx % params.width);
            let y = i32(localIdx / params.width);
            let blurred = blurPixel(frameIdx, x, y);
            result |= (blurred & 0xFFu) << (i * 8u);
        }
    }

    outputPacked[packedIdx] = result;
}
`;

// Single-frame warp shader that reads shifts/brightness from GPU buffers
// Fully GPU-resident: no CPU readback of shifts or brightness
// Dispatched once per frame to avoid accumulator race conditions
const warpAccumulateBatchShader = `
struct Params {
    inWidth: u32,
    inHeight: u32,
    outWidth: u32,
    outHeight: u32,
    numAPs: u32,
    patchSize: u32,
    drizzleScale: f32,
    minQuality: f32,
    refBrightness: f32,
    frameIdx: u32,        // Which frame to process
    searchOffsetX: f32,
    searchOffsetY: f32,
    frameWeight: f32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> frameData: array<u32>;      // All frames: Float32 RGBA
@group(0) @binding(2) var<storage, read> apPositions: array<u32>;    // AP positions: packed (x | y<<16)
@group(0) @binding(3) var<storage, read> shifts: array<f32>;         // NCC results: [dx, dy, quality] per AP per frame
@group(0) @binding(4) var<storage, read> brightness: array<f32>;     // Brightness per frame
@group(0) @binding(5) var<storage, read_write> accumR: array<f32>;
@group(0) @binding(6) var<storage, read_write> accumG: array<f32>;
@group(0) @binding(7) var<storage, read_write> accumB: array<f32>;
@group(0) @binding(8) var<storage, read_write> accumW: array<f32>;

fn readPixelFloat32(pixelIdx: u32) -> vec4<f32> {
    let pixelsPerFrame = params.inWidth * params.inHeight;
    let baseIdx = (params.frameIdx * pixelsPerFrame + pixelIdx) * 4u;
    let r = bitcast<f32>(frameData[baseIdx]);
    let g = bitcast<f32>(frameData[baseIdx + 1u]);
    let b = bitcast<f32>(frameData[baseIdx + 2u]);
    let a = bitcast<f32>(frameData[baseIdx + 3u]);
    return vec4<f32>(r, g, b, a) * 255.0;
}

fn cubicWeight(t: f32) -> f32 {
    let at = abs(t);
    if (at <= 1.0) {
        return (1.5 * at - 2.5) * at * at + 1.0;
    } else if (at < 2.0) {
        return ((-0.5 * at + 2.5) * at - 4.0) * at + 2.0;
    }
    return 0.0;
}

fn sampleFrameBicubic(x: f32, y: f32) -> vec4<f32> {
    let x0 = i32(floor(x));
    let y0 = i32(floor(y));
    let fx = x - f32(x0);
    let fy = y - f32(y0);
    let w = i32(params.inWidth);
    let h = i32(params.inHeight);

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

    for (var j: i32 = -1; j <= 2; j++) {
        let cy = clamp(y0 + j, 0, h - 1);
        let wy = select(select(select(wy3, wy2, j == 1), wy1, j == 0), wy0, j == -1);
        for (var i: i32 = -1; i <= 2; i++) {
            let cx = clamp(x0 + i, 0, w - 1);
            let wx = select(select(select(wx3, wx2, i == 1), wx1, i == 0), wx0, i == -1);
            let idx = u32(cy * w + cx);
            let pixel = readPixelFloat32(idx);
            let weight = wx * wy;
            result += pixel * weight;
            totalWeight += weight;
        }
    }

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

    let outIdx = oy * params.outWidth + ox;
    let invScale = 1.0 / params.drizzleScale;
    let inX = f32(ox) * invScale;
    let inY = f32(oy) * invScale;

    // Gaussian interpolation params
    let patchSize = f32(params.patchSize);
    let influenceRadius = patchSize * 4.0;
    let influenceRadius2 = influenceRadius * influenceRadius;
    let sigma2 = patchSize * 1.5 * patchSize * 1.5 * 2.0;

    // Interpolate displacement from APs
    var totalWeight: f32 = 0.0;
    var weightedDx: f32 = 0.0;
    var weightedDy: f32 = 0.0;

    let frameIdx = params.frameIdx;

    for (var i: u32 = 0u; i < params.numAPs; i++) {
        // Read shift for this frame and AP
        let shiftIdx = (frameIdx * params.numAPs + i) * 3u;
        let apDx = shifts[shiftIdx] + params.searchOffsetX;
        let apDy = shifts[shiftIdx + 1u] + params.searchOffsetY;
        let quality = shifts[shiftIdx + 2u];

        if (quality < params.minQuality) {
            continue;
        }

        // Read AP position
        let apPacked = apPositions[i];
        let apX = f32(apPacked & 0xFFFFu);
        let apY = f32(apPacked >> 16u);

        let dx = inX - apX;
        let dy = inY - apY;
        let dist2 = dx * dx + dy * dy;

        if (dist2 < influenceRadius2) {
            let gaussWeight = exp(-dist2 / sigma2);
            let weight = gaussWeight * quality;
            weightedDx += apDx * weight;
            weightedDy += apDy * weight;
            totalWeight += weight;
        }
    }

    // Compute source coordinates
    var srcX = inX;
    var srcY = inY;
    if (totalWeight > 0.0) {
        srcX += weightedDx / totalWeight;
        srcY += weightedDy / totalWeight;
    }

    // Bounds check
    if (srcX < 0.0 || srcX >= f32(params.inWidth) - 1.0 ||
        srcY < 0.0 || srcY >= f32(params.inHeight) - 1.0) {
        return;
    }

    // Sample frame
    let color = sampleFrameBicubic(srcX, srcY);

    // Skip black pixels
    if (color.r < 1.0 && color.g < 1.0 && color.b < 1.0) {
        return;
    }

    // Compute brightness scale from GPU buffer
    let frameBrightness = brightness[frameIdx];
    let brightnessScale = select(params.refBrightness / frameBrightness, 1.0, frameBrightness < 1.0);

    let w = params.frameWeight;
    let b = brightnessScale;

    accumR[outIdx] += color.r * b * w;
    accumG[outIdx] += color.g * b * w;
    accumB[outIdx] += color.b * b * w;
    accumW[outIdx] += w;
}
`;

let stackDevice = null;
let stackQueue = null;
let warpPipeline = null;
let warpBatchPipeline = null;  // New: fully GPU-resident batch warp
let accumulatePipeline = null;
let nccBatchPipeline = null;  // Template matching on same device
let brightnessPipeline = null;  // Brightness reduction on same device
let blurPackedPipeline = null;  // Blur for suppressing demosaic artifacts
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

        // Brightness reduction pipeline (same device for zero-copy)
        const brightnessShaderModule = stackDevice.createShaderModule({
            code: brightnessShaderCode
        });

        brightnessPipeline = stackDevice.createComputePipeline({
            layout: 'auto',
            compute: { module: brightnessShaderModule, entryPoint: 'main' }
        });

        // Blur pipeline for suppressing demosaic artifacts in grayscale
        const blurPackedShaderModule = stackDevice.createShaderModule({
            code: blurPackedShaderCode
        });

        blurPackedPipeline = stackDevice.createComputePipeline({
            layout: 'auto',
            compute: { module: blurPackedShaderModule, entryPoint: 'main' }
        });

        // Fully GPU-resident batch warp+accumulate pipeline
        const warpBatchShaderModule = stackDevice.createShaderModule({
            code: warpAccumulateBatchShader
        });

        warpBatchPipeline = stackDevice.createComputePipeline({
            layout: 'auto',
            compute: { module: warpBatchShaderModule, entryPoint: 'main' }
        });

        isStackingReady = true;
        stackDeviceLost = false;
        console.log('WebGPU stacking initialized (with VNG demosaic + blur + NCC matching + brightness + batch warp)');
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
 * NO CPU READBACK - brightness computed separately on GPU via computeBrightnessFromGpuBuffer
 * @returns {{rgbaGpuBuffer: GPUBuffer, grayGpuBuffer: GPUBuffer, batchSize: number, cropSize: number}}
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

    // Grayscale stays on GPU for template matching AND brightness computation
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

    // Create blurred grayscale buffer (blur suppresses demosaic artifacts for template matching)
    const blurredGrayBuffer = stackDevice.createBuffer({
        size: grayOutputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });

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

    const vngPass = encoder.beginComputePass();
    vngPass.setPipeline(vngCropPipeline);
    vngPass.setBindGroup(0, bindGroup);
    vngPass.dispatchWorkgroups(
        Math.ceil(cropSize / 16),
        Math.ceil(cropSize / 16),
        batchSize
    );
    vngPass.end();

    // Apply 5x5 Gaussian blur to suppress demosaic artifacts before template matching
    const blurParamsBuffer = stackDevice.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    stackQueue.writeBuffer(blurParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, 0]));

    const blurBindGroup = stackDevice.createBindGroup({
        layout: blurPackedPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: blurParamsBuffer } },
            { binding: 1, resource: { buffer: grayGpuBuffer } },
            { binding: 2, resource: { buffer: blurredGrayBuffer } }
        ]
    });

    const packedSize = Math.ceil((cropSize * cropSize * batchSize) / 4);
    const blurWorkgroups = Math.ceil(packedSize / 256);

    const blurPass = encoder.beginComputePass();
    blurPass.setPipeline(blurPackedPipeline);
    blurPass.setBindGroup(0, blurBindGroup);
    blurPass.dispatchWorkgroups(blurWorkgroups, 1, 1);
    blurPass.end();

    stackQueue.submit([encoder.finish()]);

    // Cleanup temp buffers (but keep rgbaGpuBuffer and blurredGrayBuffer!)
    paramsBuffer.destroy();
    inputBuffer.destroy();
    centersBuffer.destroy();
    blurParamsBuffer.destroy();
    grayGpuBuffer.destroy();  // Original unblurred - no longer needed

    // Return GPU buffer handles - caller must destroy after use
    // Note: grayGpuBuffer is now the BLURRED version for better template matching
    return { rgbaGpuBuffer, grayGpuBuffer: blurredGrayBuffer, batchSize, cropSize };
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

/**
 * Compute mean brightness per frame from GPU grayscale buffer (zero-copy)
 * Uses sparse sampling (every 8th pixel) matching CPU approach
 * @param {GPUBuffer} grayGpuBuffer - Packed u8 grayscale from VNG demosaic
 * @param {number} width - Frame width
 * @param {number} height - Frame height
 * @param {number} batchSize - Number of frames
 * @returns {Float32Array} - Mean brightness per frame (0-255 scale)
 */
async function computeBrightnessFromGpuBuffer(grayGpuBuffer, width, height, batchSize) {
    if (!stackDevice || !brightnessPipeline) {
        throw new Error('Stacking GPU not initialized for brightness computation');
    }

    const sampleStep = 8;  // Match CPU sparse sampling

    // Create buffers
    const paramsBuffer = stackDevice.createBuffer({
        size: 16,  // 4 u32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const brightnessBuffer = stackDevice.createBuffer({
        size: batchSize * 4,  // One f32 per frame
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    const readbackBuffer = stackDevice.createBuffer({
        size: batchSize * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    // Upload params
    const paramsData = new Uint32Array([width, height, batchSize, sampleStep]);
    stackQueue.writeBuffer(paramsBuffer, 0, paramsData);

    // Create bind group
    const bindGroup = stackDevice.createBindGroup({
        layout: brightnessPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: { buffer: grayGpuBuffer } },
            { binding: 2, resource: { buffer: brightnessBuffer } }
        ]
    });

    // Run brightness reduction - one workgroup per frame
    const encoder = stackDevice.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(brightnessPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(batchSize, 1, 1);
    pass.end();

    encoder.copyBufferToBuffer(brightnessBuffer, 0, readbackBuffer, 0, batchSize * 4);
    stackQueue.submit([encoder.finish()]);

    // Read results (tiny - just one f32 per frame!)
    await safeStackMapAsync(readbackBuffer, GPUMapMode.READ);
    const brightnessData = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();

    // Cleanup
    paramsBuffer.destroy();
    brightnessBuffer.destroy();
    readbackBuffer.destroy();

    return brightnessData;
}

/**
 * Template matching fully on GPU - returns GPU buffer, no readback
 * @returns {{shiftsGpuBuffer: GPUBuffer, apPositionsBuffer: GPUBuffer, searchOffset: {dx, dy}}}
 */
async function matchTemplatesFullyGpu(grayGpuBuffer, refGrayData, width, height, batchSize,
    alignmentPoints, patchSize, searchRadius, searchOffset = null) {

    if (!stackDevice || !nccBatchPipeline) {
        throw new Error('Stacking GPU not initialized for template matching');
    }

    const numAPs = alignmentPoints.length;
    const templateSize = patchSize * patchSize;
    const halfPatch = Math.floor(patchSize / 2);

    const offsetX = searchOffset ? Math.round(searchOffset.dx) : 0;
    const offsetY = searchOffset ? Math.round(searchOffset.dy) : 0;

    // Extract reference templates and AP positions
    const refTemplates = new Float32Array(numAPs * templateSize);
    const apPositions = new Uint32Array(numAPs);

    for (let i = 0; i < numAPs; i++) {
        const ap = alignmentPoints[i];
        // Store original AP positions (not offset) - offset applied in warp shader
        apPositions[i] = (ap.x & 0xFFFF) | ((ap.y & 0xFFFF) << 16);

        // For NCC search, use offset position
        const searchX = ap.x + offsetX;
        const searchY = ap.y + offsetY;
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

    // Create buffers
    const paramsBuffer = stackDevice.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const templatesBuffer = stackDevice.createBuffer({
        size: refTemplates.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    // AP positions buffer - kept for warp shader!
    const apPositionsBuffer = stackDevice.createBuffer({
        size: apPositions.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    // NCC search positions (may be offset from original AP positions)
    const searchPositions = new Uint32Array(numAPs);
    for (let i = 0; i < numAPs; i++) {
        const ap = alignmentPoints[i];
        const searchX = ap.x + offsetX;
        const searchY = ap.y + offsetY;
        searchPositions[i] = (searchX & 0xFFFF) | ((searchY & 0xFFFF) << 16);
    }

    const searchPosBuffer = stackDevice.createBuffer({
        size: searchPositions.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    // Results buffer - kept on GPU!
    const resultsSize = batchSize * numAPs * 3 * 4;
    const shiftsGpuBuffer = stackDevice.createBuffer({
        size: resultsSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    // Upload data
    const searchSize = patchSize + 2 * searchRadius;
    const paramsData = new Uint32Array([patchSize, patchSize, searchSize, searchSize, numAPs, batchSize, width, height]);
    stackQueue.writeBuffer(paramsBuffer, 0, paramsData);
    stackQueue.writeBuffer(templatesBuffer, 0, refTemplates);
    stackQueue.writeBuffer(apPositionsBuffer, 0, apPositions);
    stackQueue.writeBuffer(searchPosBuffer, 0, searchPositions);

    // Create bind group
    const bindGroup = stackDevice.createBindGroup({
        layout: nccBatchPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: { buffer: templatesBuffer } },
            { binding: 2, resource: { buffer: grayGpuBuffer } },
            { binding: 3, resource: { buffer: searchPosBuffer } },
            { binding: 4, resource: { buffer: shiftsGpuBuffer } }
        ]
    });

    // Run NCC
    const encoder = stackDevice.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(nccBatchPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(batchSize * numAPs, 1, 1);
    pass.end();

    stackQueue.submit([encoder.finish()]);

    // Wait for NCC computation to complete before returning GPU buffers
    await stackDevice.queue.onSubmittedWorkDone();

    // Cleanup temp buffers (keep shiftsGpuBuffer and apPositionsBuffer!)
    paramsBuffer.destroy();
    templatesBuffer.destroy();
    searchPosBuffer.destroy();

    return {
        shiftsGpuBuffer,
        apPositionsBuffer,
        searchOffset: { dx: offsetX, dy: offsetY }
    };
}

/**
 * Compute brightness fully on GPU - returns GPU buffer, no readback
 * @returns {GPUBuffer} - Buffer with one f32 per frame
 */
async function computeBrightnessFullyGpu(grayGpuBuffer, width, height, batchSize) {
    if (!stackDevice || !brightnessPipeline) {
        throw new Error('Stacking GPU not initialized for brightness computation');
    }

    const sampleStep = 8;

    const paramsBuffer = stackDevice.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Brightness buffer - kept on GPU!
    const brightnessGpuBuffer = stackDevice.createBuffer({
        size: batchSize * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    stackQueue.writeBuffer(paramsBuffer, 0, new Uint32Array([width, height, batchSize, sampleStep]));

    const bindGroup = stackDevice.createBindGroup({
        layout: brightnessPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: { buffer: grayGpuBuffer } },
            { binding: 2, resource: { buffer: brightnessGpuBuffer } }
        ]
    });

    const encoder = stackDevice.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(brightnessPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(batchSize, 1, 1);
    pass.end();

    stackQueue.submit([encoder.finish()]);

    // Wait for brightness computation to complete before returning GPU buffer
    await stackDevice.queue.onSubmittedWorkDone();

    paramsBuffer.destroy();

    return brightnessGpuBuffer;
}

/**
 * Warp and accumulate batch - fully GPU-resident, no intermediate readbacks
 * All data stays on GPU: RGBA frames, shifts, brightness
 * Creates separate params buffers per frame to allow single-submit batching
 */
async function warpAndAccumulateBatchFullyGpu(
    rgbaGpuBuffer,      // From VNG demosaic
    shiftsGpuBuffer,    // From matchTemplatesFullyGpu
    brightnessGpuBuffer,// From computeBrightnessFullyGpu
    apPositionsBuffer,  // From matchTemplatesFullyGpu
    batchSize,
    cropSize,
    frameWeights,       // Array of weights (small - just numbers)
    outWidth, outHeight,
    numAPs,
    patchSize,
    drizzleScale,
    refBrightness,
    searchOffset,
    minApQuality = 0.3
) {
    if (!stackDevice || !warpBatchPipeline) {
        throw new Error('Stacking GPU not initialized for batch warp');
    }

    console.log(`[WarpBatchFullyGpu] batchSize=${batchSize} cropSize=${cropSize} outSize=${outWidth}x${outHeight} numAPs=${numAPs} patchSize=${patchSize} drizzleScale=${drizzleScale} refBrightness=${refBrightness} searchOffset=(${searchOffset.dx}, ${searchOffset.dy}) weights=${frameWeights.slice(0, 3).join(',')}...`);

    const buffers = getStackingBuffers(cropSize, cropSize, outWidth, outHeight, numAPs);
    const workgroupsX = Math.ceil(outWidth / 16);
    const workgroupsY = Math.ceil(outHeight / 16);

    // Create per-frame params buffers and bind groups
    const paramsBuffers = [];
    const bindGroups = [];

    for (let frameIdx = 0; frameIdx < batchSize; frameIdx++) {
        const paramsBuffer = stackDevice.createBuffer({
            size: 56,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Upload params for this frame
        const paramsData = new ArrayBuffer(56);
        const paramsU32 = new Uint32Array(paramsData);
        const paramsF32 = new Float32Array(paramsData);
        paramsU32[0] = cropSize;           // inWidth
        paramsU32[1] = cropSize;           // inHeight
        paramsU32[2] = outWidth;
        paramsU32[3] = outHeight;
        paramsU32[4] = numAPs;
        paramsU32[5] = patchSize;
        paramsF32[6] = drizzleScale;
        paramsF32[7] = minApQuality;
        paramsF32[8] = refBrightness;
        paramsU32[9] = frameIdx;           // Which frame to process
        paramsF32[10] = searchOffset.dx;
        paramsF32[11] = searchOffset.dy;
        paramsF32[12] = frameWeights[frameIdx];
        paramsU32[13] = 0;                 // Padding
        stackQueue.writeBuffer(paramsBuffer, 0, paramsData);

        const bindGroup = stackDevice.createBindGroup({
            layout: warpBatchPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: paramsBuffer } },
                { binding: 1, resource: { buffer: rgbaGpuBuffer } },
                { binding: 2, resource: { buffer: apPositionsBuffer } },
                { binding: 3, resource: { buffer: shiftsGpuBuffer } },
                { binding: 4, resource: { buffer: brightnessGpuBuffer } },
                { binding: 5, resource: { buffer: buffers.accumR } },
                { binding: 6, resource: { buffer: buffers.accumG } },
                { binding: 7, resource: { buffer: buffers.accumB } },
                { binding: 8, resource: { buffer: buffers.accumW } }
            ]
        });

        paramsBuffers.push(paramsBuffer);
        bindGroups.push(bindGroup);
    }

    // Single encoder with sequential dispatches (GPU executes in order)
    const encoder = stackDevice.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(warpBatchPipeline);

    for (let frameIdx = 0; frameIdx < batchSize; frameIdx++) {
        pass.setBindGroup(0, bindGroups[frameIdx]);
        pass.dispatchWorkgroups(workgroupsX, workgroupsY);
    }

    pass.end();
    stackQueue.submit([encoder.finish()]);

    // Cleanup
    for (const buf of paramsBuffers) {
        buf.destroy();
    }
    rgbaGpuBuffer.destroy();
    shiftsGpuBuffer.destroy();
    brightnessGpuBuffer.destroy();
    apPositionsBuffer.destroy();
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
    computeBrightnessFromGpuBuffer,
    // Fully GPU-resident functions (no intermediate readbacks)
    matchTemplatesFullyGpu,
    computeBrightnessFullyGpu,
    warpAndAccumulateBatchFullyGpu,
    extractGrayscale,
    cleanupStackingBuffers
};

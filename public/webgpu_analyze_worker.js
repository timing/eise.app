// WebGPU Batched Frame Analysis Worker
// Handles: Demosaic, Sharpness (Laplacian), Circularity (Moments)
console.log('webgpu_analyze_worker.js loaded (v1)');

let device = null;
let queue = null;
let isReady = false;

// Pipelines
let demosaicPipeline = null;
let grayscalePipeline = null;
let laplacianPipeline = null;
let reductionPipeline = null;
let momentsPipeline = null;
let momentsReductionPipeline = null;

// Cached buffers for reuse across batches
let cachedAnalyzeBuffers = null;
let cachedAnalyzeConfig = null;

// ============================================================
// WGSL SHADERS
// ============================================================

// Demosaic shader - converts Bayer pattern to RGB
const demosaicShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    bayerPattern: u32,  // 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;  // Raw Bayer data (packed as u32 for 16-bit)
@group(0) @binding(2) var<storage, read_write> output: array<u32>;  // RGBA output

fn getBayerValue(frameIdx: u32, x: u32, y: u32) -> f32 {
    let idx = frameIdx * params.width * params.height + y * params.width + x;
    return f32(input[idx] & 0xFFFFu) / 65535.0;
}

fn sampleBayer(frameIdx: u32, x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(params.width) - 1);
    let cy = clamp(y, 0, i32(params.height) - 1);
    return getBayerValue(frameIdx, u32(cx), u32(cy));
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

    var r: f32 = 0.0;
    var g: f32 = 0.0;
    var b: f32 = 0.0;

    // RGGB pattern (most common)
    // R  G
    // G  B
    let pattern = params.bayerPattern;

    if (pattern == 0u) { // RGGB
        if (bx == 0u && by == 0u) { // R pixel
            r = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            b = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 1u && by == 1u) { // B pixel
            b = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            r = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 1u && by == 0u) { // G pixel (R row)
            g = sampleBayer(frameIdx, ix, iy);
            r = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            b = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        } else { // G pixel (B row)
            g = sampleBayer(frameIdx, ix, iy);
            b = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            r = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        }
    } else if (pattern == 1u) { // BGGR
        if (bx == 0u && by == 0u) { // B pixel
            b = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            r = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 1u && by == 1u) { // R pixel
            r = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            b = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 1u && by == 0u) { // G pixel (B row)
            g = sampleBayer(frameIdx, ix, iy);
            b = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            r = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        } else { // G pixel (R row)
            g = sampleBayer(frameIdx, ix, iy);
            r = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            b = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        }
    } else if (pattern == 2u) { // GRBG
        if (bx == 1u && by == 0u) { // R pixel
            r = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            b = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 0u && by == 1u) { // B pixel
            b = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            r = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 0u && by == 0u) { // G pixel (R row)
            g = sampleBayer(frameIdx, ix, iy);
            r = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            b = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        } else { // G pixel (B row)
            g = sampleBayer(frameIdx, ix, iy);
            b = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            r = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        }
    } else { // GBRG (pattern == 3)
        if (bx == 0u && by == 1u) { // R pixel
            r = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            b = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 1u && by == 0u) { // B pixel
            b = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            r = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 0u && by == 0u) { // G pixel (B row)
            g = sampleBayer(frameIdx, ix, iy);
            b = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            r = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        } else { // G pixel (R row)
            g = sampleBayer(frameIdx, ix, iy);
            r = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            b = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        }
    }

    // Pack as RGBA (8-bit per channel for output)
    let ri = u32(clamp(r * 255.0, 0.0, 255.0));
    let gi = u32(clamp(g * 255.0, 0.0, 255.0));
    let bi = u32(clamp(b * 255.0, 0.0, 255.0));
    let rgba = ri | (gi << 8u) | (bi << 16u) | (255u << 24u);

    let outIdx = frameIdx * params.width * params.height + y * params.width + x;
    output[outIdx] = rgba;
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

// Tenengrad shader - Sobel gradient magnitude squared (matches CPU sharpness metric)
const laplacianShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;  // Grayscale
@group(0) @binding(2) var<storage, read_write> laplacian: array<f32>;  // Gradient magnitude squared
@group(0) @binding(3) var<storage, read_write> laplacianSq: array<f32>;  // Not used but kept for compatibility

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
    let tenengrad = gx * gx + gy * gy;

    let idx = frameIdx * params.width * params.height + y * params.width + x;
    laplacian[idx] = tenengrad;
    laplacianSq[idx] = 0.0;  // Not needed for Tenengrad
}
`;

// Reduction shader - sums values across frame for variance calculation
const reductionShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    inputSize: u32,  // Total pixels per frame
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> laplacian: array<f32>;
@group(0) @binding(2) var<storage, read> laplacianSq: array<f32>;
@group(0) @binding(3) var<storage, read_write> results: array<f32>;  // [sum, sumSq] per frame

var<workgroup> sharedSum: array<f32, 256>;
var<workgroup> sharedSumSq: array<f32, 256>;

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

    // Load values
    var sum: f32 = 0.0;
    var sumSq: f32 = 0.0;

    if (startPixel < params.inputSize) {
        let idx = frameIdx * params.inputSize + startPixel;
        sum = laplacian[idx];
        sumSq = laplacianSq[idx];
    }

    sharedSum[localIdx] = sum;
    sharedSumSq[localIdx] = sumSq;
    workgroupBarrier();

    // Parallel reduction
    for (var stride = 128u; stride > 0u; stride = stride >> 1u) {
        if (localIdx < stride) {
            sharedSum[localIdx] += sharedSum[localIdx + stride];
            sharedSumSq[localIdx] += sharedSumSq[localIdx + stride];
        }
        workgroupBarrier();
    }

    // Write partial result
    if (localIdx == 0u) {
        // Calculate actual number of workgroups based on input size
        let numWorkgroups = (params.inputSize + 255u) / 256u;
        let resultIdx = frameIdx * numWorkgroups + wid.x;
        results[resultIdx * 2u] = sharedSum[0];
        results[resultIdx * 2u + 1u] = sharedSumSq[0];
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

    const grayscaleModule = await createShader(grayscaleShader, 'grayscale');
    grayscalePipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: grayscaleModule, entryPoint: 'main' }
    });

    const laplacianModule = await createShader(laplacianShader, 'laplacian');
    laplacianPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: laplacianModule, entryPoint: 'main' }
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

    isReady = true;
    console.log('WebGPU analyze worker initialized');
}

// ============================================================
// ANALYSIS FUNCTIONS
// ============================================================

/**
 * Get or create cached buffers for frame analysis
 * Reuses buffers across batches to avoid allocation overhead
 */
function getAnalyzeBuffers(batchSize, width, height) {
    const pixelCount = width * height;
    const numWorkgroups = Math.ceil(pixelCount / 256);

    // Calculate required buffer sizes
    const requiredSizes = {
        batchSize,
        pixelCount,
        numWorkgroups,
        paramsSize: 16,
        pixelBufferSize: batchSize * pixelCount * 4,
        momentsPixelSize: batchSize * pixelCount * 6 * 4,
        reductionSize: batchSize * numWorkgroups * 2 * 4,
        momentsReductionSize: batchSize * numWorkgroups * 6 * 4
    };

    // Check if we can reuse cached buffers
    if (cachedAnalyzeBuffers && cachedAnalyzeConfig &&
        cachedAnalyzeConfig.pixelBufferSize >= requiredSizes.pixelBufferSize &&
        cachedAnalyzeConfig.momentsPixelSize >= requiredSizes.momentsPixelSize &&
        cachedAnalyzeConfig.reductionSize >= requiredSizes.reductionSize &&
        cachedAnalyzeConfig.momentsReductionSize >= requiredSizes.momentsReductionSize) {
        // Update config with current batch params
        cachedAnalyzeConfig.batchSize = batchSize;
        cachedAnalyzeConfig.pixelCount = pixelCount;
        cachedAnalyzeConfig.numWorkgroups = numWorkgroups;
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
    const momentsPixelSize = align4(Math.ceil(requiredSizes.momentsPixelSize * headroom));
    const reductionSize = align4(Math.ceil(requiredSizes.reductionSize * headroom));
    const momentsReductionSize = align4(Math.ceil(requiredSizes.momentsReductionSize * headroom));

    cachedAnalyzeBuffers = {
        paramsBuffer: device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        inputBuffer: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        rgbaBuffer: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        }),
        grayBuffer: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.STORAGE
        }),
        laplacianBuffer: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.STORAGE
        }),
        laplacianSqBuffer: device.createBuffer({
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
        rgbaReadback: device.createBuffer({
            size: pixelBufferSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        })
    };

    cachedAnalyzeConfig = {
        batchSize,
        pixelCount,
        numWorkgroups,
        pixelBufferSize,
        momentsPixelSize,
        reductionSize,
        momentsReductionSize
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

async function analyzeBatch(frames, width, height, bayerPattern, threshold) {
    const batchSize = frames.length;
    const pixelCount = width * height;
    const numWorkgroups = Math.ceil(pixelCount / 256);

    // Get cached buffers (creates if needed, reuses if possible)
    const buffers = getAnalyzeBuffers(batchSize, width, height);

    // Determine if we need demosaic (bayerPattern >= 0 means Bayer data)
    const needsDemosaic = bayerPattern >= 0;

    if (needsDemosaic) {
        // Upload Bayer data to input buffer
        const bayerData = new Uint32Array(batchSize * pixelCount);
        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const offset = i * pixelCount;
            if (frame.data instanceof Uint16Array) {
                for (let j = 0; j < pixelCount; j++) {
                    bayerData[offset + j] = frame.data[j];
                }
            } else {
                // 8-bit data, scale up
                for (let j = 0; j < pixelCount; j++) {
                    bayerData[offset + j] = frame.data[j] * 257;  // 8-bit to 16-bit
                }
            }
        }
        queue.writeBuffer(buffers.inputBuffer, 0, bayerData);

        // Demosaic params
        queue.writeBuffer(buffers.paramsBuffer, 0, new Uint32Array([width, height, batchSize, bayerPattern]));

        // Run demosaic
        const demosaicBindGroup = device.createBindGroup({
            layout: demosaicPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: buffers.paramsBuffer } },
                { binding: 1, resource: { buffer: buffers.inputBuffer } },
                { binding: 2, resource: { buffer: buffers.rgbaBuffer } }
            ]
        });

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(demosaicPipeline);
        pass.setBindGroup(0, demosaicBindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
        pass.end();
        queue.submit([encoder.finish()]);
    } else {
        // Input is already RGBA - upload to rgba buffer
        const rgbaData = new Uint32Array(batchSize * pixelCount);
        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const offset = i * pixelCount;
            // Handle both Uint8Array and ArrayBuffer inputs
            let src;
            if (frame.data instanceof Uint8Array) {
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

            for (let j = 0; j < pixelCount; j++) {
                rgbaData[offset + j] = src[j*4] | (src[j*4+1] << 8) | (src[j*4+2] << 16) | (src[j*4+3] << 24);
            }
        }
        queue.writeBuffer(buffers.rgbaBuffer, 0, rgbaData);
    }

    // Update params for grayscale/laplacian
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
        layout: laplacianPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.paramsBuffer } },
            { binding: 1, resource: { buffer: buffers.grayBuffer } },
            { binding: 2, resource: { buffer: buffers.laplacianBuffer } },
            { binding: 3, resource: { buffer: buffers.laplacianSqBuffer } }
        ]
    });

    const reductionBindGroup = device.createBindGroup({
        layout: reductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.laplacianBuffer } },
            { binding: 2, resource: { buffer: buffers.laplacianSqBuffer } },
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

    // Execute all passes in a single command encoder
    const encoder = device.createCommandEncoder();

    // Grayscale
    let pass = encoder.beginComputePass();
    pass.setPipeline(grayscalePipeline);
    pass.setBindGroup(0, grayBindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
    pass.end();

    // Laplacian (Tenengrad)
    pass = encoder.beginComputePass();
    pass.setPipeline(laplacianPipeline);
    pass.setBindGroup(0, lapBindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
    pass.end();

    // Laplacian reduction
    pass = encoder.beginComputePass();
    pass.setPipeline(reductionPipeline);
    pass.setBindGroup(0, reductionBindGroup);
    pass.dispatchWorkgroups(numWorkgroups, batchSize, 1);
    pass.end();

    // Moments calculation
    pass = encoder.beginComputePass();
    pass.setPipeline(momentsPipeline);
    pass.setBindGroup(0, momentsBindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
    pass.end();

    // Moments reduction
    pass = encoder.beginComputePass();
    pass.setPipeline(momentsReductionPipeline);
    pass.setBindGroup(0, momentsReductionBindGroup);
    pass.dispatchWorkgroups(numWorkgroups, batchSize, 1);
    pass.end();

    // Copy results for readback
    const reductionCopySize = batchSize * numWorkgroups * 2 * 4;
    const momentsCopySize = batchSize * numWorkgroups * 6 * 4;
    const rgbaCopySize = batchSize * pixelCount * 4;

    encoder.copyBufferToBuffer(buffers.reductionBuffer, 0, buffers.reductionReadback, 0, reductionCopySize);
    encoder.copyBufferToBuffer(buffers.momentsReductionBuffer, 0, buffers.momentsReadback, 0, momentsCopySize);
    encoder.copyBufferToBuffer(buffers.rgbaBuffer, 0, buffers.rgbaReadback, 0, rgbaCopySize);

    queue.submit([encoder.finish()]);

    // Read back results
    await buffers.reductionReadback.mapAsync(GPUMapMode.READ);
    await buffers.momentsReadback.mapAsync(GPUMapMode.READ);
    await buffers.rgbaReadback.mapAsync(GPUMapMode.READ);

    const reductionData = new Float32Array(buffers.reductionReadback.getMappedRange().slice(0, reductionCopySize));
    const momentsData = new Float32Array(buffers.momentsReadback.getMappedRange().slice(0, momentsCopySize));
    const rgbaData = new Uint8Array(buffers.rgbaReadback.getMappedRange().slice(0, rgbaCopySize));

    buffers.reductionReadback.unmap();
    buffers.momentsReadback.unmap();
    buffers.rgbaReadback.unmap();

    // Process results for each frame
    const results = [];

    for (let i = 0; i < batchSize; i++) {
        // Sum up partial reductions for Tenengrad sharpness
        let tenengradSum = 0;
        for (let w = 0; w < numWorkgroups; w++) {
            tenengradSum += reductionData[(i * numWorkgroups + w) * 2];
        }

        // Tenengrad sharpness = mean of gradient magnitude squared
        // Scale by 255² = 65025 to match CPU which uses 0-255 grayscale (we use 0-1)
        const sharpness = (tenengradSum / pixelCount) * 65025;

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

        // Extract RGBA for this frame
        const frameRgba = rgbaData.slice(i * pixelCount * 4, (i + 1) * pixelCount * 4);

        results.push({
            sharpness,
            circularity,
            rgbaBuffer: frameRgba.buffer.slice(frameRgba.byteOffset, frameRgba.byteOffset + frameRgba.byteLength)
        });
    }

    // Buffers are cached and reused - no cleanup here
    return results;
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

    if (type === 'analyze-batch') {
        if (!isReady) {
            self.postMessage({ type: 'analyze-error', error: 'Not initialized' });
            return;
        }

        const { frames, width, height, bayerPattern, threshold, requestId } = e.data;

        try {
            const results = await analyzeBatch(frames, width, height, bayerPattern, threshold);
            self.postMessage({ type: 'analyze-result', requestId, results },
                results.map(r => r.rgbaBuffer));
        } catch (err) {
            self.postMessage({ type: 'analyze-error', requestId, error: err.message });
        }
        return;
    }

    if (type === 'cleanup') {
        cleanupAnalyzeBuffers();
        self.postMessage({ type: 'cleanup-done' });
        return;
    }
});

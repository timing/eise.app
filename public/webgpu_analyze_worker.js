// WebGPU Batched Frame Analysis Worker
// Handles: Demosaic, Sharpness (Laplacian), Circularity (Moments)
console.log('webgpu_analyze_worker.js loaded (v1)');

let device = null;
let queue = null;
let isReady = false;

// Pipelines
let demosaicPipeline = null;
let demosaicCropPipeline = null;
let rgbaCropPipeline = null;
let grayscalePipeline = null;
let laplacianPipeline = null;
let reductionPipeline = null;
let momentsPipeline = null;
let momentsReductionPipeline = null;
let boundsPipeline = null;
let boundsReductionPipeline = null;

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

// Demosaic + Crop shader - crops around per-frame centers during demosaic
const demosaicCropShader = `
struct Params {
    srcWidth: u32,      // Source frame width
    srcHeight: u32,     // Source frame height
    cropSize: u32,      // Output crop size (square)
    bayerPattern: u32,  // 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
    batchSize: u32,
    _pad1: u32,
    _pad2: u32,
    _pad3: u32,
}

struct CropCenter {
    x: f32,
    y: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;      // Raw Bayer data
@group(0) @binding(2) var<storage, read> centers: array<CropCenter>;  // Per-frame centers
@group(0) @binding(3) var<storage, read_write> output: array<u32>;    // Cropped RGBA output

fn getBayerValue(frameIdx: u32, x: u32, y: u32) -> f32 {
    let idx = frameIdx * params.srcWidth * params.srcHeight + y * params.srcWidth + x;
    return f32(input[idx] & 0xFFFFu) / 65535.0;
}

fn sampleBayer(frameIdx: u32, x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(params.srcWidth) - 1);
    let cy = clamp(y, 0, i32(params.srcHeight) - 1);
    return getBayerValue(frameIdx, u32(cx), u32(cy));
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let outX = gid.x;  // Output pixel x (0 to cropSize-1)
    let outY = gid.y;  // Output pixel y (0 to cropSize-1)
    let frameIdx = gid.z;

    if (outX >= params.cropSize || outY >= params.cropSize || frameIdx >= params.batchSize) {
        return;
    }

    // Get crop center for this frame
    let center = centers[frameIdx];

    // Calculate source coordinates (ensure even alignment for Bayer pattern)
    let halfSize = f32(params.cropSize) / 2.0;
    let cropStartX = i32(floor(center.x - halfSize)) & ~1;
    let cropStartY = i32(floor(center.y - halfSize)) & ~1;

    let srcX = cropStartX + i32(outX);
    let srcY = cropStartY + i32(outY);

    // Clamp to source bounds
    let x = u32(clamp(srcX, 0, i32(params.srcWidth) - 1));
    let y = u32(clamp(srcY, 0, i32(params.srcHeight) - 1));
    let ix = i32(x);
    let iy = i32(y);

    // Bayer position in the pattern
    let bx = x % 2u;
    let by = y % 2u;

    var r: f32 = 0.0;
    var g: f32 = 0.0;
    var b: f32 = 0.0;

    let pattern = params.bayerPattern;

    if (pattern == 0u) { // RGGB
        if (bx == 0u && by == 0u) {
            r = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            b = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 1u && by == 1u) {
            b = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            r = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 1u && by == 0u) {
            g = sampleBayer(frameIdx, ix, iy);
            r = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            b = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, ix, iy);
            b = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            r = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        }
    } else if (pattern == 1u) { // BGGR
        if (bx == 0u && by == 0u) {
            b = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            r = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 1u && by == 1u) {
            r = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            b = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 1u && by == 0u) {
            g = sampleBayer(frameIdx, ix, iy);
            b = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            r = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, ix, iy);
            r = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            b = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        }
    } else if (pattern == 2u) { // GRBG
        if (bx == 1u && by == 0u) {
            r = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            b = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 0u && by == 1u) {
            b = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            r = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 0u && by == 0u) {
            g = sampleBayer(frameIdx, ix, iy);
            r = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            b = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, ix, iy);
            b = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            r = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        }
    } else { // GBRG (pattern == 3)
        if (bx == 0u && by == 1u) {
            r = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            b = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 1u && by == 0u) {
            b = sampleBayer(frameIdx, ix, iy);
            g = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy) +
                 sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.25;
            r = (sampleBayer(frameIdx, ix-1, iy-1) + sampleBayer(frameIdx, ix+1, iy-1) +
                 sampleBayer(frameIdx, ix-1, iy+1) + sampleBayer(frameIdx, ix+1, iy+1)) * 0.25;
        } else if (bx == 0u && by == 0u) {
            g = sampleBayer(frameIdx, ix, iy);
            b = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            r = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        } else {
            g = sampleBayer(frameIdx, ix, iy);
            r = (sampleBayer(frameIdx, ix-1, iy) + sampleBayer(frameIdx, ix+1, iy)) * 0.5;
            b = (sampleBayer(frameIdx, ix, iy-1) + sampleBayer(frameIdx, ix, iy+1)) * 0.5;
        }
    }

    // Pack as RGBA
    let ri = u32(clamp(r * 255.0, 0.0, 255.0));
    let gi = u32(clamp(g * 255.0, 0.0, 255.0));
    let bi = u32(clamp(b * 255.0, 0.0, 255.0));
    let rgba = ri | (gi << 8u) | (bi << 16u) | (255u << 24u);

    // Output to cropped buffer
    let outIdx = frameIdx * params.cropSize * params.cropSize + outY * params.cropSize + outX;
    output[outIdx] = rgba;
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

    output[outIdx] = input[srcIdx];
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
    device.lost.then((info) => {
        console.error('WebGPU device lost:', info.message);
        device = null;
        queue = null;
        self.postMessage({ type: 'error', error: `GPU device lost: ${info.message}. Please reload the page.` });
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
        boundsPixelSize: batchSize * pixelCount * 4 * 4,  // 4 u32 per pixel
        reductionSize: batchSize * numWorkgroups * 2 * 4,
        momentsReductionSize: batchSize * numWorkgroups * 6 * 4,
        boundsReductionSize: batchSize * numWorkgroups * 4 * 4  // 4 u32 per workgroup
    };

    // Check if we can reuse cached buffers
    if (cachedAnalyzeBuffers && cachedAnalyzeConfig &&
        cachedAnalyzeConfig.pixelBufferSize >= requiredSizes.pixelBufferSize &&
        cachedAnalyzeConfig.momentsPixelSize >= requiredSizes.momentsPixelSize &&
        cachedAnalyzeConfig.boundsPixelSize >= requiredSizes.boundsPixelSize &&
        cachedAnalyzeConfig.reductionSize >= requiredSizes.reductionSize &&
        cachedAnalyzeConfig.momentsReductionSize >= requiredSizes.momentsReductionSize &&
        cachedAnalyzeConfig.boundsReductionSize >= requiredSizes.boundsReductionSize) {
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
    const boundsPixelSize = align4(Math.ceil(requiredSizes.boundsPixelSize * headroom));
    const reductionSize = align4(Math.ceil(requiredSizes.reductionSize * headroom));
    const momentsReductionSize = align4(Math.ceil(requiredSizes.momentsReductionSize * headroom));
    const boundsReductionSize = align4(Math.ceil(requiredSizes.boundsReductionSize * headroom));

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
        pixelBufferSize,
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

async function analyzeBatch(frames, width, height, bayerPattern, threshold) {
    if (!device || !queue) {
        throw new Error('WebGPU not initialized or device lost');
    }
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

    // Bounds calculation (planet detection)
    pass = encoder.beginComputePass();
    pass.setPipeline(boundsPipeline);
    pass.setBindGroup(0, boundsBindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16), batchSize);
    pass.end();

    // Bounds reduction
    pass = encoder.beginComputePass();
    pass.setPipeline(boundsReductionPipeline);
    pass.setBindGroup(0, boundsReductionBindGroup);
    pass.dispatchWorkgroups(numWorkgroups, batchSize, 1);
    pass.end();

    // Copy results for readback
    const reductionCopySize = batchSize * numWorkgroups * 2 * 4;
    const momentsCopySize = batchSize * numWorkgroups * 6 * 4;
    const boundsCopySize = batchSize * numWorkgroups * 4 * 4;
    const rgbaCopySize = batchSize * pixelCount * 4;

    encoder.copyBufferToBuffer(buffers.reductionBuffer, 0, buffers.reductionReadback, 0, reductionCopySize);
    encoder.copyBufferToBuffer(buffers.momentsReductionBuffer, 0, buffers.momentsReadback, 0, momentsCopySize);
    encoder.copyBufferToBuffer(buffers.boundsReductionBuffer, 0, buffers.boundsReadback, 0, boundsCopySize);
    encoder.copyBufferToBuffer(buffers.rgbaBuffer, 0, buffers.rgbaReadback, 0, rgbaCopySize);

    queue.submit([encoder.finish()]);

    // Read back results
    await buffers.reductionReadback.mapAsync(GPUMapMode.READ);
    await buffers.momentsReadback.mapAsync(GPUMapMode.READ);
    await buffers.boundsReadback.mapAsync(GPUMapMode.READ);
    await buffers.rgbaReadback.mapAsync(GPUMapMode.READ);

    const reductionData = new Float32Array(buffers.reductionReadback.getMappedRange().slice(0, reductionCopySize));
    const momentsData = new Float32Array(buffers.momentsReadback.getMappedRange().slice(0, momentsCopySize));
    const boundsData = new Uint32Array(buffers.boundsReadback.getMappedRange().slice(0, boundsCopySize));
    const rgbaData = new Uint8Array(buffers.rgbaReadback.getMappedRange().slice(0, rgbaCopySize));

    buffers.reductionReadback.unmap();
    buffers.momentsReadback.unmap();
    buffers.boundsReadback.unmap();
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

        // Extract RGBA for this frame
        const frameRgba = rgbaData.slice(i * pixelCount * 4, (i + 1) * pixelCount * 4);

        // Convert to Float32 (0.0-1.0) for 16-bit pipeline compatibility
        const float32Data = new Float32Array(frameRgba.length);
        for (let j = 0; j < frameRgba.length; j++) {
            float32Data[j] = frameRgba[j] / 255.0;
        }

        results.push({
            sharpness,
            circularity,
            bounds,
            rgbaBuffer: frameRgba.buffer.slice(frameRgba.byteOffset, frameRgba.byteOffset + frameRgba.byteLength),
            float32Buffer: float32Data.buffer
        });
    }

    // Buffers are cached and reused - no cleanup here
    return results;
}

// Cached buffers for crop+analyze
let cachedCropBuffers = null;
let cachedCropConfig = null;

/**
 * Get or create buffers for crop+analyze operation
 */
function getCropAnalyzeBuffers(batchSize, srcWidth, srcHeight, cropSize) {
    const srcPixelCount = srcWidth * srcHeight;
    const cropPixelCount = cropSize * cropSize;
    const numWorkgroups = Math.ceil(cropPixelCount / 256);

    const requiredSizes = {
        inputSize: batchSize * srcPixelCount * 4,       // Raw Bayer (u32 per pixel)
        centersSize: batchSize * 8,                     // 2 floats per frame (x, y)
        croppedRgbaSize: batchSize * cropPixelCount * 4, // Cropped RGBA output
        graySize: batchSize * cropPixelCount * 4,       // Grayscale float
        laplacianSize: batchSize * cropPixelCount * 4,
        laplacianSqSize: batchSize * cropPixelCount * 4,
        reductionSize: batchSize * numWorkgroups * 8,
        momentsSize: batchSize * cropPixelCount * 6 * 4,      // 6 floats per pixel
        momentsReductionSize: batchSize * numWorkgroups * 6 * 4  // 6 floats per workgroup
    };

    // Validate cache - check sizes that determine buffer requirements
    // graySize, laplacianSize, laplacianSqSize all equal croppedRgbaSize so one check covers them
    if (cachedCropBuffers && cachedCropConfig &&
        cachedCropConfig.inputSize >= requiredSizes.inputSize &&
        cachedCropConfig.croppedRgbaSize >= requiredSizes.croppedRgbaSize &&
        cachedCropConfig.momentsSize >= requiredSizes.momentsSize &&
        cachedCropConfig.reductionSize >= requiredSizes.reductionSize &&
        cachedCropConfig.momentsReductionSize >= requiredSizes.momentsReductionSize) {
        return cachedCropBuffers;
    }

    // Cleanup old buffers
    if (cachedCropBuffers) {
        Object.values(cachedCropBuffers).forEach(buf => {
            if (buf && buf.destroy) buf.destroy();
        });
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
        centersBuffer: device.createBuffer({
            size: requiredSizes.centersSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        croppedRgbaBuffer: device.createBuffer({
            size: requiredSizes.croppedRgbaSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        grayBuffer: device.createBuffer({
            size: requiredSizes.graySize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        }),
        laplacianBuffer: device.createBuffer({
            size: requiredSizes.laplacianSize,
            usage: GPUBufferUsage.STORAGE
        }),
        laplacianSqBuffer: device.createBuffer({
            size: requiredSizes.laplacianSqSize,
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
        croppedReadbackBuffer: device.createBuffer({
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

    cachedCropConfig = requiredSizes;
    return cachedCropBuffers;
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
 */
async function cropAndAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, centers, bayerPattern, threshold = 0.1, metadataOnly = false) {
    if (!device || !queue) {
        throw new Error('WebGPU not initialized or device lost');
    }
    const batchSize = frames.length;
    const srcPixelCount = srcWidth * srcHeight;
    const cropPixelCount = cropSize * cropSize;
    const numWorkgroups = Math.ceil(cropPixelCount / 256);

    const buffers = getCropAnalyzeBuffers(batchSize, srcWidth, srcHeight, cropSize);

    // Upload centers
    const centersData = new Float32Array(batchSize * 2);
    for (let i = 0; i < batchSize; i++) {
        centersData[i * 2] = centers[i].x;
        centersData[i * 2 + 1] = centers[i].y;
    }
    queue.writeBuffer(buffers.centersBuffer, 0, centersData);

    // Set crop params
    const cropParams = new Uint32Array([srcWidth, srcHeight, cropSize, bayerPattern >= 0 ? bayerPattern : 0, batchSize, 0, 0, 0]);
    queue.writeBuffer(buffers.paramsBuffer, 0, cropParams);

    const needsDemosaic = bayerPattern >= 0;

    if (needsDemosaic) {
        // Upload Bayer data
        const bayerData = new Uint32Array(batchSize * srcPixelCount);
        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const offset = i * srcPixelCount;
            if (frame.data instanceof Uint16Array) {
                for (let j = 0; j < srcPixelCount; j++) {
                    bayerData[offset + j] = frame.data[j];
                }
            } else {
                // 8-bit data, scale up
                for (let j = 0; j < srcPixelCount; j++) {
                    bayerData[offset + j] = frame.data[j] * 257;
                }
            }
        }
        queue.writeBuffer(buffers.inputBuffer, 0, bayerData);

        // Run demosaic+crop
        const demosaicCropBindGroup = device.createBindGroup({
            layout: demosaicCropPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: buffers.paramsBuffer } },
                { binding: 1, resource: { buffer: buffers.inputBuffer } },
                { binding: 2, resource: { buffer: buffers.centersBuffer } },
                { binding: 3, resource: { buffer: buffers.croppedRgbaBuffer } }
            ]
        });

        let encoder = device.createCommandEncoder();
        let pass = encoder.beginComputePass();
        pass.setPipeline(demosaicCropPipeline);
        pass.setBindGroup(0, demosaicCropBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();
        queue.submit([encoder.finish()]);
    } else {
        // RGBA input - upload directly and run crop-only
        const rgbaData = new Uint32Array(batchSize * srcPixelCount);
        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const offset = i * srcPixelCount;
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

            // Pack RGBA bytes into u32
            for (let j = 0; j < srcPixelCount; j++) {
                rgbaData[offset + j] = src[j*4] | (src[j*4+1] << 8) | (src[j*4+2] << 16) | (src[j*4+3] << 24);
            }
        }
        queue.writeBuffer(buffers.inputBuffer, 0, rgbaData);

        // Run RGBA crop
        const rgbaCropBindGroup = device.createBindGroup({
            layout: rgbaCropPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: buffers.paramsBuffer } },
                { binding: 1, resource: { buffer: buffers.inputBuffer } },
                { binding: 2, resource: { buffer: buffers.centersBuffer } },
                { binding: 3, resource: { buffer: buffers.croppedRgbaBuffer } }
            ]
        });

        let encoder = device.createCommandEncoder();
        let pass = encoder.beginComputePass();
        pass.setPipeline(rgbaCropPipeline);
        pass.setBindGroup(0, rgbaCropBindGroup);
        pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
        pass.end();
        queue.submit([encoder.finish()]);
    }

    // Now analyze the cropped frames
    // Grayscale params for cropped size
    queue.writeBuffer(buffers.grayParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, 0]));
    queue.writeBuffer(buffers.reductionParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, cropPixelCount]));

    // Moments params with threshold
    const momentsParamsData = new ArrayBuffer(16);
    new Uint32Array(momentsParamsData, 0, 3).set([cropSize, cropSize, batchSize]);
    new Float32Array(momentsParamsData, 12, 1).set([threshold]);
    queue.writeBuffer(buffers.momentsParamsBuffer, 0, momentsParamsData);

    // Grayscale
    const grayBindGroup = device.createBindGroup({
        layout: grayscalePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.grayParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.croppedRgbaBuffer } },
            { binding: 2, resource: { buffer: buffers.grayBuffer } }
        ]
    });

    encoder = device.createCommandEncoder();
    pass = encoder.beginComputePass();
    pass.setPipeline(grayscalePipeline);
    pass.setBindGroup(0, grayBindGroup);
    pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
    pass.end();
    queue.submit([encoder.finish()]);

    // Laplacian
    const lapBindGroup = device.createBindGroup({
        layout: laplacianPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.grayParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.grayBuffer } },
            { binding: 2, resource: { buffer: buffers.laplacianBuffer } },
            { binding: 3, resource: { buffer: buffers.laplacianSqBuffer } }
        ]
    });

    encoder = device.createCommandEncoder();
    pass = encoder.beginComputePass();
    pass.setPipeline(laplacianPipeline);
    pass.setBindGroup(0, lapBindGroup);
    pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
    pass.end();
    queue.submit([encoder.finish()]);

    // Reduction for sharpness
    const reduceBindGroup = device.createBindGroup({
        layout: reductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.laplacianBuffer } },
            { binding: 2, resource: { buffer: buffers.laplacianSqBuffer } },
            { binding: 3, resource: { buffer: buffers.reductionBuffer } }
        ]
    });

    encoder = device.createCommandEncoder();
    pass = encoder.beginComputePass();
    pass.setPipeline(reductionPipeline);
    pass.setBindGroup(0, reduceBindGroup);
    // Fix: shader uses wid.y for frameIdx, so batchSize goes in Y dimension
    pass.dispatchWorkgroups(numWorkgroups, batchSize, 1);
    pass.end();
    queue.submit([encoder.finish()]);

    // Moments
    const momentsBindGroup = device.createBindGroup({
        layout: momentsPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.momentsParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.grayBuffer } },
            { binding: 2, resource: { buffer: buffers.momentsBuffer } }
        ]
    });

    encoder = device.createCommandEncoder();
    pass = encoder.beginComputePass();
    pass.setPipeline(momentsPipeline);
    pass.setBindGroup(0, momentsBindGroup);
    pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
    pass.end();
    queue.submit([encoder.finish()]);

    // Moments reduction
    const momentsReduceBindGroup = device.createBindGroup({
        layout: momentsReductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: buffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: buffers.momentsBuffer } },
            { binding: 2, resource: { buffer: buffers.momentsReductionBuffer } }
        ]
    });

    encoder = device.createCommandEncoder();
    pass = encoder.beginComputePass();
    pass.setPipeline(momentsReductionPipeline);
    pass.setBindGroup(0, momentsReduceBindGroup);
    // Fix: shader uses wid.y for frameIdx, so batchSize goes in Y dimension
    pass.dispatchWorkgroups(numWorkgroups, batchSize, 1);
    pass.end();

    // Copy results to readback buffers
    encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffers.reductionBuffer, 0, buffers.readbackBuffer, 0, batchSize * numWorkgroups * 8);
    encoder.copyBufferToBuffer(buffers.momentsReductionBuffer, 0, buffers.momentsReadbackBuffer, 0, batchSize * numWorkgroups * 6 * 4);
    encoder.copyBufferToBuffer(buffers.croppedRgbaBuffer, 0, buffers.croppedReadbackBuffer, 0, batchSize * cropPixelCount * 4);
    queue.submit([encoder.finish()]);

    // Read back results
    await buffers.readbackBuffer.mapAsync(GPUMapMode.READ);
    const reductionData = new Float32Array(buffers.readbackBuffer.getMappedRange().slice(0));
    buffers.readbackBuffer.unmap();

    await buffers.momentsReadbackBuffer.mapAsync(GPUMapMode.READ);
    const momentsData = new Float32Array(buffers.momentsReadbackBuffer.getMappedRange().slice(0));
    buffers.momentsReadbackBuffer.unmap();

    await buffers.croppedReadbackBuffer.mapAsync(GPUMapMode.READ);
    const croppedData = new Uint8Array(buffers.croppedReadbackBuffer.getMappedRange().slice(0));
    buffers.croppedReadbackBuffer.unmap();

    // Process results
    const results = [];
    for (let i = 0; i < batchSize; i++) {
        // Sum sharpness from workgroups
        let sumLap = 0, sumLapSq = 0;
        for (let w = 0; w < numWorkgroups; w++) {
            const idx = (i * numWorkgroups + w) * 2;
            sumLap += reductionData[idx];
            sumLapSq += reductionData[idx + 1];
        }
        // Tenengrad sharpness = mean of gradient magnitude squared
        // Scale by 255² = 65025 to match CPU which uses 0-255 grayscale (GPU uses 0-1)
        const sharpness = (sumLap / cropPixelCount) * 65025;

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

        // Extract cropped RGBA for this frame (8-bit)
        const frameRgba = croppedData.slice(i * cropPixelCount * 4, (i + 1) * cropPixelCount * 4);

        if (metadataOnly) {
            // Pass 1: Return only metadata + 8-bit data for preview
            results.push({
                sharpness,
                circularity,
                index: frames[i].index,
                uint8Buffer: frameRgba.buffer, // 8-bit for preview
                width: cropSize,
                height: cropSize
            });
        } else {
            // Pass 2 / legacy: Convert to Float32 (0.0-1.0) for 16-bit stacking pipeline
            const float32Data = new Float32Array(frameRgba.length);
            for (let j = 0; j < frameRgba.length; j++) {
                float32Data[j] = frameRgba[j] / 255.0;
            }
            results.push({
                sharpness,
                circularity,
                index: frames[i].index,
                float32Buffer: float32Data.buffer,
                width: cropSize,
                height: cropSize
            });
        }
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
 */
async function detectCropAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold = 0.1, metadataOnly = false) {
    if (!device || !queue) {
        throw new Error('WebGPU not initialized or device lost');
    }
    const batchSize = frames.length;
    const srcPixelCount = srcWidth * srcHeight;
    const cropPixelCount = cropSize * cropSize;
    const numWorkgroupsFull = Math.ceil(srcPixelCount / 256);
    const numWorkgroupsCrop = Math.ceil(cropPixelCount / 256);

    // Get buffers for full-frame analysis
    const analyzeBuffers = getAnalyzeBuffers(batchSize, srcWidth, srcHeight);

    // Get buffers for cropped analysis (reuses some, creates others)
    const cropBuffers = getCropAnalyzeBuffers(batchSize, srcWidth, srcHeight, cropSize);

    const needsDemosaic = bayerPattern >= 0;

    // ===== STEP 1: Upload raw data and demosaic to full RGBA =====
    if (needsDemosaic) {
        const bayerData = new Uint32Array(batchSize * srcPixelCount);
        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const offset = i * srcPixelCount;
            if (frame.data instanceof Uint16Array) {
                for (let j = 0; j < srcPixelCount; j++) {
                    bayerData[offset + j] = frame.data[j];
                }
            } else {
                for (let j = 0; j < srcPixelCount; j++) {
                    bayerData[offset + j] = frame.data[j] * 257;
                }
            }
        }
        queue.writeBuffer(analyzeBuffers.inputBuffer, 0, bayerData);
        queue.writeBuffer(analyzeBuffers.paramsBuffer, 0, new Uint32Array([srcWidth, srcHeight, batchSize, bayerPattern]));

        const demosaicBindGroup = device.createBindGroup({
            layout: demosaicPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: analyzeBuffers.paramsBuffer } },
                { binding: 1, resource: { buffer: analyzeBuffers.inputBuffer } },
                { binding: 2, resource: { buffer: analyzeBuffers.rgbaBuffer } }
            ]
        });

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(demosaicPipeline);
        pass.setBindGroup(0, demosaicBindGroup);
        pass.dispatchWorkgroups(Math.ceil(srcWidth / 16), Math.ceil(srcHeight / 16), batchSize);
        pass.end();
        queue.submit([encoder.finish()]);
    } else {
        // RGBA input
        const rgbaData = new Uint32Array(batchSize * srcPixelCount);
        for (let i = 0; i < batchSize; i++) {
            const frame = frames[i];
            const offset = i * srcPixelCount;
            let src = frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray
                ? frame.data
                : new Uint8Array(frame.data.buffer || frame.data);
            for (let j = 0; j < srcPixelCount; j++) {
                rgbaData[offset + j] = src[j*4] | (src[j*4+1] << 8) | (src[j*4+2] << 16) | (src[j*4+3] << 24);
            }
        }
        queue.writeBuffer(analyzeBuffers.rgbaBuffer, 0, rgbaData);
    }

    // ===== STEP 2: Grayscale + bounds detection on full frame =====
    queue.writeBuffer(analyzeBuffers.paramsBuffer, 0, new Uint32Array([srcWidth, srcHeight, batchSize, 0]));
    queue.writeBuffer(analyzeBuffers.reductionParamsBuffer, 0, new Uint32Array([srcWidth, srcHeight, batchSize, srcPixelCount]));

    const boundsParamsData = new ArrayBuffer(16);
    new Uint32Array(boundsParamsData, 0, 3).set([srcWidth, srcHeight, batchSize]);
    new Float32Array(boundsParamsData, 12, 1).set([threshold]);
    queue.writeBuffer(analyzeBuffers.boundsParamsBuffer, 0, boundsParamsData);

    const grayBindGroup = device.createBindGroup({
        layout: grayscalePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: analyzeBuffers.paramsBuffer } },
            { binding: 1, resource: { buffer: analyzeBuffers.rgbaBuffer } },
            { binding: 2, resource: { buffer: analyzeBuffers.grayBuffer } }
        ]
    });

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
    let pass = encoder.beginComputePass();
    pass.setPipeline(grayscalePipeline);
    pass.setBindGroup(0, grayBindGroup);
    pass.dispatchWorkgroups(Math.ceil(srcWidth / 16), Math.ceil(srcHeight / 16), batchSize);
    pass.end();

    pass = encoder.beginComputePass();
    pass.setPipeline(boundsPipeline);
    pass.setBindGroup(0, boundsBindGroup);
    pass.dispatchWorkgroups(Math.ceil(srcWidth / 16), Math.ceil(srcHeight / 16), batchSize);
    pass.end();

    pass = encoder.beginComputePass();
    pass.setPipeline(boundsReductionPipeline);
    pass.setBindGroup(0, boundsReductionBindGroup);
    pass.dispatchWorkgroups(numWorkgroupsFull, batchSize, 1);
    pass.end();

    encoder.copyBufferToBuffer(analyzeBuffers.boundsReductionBuffer, 0, analyzeBuffers.boundsReadback, 0, batchSize * numWorkgroupsFull * 16);
    queue.submit([encoder.finish()]);

    // ===== STEP 3: Read back bounds and compute centers =====
    await analyzeBuffers.boundsReadback.mapAsync(GPUMapMode.READ);
    const boundsData = new Uint32Array(analyzeBuffers.boundsReadback.getMappedRange().slice(0));
    analyzeBuffers.boundsReadback.unmap();

    const centers = [];
    const validFrameIndices = [];
    const bounds = [];

    for (let i = 0; i < batchSize; i++) {
        let minX = srcWidth, minY = srcHeight, maxX = 0, maxY = 0;
        for (let w = 0; w < numWorkgroupsFull; w++) {
            const idx = (i * numWorkgroupsFull + w) * 4;
            if (boundsData[idx] < minX) minX = boundsData[idx];
            if (boundsData[idx + 1] < minY) minY = boundsData[idx + 1];
            if (boundsData[idx + 2] > maxX) maxX = boundsData[idx + 2];
            if (boundsData[idx + 3] > maxY) maxY = boundsData[idx + 3];
        }

        if (maxX > minX && maxY > minY) {
            const centroidX = (minX + maxX) / 2;
            const centroidY = (minY + maxY) / 2;
            const bboxWidth = maxX - minX;
            const bboxHeight = maxY - minY;
            // Simple circularity from bounding box aspect ratio (1.0 = circle, lower = elongated)
            const circularity = Math.min(bboxWidth, bboxHeight) / Math.max(bboxWidth, bboxHeight);
            centers.push({ x: centroidX, y: centroidY });
            validFrameIndices.push(i);
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

    // ===== STEP 4: Crop from demosaiced RGBA using detected centers =====
    // Upload centers for valid frames
    const centersData = new Float32Array(batchSize * 2);
    for (let i = 0; i < batchSize; i++) {
        if (centers[i]) {
            centersData[i * 2] = centers[i].x;
            centersData[i * 2 + 1] = centers[i].y;
        } else {
            centersData[i * 2] = srcWidth / 2;
            centersData[i * 2 + 1] = srcHeight / 2;
        }
    }
    queue.writeBuffer(cropBuffers.centersBuffer, 0, centersData);

    // Set params for RGBA crop (reuse from analyzeBuffers.rgbaBuffer)
    const cropParams = new Uint32Array([srcWidth, srcHeight, cropSize, 0, batchSize, 0, 0, 0]);
    queue.writeBuffer(cropBuffers.paramsBuffer, 0, cropParams);

    // Crop from the already-demosaiced rgbaBuffer
    const rgbaCropBindGroup = device.createBindGroup({
        layout: rgbaCropPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: cropBuffers.paramsBuffer } },
            { binding: 1, resource: { buffer: analyzeBuffers.rgbaBuffer } },  // Source: full demosaiced
            { binding: 2, resource: { buffer: cropBuffers.centersBuffer } },
            { binding: 3, resource: { buffer: cropBuffers.croppedRgbaBuffer } }  // Dest: cropped
        ]
    });

    encoder = device.createCommandEncoder();
    pass = encoder.beginComputePass();
    pass.setPipeline(rgbaCropPipeline);
    pass.setBindGroup(0, rgbaCropBindGroup);
    pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
    pass.end();
    queue.submit([encoder.finish()]);

    // ===== STEP 5: Sharpness calculation on cropped =====
    queue.writeBuffer(cropBuffers.grayParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, 0]));
    queue.writeBuffer(cropBuffers.reductionParamsBuffer, 0, new Uint32Array([cropSize, cropSize, batchSize, cropPixelCount]));

    const cropGrayBindGroup = device.createBindGroup({
        layout: grayscalePipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: cropBuffers.grayParamsBuffer } },
            { binding: 1, resource: { buffer: cropBuffers.croppedRgbaBuffer } },
            { binding: 2, resource: { buffer: cropBuffers.grayBuffer } }
        ]
    });

    const lapBindGroup = device.createBindGroup({
        layout: laplacianPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: cropBuffers.grayParamsBuffer } },
            { binding: 1, resource: { buffer: cropBuffers.grayBuffer } },
            { binding: 2, resource: { buffer: cropBuffers.laplacianBuffer } },
            { binding: 3, resource: { buffer: cropBuffers.laplacianSqBuffer } }
        ]
    });

    const reductionBindGroup = device.createBindGroup({
        layout: reductionPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: cropBuffers.reductionParamsBuffer } },
            { binding: 1, resource: { buffer: cropBuffers.laplacianBuffer } },
            { binding: 2, resource: { buffer: cropBuffers.laplacianSqBuffer } },
            { binding: 3, resource: { buffer: cropBuffers.reductionBuffer } }
        ]
    });

    encoder = device.createCommandEncoder();

    pass = encoder.beginComputePass();
    pass.setPipeline(grayscalePipeline);
    pass.setBindGroup(0, cropGrayBindGroup);
    pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
    pass.end();

    pass = encoder.beginComputePass();
    pass.setPipeline(laplacianPipeline);
    pass.setBindGroup(0, lapBindGroup);
    pass.dispatchWorkgroups(Math.ceil(cropSize / 16), Math.ceil(cropSize / 16), batchSize);
    pass.end();

    pass = encoder.beginComputePass();
    pass.setPipeline(reductionPipeline);
    pass.setBindGroup(0, reductionBindGroup);
    pass.dispatchWorkgroups(numWorkgroupsCrop, batchSize, 1);
    pass.end();

    // Copy results for readback
    encoder.copyBufferToBuffer(cropBuffers.reductionBuffer, 0, cropBuffers.readbackBuffer, 0, batchSize * numWorkgroupsCrop * 8);
    encoder.copyBufferToBuffer(cropBuffers.croppedRgbaBuffer, 0, cropBuffers.croppedReadbackBuffer, 0, batchSize * cropPixelCount * 4);
    queue.submit([encoder.finish()]);

    // ===== STEP 6: Read back results =====
    await Promise.all([
        cropBuffers.readbackBuffer.mapAsync(GPUMapMode.READ),
        cropBuffers.croppedReadbackBuffer.mapAsync(GPUMapMode.READ)
    ]);

    const reductionData = new Float32Array(cropBuffers.readbackBuffer.getMappedRange().slice(0));
    const croppedData = new Uint8Array(cropBuffers.croppedReadbackBuffer.getMappedRange().slice(0));
    cropBuffers.readbackBuffer.unmap();
    cropBuffers.croppedReadbackBuffer.unmap();

    // Build results
    const results = [];
    for (let i = 0; i < batchSize; i++) {
        let tenengradSum = 0;
        for (let w = 0; w < numWorkgroupsCrop; w++) {
            tenengradSum += reductionData[(i * numWorkgroupsCrop + w) * 2];
        }
        const sharpness = (tenengradSum / cropPixelCount) * 65025;

        const frameRgba = croppedData.slice(i * cropPixelCount * 4, (i + 1) * cropPixelCount * 4);

        if (metadataOnly) {
            results.push({
                sharpness,
                circularity: bounds[i]?.circularity || 0,
                index: frames[i].index,
                bounds: bounds[i],
                centerX: centers[i]?.x,
                centerY: centers[i]?.y,
                uint8Buffer: frameRgba.buffer,
                width: cropSize,
                height: cropSize
            });
        } else {
            const float32Data = new Float32Array(frameRgba.length);
            for (let j = 0; j < frameRgba.length; j++) {
                float32Data[j] = frameRgba[j] / 255.0;
            }
            results.push({
                sharpness,
                circularity: bounds[i]?.circularity || 0,
                index: frames[i].index,
                bounds: bounds[i],
                centerX: centers[i]?.x,
                centerY: centers[i]?.y,
                float32Buffer: float32Data.buffer,
                width: cropSize,
                height: cropSize
            });
        }
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
        { id: 'COLOR_BayerBG2RGB', pattern: 0 },  // RGGB
        { id: 'COLOR_BayerRG2RGB', pattern: 1 },  // BGGR
        { id: 'COLOR_BayerGR2RGB', pattern: 3 },  // GBRG
        { id: 'COLOR_BayerGB2RGB', pattern: 2 },  // GRBG
        { id: 'MONO', pattern: -1 }
    ];

    const pixelCount = srcWidth * srcHeight;

    // Convert raw data to Uint32Array (handles both 8-bit and 16-bit)
    let inputData;
    if (pixelDepth > 8) {
        const src = new Uint16Array(rawData);
        inputData = new Uint32Array(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
            inputData[i] = src[i];
        }
    } else {
        const src = new Uint8Array(rawData);
        inputData = new Uint32Array(pixelCount);
        for (let i = 0; i < pixelCount; i++) {
            // Scale 8-bit to 16-bit range for consistent shader processing
            inputData[i] = src[i] << 8;
        }
    }

    // Create GPU buffers
    const inputBuffer = device.createBuffer({
        size: pixelCount * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    queue.writeBuffer(inputBuffer, 0, inputData);

    const outputBuffer = device.createBuffer({
        size: pixelCount * 4,  // RGBA output
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    const readbackBuffer = device.createBuffer({
        size: pixelCount * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    const paramsBuffer = device.createBuffer({
        size: 16,
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
            // Demosaic with GPU
            queue.writeBuffer(paramsBuffer, 0, new Uint32Array([srcWidth, srcHeight, 1, pattern]));

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
            encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, pixelCount * 4);
            queue.submit([encoder.finish()]);

            await readbackBuffer.mapAsync(GPUMapMode.READ);
            fullRgba = new Uint8ClampedArray(readbackBuffer.getMappedRange().slice(0));
            readbackBuffer.unmap();
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

    // Find the result for our pattern
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

    if (type === 'analyze-batch') {
        if (!isReady) {
            self.postMessage({ type: 'analyze-error', error: 'Not initialized' });
            return;
        }

        const { frames, width, height, bayerPattern, threshold, requestId } = e.data;

        try {
            const results = await analyzeBatch(frames, width, height, bayerPattern, threshold);
            self.postMessage({ type: 'analyze-result', requestId, results },
                results.map(r => r.float32Buffer));
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

        const { frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold, requestId, metadataOnly } = e.data;

        try {
            const results = await detectCropAnalyzeBatch(frames, srcWidth, srcHeight, cropSize, bayerPattern, threshold, metadataOnly);
            // Transfer uint8Buffer or float32Buffer depending on mode
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
        self.postMessage({ type: 'cleanup-done' });
        return;
    }
});

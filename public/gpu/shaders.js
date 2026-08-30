/**
 * WGSL Compute Shaders for WebGPU Frame Analysis
 * Extracted from webgpu_analyze_worker.js for modularity
 */

// Bilinear-only demosaic shader for analysis (fast)
export const demosaicBilinearShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    bayerPattern: u32,  // 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
    _reserved: u32,     // unused (was useVng), kept for uniform buffer layout compatibility
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

// Bilinear interpolation for fast demosaic
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

    // Bilinear interpolation (fast)
    let rgb = bilinearInterpolate(frameIdx, ix, iy, bx, by, pattern);

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

// VNG-only demosaic shader for stacking (no bilinear option, always VNG quality)
export const demosaicVngShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    bayerPattern: u32,  // 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
    bitDepth: u32,      // 8 or 16
    scale: f32,         // stretch scale for 16-bit (1.0 = no stretch)
    _pad1: u32,
    _pad2: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;  // Float32 RGBA

fn getBayerValue(frameIdx: u32, x: u32, y: u32) -> f32 {
    let pixelIdx = frameIdx * params.width * params.height + y * params.width + x;
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
    } else { // GBRG (pattern == 3)
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
    let rgb = vngInterpolate(frameIdx, i32(x), i32(y), bx, by, params.bayerPattern);

    let outIdx = frameIdx * params.width * params.height + y * params.width + x;
    // Output as Float32 RGBA (4 u32s per pixel via bitcast)
    let baseIdx = outIdx * 4u;
    output[baseIdx] = bitcast<u32>(rgb.x);
    output[baseIdx + 1u] = bitcast<u32>(rgb.y);
    output[baseIdx + 2u] = bitcast<u32>(rgb.z);
    output[baseIdx + 3u] = bitcast<u32>(1.0);
}
`;

// VNG demosaic + crop shader for stacking
// Reads from full-size source, outputs cropped region with VNG quality
// Also outputs packed u8 grayscale for template matching
export const demosaicVngCropShader = `
struct Params {
    srcWidth: u32,
    srcHeight: u32,
    cropSize: u32,
    bayerPattern: u32,  // 0=RGGB, 1=BGGR, 2=GRBG, 3=GBRG
    batchSize: u32,
    bitDepth: u32,      // 8 or 16
    scale: f32,         // stretch scale for 16-bit
    _pad: u32,
}

struct CropCenter {
    x: f32,
    y: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read> centers: array<CropCenter>;
@group(0) @binding(3) var<storage, read_write> output: array<u32>;  // Float32 RGBA via bitcast
@group(0) @binding(4) var<storage, read_write> grayOutput: array<atomic<u32>>;  // Packed u8 grayscale

fn getBayerValue(frameIdx: u32, x: u32, y: u32) -> f32 {
    let pixelIdx = frameIdx * params.srcWidth * params.srcHeight + y * params.srcWidth + x;
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

fn sampleBayer(frameIdx: u32, x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(params.srcWidth) - 1);
    let cy = clamp(y, 0, i32(params.srcHeight) - 1);
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
    } else { // GBRG (pattern == 3)
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

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let outX = gid.x;
    let outY = gid.y;
    let frameIdx = gid.z;

    if (outX >= params.cropSize || outY >= params.cropSize || frameIdx >= params.batchSize) {
        return;
    }

    // Calculate source coordinates from crop center
    // NOTE: No even-alignment (& ~1) here. The VNG demosaic uses absolute source coordinates
    // (bx = x % 2) so it handles odd crop starts correctly. Allowing odd starts means the
    // Bayer residual phase varies across frames, causing it to cancel during stacking.
    // Forcing even alignment locked all frames to the same phase, reinforcing the pattern.
    let center = centers[frameIdx];
    let halfSize = f32(params.cropSize) / 2.0;
    let cropStartX = i32(floor(center.x - halfSize));
    let cropStartY = i32(floor(center.y - halfSize));

    let srcX = cropStartX + i32(outX);
    let srcY = cropStartY + i32(outY);

    // Clamp to source bounds
    let x = u32(clamp(srcX, 0, i32(params.srcWidth) - 1));
    let y = u32(clamp(srcY, 0, i32(params.srcHeight) - 1));

    // Bayer phase from absolute source position - correct regardless of crop start parity
    let bx = x % 2u;
    let by = y % 2u;
    let rgb = vngInterpolate(frameIdx, i32(x), i32(y), bx, by, params.bayerPattern);

    let outIdx = frameIdx * params.cropSize * params.cropSize + outY * params.cropSize + outX;

    // Output Float32 RGBA via bitcast
    let baseIdx = outIdx * 4u;
    output[baseIdx] = bitcast<u32>(rgb.x);
    output[baseIdx + 1u] = bitcast<u32>(rgb.y);
    output[baseIdx + 2u] = bitcast<u32>(rgb.z);
    output[baseIdx + 3u] = bitcast<u32>(1.0);

    // Output packed u8 grayscale for template matching
    let gray = u32(clamp((0.299 * rgb.x + 0.587 * rgb.y + 0.114 * rgb.z) * 255.0, 0.0, 255.0));
    let grayPackedIdx = outIdx >> 2u;
    let grayByteOffset = (outIdx & 3u) << 3u;
    atomicOr(&grayOutput[grayPackedIdx], gray << grayByteOffset);
}
`;

// Grayscale conversion shader
export const grayscaleShader = `
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

// Grayscale conversion shader for 16-bit Float32 RGBA input
export const grayscaleFloat32Shader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;  // Float32 RGBA (4 u32 per pixel, bitcast to f32)
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
    let baseIdx = idx * 4u;

    // Read Float32 RGBA (stored as bitcast u32)
    let r = bitcast<f32>(input[baseIdx]);
    let g = bitcast<f32>(input[baseIdx + 1u]);
    let b = bitcast<f32>(input[baseIdx + 2u]);

    // Standard grayscale weights
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    output[idx] = gray;
}
`;

// RGBA to u8 grayscale shader for template matching
// Input: Float32 RGBA (0.0-1.0), Output: u8 grayscale (one byte per pixel)
// 2×2 box-filter downscale from packed-u8 RGBA (input: u32 array, 4 bytes/px)
// to packed-u8 RGBA output at half width×half height. Used by the low-res
// crop-detect path so momentsPixelBuffer at src/2 × src/2 fits under the
// device's maxStorageBufferBindingSize for 4000×3000+ smartphone photos.
// Output centroid/bounds coordinates are scaled ×2 back to source space in
// the analyzeBatch result-building code.
export const rgbaDownscale2xShader = `
struct Params {
    srcWidth: u32,
    srcHeight: u32,
    dstWidth: u32,
    dstHeight: u32,
    batchSize: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;         // packed RGBA, 4 B/px
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;   // packed RGBA, 4 B/px

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let dx = gid.x;
    let dy = gid.y;
    let f = gid.z;
    if (dx >= params.dstWidth || dy >= params.dstHeight || f >= params.batchSize) {
        return;
    }

    // 2×2 source block; clamp against odd source dimensions.
    let sx0 = dx * 2u;
    let sy0 = dy * 2u;
    let srcStride = params.srcWidth;
    let srcFrameStride = params.srcWidth * params.srcHeight;

    var rSum: u32 = 0u;
    var gSum: u32 = 0u;
    var bSum: u32 = 0u;
    var aSum: u32 = 0u;
    var cnt: u32 = 0u;
    for (var oy: u32 = 0u; oy < 2u; oy = oy + 1u) {
        for (var ox: u32 = 0u; ox < 2u; ox = ox + 1u) {
            let sx = sx0 + ox;
            let sy = sy0 + oy;
            if (sx < params.srcWidth && sy < params.srcHeight) {
                let sIdx = f * srcFrameStride + sy * srcStride + sx;
                let packed = src[sIdx];
                rSum = rSum + (packed & 0xFFu);
                gSum = gSum + ((packed >> 8u) & 0xFFu);
                bSum = bSum + ((packed >> 16u) & 0xFFu);
                aSum = aSum + ((packed >> 24u) & 0xFFu);
                cnt = cnt + 1u;
            }
        }
    }
    let r = rSum / cnt;
    let g = gSum / cnt;
    let b = bSum / cnt;
    let a = aSum / cnt;
    let dIdx = f * params.dstWidth * params.dstHeight + dy * params.dstWidth + dx;
    dst[dIdx] = r | (g << 8u) | (b << 16u) | (a << 24u);
}
`;

export const rgbaToGrayU8Shader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> rgba: array<f32>;              // Float32 RGBA input
@group(0) @binding(2) var<storage, read_write> gray: array<atomic<u32>>; // u8 grayscale (packed, atomic for concurrent writes)

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let frameIdx = gid.z;

    if (x >= params.width || y >= params.height || frameIdx >= params.batchSize) {
        return;
    }

    let pixelIdx = frameIdx * params.width * params.height + y * params.width + x;
    let rgbaIdx = pixelIdx * 4u;

    let r = rgba[rgbaIdx];
    let g = rgba[rgbaIdx + 1u];
    let b = rgba[rgbaIdx + 2u];

    // Standard grayscale weights, scale to 0-255
    let grayVal = u32(clamp((0.299 * r + 0.587 * g + 0.114 * b) * 255.0, 0.0, 255.0));

    // Store as packed u32 (4 bytes per u32, little-endian)
    let storageIdx = pixelIdx >> 2u;
    let byteOffset = (pixelIdx & 3u) << 3u;
    atomicOr(&gray[storageIdx], grayVal << byteOffset);
}
`;

// Combined sharpness shader - computes both Tenengrad and Laplacian
export const tenengradShader = `
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

// Reduction shader - sums Tenengrad and Laplacian values across frame
export const reductionShader = `
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

// Final sharpness reduction - sums workgroup partial results into 2 floats per frame
export const sharpnessFinalShader = `
struct Params {
    numWorkgroups: u32,  // Number of workgroups from first reduction
    batchSize: u32,
    pixelCount: u32,     // For computing mean
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> partialSums: array<f32>;  // 2 floats per workgroup per frame
@group(0) @binding(2) var<storage, read_write> output: array<f32>;  // 2 floats per frame: [tenengrad, laplacian]

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let frameIdx = gid.x;
    if (frameIdx >= params.batchSize) {
        return;
    }

    // Sum all workgroup results for this frame
    var tenengradSum: f32 = 0.0;
    var laplacianSum: f32 = 0.0;

    for (var w = 0u; w < params.numWorkgroups; w++) {
        let idx = (frameIdx * params.numWorkgroups + w) * 2u;
        tenengradSum += partialSums[idx];
        laplacianSum += partialSums[idx + 1u];
    }

    // Scale and compute mean (matching CPU: scale by 65025, divide by pixelCount)
    let scale: f32 = 65025.0 / f32(params.pixelCount);
    let tenengradMean = tenengradSum * scale;
    let laplacianMean = laplacianSum * scale;

    // Output final values
    let outIdx = frameIdx * 2u;
    output[outIdx] = tenengradMean;
    output[outIdx + 1u] = laplacianMean;
}
`;

// 5x5 Gaussian blur shader - reduces noise before bounds detection
export const blurShader = `
struct Params {
    width: u32,
    height: u32,
    batchSize: u32,
    _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = i32(gid.x);
    let y = i32(gid.y);
    let frameIdx = gid.z;
    let w = i32(params.width);
    let h = i32(params.height);

    if (gid.x >= params.width || gid.y >= params.height || frameIdx >= params.batchSize) {
        return;
    }

    // 5x5 Gaussian kernel weights (sigma ≈ 1.0), same as CPU cv.GaussianBlur
    // Separable: [1, 4, 6, 4, 1] / 16 for each dimension
    var weights = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);

    var sum: f32 = 0.0;
    let frameOffset = i32(frameIdx) * w * h;

    for (var dy: i32 = -2; dy <= 2; dy++) {
        for (var dx: i32 = -2; dx <= 2; dx++) {
            let sx = clamp(x + dx, 0, w - 1);
            let sy = clamp(y + dy, 0, h - 1);
            let idx = frameOffset + sy * w + sx;
            let weight = weights[dx + 2] * weights[dy + 2];
            sum += input[idx] * weight;
        }
    }

    let outIdx = frameOffset + y * w + x;
    output[outIdx] = sum;
}
`;

// Bounding box shader - finds min/max x,y of bright pixels for planet detection
export const boundsShader = `
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
export const boundsReductionShader = `
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
export const centroidShader = `
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

// Moments shader - calculates image moments for circularity
export const momentsShader = `
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
export const momentsReductionShader = `
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

// Final moments shader - sums partial moments and computes circularity + centroid + tilt on GPU
export const circularityFinalShader = `
struct Params {
    numWorkgroups: u32,  // Number of workgroups from moments reduction
    batchSize: u32,
    defaultCenterX: f32,  // Fallback center if no bright pixels
    defaultCenterY: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> partialMoments: array<f32>;  // 6 floats per workgroup per frame
@group(0) @binding(2) var<storage, read_write> output: array<f32>;  // 4 floats per frame: [circ, cx, cy, tiltAngle]

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let frameIdx = gid.x;
    if (frameIdx >= params.batchSize) {
        return;
    }

    // Sum moments across all workgroups for this frame
    var m00: f32 = 0.0;
    var m10: f32 = 0.0;
    var m01: f32 = 0.0;
    var m20: f32 = 0.0;
    var m11: f32 = 0.0;
    var m02: f32 = 0.0;

    for (var w = 0u; w < params.numWorkgroups; w++) {
        let idx = (frameIdx * params.numWorkgroups + w) * 6u;
        m00 += partialMoments[idx];
        m10 += partialMoments[idx + 1u];
        m01 += partialMoments[idx + 2u];
        m20 += partialMoments[idx + 3u];
        m11 += partialMoments[idx + 4u];
        m02 += partialMoments[idx + 5u];
    }

    // Compute circularity, centroid, and tilt angle from moments
    var circ: f32 = 0.0;
    var tiltAngle: f32 = 0.0;
    var centroidX: f32 = params.defaultCenterX;
    var centroidY: f32 = params.defaultCenterY;

    if (m00 > 0.0) {
        centroidX = m10 / m00;
        centroidY = m01 / m00;

        // Central moments
        let mu20 = m20 / m00 - centroidX * centroidX;
        let mu02 = m02 / m00 - centroidY * centroidY;
        let mu11 = m11 / m00 - centroidX * centroidY;

        // Eigenvalues of covariance matrix
        let trace = mu20 + mu02;
        let det = mu20 * mu02 - mu11 * mu11;
        let discriminant = sqrt(max(0.0, trace * trace - 4.0 * det));
        let lambda1 = (trace + discriminant) / 2.0;
        let lambda2 = (trace - discriminant) / 2.0;

        // Circularity = ratio of eigenvalues (1 = perfect circle)
        if (lambda1 > 0.0) {
            circ = min(lambda2, lambda1) / max(lambda2, lambda1);
        }

        // Tilt angle from principal axis orientation (radians)
        tiltAngle = 0.5 * atan2(2.0 * mu11, mu20 - mu02);
    }

    let outIdx = frameIdx * 4u;
    output[outIdx] = circ;
    output[outIdx + 1u] = centroidX;
    output[outIdx + 2u] = centroidY;
    output[outIdx + 3u] = tiltAngle;
}
`;

// Grayscale-only demosaic shader - fast analysis without color output
export const demosaicGrayOnlyShader = `
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
    let gray = (sampleRaw(frameIdx, x, y) + sampleRaw(frameIdx, x+1u, y) +
                sampleRaw(frameIdx, x, y+1u) + sampleRaw(frameIdx, x+1u, y+1u)) * 0.25;

    let outIdx = frameIdx * params.width * params.height + y * params.width + x;
    grayOutput[outIdx] = gray;
}
`;

// Offset sharpness shader - reads from full-frame buffer with per-frame center offsets
export const offsetTenengradShader = `
struct Params {
    srcWidth: u32,
    srcHeight: u32,
    cropSize: u32,
    batchSize: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;
@group(0) @binding(2) var<storage, read> centers: array<f32>;
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

    let centerX = i32(centers[frameIdx * 2u]);
    let centerY = i32(centers[frameIdx * 2u + 1u]);
    let halfCrop = i32(params.cropSize / 2u);

    let srcX = centerX - halfCrop + i32(localX);
    let srcY = centerY - halfCrop + i32(localY);

    // Sobel X
    let gx = -1.0 * sampleGray(frameIdx, srcX-1, srcY-1) + 1.0 * sampleGray(frameIdx, srcX+1, srcY-1)
           + -2.0 * sampleGray(frameIdx, srcX-1, srcY)   + 2.0 * sampleGray(frameIdx, srcX+1, srcY)
           + -1.0 * sampleGray(frameIdx, srcX-1, srcY+1) + 1.0 * sampleGray(frameIdx, srcX+1, srcY+1);

    // Sobel Y
    let gy = -1.0 * sampleGray(frameIdx, srcX-1, srcY-1) - 2.0 * sampleGray(frameIdx, srcX, srcY-1) - 1.0 * sampleGray(frameIdx, srcX+1, srcY-1)
           +  1.0 * sampleGray(frameIdx, srcX-1, srcY+1) + 2.0 * sampleGray(frameIdx, srcX, srcY+1) + 1.0 * sampleGray(frameIdx, srcX+1, srcY+1);

    let tenengradVal = gx * gx + gy * gy;

    // Laplacian
    let lap = sampleGray(frameIdx, srcX, srcY-1)
            + sampleGray(frameIdx, srcX-1, srcY) - 4.0 * sampleGray(frameIdx, srcX, srcY) + sampleGray(frameIdx, srcX+1, srcY)
            + sampleGray(frameIdx, srcX, srcY+1);

    let outIdx = frameIdx * params.cropSize * params.cropSize + localY * params.cropSize + localX;
    tenengrad[outIdx] = tenengradVal;
    laplacian[outIdx] = lap * lap;
}
`;

// RGBA Crop shader - crops RGBA images without demosaicing (for PNG/JPEG input)
export const rgbaCropShader = `
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
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read> centers: array<CropCenter>;
@group(0) @binding(3) var<storage, read_write> output: array<u32>;
@group(0) @binding(4) var<storage, read_write> grayOutput: array<atomic<u32>>;

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

    let r = f32(rgba & 0xFFu);
    let g = f32((rgba >> 8u) & 0xFFu);
    let b = f32((rgba >> 16u) & 0xFFu);
    let gray = u32(clamp(0.299 * r + 0.587 * g + 0.114 * b, 0.0, 255.0));

    let grayPackedIdx = outIdx >> 2u;
    let grayByteOffset = (outIdx & 3u) << 3u;
    atomicOr(&grayOutput[grayPackedIdx], gray << grayByteOffset);
}
`;

// Mono 16-bit crop shader - reads packed u16 mono data, crops, outputs Float32 RGBA
// Same layout as demosaicCropShader for 16-bit output but without Bayer demosaicing
export const mono16CropFloat32Shader = `
struct Params {
    srcWidth: u32,
    srcHeight: u32,
    cropSize: u32,
    _pad1: u32,
    batchSize: u32,
    scale: f32,
    _pad3: u32,
    _pad4: u32,
}

struct CropCenter {
    x: f32,
    y: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read> centers: array<CropCenter>;
@group(0) @binding(3) var<storage, read_write> output: array<u32>;
@group(0) @binding(4) var<storage, read_write> grayOutput: array<atomic<u32>>;

fn readMono16(pixelIdx: u32) -> f32 {
    let u32Idx = pixelIdx >> 1u;
    let halfPos = pixelIdx & 1u;
    let packed = input[u32Idx];
    let rawValue = select(packed & 0xFFFFu, packed >> 16u, halfPos == 1u);
    return min(1.0, f32(rawValue) * params.scale);
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
    let cropStartX = i32(floor(center.x - halfSize));
    let cropStartY = i32(floor(center.y - halfSize));

    let srcX = u32(clamp(cropStartX + i32(outX), 0, i32(params.srcWidth) - 1));
    let srcY = u32(clamp(cropStartY + i32(outY), 0, i32(params.srcHeight) - 1));

    let srcIdx = frameIdx * params.srcWidth * params.srcHeight + srcY * params.srcWidth + srcX;
    let outIdx = frameIdx * params.cropSize * params.cropSize + outY * params.cropSize + outX;

    let v = readMono16(srcIdx);

    // Output Float32 RGBA (4 consecutive u32 slots via bitcast, same as demosaicCropShader 16-bit path)
    let baseIdx = outIdx * 4u;
    output[baseIdx] = bitcast<u32>(v);
    output[baseIdx + 1u] = bitcast<u32>(v);
    output[baseIdx + 2u] = bitcast<u32>(v);
    output[baseIdx + 3u] = bitcast<u32>(1.0);

    // Packed 8-bit grayscale for template matching
    let gray = u32(clamp(v * 255.0, 0.0, 255.0));
    let grayPackedIdx = outIdx >> 2u;
    let grayByteOffset = (outIdx & 3u) << 3u;
    atomicOr(&grayOutput[grayPackedIdx], gray << grayByteOffset);
}
`;

// Demosaic + Crop shader - crops around per-frame centers during demosaic
export const demosaicCropShader = `
struct Params {
    srcWidth: u32,
    srcHeight: u32,
    cropSize: u32,
    bayerPattern: u32,
    batchSize: u32,
    useVng: u32,
    bitDepth: u32,
    scale: f32,
}

struct CropCenter {
    x: f32,
    y: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read> centers: array<CropCenter>;
@group(0) @binding(3) var<storage, read_write> output: array<u32>;
@group(0) @binding(4) var<storage, read_write> grayOutput: array<atomic<u32>>;

fn getBayerValue(frameIdx: u32, x: u32, y: u32) -> f32 {
    let pixelIdx = frameIdx * params.srcWidth * params.srcHeight + y * params.srcWidth + x;
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

fn sampleBayer(frameIdx: u32, x: i32, y: i32) -> f32 {
    let cx = clamp(x, 0, i32(params.srcWidth) - 1);
    let cy = clamp(y, 0, i32(params.srcHeight) - 1);
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
            r = select((e + w) * 0.5, (e * wE + w * wW) / (wE + wW), (wE + wW) > 0.0);
            b = select((n + s) * 0.5, (n * wN + s * wS) / (wN + wS), (wN + wS) > 0.0);
        } else {
            g = center;
            b = select((e + w) * 0.5, (e * wE + w * wW) / (wE + wW), (wE + wW) > 0.0);
            r = select((n + s) * 0.5, (n * wN + s * wS) / (wN + wS), (wN + wS) > 0.0);
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
            b = select((e + w) * 0.5, (e * wE + w * wW) / (wE + wW), (wE + wW) > 0.0);
            r = select((n + s) * 0.5, (n * wN + s * wS) / (wN + wS), (wN + wS) > 0.0);
        } else {
            g = center;
            r = select((e + w) * 0.5, (e * wE + w * wW) / (wE + wW), (wE + wW) > 0.0);
            b = select((n + s) * 0.5, (n * wN + s * wS) / (wN + wS), (wN + wS) > 0.0);
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
            r = select((e + w) * 0.5, (e * wE + w * wW) / (wE + wW), (wE + wW) > 0.0);
            b = select((n + s) * 0.5, (n * wN + s * wS) / (wN + wS), (wN + wS) > 0.0);
        } else {
            g = center;
            b = select((e + w) * 0.5, (e * wE + w * wW) / (wE + wW), (wE + wW) > 0.0);
            r = select((n + s) * 0.5, (n * wN + s * wS) / (wN + wS), (wN + wS) > 0.0);
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
            b = select((e + w) * 0.5, (e * wE + w * wW) / (wE + wW), (wE + wW) > 0.0);
            r = select((n + s) * 0.5, (n * wN + s * wS) / (wN + wS), (wN + wS) > 0.0);
        } else {
            g = center;
            r = select((e + w) * 0.5, (e * wE + w * wW) / (wE + wW), (wE + wW) > 0.0);
            b = select((n + s) * 0.5, (n * wN + s * wS) / (wN + wS), (wN + wS) > 0.0);
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
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) + sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) + sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 1u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) + sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) + sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
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
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) + sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) + sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 1u) {
            r = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) + sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) + sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
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
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) + sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) + sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 0u && by == 1u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) + sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) + sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
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
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) + sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            b = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) + sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
        } else if (bx == 1u && by == 0u) {
            b = sampleBayer(frameIdx, x, y);
            g = (sampleBayer(frameIdx, x-1, y) + sampleBayer(frameIdx, x+1, y) + sampleBayer(frameIdx, x, y-1) + sampleBayer(frameIdx, x, y+1)) * 0.25;
            r = (sampleBayer(frameIdx, x-1, y-1) + sampleBayer(frameIdx, x+1, y-1) + sampleBayer(frameIdx, x-1, y+1) + sampleBayer(frameIdx, x+1, y+1)) * 0.25;
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

    // No even-alignment (& ~1) - see VNG crop shader comment for rationale
    let center = centers[frameIdx];
    let halfSize = f32(params.cropSize) / 2.0;
    let cropStartX = i32(floor(center.x - halfSize));
    let cropStartY = i32(floor(center.y - halfSize));

    let srcX = cropStartX + i32(outX);
    let srcY = cropStartY + i32(outY);

    let x = u32(clamp(srcX, 0, i32(params.srcWidth) - 1));
    let y = u32(clamp(srcY, 0, i32(params.srcHeight) - 1));
    let ix = i32(x);
    let iy = i32(y);

    let bx = x % 2u;
    let by = y % 2u;
    let pattern = params.bayerPattern;

    var rgb: vec3<f32>;
    if (params.useVng == 1u) {
        rgb = vngInterpolate(frameIdx, ix, iy, bx, by, pattern);
    } else {
        rgb = bilinearInterpolate(frameIdx, ix, iy, bx, by, pattern);
    }

    let outIdx = frameIdx * params.cropSize * params.cropSize + outY * params.cropSize + outX;

    let gray = u32(clamp((0.299 * rgb.x + 0.587 * rgb.y + 0.114 * rgb.z) * 255.0, 0.0, 255.0));
    let grayPackedIdx = outIdx >> 2u;
    let grayByteOffset = (outIdx & 3u) << 3u;
    atomicOr(&grayOutput[grayPackedIdx], gray << grayByteOffset);

    if (params.bitDepth == 16u) {
        let baseIdx = outIdx * 4u;
        output[baseIdx] = bitcast<u32>(rgb.x);
        output[baseIdx + 1u] = bitcast<u32>(rgb.y);
        output[baseIdx + 2u] = bitcast<u32>(rgb.z);
        output[baseIdx + 3u] = bitcast<u32>(1.0);
    } else {
        let ri = u32(clamp(rgb.x * 255.0, 0.0, 255.0));
        let gi = u32(clamp(rgb.y * 255.0, 0.0, 255.0));
        let bi = u32(clamp(rgb.z * 255.0, 0.0, 255.0));
        let rgba = ri | (gi << 8u) | (bi << 16u) | (255u << 24u);
        output[outIdx] = rgba;
    }
}
`;

// Full demosaic + grayscale shader for Bayer frames
// Supports VNG and bilinear interpolation, outputs both RGBA and grayscale
export const demosaicGrayShader = `
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

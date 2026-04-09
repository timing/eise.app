/**
 * WebGPU-accelerated transforms for post-processing
 * Applies affine transforms with bicubic interpolation on float32 data
 */

const alignTransformShader = `
struct Params {
    inWidth: u32,
    inHeight: u32,
    outWidth: u32,
    outHeight: u32,
    dx: f32,
    dy: f32,
    // 2x2 affine matrix (for ellipse correction)
    a00: f32,
    a01: f32,
    a10: f32,
    a11: f32,
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;

fn cubicWeight(t: f32) -> f32 {
    let at = abs(t);
    if (at <= 1.0) {
        return (1.5 * at - 2.5) * at * at + 1.0;
    } else if (at < 2.0) {
        return ((-0.5 * at + 2.5) * at - 4.0) * at + 2.0;
    }
    return 0.0;
}

fn sampleBicubic(x: f32, y: f32) -> vec4<f32> {
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
        // Clamp to edge (BORDER_REPLICATE) instead of skipping
        let cy = clamp(y0 + j, 0, h - 1);
        let wy = select(select(select(wy3, wy2, j == 1), wy1, j == 0), wy0, j == -1);

        for (var i: i32 = -1; i <= 2; i++) {
            // Clamp to edge (BORDER_REPLICATE) instead of skipping
            let cx = clamp(x0 + i, 0, w - 1);
            let wx = select(select(select(wx3, wx2, i == 1), wx1, i == 0), wx0, i == -1);

            let idx = u32(cy * w + cx) * 4u;
            let pixel = vec4<f32>(
                input[idx],
                input[idx + 1u],
                input[idx + 2u],
                input[idx + 3u]
            );
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

    // Output position relative to output center
    let outCenterX = f32(params.outWidth) / 2.0;
    let outCenterY = f32(params.outHeight) / 2.0;
    let px = f32(ox) - outCenterX;
    let py = f32(oy) - outCenterY;

    // Undo translation
    let tx = px - params.dx;
    let ty = py - params.dy;

    // Undo affine transform (apply inverse of 2x2 matrix)
    // A = | a00  a01 |   A^-1 = (1/det) * | a11  -a01 |
    //     | a10  a11 |                     | -a10  a00 |
    let det = params.a00 * params.a11 - params.a01 * params.a10;
    var sx: f32;
    var sy: f32;
    if (abs(det) > 0.0001) {
        let invDet = 1.0 / det;
        sx = invDet * (params.a11 * tx - params.a01 * ty);
        sy = invDet * (-params.a10 * tx + params.a00 * ty);
    } else {
        // Degenerate matrix, fall back to identity
        sx = tx;
        sy = ty;
    }

    // Convert back to input image coordinates
    let inCenterX = f32(params.inWidth) / 2.0;
    let inCenterY = f32(params.inHeight) / 2.0;
    let srcX = sx + inCenterX;
    let srcY = sy + inCenterY;

    let color = sampleBicubic(srcX, srcY);

    let outIdx = (oy * params.outWidth + ox) * 4u;
    output[outIdx] = color.r;
    output[outIdx + 1u] = color.g;
    output[outIdx + 2u] = color.b;
    output[outIdx + 3u] = color.a;
}
`;

let device = null;
let pipeline = null;
let initialized = false;

async function initGpu() {
    if (initialized) return true;
    if (!navigator.gpu) return false;

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return false;

        device = await adapter.requestDevice();
        const shaderModule = device.createShaderModule({ code: alignTransformShader });

        pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: shaderModule, entryPoint: 'main' }
        });

        initialized = true;
        console.log('[PostProcessor GPU] Initialized');
        return true;
    } catch (err) {
        console.error('[PostProcessor GPU] Init failed:', err);
        return false;
    }
}

async function applyTransform(inputData, width, height, transform, options = {}) {
    if (!initialized && !await initGpu()) {
        throw new Error('WebGPU not available');
    }

    const { dx = 0, dy = 0 } = transform;
    const outWidth = options.outputWidth || width;
    const outHeight = options.outputHeight || height;

    // Get affine matrix (default to identity if not provided)
    const affine = transform.affine || { a00: 1, a01: 0, a10: 0, a11: 1 };

    // Legacy support: if scale/dTheta provided, build affine from them
    if (!transform.affine && (transform.scale !== undefined || transform.dTheta !== undefined)) {
        const scale = transform.scale || 1;
        const dTheta = transform.dTheta || 0;
        const cos = Math.cos(dTheta);
        const sin = Math.sin(dTheta);
        affine.a00 = scale * cos;
        affine.a01 = -scale * sin;
        affine.a10 = scale * sin;
        affine.a11 = scale * cos;
    }

    const inputBuffer = device.createBuffer({
        size: inputData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(inputBuffer, 0, inputData);

    const outputSize = outWidth * outHeight * 4 * 4;
    const outputBuffer = device.createBuffer({
        size: outputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    const readbackBuffer = device.createBuffer({
        size: outputSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    // Pack params: 4 u32 + 6 f32 + 2 u32 padding = 48 bytes
    const paramsData = new ArrayBuffer(48);
    const paramsU32 = new Uint32Array(paramsData);
    const paramsF32 = new Float32Array(paramsData);
    paramsU32[0] = width;
    paramsU32[1] = height;
    paramsU32[2] = outWidth;
    paramsU32[3] = outHeight;
    paramsF32[4] = dx;
    paramsF32[5] = dy;
    paramsF32[6] = affine.a00;
    paramsF32[7] = affine.a01;
    paramsF32[8] = affine.a10;
    paramsF32[9] = affine.a11;
    paramsU32[10] = 0;  // padding
    paramsU32[11] = 0;  // padding

    const paramsBuffer = device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(paramsBuffer, 0, paramsData);

    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: { buffer: inputBuffer } },
            { binding: 2, resource: { buffer: outputBuffer } }
        ]
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(outWidth / 16), Math.ceil(outHeight / 16), 1);
    pass.end();

    encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputSize);
    device.queue.submit([encoder.finish()]);

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();

    inputBuffer.destroy();
    outputBuffer.destroy();
    readbackBuffer.destroy();
    paramsBuffer.destroy();

    return result;
}

self.addEventListener('message', async (e) => {
    const { type, requestId } = e.data;

    if (type === 'init') {
        const ok = await initGpu();
        self.postMessage({ type: ok ? 'ready' : 'init-error', error: ok ? null : 'WebGPU init failed' });
        return;
    }

    if (type === 'apply-transform') {
        try {
            const result = await applyTransform(
                e.data.inputData,
                e.data.width,
                e.data.height,
                e.data.transform,
                e.data.options
            );
            self.postMessage({ type: 'transform-result', requestId, result }, [result.buffer]);
        } catch (err) {
            self.postMessage({ type: 'transform-error', requestId, error: err.message });
        }
    }
});

console.log('[PostProcessor Worker] Loaded');

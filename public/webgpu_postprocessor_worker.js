/**
 * WebGPU-accelerated alignment transforms for batch stacked images
 *
 * Applies translation, rotation, and scale transforms with bicubic interpolation
 * for high-quality wobble-free animation alignment.
 */

const alignTransformShader = `
struct Params {
    inWidth: u32,
    inHeight: u32,
    outWidth: u32,
    outHeight: u32,
    dx: f32,          // Translation X
    dy: f32,          // Translation Y
    dTheta: f32,      // Rotation angle (radians)
    scale: f32,       // Scale factor
    centerX: f32,     // Center X for rotation
    centerY: f32,     // Center Y for rotation
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;   // Float32 RGBA (0-1 range)
@group(0) @binding(2) var<storage, read_write> output: array<f32>;  // Float32 RGBA output

// Cubic interpolation weight (Catmull-Rom)
fn cubicWeight(t: f32) -> f32 {
    let at = abs(t);
    if (at <= 1.0) {
        return (1.5 * at - 2.5) * at * at + 1.0;
    } else if (at < 2.0) {
        return ((-0.5 * at + 2.5) * at - 4.0) * at + 2.0;
    }
    return 0.0;
}

// Sample input image with bicubic interpolation
fn sampleBicubic(x: f32, y: f32) -> vec4<f32> {
    let x0 = i32(floor(x));
    let y0 = i32(floor(y));
    let fx = x - f32(x0);
    let fy = y - f32(y0);
    let w = i32(params.inWidth);
    let h = i32(params.inHeight);

    // Check if completely outside
    if (x < -1.0 || x > f32(w) || y < -1.0 || y > f32(h)) {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

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
        let cy = y0 + j;
        if (cy < 0 || cy >= h) { continue; }
        let wy = select(select(select(wy3, wy2, j == 1), wy1, j == 0), wy0, j == -1);

        for (var i: i32 = -1; i <= 2; i++) {
            let cx = x0 + i;
            if (cx < 0 || cx >= w) { continue; }
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

    // Output pixel position relative to center
    let outCenterX = f32(params.outWidth) / 2.0;
    let outCenterY = f32(params.outHeight) / 2.0;
    let px = f32(ox) - outCenterX;
    let py = f32(oy) - outCenterY;

    // Inverse transform to find source coordinates:
    // Forward: scale -> rotate -> translate
    // Inverse: un-translate -> un-rotate -> un-scale

    // 1. Undo translation
    let tx = px - params.dx;
    let ty = py - params.dy;

    // 2. Undo rotation (rotate by -dTheta)
    let cosT = cos(-params.dTheta);
    let sinT = sin(-params.dTheta);
    let rx = tx * cosT - ty * sinT;
    let ry = tx * sinT + ty * cosT;

    // 3. Undo scale
    let sx = rx / params.scale;
    let sy = ry / params.scale;

    // Convert back to image coordinates (relative to input center)
    let inCenterX = f32(params.inWidth) / 2.0;
    let inCenterY = f32(params.inHeight) / 2.0;
    let srcX = sx + inCenterX;
    let srcY = sy + inCenterY;

    // Sample with bicubic interpolation
    let color = sampleBicubic(srcX, srcY);

    // Write output
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

/**
 * Initialize WebGPU for alignment transforms
 */
async function initAlignmentGpu() {
    if (initialized) return true;

    if (!navigator.gpu) {
        console.warn('[Alignment GPU] WebGPU not available');
        return false;
    }

    try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            console.warn('[Alignment GPU] No adapter found');
            return false;
        }

        device = await adapter.requestDevice();

        const shaderModule = device.createShaderModule({
            code: alignTransformShader
        });

        pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: shaderModule,
                entryPoint: 'main'
            }
        });

        initialized = true;
        console.log('[Alignment GPU] Initialized');
        return true;
    } catch (err) {
        console.error('[Alignment GPU] Init failed:', err);
        return false;
    }
}

/**
 * Apply alignment transform using WebGPU
 */
async function applyTransformGpu(inputData, width, height, transform, options = {}) {
    if (!initialized) {
        const ok = await initAlignmentGpu();
        if (!ok) {
            throw new Error('WebGPU not available for alignment');
        }
    }

    const { dx = 0, dy = 0, dTheta = 0, scale = 1 } = transform;
    const outWidth = options.outputWidth || width;
    const outHeight = options.outputHeight || height;

    // Create buffers
    const inputBuffer = device.createBuffer({
        size: inputData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(inputBuffer, 0, inputData);

    const outputSize = outWidth * outHeight * 4 * 4; // float32 RGBA
    const outputBuffer = device.createBuffer({
        size: outputSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    const readbackBuffer = device.createBuffer({
        size: outputSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });

    // Params buffer
    const paramsData = new ArrayBuffer(48); // 12 x 4 bytes
    const paramsU32 = new Uint32Array(paramsData);
    const paramsF32 = new Float32Array(paramsData);
    paramsU32[0] = width;
    paramsU32[1] = height;
    paramsU32[2] = outWidth;
    paramsU32[3] = outHeight;
    paramsF32[4] = dx;
    paramsF32[5] = dy;
    paramsF32[6] = dTheta;
    paramsF32[7] = scale;
    paramsF32[8] = width / 2;  // centerX
    paramsF32[9] = height / 2; // centerY
    paramsU32[10] = 0; // pad
    paramsU32[11] = 0; // pad

    const paramsBuffer = device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(paramsBuffer, 0, paramsData);

    // Bind group
    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: paramsBuffer } },
            { binding: 1, resource: { buffer: inputBuffer } },
            { binding: 2, resource: { buffer: outputBuffer } }
        ]
    });

    // Dispatch
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
        Math.ceil(outWidth / 16),
        Math.ceil(outHeight / 16),
        1
    );
    pass.end();

    // Copy to readback
    encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputSize);
    device.queue.submit([encoder.finish()]);

    // Read back result
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readbackBuffer.getMappedRange().slice(0));
    readbackBuffer.unmap();

    // Cleanup
    inputBuffer.destroy();
    outputBuffer.destroy();
    readbackBuffer.destroy();
    paramsBuffer.destroy();

    return result;
}

// Worker message handling
self.addEventListener('message', async (e) => {
    const { type, requestId } = e.data;

    if (type === 'init') {
        try {
            const ok = await initAlignmentGpu();
            if (ok) {
                self.postMessage({ type: 'ready' });
            } else {
                self.postMessage({ type: 'init-error', error: 'WebGPU initialization failed' });
            }
        } catch (err) {
            self.postMessage({ type: 'init-error', error: err.message });
        }
        return;
    }

    if (type === 'apply-transform') {
        const { inputData, width, height, transform, options } = e.data;

        try {
            const result = await applyTransformGpu(inputData, width, height, transform, options);
            self.postMessage({
                type: 'transform-result',
                requestId,
                result
            }, [result.buffer]); // Transfer the buffer
        } catch (err) {
            self.postMessage({
                type: 'transform-error',
                requestId,
                error: err.message
            });
        }
        return;
    }
});

console.log('[PostProcessor Worker] Loaded');

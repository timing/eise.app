// WebGPU-accelerated frame stacking with local de-warping
// Handles: displacement map generation, frame warping, and accumulation

let stackDevice = null;
let stackQueue = null;
let warpPipeline = null;
let accumulatePipeline = null;
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
@group(0) @binding(1) var<storage, read> frameRgba: array<u32>;     // Input frame RGBA packed
@group(0) @binding(2) var<storage, read> apData: array<AP>;         // AP positions + shifts
@group(0) @binding(3) var<storage, read_write> accumR: array<f32>;
@group(0) @binding(4) var<storage, read_write> accumG: array<f32>;
@group(0) @binding(5) var<storage, read_write> accumB: array<f32>;
@group(0) @binding(6) var<storage, read_write> accumW: array<f32>;

fn sampleFrame(x: f32, y: f32) -> vec4<f32> {
    // Bilinear interpolation
    let x0 = i32(floor(x));
    let y0 = i32(floor(y));
    let x1 = x0 + 1;
    let y1 = y0 + 1;

    let fx = x - f32(x0);
    let fy = y - f32(y0);

    let w = i32(params.inWidth);
    let h = i32(params.inHeight);

    // Clamp coordinates
    let cx0 = clamp(x0, 0, w - 1);
    let cy0 = clamp(y0, 0, h - 1);
    let cx1 = clamp(x1, 0, w - 1);
    let cy1 = clamp(y1, 0, h - 1);

    // Sample 4 corners
    let p00 = frameRgba[cy0 * w + cx0];
    let p10 = frameRgba[cy0 * w + cx1];
    let p01 = frameRgba[cy1 * w + cx0];
    let p11 = frameRgba[cy1 * w + cx1];

    // Unpack RGBA
    let c00 = vec4<f32>(f32(p00 & 0xFFu), f32((p00 >> 8u) & 0xFFu), f32((p00 >> 16u) & 0xFFu), f32((p00 >> 24u) & 0xFFu));
    let c10 = vec4<f32>(f32(p10 & 0xFFu), f32((p10 >> 8u) & 0xFFu), f32((p10 >> 16u) & 0xFFu), f32((p10 >> 24u) & 0xFFu));
    let c01 = vec4<f32>(f32(p01 & 0xFFu), f32((p01 >> 8u) & 0xFFu), f32((p01 >> 16u) & 0xFFu), f32((p01 >> 24u) & 0xFFu));
    let c11 = vec4<f32>(f32(p11 & 0xFFu), f32((p11 >> 8u) & 0xFFu), f32((p11 >> 16u) & 0xFFu), f32((p11 >> 24u) & 0xFFu));

    // Bilinear blend
    let c0 = mix(c00, c10, fx);
    let c1 = mix(c01, c11, fx);
    return mix(c0, c1, fy);
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

        isStackingReady = true;
        stackDeviceLost = false;
        console.log('WebGPU stacking initialized');
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

function getStackingBuffers(inWidth, inHeight, outWidth, outHeight, numAPs) {
    const inPixels = inWidth * inHeight;
    const outPixels = outWidth * outHeight;

    const requiredSizes = {
        frameSize: inPixels * 4,
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

    cachedStackBuffers = {
        paramsBuffer: stackDevice.createBuffer({
            size: 48,  // 12 floats/u32
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        frameBuffer: stackDevice.createBuffer({
            size: frameSizeAligned,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
        apBuffer: stackDevice.createBuffer({
            size: apSizeAligned,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        }),
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
 */
async function warpAndAccumulateFrame(frameRgba, width, height, outWidth, outHeight,
    alignmentPoints, shifts, patchSize, drizzleScale, frameWeight, brightnessScale,
    globalOffsetX, globalOffsetY) {

    if (!isStackingReady) {
        const initialized = await initStackingGPU();
        if (!initialized) {
            throw new Error('WebGPU stacking not available');
        }
    }

    const buffers = getStackingBuffers(width, height, outWidth, outHeight, alignmentPoints.length);
    const numAPs = alignmentPoints.length;

    // Pack frame data
    const frameData = new Uint32Array(width * height);
    const src = new Uint8Array(frameRgba);
    for (let i = 0; i < width * height; i++) {
        frameData[i] = src[i*4] | (src[i*4+1] << 8) | (src[i*4+2] << 16) | (src[i*4+3] << 24);
    }
    stackQueue.writeBuffer(buffers.frameBuffer, 0, frameData);

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

    // Pack params
    const paramsData = new ArrayBuffer(48);
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
    paramsF32[11] = 0.3;  // minQuality
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
}

// Export
if (typeof self !== 'undefined') {
    self.initStackingGPU = initStackingGPU;
    self.getStackingBuffers = getStackingBuffers;
    self.warpAndAccumulateFrame = warpAndAccumulateFrame;
    self.clearAccumulators = clearAccumulators;
    self.readAccumulators = readAccumulators;
    self.cleanupStackingBuffers = cleanupStackingBuffers;
}

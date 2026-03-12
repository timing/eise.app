/**
 * GPU Helper Functions
 * Reduces boilerplate for common WebGPU operations
 */

/**
 * Create a bind group from a pipeline and array of buffers.
 * Buffers are bound sequentially starting at binding 0.
 *
 * @param {GPUDevice} device - The GPU device
 * @param {GPUComputePipeline} pipeline - Pipeline to get layout from
 * @param {GPUBuffer[]} buffers - Array of buffers to bind
 * @returns {GPUBindGroup}
 */
export function createBindGroup(device, pipeline, buffers) {
    return device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: buffers.map((buffer, i) => ({
            binding: i,
            resource: { buffer }
        }))
    });
}

/**
 * Add a compute pass to an encoder.
 *
 * @param {GPUCommandEncoder} encoder - The command encoder
 * @param {GPUComputePipeline} pipeline - The compute pipeline
 * @param {GPUBindGroup} bindGroup - The bind group
 * @param {number[]} workgroups - Array of [x, y, z] workgroup counts
 */
export function addComputePass(encoder, pipeline, bindGroup, workgroups) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(...workgroups);
    pass.end();
}

/**
 * Run a single compute pass immediately (creates encoder, submits).
 * Use addComputePass() instead when batching multiple passes.
 *
 * @param {GPUDevice} device - The GPU device
 * @param {GPUQueue} queue - The GPU queue
 * @param {GPUComputePipeline} pipeline - The compute pipeline
 * @param {GPUBindGroup} bindGroup - The bind group
 * @param {number[]} workgroups - Array of [x, y, z] workgroup counts
 */
export function dispatchCompute(device, queue, pipeline, bindGroup, workgroups) {
    const encoder = device.createCommandEncoder();
    addComputePass(encoder, pipeline, bindGroup, workgroups);
    queue.submit([encoder.finish()]);
}

/**
 * Helper for 2D image dispatch with 16x16 workgroups.
 *
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} batchSize - Number of images in batch
 * @returns {number[]} - Workgroup counts [x, y, z]
 */
export function imageWorkgroups(width, height, batchSize = 1) {
    return [Math.ceil(width / 16), Math.ceil(height / 16), batchSize];
}

/**
 * Helper for reduction dispatch.
 *
 * @param {number} numWorkgroups - Number of reduction workgroups
 * @param {number} batchSize - Number of items in batch
 * @returns {number[]} - Workgroup counts [x, y, z]
 */
export function reductionWorkgroups(numWorkgroups, batchSize) {
    return [numWorkgroups, batchSize, 1];
}

/**
 * Create a compute pipeline from WGSL shader code.
 * Combines shader module creation and pipeline creation in one step.
 *
 * @param {GPUDevice} device - The GPU device
 * @param {string} shaderCode - WGSL shader source code
 * @param {string} name - Name for error messages
 * @returns {Promise<GPUComputePipeline>}
 */
export async function createPipeline(device, shaderCode, name) {
    const module = device.createShaderModule({ code: shaderCode });
    const info = await module.getCompilationInfo();
    for (const msg of info.messages) {
        if (msg.type === 'error') {
            throw new Error(`Shader ${name} error: ${msg.message} at line ${msg.lineNum}`);
        }
        if (msg.type === 'warning') {
            console.warn(`Shader ${name} warning: ${msg.message}`);
        }
    }
    return device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: 'main' }
    });
}

// ============================================================
// Buffer Creation Helpers
// ============================================================

/**
 * Create a storage buffer with optional copy flags.
 *
 * @param {GPUDevice} device - The GPU device
 * @param {number} size - Buffer size in bytes
 * @param {Object} options - Copy flag options
 * @param {boolean} options.copySrc - Add COPY_SRC flag (for copying from this buffer)
 * @param {boolean} options.copyDst - Add COPY_DST flag (for copying to this buffer)
 * @returns {GPUBuffer}
 */
export function storageBuffer(device, size, { copySrc = false, copyDst = false } = {}) {
    let usage = GPUBufferUsage.STORAGE;
    if (copySrc) usage |= GPUBufferUsage.COPY_SRC;
    if (copyDst) usage |= GPUBufferUsage.COPY_DST;
    return device.createBuffer({ size, usage });
}

/**
 * Create a uniform buffer (always includes COPY_DST for uploading params).
 *
 * @param {GPUDevice} device - The GPU device
 * @param {number} size - Buffer size in bytes
 * @returns {GPUBuffer}
 */
export function uniformBuffer(device, size) {
    return device.createBuffer({
        size,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
}

/**
 * Create a readback buffer for mapping results to CPU.
 *
 * @param {GPUDevice} device - The GPU device
 * @param {number} size - Buffer size in bytes
 * @returns {GPUBuffer}
 */
export function readbackBuffer(device, size) {
    return device.createBuffer({
        size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
}

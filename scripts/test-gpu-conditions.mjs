#!/usr/bin/env node
// Verifies classifyGpuCondition() against the real Sentry messages it has to
// sort. Cases are taken verbatim from the eise project's top issues (30 days to
// 2026-09-21), so a regex tweak that starts swallowing genuine bugs fails here.
//
//   node scripts/test-gpu-conditions.mjs
//
// The `null` cases matter most: those are real defects that must keep reaching
// Sentry. Add a case here whenever a new GPU condition is routed to analytics.

import { classifyGpuCondition } from '../composables/gpuConditions.js';

const CASES = [
    // --- cascade noise (EISE-NH, 2412 events) ---
    ['validation_cascade', 'WebGPU validation error: [Invalid Buffer (unlabeled)] is invalid due to a previous error.'],
    ['validation_cascade', 'WebGPU validation error: [Invalid BindGroup (unlabeled)] is invalid due to a previous error.\n - While encoding [ComputePassEncoder (unlabeled)].SetBindGroup(0, ...)'],
    ['validation_cascade', 'WebGPU validation error: [Invalid CommandBuffer] is invalid due to a previous error.\n - While calling [Queue].Submit'],

    // --- device loss family (EISE-NJ/P3/P0/MK/NV/MR/ME/JJ/GD/MW) ---
    ['device_lost', 'GPU device lost and recovery failed: No WebGPU adapter found. Please reload the page.'],
    ['device_lost', 'GPU device was lost during buffer operation. Please reload the page.'],
    ['device_lost', 'GPU device was lost during operation. Please reload the page.'],
    ['device_lost', 'GPU device was lost and could not be recovered. Please reload the page.'],
    ['device_lost', 'GPU device was lost. Please reload the page to continue.'],
    ['device_lost', 'GPU device lost: Device was destroyed. Max recovery attempts reached. Please reload the page.'],
    ['device_lost', "GPU device lost and recovery failed: Failed to execute 'requestDevice' on 'GPUAdapter': D3D12 create command queue failed with DXGI_ERROR_DEVICE_REMOVED (0x887A0005)"],

    // --- retry sentinel (EISE-N1) ---
    ['device_recovered', 'GPU_DEVICE_RECOVERED'],

    // --- our own pre-flight guards (EISE-NY/PV/P7/PD/FG/MT) ---
    ['buffer_limit', "GPU buffer 'momentsPixelBuffer' would be 346MB, exceeds device limit 128MB (maxBufferSize=2048MB, maxStorageBufferBindingSize=128MB, batchSize=1, src=4096x3072, analyze=4096x3072, bitDepth=16). Reduce batch size or frame size."],
    ['buffer_limit', "GPU buffer 'stacking.frameBuffer' would be 158MB, exceeds device limit 128MB (maxBufferSize=4096MB, numAPs=17424). Reduce batch size or frame size."],
    ['buffer_limit', "This device's GPU cannot analyze 3840×2160 frames: a single frame's analysis buffer exceeds the per-buffer limit. Try a lower-resolution capture, or use CPU mode (slower but no size limit)."],

    // --- genuinely no WebGPU (EISE-MV, EISE-PH) ---
    ['no_adapter', 'No WebGPU adapter found'],
    ['no_adapter', 'WebGPU stacking not available'],

    // --- MUST stay in Sentry: real defects, not expected conditions ---
    [null, 'WebGPU validation error: [Buffer (unlabeled)] is already mapped.'],
    [null, "Failed to execute 'mapAsync' on 'GPUBuffer': [Buffer (unlabeled)] is already mapped."],
    [null, 'WebGPU validation error: ID3D12Device::CreateHeap'],
    [null, 'WebGPU validation error: vkAllocateMemory failed with VK_ERROR_OUT_OF_DEVICE_MEMORY'],
    [null, 'Array buffer allocation failed'],
    [null, 'GPU stack worker timeout'],
    [null, 'GPU worker not initialized'],
    [null, 'GPU worker crashed - try reloading the page'],
    [null, 'layout size is invalid'],
    [null, 'Worker initialization timed out after 10s'],
    [null, 'Decoder stalled: no frame output in 12020ms (queue=4, frames_out=48, packets_in=55)'],
    [null, 'Stacking failed: no valid frames'],
    [null, 'Not initialized'],
    [null, 'Offset is outside the bounds of the DataView'],

    // --- defensive ---
    [null, ''],
    [null, null],
    [null, undefined],
];

let failed = 0;
for (const [want, message] of CASES) {
    const got = classifyGpuCondition(message);
    const ok = got === want;
    if (!ok) failed++;
    const label = String(message).slice(0, 62).replace(/\n/g, ' ');
    console.log(`${ok ? 'ok  ' : 'FAIL'}  want=${String(want).padEnd(19)} got=${String(got).padEnd(19)} ${label}`);
}

console.log(failed ? `\n${failed} of ${CASES.length} FAILED` : `\nall ${CASES.length} pass`);
process.exit(failed ? 1 : 0);

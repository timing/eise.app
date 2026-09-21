// composables/gpuConditions.js
//
// Classifies GPU error messages into "expected conditions" that should NOT go
// to Sentry. Dependency-free on purpose so scripts/test-gpu-conditions.mjs can
// import it under plain node (same arrangement as libRawCfa.js).
//
// Background: in the 30 days to 2026-09-21, ~4,300 of 5,700 Sentry error events
// were WebGPU conditions, against the free plan's 5,000/month quota. None of
// them were ever debugged from a stacktrace, because the remedy is always
// smaller frames, more VRAM, or a page reload. They are now counted as
// `gpu_condition` analytics events instead.

/**
 * ORDER MATTERS. The cascade pattern must be tested first: cascade messages
 * also mention invalid buffers and would otherwise be misfiled as device loss.
 */
export const GPU_CONDITIONS = [
    // One failed allocation invalidates a buffer, and WebGPU then raises an
    // uncaptured error for EVERY later operation that touches it. EISE-NH was
    // 2,412 events, all downstream echoes of a root cause that is reported
    // separately, up to 30+ from a single session. Never worth sending.
    { kind: 'validation_cascade', test: /is invalid due to a previous error/i },

    // Control-flow sentinel thrown by safeMapAsync in webgpu_analyze_worker.js
    // and webgpu_stacking.js: the device WAS recovered and the caller should
    // retry. A success path that happens to travel as an Error (EISE-N1).
    { kind: 'device_recovered', test: /GPU_DEVICE_RECOVERED/ },

    // Our own pre-flight guards: assertBufferFits() in gpu/helpers.js and the
    // single-frame check in webgpu_analyze_worker.js. The message embeds frame
    // size, buffer size and device limits, which is exactly what we want to
    // aggregate on in analytics.
    { kind: 'buffer_limit', test: /exceeds device limit|exceeds the per-buffer limit/i },

    // Driver crash, TDR, tab suspend, VRAM exhaustion. Unfixable from our side,
    // and the stacktrace is always the same readback path.
    { kind: 'device_lost', test: /GPU device (was |lost)|device lost and recovery failed/i },

    // Genuine "this machine cannot do WebGPU". Already handled in the UI by
    // gpuRequiredError() in FileUploader.vue with browser-specific guidance.
    { kind: 'no_adapter', test: /No WebGPU adapter found|WebGPU (stacking )?not available/i },
];

/**
 * @param {string} message
 * @returns {string|null} condition kind, or null if this is a normal error that
 *   still belongs in Sentry.
 */
export function classifyGpuCondition(message) {
    if (!message || typeof message !== 'string') return null;
    for (const { kind, test } of GPU_CONDITIONS) {
        if (test.test(message)) return kind;
    }
    return null;
}

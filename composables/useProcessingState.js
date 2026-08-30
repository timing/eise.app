// composables/useProcessingState.js
// Shared state for the current processing session

import { ref } from 'vue';

// FNV-1a 32-bit — synchronous, tiny, no crypto dependency. Base-36 keeps the
// output short. Not cryptographic, but we're deduping analytics events, not
// verifying signatures.
function shortJobHash(input) {
    let h = 2166136261;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    // Pad/truncate to 8 base-36 chars.
    return (h >>> 0).toString(36).padStart(8, '0').slice(0, 8);
}

const inputFilename = ref('');
const inputFilenameWithExt = ref('');
// Short per-attempt identifier that ties stack_start / stack_finished /
// stack_failed / stack_cancelled / stack_reader_fallback for the same run
// together in analytics. Rebuilt each time a file is selected so retries of
// the same file count as separate jobs.
const stackJobId = ref('');
const minApQuality = ref(0.3);
const apPatchSize = ref(20);
const pixfrac = ref(1.0);

// Tracking context for analytics
const trackingContext = ref({
    file_type: null,     // 'ser', 'avi', 'video', 'images'
    reader: null,        // 'debayer', 'avi', 'ffmpeg', 'image' — current reader (rewritten on fallback)
    initial_reader: null,// First reader chosen for this job; never overwritten by fallback. Lets
                         // analytics tell "mediabunny failed then ffmpeg failed" from "ffmpeg failed".
    gpu_enabled: null    // true/false
});

const stackingMode = ref('single'); // 'single' or 'continuous'
// When true, crop-detection analyze runs at half resolution (fixed 2× box-
// filter downscale). Trade-off: ~1 source-pixel error in the initial centroid,
// well inside the 8 px template-match search radius; in exchange the
// momentsPixelBuffer drops from 24 B/px × sourcePixels to a quarter of that,
// which is what fixes the Android momentsPixelBuffer-exceeds-device-limit
// failures on 4000×3000+ smartphone photos. Default is initialized in
// FileUploader based on isMobileDevice: on by default on mobile, off on desktop.
const lowResCropDetect = ref(false);
const continuousStackingResults = ref([]); // Stores [pct, blob, sharpness] for comparison
const batchStartIndex = ref(0); // Initial index for BatchPostProcessor

// Non-reactive telemetry for mediabunny pass 2 loop. Plain scalars so hot-path
// increments don't trigger Vue reactivity. Read once per stack_ping in app.vue
// so we can pin *which* await is stalling: packet iterator, decoder output
// callback, backpressure spin, or GPU analyze batch.
let pass2Counters = { packet_count: 0, frame_index: 0, batch_count: 0, last_frame_ts: 0, decode_queue_size: null };
export function resetPass2Counters() {
    pass2Counters = { packet_count: 0, frame_index: 0, batch_count: 0, last_frame_ts: 0, decode_queue_size: null };
}
export function bumpPass2Packet() { pass2Counters.packet_count++; }
export function bumpPass2Frame() { pass2Counters.frame_index++; pass2Counters.last_frame_ts = Date.now(); }
export function bumpPass2Batch() { pass2Counters.batch_count++; }
export function setPass2QueueSize(n) { pass2Counters.decode_queue_size = n; }
export function getPass2Counters() { return { ...pass2Counters }; }

// Trace state written by app.vue on start / stack-step / stop, read by any
// terminal fire site via getStackJobProps. Module-scoped (not per-composable-call)
// so that mark* from one component and read from another see the same jobTrace.
const jobTrace = { lastStep: null, lastStepTs: 0, startTs: 0 };

export function useProcessingState() {
    // Set filename only (display / export). Does NOT mint a new stack_job_id
    // — post-processor Prev/Next navigation calls this to update the export
    // name and we don't want each click to spawn a phantom job in analytics.
    function setInputFilename(filename) {
        inputFilenameWithExt.value = filename;
        inputFilename.value = filename.replace(/\.[^/.]+$/, '');
    }

    // Call this at the start of a genuine new stack attempt (fresh file
    // selection). Sets filename AND mints a new stack_job_id so all
    // stack_start / stack_step / stack_ping / stack_finished events for this
    // attempt share one identifier. 8 base-36 chars ≈ 40 bits of entropy —
    // enough for uniqueness within a session without bloating props.
    function startNewStackJob(filename) {
        setInputFilename(filename);
        stackJobId.value = shortJobHash(`${filename}|${Date.now()}|${Math.random()}`);
        // Reset initial_reader so the next setTrackingContext claims it. Without
        // this, a second attempt would inherit the previous job's initial_reader.
        trackingContext.value = { file_type: null, reader: null, initial_reader: null, gpu_enabled: null };
    }

    function getStackJobId() {
        return stackJobId.value || '';
    }

    function getOutputFilename(suffix, extension) {
        const base = inputFilename.value || 'eise_app';
        return `${base}_${suffix}.${extension}`;
    }

    function getInputFilename() {
        return inputFilenameWithExt.value;
    }

    function setMinApQuality(value) {
        minApQuality.value = value;
    }

    function getMinApQuality() {
        return minApQuality.value;
    }

    function setApPatchSize(value) {
        apPatchSize.value = value;
    }

    function getApPatchSize() {
        return apPatchSize.value;
    }

    function setPixfrac(value) {
        pixfrac.value = value;
    }

    function getPixfrac() {
        return pixfrac.value;
    }

    function setStackingMode(mode) {
        stackingMode.value = mode;
    }

    function getStackingMode() {
        return stackingMode.value;
    }

    function setLowResCropDetect(value) {
        lowResCropDetect.value = !!value;
    }

    function getLowResCropDetect() {
        return lowResCropDetect.value;
    }

    function setContinuousResults(results) {
        continuousStackingResults.value = results;
    }

    function getContinuousResults() {
        return continuousStackingResults.value;
    }

    function setBatchStartIndex(index) {
        batchStartIndex.value = index;
    }

    function getBatchStartIndex() {
        return batchStartIndex.value;
    }

    function setTrackingContext({ file_type, reader, gpu_enabled }) {
        // initial_reader is sticky per job: whoever calls setTrackingContext first
        // owns it, and later fallback calls (mediabunny -> ffmpeg) only rewrite
        // `reader`. Lets analytics attribute silent/failed jobs to the real starting
        // reader instead of just the one active at terminal time.
        const prev = trackingContext.value;
        trackingContext.value = {
            file_type,
            reader,
            initial_reader: prev.initial_reader || reader,
            gpu_enabled,
        };
    }

    function getTrackingContext() {
        // Always carry the job id so every stack_* event can be joined for
        // one attempt in analytics without extra plumbing at each call site.
        // stacking_mode rides along so we can filter continuous vs single
        // runs on any downstream event without joining back to stack_start.
        return {
            ...trackingContext.value,
            stack_job_id: stackJobId.value || null,
            stacking_mode: stackingMode.value || null,
        };
    }

    // Terminal-event helper. stack_job_id is the join key (already in tracking
    // context), so we don't repeat filename here — that lives on stack_start.
    // What terminals DO need beyond the base context: the trace state
    // (last_step, ms_since_step, ms_since_start) so a cancel or event-based
    // stack_failed carries the same "where did we die" signal that watchdog
    // stack_failed already has via stackPingSnapshot. app.vue writes trace
    // state on start / step / stop.
    function getStackJobProps() {
        const now = Date.now();
        return {
            ...getTrackingContext(),
            last_step: jobTrace.lastStep || 'none',
            ms_since_step: jobTrace.lastStepTs ? now - jobTrace.lastStepTs : null,
            ms_since_start: jobTrace.startTs ? now - jobTrace.startTs : null,
        };
    }

    function markStackStart() { jobTrace.startTs = Date.now(); jobTrace.lastStep = null; jobTrace.lastStepTs = 0; }
    function markStackStep(step) { jobTrace.lastStep = step; jobTrace.lastStepTs = Date.now(); }
    function markStackStop() { jobTrace.startTs = 0; jobTrace.lastStep = null; jobTrace.lastStepTs = 0; }

    function clearTrackingContext() {
        trackingContext.value = { file_type: null, reader: null, initial_reader: null, gpu_enabled: null };
    }

    return {
        inputFilename,
        setInputFilename,
        startNewStackJob,
        getOutputFilename,
        getInputFilename,
        minApQuality,
        setMinApQuality,
        getMinApQuality,
        apPatchSize,
        setApPatchSize,
        getApPatchSize,
        pixfrac,
        setPixfrac,
        getPixfrac,
        stackingMode,
        setStackingMode,
        getStackingMode,
        lowResCropDetect,
        setLowResCropDetect,
        getLowResCropDetect,
        continuousStackingResults,
        setContinuousResults,
        getContinuousResults,
        batchStartIndex,
        setBatchStartIndex,
        getBatchStartIndex,
        setTrackingContext,
        getTrackingContext,
        getStackJobProps,
        markStackStart,
        markStackStep,
        markStackStop,
        clearTrackingContext,
        getStackJobId,
    };
}

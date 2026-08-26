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
    file_type: null,  // 'ser', 'avi', 'video', 'images'
    reader: null,     // 'debayer', 'avi', 'ffmpeg', 'image'
    gpu_enabled: null // true/false
});

const stackingMode = ref('single'); // 'single' or 'continuous'
const continuousStackingResults = ref([]); // Stores [pct, blob, sharpness] for comparison
const batchStartIndex = ref(0); // Initial index for BatchPostProcessor

export function useProcessingState() {
    function setInputFilename(filename) {
        // Store full filename for error reporting
        inputFilenameWithExt.value = filename;
        // Strip extension and store base name for output naming
        inputFilename.value = filename.replace(/\.[^/.]+$/, '');
        // Fresh job identifier for this attempt. 8 base-36 chars ≈ 40 bits of
        // entropy per attempt — enough to avoid collisions within any user's
        // session without bloating props payloads.
        stackJobId.value = shortJobHash(`${filename}|${Date.now()}|${Math.random()}`);
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
        trackingContext.value = { file_type, reader, gpu_enabled };
    }

    function getTrackingContext() {
        // Always carry the job id so every stack_* event can be joined for
        // one attempt in analytics without extra plumbing at each call site.
        return { ...trackingContext.value, stack_job_id: stackJobId.value || null };
    }

    function clearTrackingContext() {
        trackingContext.value = { file_type: null, reader: null, gpu_enabled: null };
    }

    return {
        inputFilename,
        setInputFilename,
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
        continuousStackingResults,
        setContinuousResults,
        getContinuousResults,
        batchStartIndex,
        setBatchStartIndex,
        getBatchStartIndex,
        setTrackingContext,
        getTrackingContext,
        clearTrackingContext,
        getStackJobId,
    };
}

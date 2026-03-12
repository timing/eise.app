// composables/useProcessingState.js
// Shared state for the current processing session

import { ref } from 'vue';

const inputFilename = ref('');
const inputFilenameWithExt = ref('');
const minApQuality = ref(0.3);
const apPatchSize = ref(20);

// Tracking context for analytics
const trackingContext = ref({
    file_type: null,  // 'ser', 'avi', 'video', 'images'
    reader: null,     // 'debayer', 'avi', 'ffmpeg', 'image'
    gpu_enabled: null // true/false
});

export function useProcessingState() {
    function setInputFilename(filename) {
        // Store full filename for error reporting
        inputFilenameWithExt.value = filename;
        // Strip extension and store base name for output naming
        inputFilename.value = filename.replace(/\.[^/.]+$/, '');
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

    function setTrackingContext({ file_type, reader, gpu_enabled }) {
        trackingContext.value = { file_type, reader, gpu_enabled };
    }

    function getTrackingContext() {
        return trackingContext.value;
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
        setTrackingContext,
        getTrackingContext,
        clearTrackingContext
    };
}

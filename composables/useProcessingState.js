// composables/useProcessingState.js
// Shared state for the current processing session

import { ref } from 'vue';

const inputFilename = ref('');
const inputFilenameWithExt = ref('');
const minApQuality = ref(0.3);
const apPatchSize = ref(20);

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
        getApPatchSize
    };
}

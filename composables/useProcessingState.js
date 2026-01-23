// composables/useProcessingState.js
// Shared state for the current processing session

import { ref } from 'vue';

const inputFilename = ref('');
const inputFilenameWithExt = ref('');

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

    return {
        inputFilename,
        setInputFilename,
        getOutputFilename,
        getInputFilename
    };
}

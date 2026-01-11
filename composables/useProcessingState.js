// composables/useProcessingState.js
// Shared state for the current processing session

import { ref } from 'vue';

const inputFilename = ref('');

export function useProcessingState() {
    function setInputFilename(filename) {
        // Strip extension and store base name
        inputFilename.value = filename.replace(/\.[^/.]+$/, '');
    }

    function getOutputFilename(suffix, extension) {
        const base = inputFilename.value || 'eise_app';
        return `${base}_${suffix}.${extension}`;
    }

    return {
        inputFilename,
        setInputFilename,
        getOutputFilename
    };
}

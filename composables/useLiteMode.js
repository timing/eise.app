// Shared reactive state for Lite mode detection
// Set by app.vue based on mobile detection, WebGPU support, and force flag
// Read by composables that need to adjust memory limits

import { ref } from 'vue';

// Shared state - singleton across all imports
const liteMode = ref(false);

export function useLiteMode() {
    /**
     * Set lite mode state (call from app.vue)
     * @param {boolean} value
     */
    function setLiteMode(value) {
        liteMode.value = value;
    }

    /**
     * Check if lite mode is enabled
     * @returns {boolean}
     */
    function isLiteMode() {
        return liteMode.value;
    }

    return {
        liteMode,
        setLiteMode,
        isLiteMode
    };
}

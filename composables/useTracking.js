// composables/useTracking.js

const PIXEL_URL = 'https://analytics.tijmentiming.workers.dev/pixel.gif';

export function useTracking() {
    function track(event) {
        if (typeof window === 'undefined') return;

        const img = new Image();
        img.src = `${PIXEL_URL}?e=${encodeURIComponent(event)}`;
    }

    return { track };
}

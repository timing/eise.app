// composables/useTracking.js

const PIXEL_URL = 'https://analytics.tijmentiming.workers.dev/pixel.gif';

let humanInteractionTracked = false;

export function useTracking() {
    function track(event) {
        if (typeof window === 'undefined') return;

        const img = new Image();
        img.src = `${PIXEL_URL}?e=${encodeURIComponent(event)}`;

        // Also send to Simple Analytics (if loaded)
        if (typeof window.sa_event === 'function') {
            window.sa_event(event);
        }
    }

    function trackHumanInteraction() {
        if (typeof window === 'undefined' || humanInteractionTracked) return;

        const onInteraction = () => {
            if (humanInteractionTracked) return;
            humanInteractionTracked = true;
            track('human_interaction');
            // Remove all listeners after first interaction
            window.removeEventListener('scroll', onInteraction);
            window.removeEventListener('mousemove', onInteraction);
            window.removeEventListener('mousedown', onInteraction);
            window.removeEventListener('touchstart', onInteraction);
            window.removeEventListener('keydown', onInteraction);
        };

        window.addEventListener('scroll', onInteraction, { once: true, passive: true });
        window.addEventListener('mousemove', onInteraction, { once: true, passive: true });
        window.addEventListener('mousedown', onInteraction, { once: true, passive: true });
        window.addEventListener('touchstart', onInteraction, { once: true, passive: true });
        window.addEventListener('keydown', onInteraction, { once: true, passive: true });
    }

    return { track, trackHumanInteraction };
}

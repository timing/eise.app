// composables/useTracking.js

let humanInteractionTracked = false;

export function useTracking() {
    function track(event, metadata = null) {
        if (typeof window === 'undefined') return;

        // Send to Simple Analytics (if loaded)
        if (typeof window.sa_event === 'function') {
            if (metadata) {
                window.sa_event(event, metadata);
            } else {
                window.sa_event(event);
            }
        }

        // Send to eise analytics (if beacon loaded)
        if (window.eise && typeof window.eise.track === 'function') {
            window.eise.track(event, metadata || undefined);
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

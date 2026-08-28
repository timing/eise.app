// composables/useTracking.js

import { getVariant } from '@/composables/useAbTest';

let humanInteractionTracked = false;

// Experiments whose variant should be reported with each tracked event.
// Sent at the top-level `variants` field so the server can attach them to
// the session once, instead of duplicating on every event's props.
// video_reader concluded — rolled back to A (mediabunny-first) so we get the
// fullest pass-2 telemetry coverage during the ongoing 4K stall investigation.
// Historical variant data stays on old sessions; new sessions carry no variant.
const ACTIVE_EXPERIMENTS = [];

function activeVariants() {
    const v = {};
    for (const name of ACTIVE_EXPERIMENTS) {
        v[name] = getVariant(name);
    }
    return v;
}

export function useTracking() {
    function track(event, metadata = null) {
        if (typeof window === 'undefined') return;

        const variants = activeVariants();

        // Simple Analytics uses a flat props bag; keep ab_<name> merged for it.
        if (typeof window.sa_event === 'function') {
            const saProps = { ...(metadata || {}) };
            for (const [name, v] of Object.entries(variants)) saProps[`ab_${name}`] = v;
            window.sa_event(event, saProps);
        }

        // eise analytics: props stays clean; variants travel separately.
        if (window.eise && typeof window.eise.track === 'function') {
            window.eise.track(event, metadata, { variants });
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

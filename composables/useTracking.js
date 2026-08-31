// composables/useTracking.js

let humanInteractionTracked = false;

// Experiments whose variant should be reported with each tracked event.
// Sent at the top-level `variants` field so the server can attach them to
// the session once, instead of duplicating on every event's props.
// social_proof_counter: desktop-only "N Stacks today" badge between logo and nav.
const ACTIVE_EXPERIMENTS = ['social_proof_counter'];

// Read a variant from localStorage WITHOUT assigning one. This keeps
// non-enrolled users (e.g. mobile visitors for the desktop-only counter test)
// from getting a stray variants_json entry every time they fire an event.
// The experiment's own useAbTest() call is what actually enrolls a user.
function readStoredVariant(name) {
    if (typeof window === 'undefined') return null;
    try {
        const v = window.localStorage.getItem(`ab_${name}`);
        return v === 'A' || v === 'B' ? v : null;
    } catch {
        return null;
    }
}

function activeVariants() {
    const v = {};
    for (const name of ACTIVE_EXPERIMENTS) {
        const variant = readStoredVariant(name);
        if (variant) v[name] = variant;
    }
    return v;
}

export function useTracking() {
    // Returns Promise<boolean> from the eise beacon: true if the event landed
    // (2xx), false if it didn't. Callers that don't care can ignore it. Used by
    // stack_ping to keep undelivered log lines in a retry queue.
    function track(event, metadata = null) {
        if (typeof window === 'undefined') return Promise.resolve(false);

        const variants = activeVariants();

        // Simple Analytics uses a flat props bag; keep ab_<name> merged for it.
        if (typeof window.sa_event === 'function') {
            const saProps = { ...(metadata || {}) };
            for (const [name, v] of Object.entries(variants)) saProps[`ab_${name}`] = v;
            window.sa_event(event, saProps);
        }

        // eise analytics: props stays clean; variants travel separately.
        if (window.eise && typeof window.eise.track === 'function') {
            const p = window.eise.track(event, metadata, { variants });
            return (p && typeof p.then === 'function') ? p : Promise.resolve(true);
        }
        return Promise.resolve(false);
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

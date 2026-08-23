// composables/useAbTest.js
//
// Simple per-experiment A/B assignment with:
//   - persistent localStorage bucket keyed as ab_<name>
//   - GET param override: ?ab_<name>=A | B | clear (persists across reloads;
//     "clear" removes the stored value so the next visit re-randomizes)
//   - deterministic on SSR (defaults to 'A') to avoid hydration mismatch;
//     the client re-evaluates on mount.

const assignments = new Map(); // name -> 'A' | 'B' (client-only cache)

function readParam(name) {
    if (typeof window === 'undefined') return null;
    try {
        const params = new URLSearchParams(window.location.search);
        const v = params.get(`ab_${name}`);
        if (v === 'A' || v === 'B') return v;
        if (v === 'clear') return 'clear';
        return null;
    } catch {
        return null;
    }
}

function readStored(name) {
    try {
        const v = window.localStorage.getItem(`ab_${name}`);
        return v === 'A' || v === 'B' ? v : null;
    } catch {
        return null;
    }
}

function writeStored(name, variant) {
    try {
        window.localStorage.setItem(`ab_${name}`, variant);
    } catch {}
}

function clearStored(name) {
    try {
        window.localStorage.removeItem(`ab_${name}`);
    } catch {}
}

function pickRandom() {
    return Math.random() < 0.5 ? 'A' : 'B';
}

// Resolve the variant for an experiment on the client. Order of precedence:
//   1. ?ab_<name>=clear → wipe stored, then randomize fresh
//   2. ?ab_<name>=A|B   → override + persist
//   3. localStorage     → existing assignment
//   4. random 50/50     → assign + persist
function resolveClient(name) {
    if (assignments.has(name)) return assignments.get(name);

    const param = readParam(name);
    if (param === 'clear') {
        clearStored(name);
        const fresh = pickRandom();
        writeStored(name, fresh);
        assignments.set(name, fresh);
        return fresh;
    }
    if (param === 'A' || param === 'B') {
        writeStored(name, param);
        assignments.set(name, param);
        return param;
    }

    const stored = readStored(name);
    if (stored) {
        assignments.set(name, stored);
        return stored;
    }

    const fresh = pickRandom();
    writeStored(name, fresh);
    assignments.set(name, fresh);
    return fresh;
}

// Synchronous getter for use inside track() (no reactivity required).
export function getVariant(name) {
    if (typeof window === 'undefined') return 'A';
    return resolveClient(name);
}

// Reactive Vue accessor. Returns a ref that starts as 'A' during SSR and
// updates to the resolved variant on mount.
export function useAbTest(name) {
    const variant = ref('A');
    if (typeof window !== 'undefined') {
        // If Nuxt's onMounted is available we defer to avoid SSR hydration
        // mismatch; otherwise resolve immediately.
        if (typeof onMounted === 'function') {
            onMounted(() => {
                variant.value = resolveClient(name);
            });
        } else {
            variant.value = resolveClient(name);
        }
    }
    return variant;
}

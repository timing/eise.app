// Reload the tab once when we detect the current bundle is stale after a deploy.
// Covers Sentry groups EISE-J5/J4/J3/HA/G8/EISE-30 (~50 events): dynamic import failures,
// CSS preload failures, and 404s on /_nuxt/builds/meta/*.json.
//
// The Nuxt `experimental.emitRouteChunkError: 'automatic'` flag handles route-chunk errors.
// This plugin catches the other cases: `vite:preloadError` and unhandled fetch 404s for
// stale build-meta files.

export default defineNuxtPlugin(() => {
    if (typeof window === 'undefined') return;

    const RELOAD_KEY = 'eise:chunk-reload-at';
    const RELOAD_COOLDOWN_MS = 60_000;

    function tryReload(reason) {
        let last = 0;
        try { last = Number(sessionStorage.getItem(RELOAD_KEY) || 0); } catch {}
        const now = Date.now();
        if (now - last < RELOAD_COOLDOWN_MS) {
            console.warn(`[stale-chunk] skipping reload for "${reason}" — reloaded ${now - last}ms ago`);
            return;
        }
        try { sessionStorage.setItem(RELOAD_KEY, String(now)); } catch {}
        console.info(`[stale-chunk] reloading tab: ${reason}`);
        window.location.reload();
    }

    // Vite dispatches this when a <link rel="modulepreload"> / preload chunk fails to load.
    window.addEventListener('vite:preloadError', (event) => {
        event.preventDefault?.();
        tryReload(`vite:preloadError ${event.payload?.message || event.message || ''}`);
    });
});

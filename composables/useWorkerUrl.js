/**
 * Provides cache-busted worker URLs using build timestamp
 */
export function useWorkerUrl() {
    const config = useRuntimeConfig();
    const buildTs = Math.floor(config.public.buildTimestamp / 1000); // seconds

    /**
     * Get worker URL with cache busting query param
     * @param {string} path - Worker path like '/webgpu_worker.js'
     * @returns {string} - Path with cache bust param like '/webgpu_worker.js?v=1737820800'
     */
    function workerUrl(path) {
        return `${path}?v=${buildTs}`;
    }

    return { workerUrl };
}

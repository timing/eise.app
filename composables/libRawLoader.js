/**
 * Loads libraw-wasm from /libraw/ instead of through the bundler.
 *
 * libraw-wasm's Emscripten pthreads build (dist/libraw.js) contains
 * `new Worker(new URL("libraw.js", import.meta.url), { type: "module" })`,
 * pointing at itself. Vite resolves `new Worker(new URL())` statically and
 * spawns a nested Rollup build per occurrence, so that self-reference recurses
 * without bound until the build OOMs — which is exactly how the 2026-09-20
 * Cloudflare deploy died ("Ineffective mark-compacts near heap limit").
 * `optimizeDeps.exclude` does not help; it only covers dev pre-bundling.
 *
 * Keeping the specifier in a variable behind @vite-ignore means Vite never
 * parses the package, so no worker pass ever runs over it. At runtime
 * import.meta.url inside index.js is /libraw/index.js, so its relative
 * worker.js / libraw.js / libraw.wasm all resolve as real static files.
 * scripts/sync-libraw.mjs keeps public/libraw/ in step with node_modules.
 */

// Indirection is load-bearing: a literal here would be statically analysable
// again and the recursion would come straight back.
const LIBRAW_ENTRY = '/libraw/index.js';

let ctorPromise = null;

/** Resolve the LibRaw constructor, fetching /libraw/index.js at most once. */
export function loadLibRawCtor() {
	if (!ctorPromise) {
		ctorPromise = import(/* @vite-ignore */ LIBRAW_ENTRY)
			.then(({ default: LibRaw }) => {
				if (typeof LibRaw !== 'function') {
					throw new Error('libraw: /libraw/index.js has no default export');
				}
				return LibRaw;
			})
			.catch((e) => {
				// Let a later attempt retry rather than caching the failure forever.
				ctorPromise = null;
				throw e;
			});
	}
	return ctorPromise;
}

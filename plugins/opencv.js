import { defineNuxtPlugin } from '#app'

export default defineNuxtPlugin(nuxtApp => {
	// Lazy load OpenCV - only when first needed
	// Use window-level flags to prevent duplicate loading across HMR/refreshes
	const loadOpenCV = () => {
		if (typeof window === 'undefined') return Promise.resolve();

		// Check if already loaded
		if (window.__cvLoaded) return Promise.resolve();
		if (window.__cvLoadPromise) return window.__cvLoadPromise;

		// Check if script tag already exists
		const existingScript = document.querySelector('script[src*="opencv-bindings"]');
		if (existingScript && window.cv) {
			window.__cvLoaded = true;
			return Promise.resolve();
		}

		window.__cvLoadPromise = new Promise((resolve, reject) => {
			console.log('Loading OpenCV...');
			const script = document.createElement('script');
			// Served from public/ rather than a CDN: the Electron build has no
			// network guarantee, and a blocked or unreachable jsdelivr took out
			// the CPU fallback for exactly the users who have no WebGPU (EISE-E).
			script.src = '/opencv/opencv-bindings-4.5.5.min.js';
			script.id = 'opencv-script';
			script.onload = () => {
				cv['onRuntimeInitialized'] = () => {
					console.log('OpenCV loaded');
					window.__cvLoaded = true;
					resolve();
				};
			};
			script.onerror = (err) => {
				console.error('Failed to load OpenCV:', err);
				window.__cvLoadPromise = null; // Allow retry
				reject(new Error('Failed to load OpenCV. Please check your connection and refresh.'));
			};
			document.head.appendChild(script);
		});

		return window.__cvLoadPromise;
	};

	nuxtApp.provide('loadOpenCV', loadOpenCV);
})


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
			script.src = 'https://cdn.jsdelivr.net/npm/opencv-bindings@4.5.5/index.min.js';
			script.crossOrigin = 'anonymous';
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


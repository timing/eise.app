// https://nuxt.com/docs/api/configuration/nuxt-config
// also trying to fix this: https://github.com/nuxt/nuxt/issues/22141
export default defineNuxtConfig({
	devtools: { enabled: true },
	vite: {
		optimizeDeps: {
			include: ['@ffmpeg/ffmpeg']
		}
	},
	plugins: [
		{src: '~/plugins/opencv.js', mode: 'client'}
	],
	// see https://github.com/nuxt/nuxt/issues/22141
	vite: {
		server: {
			headers: {
				'Cross-Origin-Embedder-Policy': 'require-corp',
				'Cross-Origin-Opener-Policy': 'same-origin'
			}
		} 
	}
})

// https://nuxt.com/docs/api/configuration/nuxt-config
// also trying to fix this: https://github.com/nuxt/nuxt/issues/22141
export default defineNuxtConfig({
	devtools: { enabled: true },
	app: {
		head: {
			script: [
				{
					src: 'https://scripts.simpleanalyticscdn.com/latest.js',
					async: true,
					'data-collect-dnt': 'true'
				}
			]
		}
	},
	runtimeConfig: {
		public: {
			buildTimestamp: Date.now() // Unix timestamp in ms, set at build time
		}
	},
	plugins: [
		'~/plugins/sentry.client.js',
		'~/plugins/ffmpeg.js',
		{src: '~/plugins/opencv.js', mode: 'client'}
	],
	// see https://github.com/nuxt/nuxt/issues/22141
	routeRules: {
		'/': {
			headers: {
				'Cross-Origin-Embedder-Policy': 'require-corp',
				'Cross-Origin-Opener-Policy': 'same-origin'
			}
		}
	},
	vite: {
		optimizeDeps: {
			include: ['@ffmpeg/ffmpeg']
		},
		server: {
			headers: {
				'Cross-Origin-Embedder-Policy': 'require-corp',
				'Cross-Origin-Opener-Policy': 'same-origin'
			}
		} 
	}/*,
	serverMiddleware: [
		'~/server/middleware/headers.ts',
	]*/
})

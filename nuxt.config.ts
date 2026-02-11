// https://nuxt.com/docs/api/configuration/nuxt-config
// also trying to fix this: https://github.com/nuxt/nuxt/issues/22141
export default defineNuxtConfig({
	devtools: { enabled: true },
	app: {
		head: {
			meta: [
				{ property: 'og:type', content: 'website' },
				{ property: 'og:site_name', content: 'eise.app' },
				{ property: 'og:image', content: 'https://eise.app/screenshot-1.png' },
				{ property: 'og:image:width', content: '1928' },
				{ property: 'og:image:height', content: '1500' },
				{ property: 'og:image:alt', content: 'eise.app - Browser-based planetary image stacker for astrophotography' },
				{ name: 'twitter:card', content: 'summary_large_image' },
				{ name: 'twitter:image', content: 'https://eise.app/screenshot-1.png' },
			],
			script: [
				{
					src: 'https://scripts.simpleanalyticscdn.com/latest.js',
					async: true,
					defer: true,
					crossorigin: 'anonymous',
				}
			],
			noscript: [
				{ children: '<img src="https://queue.simpleanalyticscdn.com/noscript.gif" alt="" referrerpolicy="no-referrer-when-downgrade" />' }
			]
		}
	},
	router: {
		options: {
			trailingSlash: false
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
		},
		build: {
			sourcemap: true // Enable source maps for better Sentry stack traces
		}
	}/*,
	serverMiddleware: [
		'~/server/middleware/headers.ts',
	]*/
})

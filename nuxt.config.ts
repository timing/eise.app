// https://nuxt.com/docs/api/configuration/nuxt-config
// also trying to fix this: https://github.com/nuxt/nuxt/issues/22141

// Cloudflare Pages sets CF_PAGES_BRANCH during build
const isProduction = process.env.CF_PAGES_BRANCH === 'main';
const robotsContent = isProduction ? 'index, follow' : 'noindex, nofollow';

export default defineNuxtConfig({
	devtools: { enabled: true },
	app: {
		head: {
			link: [
				{ rel: 'alternate', type: 'text/markdown', href: '/llms.txt' }
			],
			meta: [
				{ name: 'robots', content: robotsContent },
				{ property: 'og:type', content: 'website' },
				{ property: 'og:site_name', content: 'Eise.app' },
				{ property: 'og:image', content: 'https://eise.app/screenshot-1.png' },
				{ property: 'og:image:width', content: '1928' },
				{ property: 'og:image:height', content: '1500' },
				{ property: 'og:image:alt', content: 'Eise.app - Browser-based planetary image stacker for astrophotography' },
				{ name: 'twitter:card', content: 'summary_large_image' },
				{ name: 'twitter:image', content: 'https://eise.app/screenshot-1.png' },
			],
			script: [
				{
					src: 'https://api.eise.app/latest.js',
					async: true,
					defer: true,
					'data-hostname': isProduction ? 'eise.app' : 'localhost.eise.app',
				}
			],
			noscript: [
				{ children: '<img src="https://api.eise.app/noscript.gif" alt="" referrerpolicy="no-referrer-when-downgrade" />' }
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

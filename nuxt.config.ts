// https://nuxt.com/docs/api/configuration/nuxt-config
// also trying to fix this: https://github.com/nuxt/nuxt/issues/22141

import { sentryVitePlugin } from '@sentry/vite-plugin';

// Cloudflare Pages sets CF_PAGES_BRANCH during build
const isProduction = process.env.CF_PAGES_BRANCH === 'main';
const robotsContent = isProduction ? 'index, follow' : 'noindex, nofollow';

// Electron builds set EISE_BUILD_TARGET=electron so analytics land in a separate
// Simple Analytics hostname bucket instead of polluting web stats.
const isElectronBuild = process.env.EISE_BUILD_TARGET === 'electron';
const analyticsHostname = isElectronBuild
	? 'electron.eise.app'
	: (isProduction ? 'eise.app' : 'localhost.eise.app');

// Custom analytics beacon (parallel-run with Simple Analytics for validation).
const beaconSite = isElectronBuild
	? 'eise-electron'
	: (isProduction ? 'eise-prod' : 'eise-dev');
// In dev builds, point beacon at local gallery-api; prod hits the deployed edge script.
const beaconEndpoint = isProduction || isElectronBuild
	? 'https://gallery.eise.app/a'
	: 'http://localhost:8787/a';

// Sentry release identifier: prefer Cloudflare's commit SHA, fall back to local git or package version.
const sentryRelease =
	process.env.SENTRY_RELEASE ||
	process.env.CF_PAGES_COMMIT_SHA ||
	process.env.GITHUB_SHA ||
	`local-${Date.now()}`;

// Upload source maps only when the auth token is present at build time.
// Without a token the plugin is a no-op, so local `nuxt generate` still works.
const sentryUploadEnabled = !!process.env.SENTRY_AUTH_TOKEN;

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
					crossorigin: 'anonymous',
					'data-hostname': analyticsHostname,
				},
				{
					src: '/beacon.js',
					async: true,
					defer: true,
					'data-endpoint': beaconEndpoint,
					'data-site': beaconSite,
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
	experimental: {
		// Reload the app when a route-chunk load fails (stale bundle after a deploy).
		// Fires the app:chunkError hook and triggers reload automatically.
		emitRouteChunkError: 'automatic'
	},
	runtimeConfig: {
		public: {
			buildTimestamp: Date.now(), // Unix timestamp in ms, set at build time
			sentryRelease
		}
	},
	plugins: [
		'~/plugins/reload-on-stale-chunk.client.js',
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
		},
		plugins: [
			sentryVitePlugin({
				disable: !sentryUploadEnabled,
				org: process.env.SENTRY_ORG || 'eiseapp',
				project: process.env.SENTRY_PROJECT || 'eise',
				authToken: process.env.SENTRY_AUTH_TOKEN,
				release: { name: sentryRelease },
				sourcemaps: {
					filesToDeleteAfterUpload: ['dist/**/*.map', '.output/**/*.map']
				},
				telemetry: false
			})
		]
	}/*,
	serverMiddleware: [
		'~/server/middleware/headers.ts',
	]*/
})

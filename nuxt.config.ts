// https://nuxt.com/docs/api/configuration/nuxt-config
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
	serverMiddleware: [
		'~/middleware/securityHeaders.js',
	]
})

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
	]/*,
	security: {
        headers: {
			crossOriginEmbedderPolicy: 'require-corp',
			crossOriginOpenerPolicy: 'same-origin'
		}
	}*/
	,
	serverMiddleware: [
		'~/server/middleware/headers.ts',
	]
})

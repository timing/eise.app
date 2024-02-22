import { defineNuxtPlugin } from '#app'

export default defineNuxtPlugin(nuxtApp => {
	return new Promise((resolve) => {	
		const script = document.createElement('script')
		//script.src = 'https://cdn.jsdelivr.net/npm/opencv.js-webassembly@4.2.0/opencv.min.js' // Adjust the path if you're using a CDN
		script.src = 'https://cdn.jsdelivr.net/npm/opencv-bindings@4.5.5/index.min.js'
		script.onload = () => {
			cv['onRuntimeInitialized'] = () => {
				console.log('OpenCV loaded')
				resolve()
			}
		}
		document.head.appendChild(script)
	})
})


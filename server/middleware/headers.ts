// this one only works with the wavelet wasm, only the first two lines are needed for that, the rest is just trying to copy from below to have it work in both ways
/*export default defineEventHandler((event) => {
	setHeader(event, 'Cross-Origin-Embedder-Policy', 'require-corp');
	setHeader(event, 'crossOriginEmbedderPolicy', 'require-corp');
	setHeader(event, 'Cross-Origin-Opener-Policy', 'same-origin');
	setHeader(event, 'Access-Control-Allow-Origin', 'same-origin');
	setHeader(event, 'Cross-Origin-Resource-Policy', 'same-origin');
	setHeader(event, 'X-XSS-Protection', 1);
	setHeader(event,'contentSecurityPolicy', "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests");

});*/

// this one works only with ffmpeg
export default defineEventHandler((event) => {
    const headers = {
        'Access-Control-Allow-Origin': 'Same-Origin',
        'crossOriginResourcePolicy': 'same-origin',
        'crossOriginOpenerPolicy': 'same-origin',
        'crossOriginEmbedderPolicy': 'require-corp',
        'contentSecurityPolicy': "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests",
        'X-XSS-Protection': 1
    }
    setHeaders(event, headers)

})

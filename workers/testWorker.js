/*
	Test worker - for testing different worker inclusion methods on Cloudflare
	This file is intentionally in workers/ (not public/) to test Vite bundling
*/

self.addEventListener('message', (e) => {
	const { method, timestamp } = e.data;

	// Simulate some work
	const start = performance.now();
	let sum = 0;
	for (let i = 0; i < 1000000; i++) {
		sum += Math.sqrt(i);
	}
	const elapsed = performance.now() - start;

	self.postMessage({
		method,
		success: true,
		message: `Worker responded in ${elapsed.toFixed(2)}ms`,
		timestamp,
		computeResult: sum
	});
});

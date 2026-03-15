<template>
	<div class="page-layout page-layout-wide">
		<div class="content">
			<h2>Download eise.app</h2>
			<h3>Native app coming soon</h3>

			<p>
				Eise.app currently runs entirely in your browser - no installation needed.
				I'm exploring a native desktop and mobile app that could offer:
			</p>

			<ul class="benefits-list">
				<li><strong>Faster processing on mobile</strong> - Native code instead of WebAssembly or WebGPU</li>
				<li><strong>More memory on mobile</strong> - Process larger files and more frames</li>
				<li><strong>Full offline use</strong> - No internet connection required</li>
				<li><strong>Mobile stacking</strong> - Stack videos recorded with your phone, without sending them to your desktop</li>
			</ul>

			<div class="interest-form">
				<h3>Interested? Let me know!</h3>
				<p>Sign up to be notified when the native app becomes available. Your feedback helps me prioritize which platforms to support first.</p>

				<form
					action="https://app.us18.list-manage.com/subscribe/post?u=1e23126c833bf49699891f7d2&amp;id=bf3278e839"
					method="POST"
					target="_blank"
					class="signup-form"
				>
					<div class="form-row">
						<label for="mce-EMAIL">Email</label>
						<input type="email" name="EMAIL" id="mce-EMAIL" placeholder="your@email.com" required />
					</div>

					<div class="form-row">
						<label for="mce-PLATFORM">Which platform interests you most?</label>
						<select name="PLATFORM" id="mce-PLATFORM">
							<option value="Desktop - macOS">Desktop - macOS</option>
							<option value="Desktop - Windows">Desktop - Windows</option>
							<option value="Desktop - Linux">Desktop - Linux</option>
							<option value="Mobile - Android">Mobile - Android</option>
							<option value="Mobile - iOS">Mobile - iOS</option>
						</select>
					</div>

					<div class="form-row">
						<label for="mce-USECASE">How would you use it? (optional)</label>
						<input type="text" name="USECASE" id="mce-USECASE" placeholder="e.g., phone recordings through eyepiece, then stack with an app." />
					</div>

					<!-- Bot protection -->
					<div style="position: absolute; left: -5000px;" aria-hidden="true">
						<input type="text" name="b_1e23126c833bf49699891f7d2_bf3278e839" tabindex="-1" value="" />
					</div>

					<button type="submit" class="submit-btn">Notify me</button>
				</form>
			</div>

			<div class="current-option">
				<h3>Use eise.app now</h3>
				<p>
					The web version is fully functional and free to use.
					<NuxtLink to="/">Start stacking</NuxtLink> right in your browser -
					works on any device with a modern browser.
				</p>
			</div>
		</div>
	</div>
</template>

<script setup>
useHead({
	title: 'Download eise.app - Native App Coming Soon',
	meta: [
		{ name: 'description', content: 'Sign up to be notified when the native eise.app becomes available for desktop (Windows, macOS, Linux) and mobile (Android, iOS).' },
	],
});
</script>

<style scoped>
.benefits-list {
	margin: 1.5rem 0;
	padding-left: 1.5rem;
}

.benefits-list li {
	margin: 0.75rem 0;
	line-height: 1.5;
}

.interest-form {
	background: rgba(255, 255, 255, 0.05);
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 8px;
	padding: 1.5rem 2rem;
	margin: 2rem 0;
}

.interest-form h3 {
	margin-top: 0;
}

.signup-form {
	max-width: 400px;
}

.form-row {
	margin-bottom: 1rem;
}

.form-row label {
	display: block;
	margin-bottom: 0.4rem;
	font-weight: 500;
	font-size: 0.9rem;
}

.form-row input,
.form-row select {
	width: 100%;
	padding: 0.6rem 0.8rem;
	border: 1px solid #555;
	border-radius: 4px;
	background: #2a2a2a;
	color: #fff;
	font-size: 1rem;
	box-sizing: border-box;
}

.form-row input:focus,
.form-row select:focus {
	outline: none;
	border-color: #70f1ec;
}

.form-row input::placeholder {
	color: #777;
}

.submit-btn {
	background: #8CCF7E;
	color: #111;
	border: none;
	padding: 0.7rem 1.5rem;
	font-size: 1rem;
	font-weight: bold;
	border-radius: 4px;
	cursor: pointer;
	transition: background 0.2s;
	margin-top: 0.5rem;
}

.submit-btn:hover {
	background: #9ddb8f;
}

.current-option {
	margin-top: 2rem;
	padding-top: 1.5rem;
	border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.current-option h3 {
	margin-top: 0;
}
</style>

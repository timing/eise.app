<template>
	<form
		action="https://app.us18.list-manage.com/subscribe/post?u=1e23126c833bf49699891f7d2&amp;id=bf3278e839"
		method="POST"
		target="_blank"
		class="signup-form"
		@submit="onSubmit"
	>
		<div class="form-row">
			<label :for="emailId">Email</label>
			<input type="email" name="EMAIL" :id="emailId" placeholder="your@email.com" required />
		</div>

		<div v-if="showPlatform" class="form-row">
			<label :for="platformId">Which platform interests you most?</label>
			<select name="PLATFORM" :id="platformId">
				<option value="Mobile - Android">Android</option>
				<option value="Mobile - iOS">iOS</option>
			</select>
		</div>

		<div class="form-row">
			<label :for="usecaseId">{{ usecaseLabel }}</label>
			<input type="text" name="USECASE" :id="usecaseId" :placeholder="usecasePlaceholder" />
		</div>

		<!-- Bot protection -->
		<div style="position: absolute; left: -5000px;" aria-hidden="true">
			<input type="text" name="b_1e23126c833bf49699891f7d2_bf3278e839" tabindex="-1" value="" />
		</div>

		<button type="submit" class="submit-btn">{{ submitLabel }}</button>
	</form>
</template>

<script setup>
import { useTracking } from '~/composables/useTracking';

const props = defineProps({
	showPlatform: { type: Boolean, default: false },
	submitLabel: { type: String, default: 'Subscribe' },
	usecaseLabel: { type: String, default: 'Anything you\'d like to tell me? (optional)' },
	usecasePlaceholder: { type: String, default: '' },
	trackEvent: { type: String, default: 'mailinglist_signup' },
	trackSource: { type: String, default: '' },
});

const uid = Math.random().toString(36).slice(2, 8);
const emailId = `mce-EMAIL-${uid}`;
const platformId = `mce-PLATFORM-${uid}`;
const usecaseId = `mce-USECASE-${uid}`;

const { track } = useTracking();

function onSubmit() {
	track(props.trackEvent, props.trackSource ? { source: props.trackSource } : null);
}
</script>

<style scoped>
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
	border: 1px solid #ccc;
	border-radius: 4px;
	background: #fff;
	color: #222;
	font-size: 1rem;
	box-sizing: border-box;
}

.form-row input:focus,
.form-row select:focus {
	outline: none;
	border-color: #1a5a99;
}

.form-row input::placeholder {
	color: #999;
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
</style>

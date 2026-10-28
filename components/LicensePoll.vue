<template>
	<div class="license-poll">
		<p class="poll-question">{{ question }}</p>
		<p v-if="showOptions" class="poll-note">
			This is only a poll. Clicking an amount does not buy anything and will not
			take you to a payment page. You can change your answer afterwards.
		</p>

		<div v-if="showOptions" class="poll-options">
			<button
				v-for="amount in AMOUNTS"
				:key="amount"
				type="button"
				class="eise-cta poll-btn"
				:class="{ 'poll-btn-active': amount === choice }"
				:aria-pressed="amount === choice"
				@click="vote(amount)"
			>
				{{ label(amount) }}
			</button>
		</div>

		<p v-if="choice !== null && !editing" class="poll-thanks">
			Thanks! You picked {{ label(choice) }}.
			<button type="button" class="poll-change" @click="editing = true">Change my answer</button>
		</p>
	</div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useTracking } from '~/composables/useTracking';

const props = defineProps({
	question: {
		type: String,
		default: 'What would you pay for a desktop Eise.app? A one-off license, not a subscription.',
	},
	// Lets a second placement (e.g. the post-processor) be told apart in
	// analytics without adding a second event name.
	source: { type: String, default: 'download' },
});

// Ascending, with "Nothing" first. Leading on $20 would anchor the whole
// scale high and make the median read as a price people accept rather than
// one they chose.
const AMOUNTS = [0, 20, 30, 50, 100];
const STORAGE_KEY = 'eise-license-poll';

const { track } = useTracking();
// null until this browser has answered; otherwise the amount it last picked.
const choice = ref(null);
const editing = ref(false);

const showOptions = computed(() => choice.value === null || editing.value);

const label = (amount) => (amount === 0 ? 'Nothing' : `$${amount}`);

// Read on mount rather than at setup: this page is prerendered by `nuxt
// generate`, so touching localStorage during SSR would both throw and bake a
// stale answered/unanswered state into the static HTML.
onMounted(() => {
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		// Number('') is 0, which would silently read an empty entry as a "Nothing"
		// vote, so check the parsed value against the real options.
		const parsed = stored === null ? NaN : Number(stored);
		if (AMOUNTS.includes(parsed)) choice.value = parsed;
	} catch {
		// Private mode or storage disabled. Showing the poll again is a better
		// failure than hiding it, so leave choice null.
	}
});

function vote(amount) {
	// Re-clicking the current answer is a no-op rather than a duplicate event,
	// so someone fiddling with the buttons doesn't inflate the click count.
	if (amount === choice.value) { editing.value = false; return; }

	choice.value = amount;
	editing.value = false;

	// Every click is sent, including changes of mind. The admin panel keeps only
	// the latest per session, and the discarded ones are what it counts as
	// "changed". Value is a number so the panel can average it without parsing.
	// Currency is explicit because the buttons read "$" while the donations so
	// far arrived in EUR.
	track('license_price_vote', { value: amount, currency: 'USD', source: props.source });

	try {
		window.localStorage.setItem(STORAGE_KEY, String(amount));
	} catch {
		// The vote is already sent; losing the flag only costs this browser its
		// memory of the answer, and the panel dedupes by session anyway.
	}
}
</script>

<style scoped>
.license-poll {
	margin-top: 14px;
	padding-top: 14px;
	border-top: 1px solid var(--eise-panel-border);
}
.poll-question {
	margin: 0 0 4px;
	max-width: 58ch;
	font-size: 14px;
	line-height: 1.6;
	color: var(--eise-bright);
}
/* Sits between the question and the buttons so it is read before the click,
   not after. People assume a row of prices is a buy button. */
.poll-note {
	margin: 0 0 12px;
	max-width: 58ch;
	font-size: 13px;
	line-height: 1.55;
	color: var(--eise-muted-2);
}
.poll-options {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
}
/* .eise-cta is an <a> style in app.vue; these are real buttons, so the UA's
   own font and background have to be cleared for them to match. */
.poll-btn {
	font-family: inherit;
	font-weight: 600;
	cursor: pointer;
	min-width: 64px;
}
/* Marks the standing answer while someone is changing it. Same filled look
   .eise-cta uses on hover, so no new colour enters the palette. */
.poll-btn-active {
	background: var(--eise-gilt);
	border-color: var(--eise-gilt);
	color: var(--eise-ink);
}
.poll-thanks {
	margin: 0;
	font-size: 14px;
	line-height: 1.6;
	color: var(--eise-gilt-lt);
}
.poll-change {
	padding: 0;
	margin-left: 6px;
	border: none;
	background: none;
	font: inherit;
	color: var(--eise-link);
	text-decoration: underline;
	cursor: pointer;
}
</style>

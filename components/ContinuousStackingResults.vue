<template>
<div class="page-layout stack-layout">
	<div class="panel">
		<!-- Same card as the stack panel and the post processor: continuous runs
		     are long, so what is being stacked stays named throughout. -->
		<div v-if="sourceFile" class="panel-section">
			<FileMetaCard :file="sourceFile" :profile="sourceColorProfile" />
		</div>

		<div class="panel-section">
			<div class="caption">
				<span class="caption-dot" aria-hidden="true"></span>
				<span>Continuous stacking</span>
			</div>
			<p class="panel-note csr-lede">Eise is now stacking frames continuously from {{ firstPercentage }}% up to {{ lastPercentage }}%, so you can pick the best result in the Post Processor.</p>

			<template v-if="isProcessing">
				<div class="loading-readout">
					<span class="frame-counter" v-if="stackingTotal > 0">{{ stackingCurrent }} / {{ stackingTotal }}</span>
					<span class="loading-percent">{{ stackingProgress }}%</span>
				</div>
				<div class="loading-indicator">
					<div class="determinate" :style="{ width: stackingProgress + '%' }"></div>
				</div>
			</template>

			<!-- One tick per snapshot the run will produce, so the remaining
			     work is visible from the first stack onwards. -->
			<div class="csr-stacks-head">
				<span class="panel-label csr-stacks-label">Stacks</span>
				<span v-if="isProcessing" class="csr-current">Stacking the <span class="csr-pct">{{ currentPercentage }}%</span> best frames</span>
			</div>
			<div class="csr-ticks" :style="{ gridTemplateColumns: `repeat(${ticks.length}, minmax(0, 1fr))` }">
				<span v-for="tick in ticks" :key="tick.percentage" class="csr-tick" :class="tick.state" :title="`${tick.percentage}%`"></span>
			</div>
			<div class="csr-scale">
				<span>{{ firstPercentage }}%</span>
				<span>{{ readyLabel }}</span>
				<span>{{ lastPercentage }}%</span>
			</div>
		</div>

		<div v-if="!isProcessing && results.length === 0" class="panel-section">
			<p class="panel-note csr-empty">No results produced yet. Stacking may have failed.</p>
		</div>

		<div class="panel-section csr-actions">
			<button v-if="isProcessing" class="cancel-btn" @click="abort">Abort stack</button>
			<button v-else class="btn-secondary" @click="cancel">{{ results.length === 0 ? 'Back' : 'Cancel' }}</button>
			<p v-if="isProcessing" class="panel-note csr-hint">Finished stacks can already be opened in the Post Processor while the rest continue.</p>
		</div>
	</div>

	<div class="content results-content" v-if="results.length > 0">
		<div class="csr-results-head">
			<span class="panel-label csr-results-label">Results</span>
			<span class="csr-ready">{{ readyLabel }}</span>
		</div>
		<div class="results-grid">
			<div v-for="result in sortedResults"
				 :key="result.percentage"
				 class="result-item no-click">
				<div class="result-preview">
					<img :src="getBlobUrl(result)" alt="Stacked result" />
					<div class="percentage-badge">{{ result.percentage }}%</div>
				</div>
				<!-- Direct children of the grid, not wrapped rows: the label and
				     the value are the two columns. -->
				<div class="result-info">
					<span class="label">Frames</span>
					<span class="value">{{ result.frameCount }}</span>
					<span class="label">Sharpness</span>
					<span class="value">{{ formatScore(result.sharpness) }}</span>
				</div>
			</div>
		</div>
	</div>
</div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useEventBus } from '@/composables/eventBus';
import { useProcessingState } from '@/composables/useProcessingState';
import { CONTINUOUS_PERCENTAGES } from '@/composables/useContinuousStacking';
import FileMetaCard from '@/components/FileMetaCard.vue';

const { on, off } = useEventBus();
const { sourceFile, sourceColorProfile } = useProcessingState();

const stackingProgress = ref(0);
const stackingCurrent = ref(0);
const stackingTotal = ref(0);

function onUpdateLoading(data) {
	if (typeof data === 'object') {
		if (data.progress >= 0) stackingProgress.value = Math.ceil(data.progress);
		if (data.current !== undefined) stackingCurrent.value = data.current;
		if (data.total !== undefined) stackingTotal.value = data.total;
	} else {
		stackingProgress.value = Math.ceil(data);
	}
}

onMounted(() => {
	on('update-loading', onUpdateLoading);
});

const props = defineProps({
	results: { type: Array, default: () => [] },
	isProcessing: { type: Boolean, default: false },
	currentPercentage: { type: Number, default: 0 }
});

const emit = defineEmits(['selected', 'cancel', 'abort']);

const urls = ref(new Map());

function getBlobUrl(result) {
    if (!result.blob) return '';
    if (urls.value.has(result.percentage)) {
        return urls.value.get(result.percentage);
    }
    const url = URL.createObjectURL(result.blob);
    urls.value.set(result.percentage, url);
    return url;
}

onUnmounted(() => {
    off('update-loading', onUpdateLoading);
    for (const url of urls.value.values()) {
        URL.revokeObjectURL(url);
    }
});

const sortedResults = computed(() => {
    return [...props.results].sort((a, b) => a.percentage - b.percentage);
});

const firstPercentage = CONTINUOUS_PERCENTAGES[0];
const lastPercentage = CONTINUOUS_PERCENTAGES[CONTINUOUS_PERCENTAGES.length - 1];

const ticks = computed(() => {
    const done = new Set(props.results.map(r => r.percentage));
    return CONTINUOUS_PERCENTAGES.map(percentage => ({
        percentage,
        state: done.has(percentage) ? 'is-done'
            : (props.isProcessing && percentage === props.currentPercentage) ? 'is-active'
            : 'is-pending'
    }));
});

const readyLabel = computed(() => `${props.results.length} of ${CONTINUOUS_PERCENTAGES.length} ready`);

function formatScore(val) {
    if (val === undefined || val === null) return 'N/A';
    return val.toFixed(4);
}

function selectResult(result) {
    emit('selected', result);
}

function cancel() {
    emit('cancel');
}

function abort() {
    emit('abort');
}
</script>

<style scoped>
/* Panel column -------------------------------------------------- */
/* .caption / .caption-dot / .loading-* come from LoadingIndicator's global
   stylesheet, so the progress block here reads identically to the one on the
   stack panel. */
.caption {
	margin-bottom: 10px;
}
.csr-lede {
	margin: 0 0 20px;
}
.csr-stacks-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
	margin-top: 22px;
}
.csr-stacks-label {
	margin-bottom: 0;
}
.csr-current {
	font-size: 12px;
	color: var(--eise-body);
	text-align: right;
}
.csr-pct {
	font-family: var(--eise-mono);
	color: var(--eise-gilt-lt);
}
.csr-ticks {
	display: grid;
	gap: 3px;
	margin-top: 9px;
}
.csr-tick {
	height: 14px;
	border-radius: 2px;
	background: rgba(255, 255, 255, 0.08);
}
.csr-tick.is-done {
	background: var(--eise-gilt);
}
.csr-tick.is-active {
	background: rgba(217, 169, 74, 0.5);
	animation: caption-pulse 1.4s ease-in-out infinite;
}
.csr-scale {
	display: flex;
	justify-content: space-between;
	gap: 12px;
	margin-top: 6px;
	font-family: var(--eise-mono);
	font-size: 10px;
	color: var(--eise-label);
}
.csr-empty {
	margin: 0;
	color: #e58a8a;
}
.csr-actions {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 0;
}
.csr-actions button {
	width: 100%;
}
.csr-hint {
	margin: 12px 0 0;
}

/* Results column ------------------------------------------------ */
.csr-results-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 16px;
	margin-bottom: 12px;
}
.csr-results-label {
	margin-bottom: 0;
}
.csr-ready {
	font-family: var(--eise-mono);
	font-size: 11px;
	color: var(--eise-muted);
}
/* Small tiles on purpose: this is a contact sheet of 18 near-identical stacks
   to scan for the sweet spot, not a place to judge detail. The chosen one gets
   the full canvas in the post processor. */
.results-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
	gap: 12px;
}

.result-item {
	background: rgba(0, 0, 0, 0.24);
	border: 1px solid var(--eise-panel-border);
	border-radius: 10px;
	overflow: hidden;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

.result-item.no-click {
	cursor: default;
}

.result-preview {
	position: relative;
	aspect-ratio: 1/1;
	background-color: #000;
	display: flex;
	align-items: center;
	justify-content: center;
}

.result-preview img {
	max-width: 100%;
	max-height: 100%;
	object-fit: contain;
}

.percentage-badge {
	position: absolute;
	top: 6px;
	left: 6px;
	padding: 1px 6px;
	border-radius: 4px;
	background: rgba(9, 52, 66, 0.82);
	border: 1px solid var(--eise-panel-border);
	font-family: var(--eise-mono);
	font-size: 10px;
	color: #fff;
}

.result-info {
	display: grid;
	grid-template-columns: 1fr auto;
	gap: 2px 10px;
	padding: 8px 10px;
	font-size: 11px;
}

.label {
	color: #8fa9b1;
}

.value {
	font-family: var(--eise-mono);
	color: var(--eise-bright);
	text-align: right;
}

@media (max-width: 600px) {
	.results-grid {
		grid-template-columns: repeat(2, 1fr);
	}
}
</style>

<template>
<div class="page-layout">
	<div class="card header-card">
		<h3>Continuous Stacking</h3>
		<p>Eise is now stacking frames in continuously from 5% up to 90% so you can pick the best result in the Post Processor.</p>

		<div v-if="isProcessing" class="processing-status">
			<div class="frame-counter" v-if="stackingTotal > 0">{{ stackingCurrent }} / {{ stackingTotal }}</div>
			<div class="loading-indicator">
				<div class="determinate" :style="{ width: stackingProgress + '%' }"></div>
			</div>
			<p>Stacking up to {{ currentPercentage }}% of frames</p>
            <button class="btn-danger small" @click="abort">Abort stack</button>
		</div>

		<div v-if="!isProcessing && results.length === 0" class="no-results">
			<p>No results produced yet. Stacking may have failed.</p>
			<button class="btn-primary" @click="cancel">Back</button>
		</div>

		<div class="action-buttons" v-if="!isProcessing">
			<button class="btn-secondary" @click="cancel">Cancel</button>
		</div>
	</div>

    <div class="content results-content" v-if="results.length > 0">
		<div class="results-grid">
			<div v-for="result in sortedResults" 
                 :key="result.percentage" 
                 class="result-item no-click">
				<div class="result-preview">
					<img :src="getBlobUrl(result)" alt="Stacked result" />
					<div class="percentage-badge">{{ result.percentage }}%</div>
				</div>
				<div class="result-info">
					<div class="info-row">
						<span class="label">Frames:</span>
						<span class="value">{{ result.frameCount }}</span>
					</div>
					<div class="info-row">
						<span class="label">Sharpness:</span>
						<span class="value">{{ formatScore(result.combined) }}</span>
					</div>
					<div class="info-row small">
						<span class="label">Tenengrad:</span>
						<span class="value">{{ formatScore(result.tenengrad) }}</span>
					</div>
					<div class="info-row small">
						<span class="label">Laplacian:</span>
						<span class="value">{{ formatScore(result.laplacian) }}</span>
					</div>
				</div>
			</div>
		</div>
    </div>
</div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useEventBus } from '@/composables/eventBus';

const { on, off } = useEventBus();

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

const maxCombined = computed(() => {
    if (props.results.length === 0) return 0;
    return Math.max(...props.results.map(r => r.combined));
});

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
.processing-status {
	margin: 20px 0;
	text-align: center;
}

.btn-danger.small {
    padding: 4px 12px;
    font-size: 12px;
    margin-top: 8px;
}

.results-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
	gap: 15px;
	margin: 20px 0;
}

.result-item {
	background-color: #152525;
	border: 1px solid #2a4a4a;
	border-radius: 8px;
	overflow: hidden;
	transition: transform 0.2s, border-color 0.2s;
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
	top: 8px;
	left: 8px;
	background-color: rgba(0, 0, 0, 0.7);
	color: #fff;
	padding: 2px 6px;
	border-radius: 4px;
	font-size: 12px;
	font-weight: bold;
}

.result-info {
	padding: 10px;
}

.info-row {
	display: flex;
	justify-content: space-between;
	margin-bottom: 2px;
	font-size: 13px;
}

.info-row.small {
	font-size: 11px;
	color: #8ababa;
}

.label {
	color: #c6fffd;
	opacity: 0.8;
}

.value {
	font-family: monospace;
	font-weight: bold;
	color: #c6fffd;
}

.no-results {
	padding: 40px;
	text-align: center;
	color: #ff5252;
}

.action-buttons {
	margin-top: 20px;
	display: flex;
	justify-content: center;
	gap: 10px;
}

@media (max-width: 600px) {
	.results-grid {
		grid-template-columns: repeat(2, 1fr);
	}
}
</style>

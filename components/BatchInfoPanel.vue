<template>
<div class="panel-section batch-panel">
	<div class="batch-head">
		<span class="panel-label batch-label">Batch · {{ files.length }} files</span>
		<button v-if="!isProcessing" class="panel-btn batch-head-btn" @click="handleClearBatch">Clear</button>
		<button v-else class="panel-btn batch-head-btn" @click="handleCancelBatch">Cancel</button>
	</div>

	<div class="batch-file-list">
		<div
			v-for="file in files"
			:key="file.id"
			class="batch-file-item"
			:class="[statusKind(file), { 'is-current': file.id === currentFile?.id }]"
		>
			<span class="batch-dot" aria-hidden="true"></span>
			<div class="batch-file-body">
				<!-- Same card as the stack panel and the post processor. -->
				<FileMetaCard :file="file.file || file" flat />
				<div class="batch-file-status">{{ statusLabel(file) }}</div>
				<div v-if="isRunning(file)" class="loading-indicator batch-bar">
					<div class="determinate" :style="{ width: file.progress + '%' }"></div>
				</div>
			</div>
			<button
				v-if="file.status === BatchStatus.PENDING && !isProcessing"
				class="remove-btn"
				@click="handleRemoveFile(file.id)"
				:title="`Remove ${file.name}`"
			>&times;</button>
		</div>
	</div>

	<button
		v-if="!isProcessing && files.length > 0"
		class="btn-primary batch-start"
		@click="handleStartBatch"
		:disabled="pendingCount === 0"
	>
		Stack {{ pendingCount }} file{{ pendingCount !== 1 ? 's' : '' }}
	</button>

	<div v-if="isProcessing" class="batch-overall">
		<div class="batch-overall-head">
			<span class="panel-label batch-label">Overall</span>
			<span class="batch-overall-count">{{ completedCount }} / {{ files.length }}</span>
		</div>
		<div class="loading-indicator">
			<div class="determinate" :style="{ width: batchProgress + '%' }"></div>
		</div>
	</div>
</div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useBatchProcessing, BatchStatus } from '@/composables/useBatchProcessing';
import { useEventBus } from '@/composables/eventBus';
import FileMetaCard from '@/components/FileMetaCard.vue';

const props = defineProps({
	settings: {
		type: Object,
		default: () => ({})
	}
});

const emit = defineEmits(['start', 'clear']);

const { on } = useEventBus();
const {
	files,
	currentFile,
	batchProgress,
	completedFiles,
	removeFile,
	startBatch,
	cancelBatch,
	clearBatch,
	getSettings
} = useBatchProcessing();

const isProcessing = ref(false);

// Computed properties
const pendingCount = computed(() =>
	files.value.filter(f => f.status === BatchStatus.PENDING).length
);

const completedCount = computed(() =>
	files.value.filter(f =>
		f.status === BatchStatus.COMPLETED ||
		f.status === BatchStatus.FAILED ||
		f.status === BatchStatus.CANCELLED
	).length
);

// Status, as one class and one line of text per file. The dot colours match the
// run steps in VideoFrameProcessor so the two panels read the same.
function isRunning(file) {
	return file.status === BatchStatus.ANALYZING || file.status === BatchStatus.STACKING;
}

function statusKind(file) {
	if (file.status === BatchStatus.COMPLETED) return 'is-done';
	if (file.status === BatchStatus.FAILED) return 'is-failed';
	if (file.status === BatchStatus.CANCELLED) return 'is-cancelled';
	if (isRunning(file)) return 'is-active';
	return 'is-pending';
}

function statusLabel(file) {
	if (file.status === BatchStatus.FAILED) return file.error || 'Failed';
	if (file.status === BatchStatus.CANCELLED) return 'Cancelled';
	if (file.status === BatchStatus.COMPLETED) return 'Completed';
	if (file.status === BatchStatus.ANALYZING) return `Analyzing ${Math.round(file.progress)}%`;
	if (file.status === BatchStatus.STACKING) return `Stacking ${Math.round(file.progress)}%`;
	// Pending: say what we know about the file if analysis already read it.
	const m = file.metadata;
	if (m) return `${m.width}×${m.height} · ${m.frameCount} frames`;
	return 'Pending';
}

// Event handlers
function handleRemoveFile(fileId) {
	removeFile(fileId);
}

async function handleStartBatch() {
	isProcessing.value = true;
	emit('start');

	await startBatch(props.settings);

	isProcessing.value = false;
}

function handleCancelBatch() {
	cancelBatch();
	isProcessing.value = false;
}

function handleClearBatch() {
	clearBatch();
	emit('clear');
}

// Listen for batch events
on('batch-started', () => {
	isProcessing.value = true;
});

on('batch-complete', () => {
	isProcessing.value = false;
});

on('batch-cancelled', () => {
	isProcessing.value = false;
});
</script>

<style scoped>
.batch-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 12px;
}
.batch-label {
	margin-bottom: 0;
}
/* Clearing or cancelling a batch is a quiet action, not a red alarm. */
.batch-head-btn {
	flex: 0 0 auto;
	padding: 5px 12px;
	font-size: 12px;
}

.batch-file-list {
	max-height: 320px;
	overflow-y: auto;
}

/* Same inset card as the stack panel's selected files. */
.batch-file-item {
	display: flex;
	align-items: flex-start;
	gap: 11px;
	padding: 12px 14px;
	margin-bottom: 8px;
	border-radius: 9px;
	background: rgba(0, 0, 0, 0.2);
	border: 1px solid rgba(255, 255, 255, 0.1);
	transition: border-color 120ms ease, background 120ms ease;
}
.batch-file-item:last-child {
	margin-bottom: 0;
}
.batch-file-item.is-current {
	border-color: rgba(217, 169, 74, 0.45);
	background: rgba(217, 169, 74, 0.1);
}

.batch-file-body {
	flex: 1;
	min-width: 0;
}

/* Dot states mirror the run steps: hollow queued, gilt running, green done. */
.batch-dot {
	flex: 0 0 auto;
	width: 7px;
	height: 7px;
	margin-top: 6px;
	border-radius: 50%;
	box-sizing: border-box;
	border: 1px solid rgba(255, 255, 255, 0.22);
}
.is-active .batch-dot {
	background: var(--eise-gilt);
	border: none;
	animation: caption-pulse 1.4s ease-in-out infinite;
}
.is-done .batch-dot {
	background: #5f9e7a;
	border: none;
}
.is-failed .batch-dot {
	background: #e58a8a;
	border: none;
}

.batch-file-status {
	margin-top: 5px;
	font-size: 11px;
	color: var(--eise-label);
}
.is-active .batch-file-status {
	color: #ffffff;
}
.is-done .batch-file-status {
	color: #8fa9b1;
}
.is-failed .batch-file-status {
	color: #e58a8a;
}

.batch-bar {
	margin-top: 7px;
	height: 4px;
}

.remove-btn {
	flex: 0 0 auto;
	width: 22px;
	height: 22px;
	padding: 0;
	border: none;
	border-radius: 50%;
	background: rgba(255, 255, 255, 0.08);
	color: var(--eise-body);
	font-size: 15px;
	line-height: 1;
	cursor: pointer;
}
.remove-btn:hover {
	background: #D9534F;
	color: #fff;
}

.batch-start {
	display: block;
	width: 100%;
	margin-top: 12px;
}

.batch-overall {
	margin-top: 16px;
	padding-top: 14px;
	border-top: 1px solid var(--eise-panel-line);
}
.batch-overall-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 9px;
}
.batch-overall-count {
	font-family: var(--eise-mono);
	font-size: 12px;
	color: var(--eise-gilt-lt);
}
</style>

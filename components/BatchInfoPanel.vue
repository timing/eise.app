<template>
<div class="batch-info-panel">
	<div class="batch-header">
		<h4>Batch: {{ files.length }} files</h4>
		<button v-if="!isProcessing" class="btn-danger btn-small" @click="handleClearBatch">Clear</button>
		<button v-if="isProcessing" class="btn-danger btn-small" @click="handleCancelBatch">Cancel</button>
	</div>

	<div class="batch-file-list">
		<div
			v-for="file in files"
			:key="file.id"
			class="batch-file-item"
			:class="{ 'is-current': file.id === currentFile?.id }"
		>
			<div class="file-row">
				<span class="file-status">
					<span v-if="file.status === 'completed'" class="status-icon completed">&#10003;</span>
					<span v-else-if="file.status === 'failed'" class="status-icon failed">&#10007;</span>
					<span v-else-if="file.status === 'cancelled'" class="status-icon cancelled">&#8722;</span>
					<span v-else-if="file.status === 'analyzing' || file.status === 'stacking'" class="status-icon processing">&#9684;</span>
					<span v-else class="status-icon pending">&#9675;</span>
				</span>
				<span class="file-name" :title="file.name">{{ truncateName(file.name) }}</span>
				<span class="file-size">{{ formatSize(file.size) }}</span>
				<button
					v-if="file.status === 'pending' && !isProcessing"
					class="remove-btn"
					@click="handleRemoveFile(file.id)"
					title="Remove from batch"
				>&times;</button>
			</div>

			<div class="file-details">
				<template v-if="file.metadata">
					<span class="detail">{{ file.metadata.width }}&times;{{ file.metadata.height }}</span>
					<span class="detail">{{ file.metadata.frameCount }} frames</span>
				</template>
				<template v-else-if="file.status === 'pending'">
					<span class="detail pending-text">Pending</span>
				</template>
			</div>

			<div v-if="file.status === 'analyzing' || file.status === 'stacking'" class="file-progress">
				<div class="progress-bar">
					<div class="progress-fill" :style="{ width: file.progress + '%' }"></div>
				</div>
				<span class="progress-text">
					{{ file.status === 'analyzing' ? 'Analyzing' : 'Stacking' }}... {{ Math.round(file.progress) }}%
				</span>
			</div>

			<div v-if="file.status === 'completed'" class="file-result">
				<span class="result-text">Completed</span>
			</div>

			<div v-if="file.status === 'failed'" class="file-error">
				<span class="error-text">{{ file.error || 'Failed' }}</span>
			</div>
		</div>
	</div>

	<div v-if="!isProcessing && files.length > 0" class="batch-actions">
		<button class="btn-primary" @click="handleStartBatch" :disabled="pendingCount === 0">
			Stack {{ pendingCount }} file{{ pendingCount !== 1 ? 's' : '' }}
		</button>
	</div>

	<div v-if="isProcessing" class="batch-progress">
		<div class="overall-progress">
			<span>Overall: {{ completedCount }}/{{ files.length }}</span>
			<div class="progress-bar">
				<div class="progress-fill" :style="{ width: batchProgress + '%' }"></div>
			</div>
		</div>
	</div>
</div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useBatchProcessing, formatFileSize, BatchStatus } from '@/composables/useBatchProcessing';
import { useEventBus } from '@/composables/eventBus';

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

// Helper functions
function truncateName(name, maxLength = 25) {
	if (name.length <= maxLength) return name;
	const ext = name.split('.').pop();
	const base = name.slice(0, -(ext.length + 1));
	const truncatedBase = base.slice(0, maxLength - ext.length - 4) + '...';
	return truncatedBase + '.' + ext;
}

function formatSize(bytes) {
	return formatFileSize(bytes);
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
.batch-info-panel {
	margin-top: 15px;
	border: 1px solid #ddd;
	border-radius: 8px;
	background: #f9f9f9;
	padding: 12px;
}

.batch-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 10px;
}

.batch-header h4 {
	margin: 0;
	font-size: 14px;
}

.btn-small {
	padding: 5px 10px;
	font-size: 12px;
}

.batch-file-list {
	max-height: 300px;
	overflow-y: auto;
}

.batch-file-item {
	background: white;
	border: 1px solid #e0e0e0;
	border-radius: 6px;
	padding: 8px 10px;
	margin-bottom: 8px;
}

.batch-file-item.is-current {
	border-color: #8CCF7E;
	background: #f0fff0;
}

.batch-file-item:last-child {
	margin-bottom: 0;
}

.file-row {
	display: flex;
	align-items: center;
	gap: 8px;
}

.file-status {
	flex-shrink: 0;
	width: 20px;
	text-align: center;
}

.status-icon {
	font-size: 14px;
}

.status-icon.completed {
	color: #4CAF50;
}

.status-icon.failed {
	color: #D9534F;
}

.status-icon.cancelled {
	color: #999;
}

.status-icon.processing {
	color: #2196F3;
	animation: spin 1s linear infinite;
}

.status-icon.pending {
	color: #999;
}

@keyframes spin {
	from { transform: rotate(0deg); }
	to { transform: rotate(360deg); }
}

.file-name {
	flex: 1;
	font-size: 13px;
	font-weight: 500;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.file-size {
	flex-shrink: 0;
	font-size: 11px;
	color: #888;
}

.remove-btn {
	flex-shrink: 0;
	width: 20px;
	height: 20px;
	padding: 0;
	border: none;
	background: #f0f0f0;
	border-radius: 50%;
	cursor: pointer;
	font-size: 14px;
	line-height: 1;
	color: #666;
}

.remove-btn:hover {
	background: #D9534F;
	color: white;
}

.file-details {
	display: flex;
	gap: 10px;
	margin-top: 4px;
	margin-left: 28px;
}

.detail {
	font-size: 11px;
	color: #666;
}

.pending-text {
	color: #999;
	font-style: italic;
}

.file-progress {
	margin-top: 6px;
	margin-left: 28px;
}

.progress-bar {
	height: 6px;
	background: #e0e0e0;
	border-radius: 3px;
	overflow: hidden;
}

.progress-fill {
	height: 100%;
	background: #8CCF7E;
	transition: width 0.3s ease;
}

.progress-text {
	font-size: 11px;
	color: #666;
	display: block;
	margin-top: 2px;
}

.file-result {
	margin-top: 4px;
	margin-left: 28px;
}

.result-text {
	font-size: 11px;
	color: #4CAF50;
}

.file-error {
	margin-top: 4px;
	margin-left: 28px;
}

.error-text {
	font-size: 11px;
	color: #D9534F;
}

.batch-actions {
	margin-top: 12px;
	text-align: center;
}

.batch-progress {
	margin-top: 12px;
	padding-top: 10px;
	border-top: 1px solid #ddd;
}

.overall-progress {
	display: flex;
	align-items: center;
	gap: 10px;
	font-size: 12px;
	color: #666;
}

.overall-progress .progress-bar {
	flex: 1;
}
</style>

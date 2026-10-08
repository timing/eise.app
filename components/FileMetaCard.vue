<template>
	<div class="file-meta" :class="{ 'file-meta-flat': flat }">
		<div class="file-meta-name" :title="file.name">{{ file.name }}</div>
		<div class="file-meta-row">
			<span>{{ sizeLabel }}</span>
			<template v-if="dateLabel">
				<span class="file-meta-sep">·</span>
				<span>{{ dateLabel }}</span>
			</template>
			<!-- The Bayer pattern is only known once a reader has read the
			     header, so the badge is absent for a freshly picked file and
			     for formats that never name one. -->
			<span v-if="profile" class="file-meta-badge">{{ profile }}</span>
		</div>
	</div>
</template>

<script setup>
import { computed } from 'vue';
import { formatFileSize } from '@/composables/useBatchProcessing';

const props = defineProps({
	// { name, size, lastModified } — a File works too.
	file: { type: Object, required: true },
	profile: { type: String, default: null },
	// Drop the inset background/border for places that already have one.
	flat: { type: Boolean, default: false }
});

const sizeLabel = computed(() => formatFileSize(props.file.size || 0));

const dateLabel = computed(() => {
	const ms = props.file.lastModified;
	if (!ms) return '';
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return '';
	return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
});
</script>

<style scoped>
.file-meta {
	min-width: 0;
	padding: 12px 14px;
	border-radius: 8px;
	background: rgba(0, 0, 0, 0.2);
	border: 1px solid rgba(255, 255, 255, 0.1);
}
.file-meta-flat {
	padding: 0;
	border: none;
	background: none;
}
.file-meta-name {
	font-family: var(--eise-mono);
	font-size: 12px;
	line-height: 1.45;
	color: var(--eise-bright);
	overflow-wrap: anywhere;
}
.file-meta-flat .file-meta-name {
	overflow-wrap: normal;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.file-meta-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 9px;
	margin-top: 5px;
	font-family: var(--eise-mono);
	font-size: 11px;
	color: #8fa9b1;
}
.file-meta-flat .file-meta-row {
	flex-wrap: nowrap;
	white-space: nowrap;
	overflow: hidden;
	margin-top: 3px;
}
.file-meta-sep {
	color: var(--eise-label);
}
.file-meta-badge {
	flex: 0 0 auto;
	padding: 1px 6px;
	border-radius: 4px;
	border: 1px solid rgba(217, 169, 74, 0.35);
	font-size: 10px;
	letter-spacing: 0.06em;
	color: var(--eise-gilt-lt);
}
</style>

<template>
	<div>
		<div class="zoomable-canvas-wrapper">
			<div class="canvas-topbar">Zoom: {{ Math.round(zoomLevel * 100) }}%</div>
			<div class="zoomable-canvas-container" @wheel.prevent="handleWheel" @mousedown="startDrag" @dblclick="handleDoubleClick" ref="container">
				<canvas ref="canvas" :id="id" :style="canvasStyle"></canvas>
			</div>
		</div>
	</div>
</template>

<script setup>
import { defineEmits, ref, onMounted, nextTick, computed } from 'vue';

const emit = defineEmits(['canvasReady']);

const props = defineProps({
	id: String
});

const canvas = ref(null);
const container = ref(null);
const zoomLevel = ref(1); // Initial zoom level
const position = ref({ x: 0, y: 0 });
const isDragging = ref(false); // Renamed to isDragging
const startPos = ref({ x: 0, y: 0 });

// Emit the canvas ref to parent right after it's mounted and ready
onMounted(async () => {
	await nextTick();
	emit('canvasReady', canvas);
});

const handleWheel = (event) => {
	event.preventDefault(); // Prevent the page from scrolling
	const scaleAmount = 0.02;
	const rect = canvas.value.getBoundingClientRect(); // Get canvas position and size
	const mouseX = event.clientX - rect.left; // Mouse X position within the canvas
	const mouseY = event.clientY - rect.top; // Mouse Y position within the canvas

	const oldZoom = zoomLevel.value;
	if (event.deltaY < 0) {
		// Zoom in
		zoomLevel.value = Math.min(zoomLevel.value + scaleAmount, 15); // Limit zoom in
	} else {
		// Zoom out
		zoomLevel.value = Math.max(zoomLevel.value - scaleAmount, 0.3); // Limit zoom out
	}

	if( Math.abs(1, zoomLevel.value) < 0.1 ){
		zoomLevel.value = 1;
	}
	
	const newZoom = zoomLevel.value;

	zoomLevel.value = Math.round(zoomLevel.value * 100) / 100;

	// Calculate the factor of zoom change
	const zoomFactor = newZoom - oldZoom;

	// Adjust the position to zoom towards the mouse position
	// This calculation keeps the mouse position a fixed point in the document
	// by adjusting the position based on the zoom change
	position.value.x -= mouseX * (zoomFactor / oldZoom);
	position.value.y -= mouseY * (zoomFactor / oldZoom);
};

const handleDoubleClick = (event) => {
	event.preventDefault();
	const scaleAmount = 0.5; // Adjust this value as needed
	zoomLevel.value = Math.min(zoomLevel.value + scaleAmount, 10); // Limit zoom in

	// Recalculate position to center the zoom on the double-click point
	const rect = canvas.value.getBoundingClientRect();
	const mouseX = event.clientX - rect.left;
	const mouseY = event.clientY - rect.top;
	const oldZoom = zoomLevel.value - scaleAmount; // Previous zoom before this click
	const newZoom = zoomLevel.value;
	const zoomFactor = newZoom / oldZoom;
	
	// Adjust position for the zoom towards the double-click point
	position.value.x -= (mouseX - position.value.x) * (zoomFactor - 1);
	position.value.y -= (mouseY - position.value.y) * (zoomFactor - 1);
};


const canvasStyle = computed(() => {
	return {
		transform: `translate(${position.value.x}px, ${position.value.y}px) scale(${zoomLevel.value})`,
		transformOrigin: 'top left',
		cursor: isDragging.value ? 'grabbing' : 'grab'
	};
});

const startDrag = (event) => {
	isDragging.value = true;
	startPos.value = { x: event.clientX - position.value.x, y: event.clientY - position.value.y };
	event.target.style.cursor = 'grabbing';
	document.addEventListener('mousemove', handleMouseMove);
	document.addEventListener('mouseup', handleMouseUp);
};

const handleMouseMove = (event) => {
	if (!isDragging.value) return;
	handleDrag(event);
};

const handleMouseUp = () => {
	document.removeEventListener('mousemove', handleMouseMove);
	document.removeEventListener('mouseup', handleMouseUp);
	endDrag();
};

const handleDrag = (event) => {
	if (isDragging.value) {
		position.value = {
			x: event.clientX - startPos.value.x,
			y: event.clientY - startPos.value.y
		};
	}
};

onUnmounted(() => {
	document.removeEventListener('mousemove', handleMouseMove);
	document.removeEventListener('mouseup', handleMouseUp);
});

const endDrag = () => {
	isDragging.value = false;
};

</script>

<style scoped>
.canvas-topbar {
	line-height: 20px;
	color: white;
	margin-top:-24px;
}
.zoomable-canvas-wrapper {
	height: calc(100vh - 240px);
	width: calc(100% - 40px);
	position: relative;
	border: 1px solid white;
}
.zoomable-canvas-container {
	overflow: hidden;
	align-items: center;
	justify-content: center;
	position: absolute;
	left: 0;
	top: 0;
	bottom: 0;
	right: 0;
	/*touch-action: none;*/
}
canvas {
	transition: transform 0.05s ease; /* Smooth transition for zooming */
	border: 1px solid white;
}
</style>

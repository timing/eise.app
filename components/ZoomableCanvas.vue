<template>
	<div class="zoomable-canvas-outer">
		<div class="canvas-topbar">
			<span class="zoom-indicator">
				Zoom:
				<div class="kebab-menu">
					<button class="kebab-btn" @click="showZoomDropdown = !showZoomDropdown">&#9662;</button>
					<div v-if="showZoomDropdown" class="kebab-backdrop" @click="showZoomDropdown = false"></div>
					<div v-if="showZoomDropdown" class="kebab-dropdown">
						<button v-for="preset in [25, 50, 75, 100, 150, 200, 300]" :key="preset"
							@click="setZoomPreset(preset); showZoomDropdown = false">{{ preset }}%</button>
						<button @click="fitToView(); showZoomDropdown = false">Fit to view</button>
						<button @click="centerCanvas(); showZoomDropdown = false">Center</button>
					</div>
				</div>
				<input
					type="number"
					:value="Math.round(zoomLevel * 100)"
					@change="setZoomFromInput"
					min="10"
					max="1500"
					step="1"
					class="zoom-input"
				/>%
			</span>
			<slot name="toolbar"></slot>
		</div>
		<div class="zoomable-canvas-wrapper">
			<slot name="overlay"></slot>
			<div class="zoomable-canvas-container" @wheel.prevent="handleWheel" @mousedown="startDrag" @dblclick="handleDoubleClick" ref="container">
				<canvas ref="canvas" :id="id" :style="canvasStyle"></canvas>
			</div>
		</div>
	</div>
</template>

<script setup>
import { defineEmits, ref, onMounted, onUnmounted, nextTick, computed } from 'vue';

const emit = defineEmits(['canvasReady']);

const props = defineProps({
	id: String,
	disableDrag: {
		type: Boolean,
		default: false
	},
	previewRotation: {
		type: Number,
		default: 0
	}
});

const canvas = ref(null);
const container = ref(null);
const zoomLevel = ref(1);
const position = ref({ x: 0, y: 0 });
const isDragging = ref(false);
const startPos = ref({ x: 0, y: 0 });
const showZoomDropdown = ref(false);

// Emit the canvas ref to parent right after it's mounted and ready
onMounted(async () => {
	await nextTick();
	emit('canvasReady', canvas);
});

const setZoomFromInput = (event) => {
	const value = parseInt(event.target.value, 10);
	if (!isNaN(value) && value >= 10 && value <= 1500) {
		zoomLevel.value = value / 100;
		centerCanvas();
	}
};

const setZoomPreset = (percent) => {
	zoomLevel.value = percent / 100;
	centerCanvas();
};

const handleWheel = (event) => {
	event.preventDefault();
	const rect = canvas.value.getBoundingClientRect();
	const mouseX = event.clientX - rect.left;
	const mouseY = event.clientY - rect.top;

	const oldZoom = zoomLevel.value;
	// Proportional zoom: 10% per scroll step, feels consistent at any zoom level
	const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
	zoomLevel.value = Math.max(0.1, Math.min(15, zoomLevel.value * factor));
	zoomLevel.value = Math.round(zoomLevel.value * 100) / 100;

	const newZoom = zoomLevel.value;
	const zoomChange = newZoom - oldZoom;

	// Zoom towards mouse position
	position.value.x -= mouseX * (zoomChange / oldZoom);
	position.value.y -= mouseY * (zoomChange / oldZoom);
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
	const isRotating = props.previewRotation !== 0;
	// Always use top left origin for consistent zoom behavior
	// For rotation, we rotate around the scaled canvas center
	let transform = `translate(${position.value.x}px, ${position.value.y}px) scale(${zoomLevel.value})`;
	if (isRotating && canvas.value) {
		// Rotate around canvas center: translate to center, rotate, translate back
		const cx = canvas.value.width / 2;
		const cy = canvas.value.height / 2;
		transform += ` translate(${cx}px, ${cy}px) rotate(${props.previewRotation}deg) translate(${-cx}px, ${-cy}px)`;
	}
	return {
		transform,
		transformOrigin: 'top left',
		transition: isRotating ? 'none' : 'transform 0.05s ease',
		cursor: props.disableDrag ? 'crosshair' : (isDragging.value ? 'grabbing' : 'grab')
	};
});

const startDrag = (event) => {
	if (props.disableDrag) return; // Skip drag when disabled (e.g., crop mode)
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

// Center the canvas within the container
const centerCanvas = () => {
	if (!canvas.value || !container.value) return;
	const containerRect = container.value.getBoundingClientRect();
	const canvasWidth = canvas.value.width * zoomLevel.value;
	const canvasHeight = canvas.value.height * zoomLevel.value;
	position.value = {
		x: (containerRect.width - canvasWidth) / 2,
		y: (containerRect.height - canvasHeight) / 2
	};
};

// Fit canvas to the visible container area
const fitToView = () => {
	if (!canvas.value || !container.value) return;
	const containerRect = container.value.getBoundingClientRect();
	const scaleX = containerRect.width / canvas.value.width;
	const scaleY = containerRect.height / canvas.value.height;
	zoomLevel.value = Math.round(Math.min(scaleX, scaleY) * 100) / 100;
	centerCanvas();
};

// Adjust position after crop so the cropped area stays in the same screen location
const adjustPositionForCrop = (sel) => {
	// Before crop: selection at (sel.x, sel.y) appears at screen position (position + sel * zoom)
	// After crop: new canvas top-left should appear at that same screen position
	position.value = {
		x: position.value.x + sel.x * zoomLevel.value,
		y: position.value.y + sel.y * zoomLevel.value
	};
};

// Expose centerCanvas so parent can call it after loading an image
defineExpose({ centerCanvas, adjustPositionForCrop });

</script>

<style scoped>
.zoomable-canvas-outer {
	width: calc(100% - 40px);
}
.canvas-topbar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	color: white;
	padding: 8px 0;
}
.zoom-indicator {
	font-size: 13px;
	display: inline-flex;
	align-items: center;
	gap: 4px;
}
.zoom-input {
	width: 50px;
	background: transparent;
	border: 1px solid #666;
	border-radius: 3px;
	color: white;
	font-size: 13px;
	padding: 2px 4px;
	text-align: right;
	box-sizing: border-box;
	height: 24px;
}
.zoom-input:focus {
	outline: none;
	border-color: #888;
}
.kebab-menu {
	position: relative;
	display: inline-block;
}
.kebab-btn {
	background: transparent;
	border: 1px solid #666;
	color: #aaa;
	font-size: 10px;
	padding: 4px 6px;
	cursor: pointer;
	border-radius: 3px;
	box-sizing: border-box;
	height: 24px;
}
.kebab-btn:hover {
	color: #fff;
	border-color: #888;
}
.kebab-backdrop {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 99;
}
.kebab-dropdown {
	position: absolute;
	top: 100%;
	margin-top: 4px;
	background: #fefefe;
	border-radius: 6px;
	box-shadow: 0 2px 10px rgba(0,0,0,0.2);
	z-index: 100;
	min-width: 120px;
	overflow: hidden;
}
.kebab-dropdown button {
	display: block;
	width: 100%;
	padding: 8px 12px;
	border: none;
	background: none;
	text-align: left;
	cursor: pointer;
	font-size: 13px;
	font-weight: bold;
	color: #333;
}
.kebab-dropdown button:hover {
	background: #f0f0f0;
}
.zoomable-canvas-wrapper {
	height: calc(100vh - 240px);
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

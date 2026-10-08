<template>
	<div class="zoomable-canvas-outer">
		<div class="canvas-topbar">
			<!-- What is on screen: filename + metadata. -->
			<div class="canvas-topbar-info">
				<slot name="info"></slot>
			</div>
			<!-- Moving through a set of related images (the continuous stacks,
			     a batch). -->
			<slot name="nav"></slot>
			<slot name="toolbar"></slot>
		</div>
		<div class="zoomable-canvas-wrapper">
			<!-- Outside the pill on purpose: its backdrop-filter would make it the
			     containing block for this fixed-position catcher, shrinking it to
			     the pill and breaking click-outside-to-close. -->
			<div v-if="showZoomDropdown" class="kebab-backdrop" @click="showZoomDropdown = false"></div>
			<!-- Floats over the canvas rather than sitting in the row above: it
			     belongs to the view, not to the image's actions. -->
			<span class="zoom-indicator">
				<span class="zoom-label">Zoom</span>
				<span class="zoom-field">
					<input
						type="number"
						:value="Math.round(zoomLevel * 100)"
						@change="setZoomFromInput"
						min="10"
						max="1500"
						step="1"
						class="zoom-input"
					/>
					<span class="zoom-unit">%</span>
					<div class="kebab-menu">
						<button class="kebab-btn" @click="showZoomDropdown = !showZoomDropdown" aria-label="Zoom presets">&#9662;</button>
						<div v-if="showZoomDropdown" class="kebab-dropdown">
							<button v-for="preset in [25, 50, 75, 100, 150, 200, 300]" :key="preset"
								@click="setZoomPreset(preset); showZoomDropdown = false">{{ preset }}%</button>
							<button @click="fitToView(); showZoomDropdown = false">Fit to view</button>
							<button @click="centerCanvas(); showZoomDropdown = false">Center</button>
						</div>
					</div>
				</span>
			</span>
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
	// Proportional zoom: 5% per scroll step, feels consistent at any zoom level
	const factor = event.deltaY < 0 ? 1.035 : 1 / 1.035;
	zoomLevel.value = Math.max(0.1, Math.min(15, zoomLevel.value * factor));
	// Round to 0.1% precision, not whole percent — at low zoom (≤ 14%) the
	// multiplicative step (~3.5%) is smaller than 0.5 percentage points and the
	// old whole-percent rounding trapped the value (e.g. 14% × 1.035 = 14.49
	// → rounds back to 14%, both directions stuck).
	zoomLevel.value = Math.round(zoomLevel.value * 1000) / 1000;

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
/* A row of its own, not a bare strip of controls: the inset surface groups the
   filename, the navigator and the actions into one bar above the canvas. */
.canvas-topbar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 12px 20px;
	flex-wrap: wrap;
	margin-bottom: 14px;
	padding: 7px 8px 7px 14px;
	border-radius: 10px;
	background: rgba(0, 0, 0, 0.22);
	border: 1px solid rgba(255, 255, 255, 0.1);
	color: var(--eise-on-dark);
	box-sizing: border-box;
}
/* Takes the slack so the zoom control and the actions stay right-aligned.
   Empty when nothing fills the slot, and then contributes no width. */
.canvas-topbar-info {
	flex: 1 1 0;
	min-width: 0;
}
.canvas-topbar-info:empty {
	flex: 0 0 auto;
}
/* Floating pill over the top-left of the canvas. */
.zoom-indicator {
	position: absolute;
	top: 12px;
	left: 12px;
	z-index: 3;
	display: inline-flex;
	align-items: center;
	gap: 8px;
	padding: 4px 4px 4px 10px;
	border-radius: 8px;
	background: rgba(9, 52, 66, 0.88);
	backdrop-filter: blur(8px);
	border: 1px solid rgba(255, 255, 255, 0.12);
	box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
}
.zoom-label {
	font-size: 12px;
	color: var(--eise-muted-2);
}
.zoom-field {
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 3px 3px 3px 7px;
	border-radius: 7px;
	background: rgba(0, 0, 0, 0.25);
	border: 1px solid rgba(255, 255, 255, 0.12);
}
.zoom-input {
	width: 30px;
	padding: 0;
	background: transparent;
	border: none;
	color: var(--eise-bright);
	font-family: var(--eise-mono);
	font-size: 12px;
	text-align: right;
	box-sizing: content-box;
	appearance: textfield;
	-moz-appearance: textfield;
}
.zoom-input::-webkit-outer-spin-button,
.zoom-input::-webkit-inner-spin-button {
	-webkit-appearance: none;
	margin: 0;
}
.zoom-input:focus {
	outline: none;
	color: var(--eise-gilt-lt);
}
.zoom-unit {
	font-family: var(--eise-mono);
	font-size: 12px;
	color: var(--eise-muted-2);
}
.kebab-menu {
	position: relative;
	display: inline-block;
}
/* Borderless inside the zoom field: the field is already the frame. */
.kebab-btn {
	display: grid;
	place-items: center;
	width: 20px;
	height: 22px;
	background: transparent;
	border: none;
	color: var(--eise-on-dark);
	font-size: 10px;
	padding: 0;
	cursor: pointer;
	border-radius: 5px;
	box-sizing: border-box;
}
.kebab-btn:hover {
	background: rgba(255, 255, 255, 0.07);
	color: #fff;
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
	/* The pill now lives inside the canvas frame, which clips its overflow, so
	   this list has to stay shorter than the frame on a short window. */
	max-height: 40vh;
	overflow-y: auto;
}
.kebab-dropdown button {
	display: block;
	width: 100%;
	padding: 8px 12px;
	border: none;
	background: none;
	text-align: left;
	cursor: pointer;
	font-size: 14px;
	font-weight: bold;
	color: #333;
}
.kebab-dropdown button:hover {
	background: #f0f0f0;
}
.zoomable-canvas-wrapper {
	height: calc(100vh - 240px);
	position: relative;
	border: 1px solid rgba(255, 255, 255, 0.1);
	border-radius: 12px;
	background: rgba(0, 0, 0, 0.24);
	overflow: hidden;
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

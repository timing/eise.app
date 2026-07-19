<template>
<div class="design-system">
	<div class="ds-header">
		<h1>Design System</h1>
		<p>An inventory of all UI patterns and styles used in Eise.app</p>
	</div>

	<!-- TYPOGRAPHY -->
	<section class="ds-section">
		<h2>Typography & Text Colors</h2>

		<div class="ds-group">
			<h3>Body Text on Blue Gradient</h3>
			<p class="ds-note">Main content area text color - used in .content on the radial gradient background</p>
			<div class="ds-examples text-on-gradient">
				<p class="body-text-demo">This is the standard body text color (#c6fffd - light cyan) on the blue gradient background. It's used for all main content text in the .content area.</p>
				<p class="body-text-demo"><strong>Bold text</strong> and <a href="#">links</a> inherit this color.</p>
			</div>
			<div class="ds-variants">
				<strong>Color:</strong> #c6fffd (light cyan)<br>
				<strong>Background:</strong> radial-gradient(circle at bottom, #27587c, #0A2940) on html element<br>
				<strong>Used in:</strong> app.vue html/body styles, .content area
			</div>
		</div>

		<div class="ds-group">
			<h3>Card Text (Dark on Light)</h3>
			<p class="ds-note">Text inside .card elements which have white background</p>
			<div class="ds-examples">
				<div class="card-text-demo">
					<p>This is card text (#333) on the white card background (#fefefe).</p>
					<p class="card-muted">This is muted text (#666, #888) for secondary info.</p>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Primary:</strong> #333<br>
				<strong>Muted:</strong> #666, #888<br>
				<strong>Used in:</strong> .card, form labels, info text
			</div>
		</div>

		<div class="ds-group">
			<h3>Preview Labels</h3>
			<p class="ds-note">Text used in frame preview areas (QualitySelector, VideoFrameProcessor)</p>
			<div class="ds-examples text-on-gradient">
				<h4 class="preview-heading">Sharpest Frame</h4>
				<p class="preview-stats">Sharpness: 0.85 (Tenengrad: 0.72, Laplacian: 0.91) · Circularity: 0.98</p>
			</div>
			<div class="ds-variants">
				<strong>Headings:</strong> #c6fffd (same as body)<br>
				<strong>Stats:</strong> #c6fffd, font-size: 13px
			</div>
		</div>

		<div class="ds-group">
			<h3>Header & Navigation</h3>
			<div class="ds-examples text-on-gradient">
				<h1 class="header-demo"><a href="#">Eise.app</a> <span class="subtitle-demo">- Easy Image Stacker Engine</span></h1>
			</div>
			<div class="ds-variants">
				<strong>Logo link:</strong> #8CCF7E (green)<br>
				<strong>Subtitle:</strong> white, 12px, normal weight
			</div>
		</div>
	</section>

	<!-- BUTTONS -->
	<section class="ds-section">
		<h2>Buttons</h2>

		<div class="ds-group">
			<h3>Primary Buttons (Green - #8CCF7E)</h3>
			<p class="ds-note">Used for main actions: Stack, Apply, Export</p>
			<div class="ds-examples">
				<button class="btn-primary">Stack</button>
				<button class="btn-primary">Apply</button>
				<button class="btn-primary">Export</button>
				<button class="btn-primary" disabled>Disabled</button>
			</div>
			<div class="ds-variants">
				<strong>Class:</strong> .btn-primary (global in app.vue)<br>
				<strong>Colors:</strong> bg: #8CCF7E, hover: #7ABF6E, text: #111
			</div>
		</div>

		<div class="ds-group">
			<h3>Danger Buttons (Red - #D9534F)</h3>
			<p class="ds-note">Used for cancel/stop actions during processing</p>
			<div class="ds-examples">
				<button class="btn-danger">Cancel</button>
				<button class="btn-danger">Stop</button>
			</div>
			<div class="ds-variants">
				<strong>Class:</strong> .btn-danger (global in app.vue)<br>
				<strong>Colors:</strong> bg: #D9534F, hover: #C9302C, text: white
			</div>
		</div>

		<div class="ds-group">
			<h3>Secondary Buttons (Gray)</h3>
			<p class="ds-note">Used for secondary actions, dismiss dialogs</p>
			<div class="ds-examples">
				<button class="btn-secondary">Clear</button>
				<button class="btn-secondary">Cancel</button>
			</div>
			<div class="ds-variants">
				<strong>Class:</strong> .btn-secondary (global in app.vue)<br>
				<strong>Colors:</strong> bg: #888, hover: #666, text: white
			</div>
		</div>

		<div class="ds-group">
			<h3>Warning/Undo Buttons (Orange - #ff9800)</h3>
			<p class="ds-note">Used for undo/remove actions</p>
			<div class="ds-examples">
				<button class="undo-crop">Undo crop</button>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .undo-crop<br>
				<strong>Colors:</strong> bg: #ff9800, text: white
			</div>
		</div>

		<div class="ds-group">
			<h3>Remove/Delete Buttons (Coral Red - #ff6b6b)</h3>
			<p class="ds-note">Used for removing things</p>
			<div class="ds-examples">
				<button class="remove-mask">Remove mask</button>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .remove-mask<br>
				<strong>Colors:</strong> bg: #ff6b6b, text: white
			</div>
		</div>

		<div class="ds-group">
			<h3>Info/Play Buttons (Blue - #27587c)</h3>
			<p class="ds-note">Used for playback, secondary info actions</p>
			<div class="ds-examples">
				<button class="play-button">Play</button>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .play-button<br>
				<strong>Colors:</strong> bg: #27587c, hover: #1D4A66, text: white
			</div>
		</div>

		<div class="ds-group">
			<h3>Tab/Navigation Buttons</h3>
			<p class="ds-note">Used in top navigation and sharpening method tabs</p>
			<div class="ds-examples">
				<div class="tabs-demo">
					<button class="tab-btn">Inactive Tab</button>
					<button class="tab-btn active">Active Tab</button>
				</div>
				<div class="sharpening-tabs">
					<button>Wavelets</button>
					<button class="active">USM</button>
					<button>None</button>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .tabs a, .sharpening-tabs button<br>
				<strong>Colors:</strong> inactive: #fefefe, hover: #70f1ec, active: #8CCF7E
			</div>
		</div>

		<div class="ds-group">
			<h3>Control Buttons (Light Gray - #e8e8e8)</h3>
			<p class="ds-note">Used for in-control buttons like crop/mask selection</p>
			<div class="ds-examples">
				<button class="control-btn">Select crop area</button>
				<button class="control-btn">Add edge mask</button>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .crop-controls button, .edge-mask-controls button<br>
				<strong>Colors:</strong> bg: #e8e8e8, text: #555
			</div>
		</div>
	</section>

	<!-- MESSAGES -->
	<section class="ds-section">
		<h2>Messages & Alerts</h2>

		<div class="ds-group">
			<h3>Error Message (Red)</h3>
			<p class="ds-note">Used in FileUploader.vue and VideoFrameProcessor.vue</p>
			<div class="ds-examples">
				<div class="error-message">
					<p>This is an error message</p>
					<p class="feedback-prompt">
						Something went wrong? <a href="#">Let me know</a>
					</p>
					<button class="reload-button">Start over</button>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .error-message<br>
				<strong>Colors:</strong> bg: #ffcccc, text: #D9534F
			</div>
		</div>

		<div class="ds-group">
			<h3>Cancelled/Warning Message (Amber)</h3>
			<p class="ds-note">Used for cancelled state and lite mode warnings</p>
			<div class="ds-examples">
				<div class="cancelled-message">
					<p>Processing cancelled.</p>
					<p class="feedback-prompt">
						Was something not working? <a href="#">Let me know</a>
					</p>
					<button class="reload-button">Start over</button>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .cancelled-message, .lite-mode-warning, .skipped-info<br>
				<strong>Colors:</strong> bg: #fff3cd, text: #856404, border: #ffc107
			</div>
		</div>

		<div class="ds-group">
			<h3>Info Text (Gray background)</h3>
			<p class="ds-note">Used for expandable help text after info icon click</p>
			<div class="ds-examples">
				<p class="info-text">This is an info text block that appears when you click the <span class="info-icon">ⓘ</span> icon.</p>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .info-text<br>
				<strong>Colors:</strong> bg: #f5f5f5, text: #555
			</div>
		</div>

		<div class="ds-group">
			<h3>Memory Optimization Box (Amber)</h3>
			<p class="ds-note">Used in FileUploader for mobile memory warnings</p>
			<div class="ds-examples">
				<div class="memory-optimization-box">
					<p class="optimization-hint">Memory optimization options:</p>
					<label class="checkbox-option">
						<input type="checkbox" checked /> Pre-crop video <span class="auto-badge">auto</span>
					</label>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .memory-optimization-box<br>
				<strong>Colors:</strong> bg: #fff8e1, border: #ffcc80
			</div>
		</div>
	</section>

	<!-- FORM CONTROLS -->
	<section class="ds-section">
		<h2>Form Controls</h2>

		<div class="ds-group">
			<h3>File Input</h3>
			<div class="ds-examples">
				<div class="file-input-wrapper">
					<input type="file" id="demo-file" style="display:none" />
					<label for="demo-file" class="file-label">Choose files...</label>
				</div>
				<p class="supported-formats">SER, AVI, MP4, PNG, TIFF, JPEG</p>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .file-input-wrapper, .file-label, .supported-formats<br>
				<strong>Colors:</strong> border: #ccc dashed, hover-border: #8CCF7E
			</div>
		</div>

		<div class="ds-group">
			<h3>Radio Groups</h3>
			<div class="ds-examples">
				<div class="radio-group">
					<label class="radio-option">
						<input type="radio" name="demo-radio" checked /> Planet (or Moon fully in frame)
					</label>
					<label class="radio-option">
						<input type="radio" name="demo-radio" /> Surface: Closeup of Sun or Moon
					</label>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .radio-group, .radio-option
			</div>
		</div>

		<div class="ds-group">
			<h3>Checkbox Options</h3>
			<div class="ds-examples">
				<label class="checkbox-option">
					<input type="checkbox" /> Enable feature
				</label>
				<label class="checkbox-option disabled">
					<input type="checkbox" disabled /> Disabled option
				</label>
				<label class="checkbox-label">
					<input type="checkbox" /> Auto (PostProcessor style)
				</label>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .checkbox-option (FileUploader), .checkbox-label (PostProcessor)<br>
				<strong>Note:</strong> These are nearly identical - candidate for merging
			</div>
		</div>

		<div class="ds-group">
			<h3>Number Inputs (Unified)</h3>
			<div class="ds-examples">
				<input type="number" class="number-input" value="30" /> %
				<input type="number" class="number-input" value="0.3" />
				<input type="number" class="number-input" value="100" /> frames
			</div>
			<div class="ds-variants">
				<strong>Class:</strong> .number-input (global in app.vue)<br>
				<strong>Width:</strong> 55px, centered text<br>
				<strong>Replaces:</strong> .percentage-input, .small-number-input, .inline-number, .repeats-input
			</div>
		</div>

		<div class="ds-group">
			<h3>Range Sliders</h3>
			<div class="ds-examples">
				<div>
					<label>Crop margin: </label>
					<input type="range" min="5" max="50" value="10" /> 10%
				</div>
			</div>
			<div class="ds-variants">
				<strong>Note:</strong> Uses default browser styling
			</div>
		</div>
	</section>

	<!-- LAYOUT -->
	<section class="ds-section">
		<h2>Layout</h2>

		<div class="ds-group">
			<h3>Page Layout (Card + Content)</h3>
			<div class="ds-examples layout-demo">
				<div class="demo-page-layout">
					<div class="demo-card">.card (272px fixed on desktop)</div>
					<div class="demo-content">.content (flexible, max-width 500px)</div>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .page-layout, .card, .content<br>
				<strong>Breakpoint:</strong> 640px - stacks vertically on mobile
			</div>
		</div>

		<div class="ds-group">
			<h3>Separator</h3>
			<div class="ds-examples">
				<div class="separator"></div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .separator<br>
				<strong>Colors:</strong> border: #ddd
			</div>
		</div>

		<div class="ds-group">
			<h3>Action Buttons Row</h3>
			<div class="ds-examples">
				<div class="action-buttons">
					<button class="btn-primary">Stack</button>
					<button class="clear-button">Clear</button>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .action-buttons<br>
				<strong>Styling:</strong> flex, gap: 10px
			</div>
		</div>
	</section>

	<!-- LOADING & PROGRESS -->
	<section class="ds-section">
		<h2>Loading & Progress</h2>

		<div class="ds-group">
			<h3>Loading Indicator</h3>
			<div class="ds-examples">
				<div class="loading-demo">
					<div class="caption">Analyzing frames</div>
					<div class="frame-counter">42 / 100</div>
					<div class="loading-indicator">
						<div class="determinate" style="width: 42%"></div>
					</div>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .loading-indicator, .determinate, .indeterminate<br>
				<strong>Colors:</strong> bg: #e0e0e0, progress: #8CCF7E
			</div>
		</div>

		<div class="ds-group">
			<h3>Spinner</h3>
			<div class="ds-examples">
				<div class="spinner"></div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .spinner<br>
				<strong>Colors:</strong> border: #27587c
			</div>
		</div>
	</section>

	<!-- POPUPS -->
	<section class="ds-section">
		<h2>Popups & Dialogs</h2>

		<div class="ds-group">
			<h3>Export Popup</h3>
			<p class="ds-note">Dialog styling used for export and help popups</p>
			<div class="ds-examples">
				<div class="popup-demo">
					<div class="export-popup">
						<h3>Export</h3>
						<div class="export-filename">
							<label>Filename:</label>
							<input type="text" value="jupiter_stacked" />
						</div>
						<div class="export-buttons">
							<button class="export-option">Download PNG (8-bit)</button>
							<button class="export-option secondary">Download Cropped SER</button>
						</div>
						<button class="close-btn">Close</button>
					</div>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .export-popup-overlay, .export-popup, .export-option
			</div>
		</div>

		<div class="ds-group">
			<h3>WebGPU Dialog</h3>
			<p class="ds-note">Warning dialog when WebGPU unavailable</p>
			<div class="ds-examples">
				<div class="popup-demo">
					<div class="webgpu-dialog">
						<h3>WebGPU Not Available</h3>
						<p>Your browser doesn't support WebGPU acceleration.</p>
						<div class="browser-tip">Tip: Try Chrome or Edge for best performance</div>
						<div class="webgpu-dialog-buttons">
							<button class="continue-button">Continue with CPU</button>
							<button class="cancel-button">Cancel</button>
						</div>
					</div>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .webgpu-dialog-overlay, .webgpu-dialog
			</div>
		</div>

		<div class="ds-group">
			<h3>Kebab Menu / Dropdown</h3>
			<div class="ds-examples">
				<div class="kebab-demo">
					<button class="kebab-btn">⋮</button>
					<div class="kebab-dropdown-static">
						<button>Load another image</button>
						<button>Start new stack</button>
						<button>Close Post Processor</button>
					</div>
				</div>
			</div>
			<div class="ds-variants">
				<strong>Classes:</strong> .kebab-menu, .kebab-btn, .kebab-dropdown<br>
				<strong>Also used:</strong> .dropdown (nav), similar pattern
			</div>
		</div>
	</section>

	<!-- COLOR PALETTE -->
	<section class="ds-section">
		<h2>Color Palette</h2>

		<div class="ds-group">
			<h3>Primary Colors</h3>
			<div class="color-swatches">
				<div class="swatch" style="background: #8CCF7E">
					<span>#8CCF7E</span>
					<small>Primary Green (buttons, active states)</small>
				</div>
				<div class="swatch" style="background: #7ABF6E">
					<span>#7ABF6E</span>
					<small>Primary Green Hover</small>
				</div>
				<div class="swatch" style="background: #27587c; color: white">
					<span>#27587c</span>
					<small>Primary Blue (bg gradient, play btn)</small>
				</div>
				<div class="swatch" style="background: #70f1ec">
					<span>#70f1ec</span>
					<small>Cyan (tab hover)</small>
				</div>
				<div class="swatch" style="background: #c6fffd">
					<span>#c6fffd</span>
					<small>Light Cyan (body text)</small>
				</div>
			</div>
		</div>

		<div class="ds-group">
			<h3>Status Colors</h3>
			<div class="color-swatches">
				<div class="swatch" style="background: #D9534F; color: white">
					<span>#D9534F</span>
					<small>Error/Danger Red</small>
				</div>
				<div class="swatch" style="background: #ffcccc">
					<span>#ffcccc</span>
					<small>Error Background</small>
				</div>
				<div class="swatch" style="background: #fff3cd">
					<span>#fff3cd</span>
					<small>Warning Background</small>
				</div>
				<div class="swatch" style="background: #856404">
					<span>#856404</span>
					<small>Warning Text</small>
				</div>
				<div class="swatch" style="background: #ff9800; color: white">
					<span>#ff9800</span>
					<small>Orange (undo)</small>
				</div>
				<div class="swatch" style="background: #ff6b6b; color: white">
					<span>#ff6b6b</span>
					<small>Coral (remove)</small>
				</div>
			</div>
		</div>

		<div class="ds-group">
			<h3>Neutral Colors</h3>
			<div class="color-swatches">
				<div class="swatch" style="background: #fefefe">
					<span>#fefefe</span>
					<small>Card Background</small>
				</div>
				<div class="swatch" style="background: #f5f5f5">
					<span>#f5f5f5</span>
					<small>Info Background</small>
				</div>
				<div class="swatch" style="background: #e8e8e8">
					<span>#e8e8e8</span>
					<small>Control Button</small>
				</div>
				<div class="swatch" style="background: #888; color: white">
					<span>#888</span>
					<small>Secondary Button</small>
				</div>
				<div class="swatch" style="background: #333; color: white">
					<span>#333</span>
					<small>Card Text</small>
				</div>
			</div>
		</div>
	</section>

	<!-- DUPLICATES -->
	<section class="ds-section">
		<h2>Potential Duplicates to Merge</h2>

		<div class="ds-group duplicate-warning">
			<h3>1. Checkbox Styles</h3>
			<p><strong>.checkbox-option</strong> (FileUploader) vs <strong>.checkbox-label</strong> (PostProcessor)</p>
			<p>Both do the same thing - flexbox with gap and cursor pointer. Merge into single class.</p>
		</div>

		<div class="ds-group duplicate-warning">
			<h3>2. Error/Cancelled Message Buttons</h3>
			<p><strong>.reload-button</strong> is defined twice (in .error-message and .cancelled-message)</p>
			<p>Extract to standalone button class with color modifiers.</p>
		</div>

		<div class="ds-group duplicate-warning">
			<h3>3. Control Button Groups</h3>
			<p><strong>.crop-controls button</strong> and <strong>.edge-mask-controls button</strong> are identical</p>
			<p>Merge into shared <strong>.control-button-group</strong> class.</p>
		</div>

		<div class="ds-group duplicate-warning">
			<h3>4. Feedback Prompt Styles</h3>
			<p><strong>.error-message .feedback-prompt</strong> and <strong>.cancelled-message .feedback-prompt</strong></p>
			<p>Same styling, different parent. Make <strong>.feedback-prompt</strong> standalone.</p>
		</div>

		<div class="ds-group duplicate-warning">
			<h3>5. Info Icon + Text</h3>
			<p><strong>.info-icon</strong> and <strong>.info-text</strong> defined in both FileUploader and PostProcessor</p>
			<p>Move to global styles in app.vue.</p>
		</div>

		<div class="ds-group duplicate-warning">
			<h3>6. Action Buttons</h3>
			<p><strong>.action-buttons</strong> defined in multiple components with same flex + gap</p>
			<p>Move to global styles.</p>
		</div>

		<div class="ds-group duplicate-warning">
			<h3>7. Popup/Dialog Styles</h3>
			<p>Export popup and WebGPU dialog share overlay pattern</p>
			<p>Create shared <strong>.modal-overlay</strong> and <strong>.modal-content</strong> classes.</p>
		</div>
	</section>
</div>
</template>

<script setup>
// Hidden design system page - only for development reference
definePageMeta({
	layout: 'default'
});
useHead({
	meta: [
		{ name: 'robots', content: 'noindex, nofollow' },
	],
});
</script>

<style scoped>
.design-system {
	max-width: 900px;
	margin: 0 auto;
	padding: 20px;
	color: #333;
}

.ds-header {
	background: #fefefe;
	padding: 30px;
	border-radius: 10px;
	margin-bottom: 30px;
}

.ds-header h1 {
	margin: 0 0 10px 0;
	color: #333;
}

.ds-header p {
	margin: 0;
	color: #666;
}

.ds-section {
	background: #fefefe;
	border-radius: 10px;
	padding: 20px 30px;
	margin-bottom: 20px;
}

.ds-section h2 {
	margin: 0 0 20px 0;
	padding-bottom: 10px;
	border-bottom: 2px solid #8CCF7E;
	color: #333;
}

.ds-group {
	margin-bottom: 30px;
	padding-bottom: 20px;
	border-bottom: 1px solid #eee;
}

.ds-group:last-child {
	margin-bottom: 0;
	padding-bottom: 0;
	border-bottom: none;
}

.ds-group h3 {
	margin: 0 0 8px 0;
	color: #333;
	font-size: 16px;
}

.ds-note {
	color: #888;
	font-size: 13px;
	margin: 0 0 15px 0;
}

.ds-examples {
	background: #f9f9f9;
	padding: 20px;
	border-radius: 8px;
	margin-bottom: 15px;
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
	align-items: flex-start;
}

.ds-variants {
	font-size: 12px;
	color: #666;
	line-height: 1.6;
}

/* Typography demos */
.text-on-gradient {
	background: radial-gradient(circle at bottom, #27587c, #0A2940);
	padding: 25px;
	border-radius: 8px;
}

.body-text-demo {
	color: #c6fffd;
	margin: 0 0 10px 0;
	line-height: 1.5;
}

.body-text-demo a {
	color: inherit;
}

.card-text-demo {
	background: #fefefe;
	padding: 15px;
	border-radius: 8px;
	width: 100%;
}

.card-text-demo p {
	margin: 0 0 8px 0;
	color: #333;
}

.card-muted {
	color: #888 !important;
	font-size: 13px;
}

.preview-heading {
	color: #c6fffd;
	margin: 0 0 8px 0;
	font-size: 14px;
}

.preview-stats {
	color: #c6fffd;
	font-size: 13px;
	margin: 0;
}

.header-demo {
	margin: 0;
	font-size: 18px;
	color: white;
}

.header-demo a {
	color: #8CCF7E;
	text-decoration: none;
}

.subtitle-demo {
	font-size: 12px;
	font-weight: normal;
}

/* Button demos - using global classes from app.vue */

.undo-crop {
	background-color: #ff9800;
	color: white;
	padding: 8px 16px;
	border: none;
	border-radius: 4px;
	cursor: pointer;
}

.remove-mask {
	background-color: #ff6b6b;
	color: white;
	padding: 8px 16px;
	border: none;
	border-radius: 4px;
	cursor: pointer;
}

.play-button {
	background-color: #27587c;
	color: white;
	padding: 8px 16px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
}

.control-btn {
	background-color: #e8e8e8;
	color: #555;
	padding: 8px 16px;
	border: none;
	border-radius: 4px;
	cursor: pointer;
}

.tab-btn {
	background-color: #fefefe;
	border: none;
	color: #333;
	padding: 10px 20px;
	cursor: pointer;
	border-right: 1px solid #ccc;
	font-weight: bold;
}

.tab-btn.active {
	background-color: #8CCF7E;
	color: #111;
}

.tabs-demo {
	display: flex;
}

/* Sharpening tabs */
.sharpening-tabs {
	display: inline-flex;
}

.sharpening-tabs button {
	padding: 6px 12px;
	border: 1px solid #ccc;
	border-radius: 0;
	margin-left: -1px;
	background-color: #e8e8e8;
	color: #555;
	cursor: pointer;
	font-size: 12px;
}

.sharpening-tabs button:first-child {
	margin-left: 0;
	border-radius: 4px 0 0 4px;
}

.sharpening-tabs button:last-child {
	border-radius: 0 4px 4px 0;
}

.sharpening-tabs button.active {
	background-color: #8CCF7E;
	color: #111;
}

/* Messages */
.error-message {
	background-color: #ffcccc;
	color: #D9534F;
	padding: 15px;
	border-radius: 5px;
	width: 100%;
}

.error-message p {
	margin: 0 0 8px 0;
}

.error-message .feedback-prompt {
	font-weight: normal;
	font-size: 0.9em;
}

.error-message .reload-button {
	margin-top: 12px;
	padding: 8px 16px;
	background-color: #D9534F;
	color: white;
	border: none;
	border-radius: 4px;
	cursor: pointer;
}

.cancelled-message {
	background-color: #fff3cd;
	color: #856404;
	padding: 15px;
	border-radius: 5px;
	width: 100%;
	text-align: left;
	font-weight: bold;
}

.cancelled-message p {
	margin: 0 0 8px 0;
}

.cancelled-message .feedback-prompt {
	font-weight: normal;
	font-size: 0.9em;
}

.cancelled-message .reload-button {
	margin-top: 12px;
	padding: 8px 16px;
	background-color: #856404;
	color: white;
	border: none;
	border-radius: 4px;
	cursor: pointer;
}

.info-icon {
	cursor: pointer;
	color: #666;
}

.info-text {
	font-size: 0.9em;
	color: #555;
	padding: 8px;
	background: #f5f5f5;
	border-radius: 4px;
	width: 100%;
}

.memory-optimization-box {
	background: #fff8e1;
	border: 1px solid #ffcc80;
	border-radius: 5px;
	padding: 10px;
	width: 100%;
}

.optimization-hint {
	margin: 0 0 8px 0;
	font-size: 0.9em;
	color: #e65100;
	font-weight: 500;
}

.auto-badge {
	font-size: 0.7em;
	background: #4caf50;
	color: white;
	padding: 2px 5px;
	border-radius: 3px;
	margin-left: 5px;
}

/* Form controls - using global classes from app.vue */

.radio-group {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.radio-option, .checkbox-option, .checkbox-label {
	display: flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
}

.checkbox-option.disabled {
	opacity: 0.5;
	cursor: not-allowed;
}


/* Layout demo */
.demo-page-layout {
	display: flex;
	gap: 20px;
	width: 100%;
}

.demo-card {
	width: 150px;
	flex-shrink: 0;
	background: #fefefe;
	border: 1px solid #ddd;
	border-radius: 8px;
	padding: 15px;
	text-align: center;
	font-size: 11px;
}

.demo-content {
	flex: 1;
	background: #27587c;
	color: #c6fffd;
	border-radius: 8px;
	padding: 15px;
	text-align: center;
	font-size: 11px;
}

.separator {
	border-top: 1px solid #ddd;
	margin: 10px 0;
	width: 100%;
}

.action-buttons {
	display: flex;
	gap: 10px;
}

/* Loading */
.loading-demo {
	width: 100%;
}

.caption {
	text-align: center;
	font-size: 16px;
	font-weight: bold;
	color: #333;
	margin-bottom: 5px;
}

.frame-counter {
	text-align: center;
	font-size: 24px;
	font-weight: bold;
	color: #4A90E2;
	margin-bottom: 10px;
}

.loading-indicator {
	height: 8px;
	background-color: #e0e0e0;
	border-radius: 4px;
	overflow: hidden;
}

.determinate {
	height: 100%;
	background-color: #8CCF7E;
	border-radius: 4px;
}

.spinner {
	width: 20px;
	height: 20px;
	border: 2px solid #27587c;
	border-top-color: transparent;
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}

@keyframes spin {
	to { transform: rotate(360deg); }
}

/* Popup demos */
.popup-demo {
	width: 100%;
}

.export-popup, .webgpu-dialog {
	background: #fefefe;
	color: #333;
	border-radius: 10px;
	padding: 20px;
	box-shadow: 0 4px 20px rgba(0,0,0,0.15);
}

.export-popup h3, .webgpu-dialog h3 {
	margin: 0 0 15px 0;
}

.webgpu-dialog h3 {
	color: #d9534f;
}

.export-filename {
	margin-bottom: 15px;
}

.export-filename label {
	display: block;
	margin-bottom: 5px;
	font-weight: bold;
	font-size: 13px;
}

.export-filename input {
	width: 100%;
	padding: 8px;
	border: 1px solid #ccc;
	border-radius: 5px;
	box-sizing: border-box;
}

.export-buttons {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin-bottom: 15px;
}

.export-option {
	padding: 10px 16px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	background-color: #8CCF7E;
	color: #111;
	font-weight: bold;
	text-align: left;
}

.export-option.secondary {
	background-color: #e8e8e8;
	color: #333;
	font-weight: normal;
}

.close-btn {
	padding: 8px 16px;
	border: none;
	border-radius: 4px;
	cursor: pointer;
	background: #eee;
}

.browser-tip {
	font-size: 12px;
	color: #666;
	background: #f5f5f5;
	padding: 10px;
	border-radius: 5px;
	margin: 15px 0;
}

.webgpu-dialog-buttons {
	display: flex;
	gap: 10px;
}

.continue-button {
	background-color: #8CCF7E;
	color: #111;
	font-weight: bold;
	flex: 1;
	padding: 10px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
}

.cancel-button {
	background-color: #D9534F;
	color: white;
	padding: 10px 20px;
	border: none;
	border-radius: 5px;
	cursor: pointer;
	font-weight: bold;
}

/* Kebab demo */
.kebab-demo {
	display: flex;
	gap: 10px;
	align-items: flex-start;
}

.kebab-btn {
	background: #fefefe;
	border: none;
	color: #333;
	font-size: 14px;
	padding: 8px 12px;
	cursor: pointer;
	border-radius: 5px;
	font-weight: bold;
}

.kebab-dropdown-static {
	background: #fefefe;
	border-radius: 6px;
	box-shadow: 0 2px 10px rgba(0,0,0,0.2);
	min-width: 180px;
	overflow: hidden;
}

.kebab-dropdown-static button {
	display: block;
	width: 100%;
	padding: 10px 15px;
	border: none;
	background: none;
	text-align: left;
	cursor: pointer;
	font-size: 14px;
	color: #333;
}

.kebab-dropdown-static button:hover {
	background: #f0f0f0;
}

/* Color swatches */
.color-swatches {
	display: flex;
	flex-wrap: wrap;
	gap: 10px;
}

.swatch {
	width: 150px;
	padding: 15px 10px;
	border-radius: 8px;
	text-align: center;
	box-shadow: 0 2px 5px rgba(0,0,0,0.1);
}

.swatch span {
	display: block;
	font-weight: bold;
	font-family: monospace;
	margin-bottom: 5px;
}

.swatch small {
	font-size: 11px;
	opacity: 0.8;
}

/* Duplicate warnings */
.duplicate-warning {
	background: #fff8e1;
	border: 1px solid #ffcc80;
	border-radius: 8px;
	padding: 15px !important;
}

.duplicate-warning h3 {
	color: #e65100;
}

.duplicate-warning p {
	margin: 5px 0;
	font-size: 13px;
}
</style>

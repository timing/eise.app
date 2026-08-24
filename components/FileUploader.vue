<template>
<div class="page-layout">
	<div class="card">
		<!-- LoadingIndicator always mounted so it can receive events -->
		<LoadingIndicator />

		<!-- Status indicators (mobile only) -->
		<div v-if="isMobileClient" class="status-indicators">
			<span class="status-item" :class="{ active: useGPU }">
				<span class="status-check">{{ useGPU ? '✓' : '✗' }}</span> GPU
			</span>
			<span class="status-item" :class="{ active: !useGPU }">
				<span class="status-check">{{ !useGPU ? '✓' : '✗' }}</span> CPU
			</span>
		</div>

		<!-- Cancel button during processing -->
		<div v-if="isProcessing" class="action-buttons processing-actions">
			<button class="btn-danger" @click="cancelProcessing">Cancel</button>
			<p class="processing-hint">Stacking can take a while, but the results are hopefully worth the wait!</p>
		</div>

		<!-- Error message - always visible when set, regardless of processing state -->
		<div v-if="errorMessage" class="error-message">
			<p>{{ errorMessage }}</p>
			<ul v-if="errorAlternatives.length" class="error-alternatives">
				<li v-for="(alt, i) in errorAlternatives" :key="i">
					<a v-if="alt.url" :href="alt.url" :target="alt.external ? '_blank' : undefined" :rel="alt.external ? 'noopener' : undefined">{{ alt.label }}</a>
					<span v-else>{{ alt.label }}</span>
					<small v-if="alt.description">{{ alt.description }}</small>
				</li>
			</ul>
			<p v-if="!errorIsUserFault" class="feedback-prompt">
				Something went wrong? <a href="https://github.com/timing/eise.app/issues" @click="openErrorFeedback">Let me know what happened</a> so I can fix it.
			</p>
			<button v-if="!errorIsUserFault" class="reload-button" @click="reloadPage">Start over</button>
		</div>

		<!-- Cancelled message -->
		<div v-if="showCancelledMessage" class="cancelled-message">
			<p>Processing cancelled.</p>
			<p class="feedback-prompt">
				Was something not working? <a href="https://github.com/timing/eise.app/issues" @click="openCancelFeedback">Let me know</a> so I can improve things.
			</p>
			<button class="reload-button" @click="reloadPage">Start over</button>
		</div>

		<!-- Batch info panel - always visible when in batch mode (even during processing) -->
		<BatchInfoPanel
			v-if="isBatchMode"
			:settings="batchSettings"
			@start="handleBatchStart"
			@clear="handleBatchClear"
		/>

		<!-- Initial state: file selection and settings (hidden during processing) -->
		<template v-if="!isProcessing && !isBatchMode">
			<h3>Select file(s) for stacking and/or post processing</h3>
			<div class="file-input-wrapper" :class="{ 'has-files': selectedFiles.length > 0 }">
				<input id="file-upload" ref="fileInput" type="file" accept="video/*,image/*,.ser" multiple @change="onFileChanged" title="" />
				<label for="file-upload" class="file-label">
					<template v-if="selectedFiles.length > 0">
						{{ selectedFilesDescription }}
					</template>
					<template v-else>
						<span class="drop-zone-content">
							<span class="drop-icon">📂</span>
							<span class="drop-text">Drag files here</span>
							<span class="drop-button">Choose files</span>
							<span class="drop-formats">SER, AVI, MP4, PNG, TIFF, JPEG</span>
							<span class="drop-privacy">Nothing is uploaded.</span>
						</span>
					</template>
				</label>
			</div>

			<p v-if="selectedFiles.length === 0" class="try-sample-line">
				No footage of your own? <a href="#" @click.prevent="loadSample" :aria-busy="loadingSample" class="try-sample-link">{{ loadingSample ? 'Loading sample…' : 'Try a sample Jupiter clip →' }}</a>
			</p>

			<div v-if="liteModeClient" class="lite-mode-warning">
				Stacking on mobile devices will likely not work due to memory limitations. For best results, use Eise.app on a laptop or desktop computer.
			</div>

			<!-- Batch choice dialog -->
			<div v-if="showBatchChoice" class="batch-choice-dialog">
				<h4>{{ pendingBatchFiles.length }} files selected</h4>
				<p>How would you like to process them?</p>
				<div v-if="qualityMode === 'continuous'" class="lite-mode-warning">Continuous stacking is not available in batch mode. Batch files will be stacked using the percentage method instead.</div>
				<div class="batch-choice-buttons">
					<button class="btn-primary" @click="processBatchMode">
						Stack separately (batch)
						<small>Each file becomes its own stack</small>
					</button>
					<button class="btn-secondary" @click="processCombinedMode">
						Combine into one
						<small>All frames merged together</small>
					</button>
				</div>
				<button class="btn-text" @click="cancelBatchChoice">Cancel</button>
			</div>

			<div v-if="selectedFiles.length > 0 && !showBatchChoice && !isBatchMode" class="selected-files">
				<div v-if="selectedFiles.length > 1" class="selected-file-list">
					<div
						v-for="(file, index) in selectedFiles"
						:key="`${file.name}-${index}`"
						class="selected-file-item"
						:class="{ 'is-mismatched': mismatchedFileNames.has(file.name) }"
					>
						<span class="file-name" :title="file.name">{{ file.name }}</span>
						<span class="file-size">{{ formatFileSize(file.size) }}</span>
						<button
							class="remove-btn"
							@click="removeSelectedFile(index)"
							:title="`Remove ${file.name}`"
						>&times;</button>
					</div>
				</div>

				<div v-if="showMemoryOptimization" class="memory-optimization-box">
					<p class="optimization-hint">
						Memory optimization options:
					</p>
					<label class="checkbox-option">
						<input type="checkbox" v-model="enablePreCrop" />
						Pre-crop video
						<span v-if="preCropAutoEnabled" class="auto-badge">auto</span>
					</label>
					<label class="checkbox-option">
						<input type="checkbox" v-model="enableMaxFrames" />
						Limit to
						<input type="number" v-model.number="selectedMaxFrames" min="100" max="5000" step="100" class="number-input" :disabled="!enableMaxFrames" />
						frames
					</label>
				</div>

				<div class="action-buttons">
					<button class="btn-primary" @click="startProcessing">{{ startButtonText }}</button>
					<button class="btn-secondary" @click="clearSelection">Clear</button>
				</div>
			</div>

			<div class="separator"></div>

			<h4>Target <span class="info-icon" @click="showTargetInfo = !showTargetInfo">ⓘ</span></h4>
			<div class="radio-group">
				<label class="radio-option">
					<input type="radio" v-model="targetType" value="planet" />
					Planet (or Moon fully in frame)
				</label>
				<label class="radio-option">
					<input type="radio" v-model="targetType" value="sun-moon" />
					Surface: Closeup of Sun or Moon
				</label>
			</div>
			<p v-if="showTargetInfo" class="info-text"><strong>Planet:</strong> For full-disk planets or Moon. Rejects frames where the object touches the edge.<br><strong>Surface:</strong> For Moon/Sun closeups. Disables edge detection and uses drift tracking for larger frame-to-frame motion.</p>

			<!-- Frame selection hidden in lite mode (defaults to 30%) -->
			<template v-if="!liteModeClient">
				<div class="separator"></div>

				<h4>Frame selection <span class="info-icon" @click="showFrameSelectionInfo = !showFrameSelectionInfo">ⓘ</span></h4>
				<div class="radio-group">
					<label class="radio-option">
						<input type="radio" v-model="qualityMode" value="manual" />
						Manually pick best frames threshold
					</label>
					<label class="radio-option">
						<input type="radio" v-model="qualityMode" value="percentage" />
						Stack best
						<input type="number" v-model.number="stackPercentage" min="1" max="100" class="number-input" :disabled="qualityMode !== 'percentage'" />%
					</label>
					<label class="radio-option">
						<input type="radio" v-model="qualityMode" value="continuous" />
						Continuous stacking (5% to 90%) <b>new+beta</b>
					</label>
				</div>
				<p v-if="showFrameSelectionInfo" class="info-text">
					<strong>Manual:</strong> After analysis, you'll see a quality graph and can choose which frames to stack.<br>
					<strong>Percentage:</strong> Automatically selects the sharpest frames. Recommended if you run into memory issues.<br>
					<strong>Continuous:</strong> Stacks the same file multiple times, each time using more frames (5%, 10%, 15%, ... up to 90%). Helps you find the sweet spot between detail and noise without trial and error. Not the same as batch processing, which processes multiple files.
				</p>
			</template>

			<!-- Advanced toggle (variant B only) -->
			<div v-if="homepageVariant === 'B' && !liteModeClient" class="advanced-toggle-wrapper">
				<button type="button" class="advanced-toggle" @click="toggleAdvanced">
					{{ advancedExpanded ? '− Hide advanced settings' : '+ Advanced settings' }}
				</button>
			</div>

			<!-- Advanced options hidden in lite mode -->
			<template v-if="!liteModeClient && showAdvanced">
				<div class="separator"></div>

				<h4>Stacking mode <span class="info-icon" @click="showStackingModeInfo = !showStackingModeInfo">ⓘ</span></h4>
				<div class="radio-group">
					<label class="radio-option">
						<input type="radio" v-model="drizzleMethod" value="normal" />
						Normal (1x)
					</label>
					<label class="radio-option">
						<input type="radio" v-model="drizzleMethod" value="bicubic" />
						1.5x Bicubic drizzle
					</label>
					<label class="radio-option">
						<input type="radio" v-model="drizzleMethod" value="drizzle" />
						1.5x Pixfrac drizzle <b>beta</b>
					</label>
				</div>
				<label v-if="drizzleMethod === 'drizzle'" class="checkbox-option">
					Pixfrac:
					<input type="number" min="0.3" max="0.95" step="0.05" v-model.number="pixfrac" class="number-input" />
				</label>

				<label class="checkbox-option">
					AP size:
					<input type="number" min="10" max="64" step="2" v-model.number="apPatchSize" class="number-input" />
				</label>

				<label class="checkbox-option">
					AP quality threshold:
					<input type="number" min="0.1" max="0.9" step="0.05" v-model.number="minApQuality" class="number-input" />
				</label>

								<p v-if="showStackingModeInfo" class="info-text"><strong>Normal:</strong> Stacks at original resolution. Faster and uses less memory.<br><strong>Bicubic drizzle:</strong> 1.5x upscale using bicubic interpolation. Good general-purpose drizzle.<br><strong>Pixfrac drizzle:</strong> True Fruchter &amp; Hook drizzle with area-overlap accumulation. Each input pixel is shrunk by pixfrac before mapping to the output grid. Smaller pixfrac (0.5-0.7) recovers more sub-pixel detail but needs more frames for coverage.<br><strong>AP quality threshold:</strong> Minimum NCC correlation score for alignment points. Higher values reject more uncertain matches, reducing artifacts but may leave gaps. Try 0.5-0.6 if you see polygon artifacts.<br><strong>AP size:</strong> Size of alignment point patches in pixels. Smaller = finer precision for local distortion correction, but needs enough features to match. Default 30 is a safe middle ground.</p>

				<template v-if="targetType !== 'sun-moon'">
					<div class="separator"></div>

					<h4>Crop margin <span class="info-icon" @click="showCropMarginInfo = !showCropMarginInfo">ⓘ</span></h4>
					<input type="range" min="5" max="200" step="5" v-model="cropMarginPercent" />
					{{ cropMarginPercent }}%
					<p v-if="showCropMarginInfo" class="info-text">Extra space around detected object. Increase for Saturn's rings, decrease for tighter crops.</p>
				</template>

				</template>

			<!-- Max frames - always visible (important for lite mode) -->
			<template v-if="!showMemoryOptimization && (showAdvanced || liteModeClient)">
				<div class="separator"></div>
				<h4>Max frames <span class="info-icon" @click="showMaxFramesInfo = !showMaxFramesInfo">ⓘ</span></h4>
				<label>
					<input type="checkbox" v-model="enableMaxFrames" />
					Limit frames
				</label>
				<input type="range" min="2" :max="liteModeClient ? 100 : 5000" step="1" v-model="selectedMaxFrames" :disabled="!enableMaxFrames" />
				{{ enableMaxFrames ? selectedMaxFrames : '∞' }}
				<p v-if="showMaxFramesInfo" class="info-text">Lower this if you experience memory issues.</p>
			</template>

			<!-- Processing backend toggle - only meaningful when GPU is actually available -->
			<template v-if="useGPU && showAdvanced">
				<div class="separator"></div>
				<h4>Processing <span class="info-icon" @click="showProcessingBackendInfo = !showProcessingBackendInfo">ⓘ</span></h4>
				<div class="radio-group">
					<label class="radio-option">
						<input type="radio" v-model="processingBackend" value="gpu" />
						GPU (fast)
					</label>
					<label class="radio-option">
						<input type="radio" v-model="processingBackend" value="cpu" />
						CPU (slow)
					</label>
				</div>
				<p v-if="showProcessingBackendInfo" class="info-text">
					GPU is much faster and is the default. Only pick CPU if the GPU path produces bad results or crashes on your file. CPU processing can take many minutes even for short clips.
				</p>
			</template>
		</template>
	</div>

	<!-- Welcome content: only show when not processing -->
	<div class="content" v-if="!isProcessing">
		<h2>Welcome to Eise.app</h2>
		<p class="intro">Eise.app is a free browser-based planetary image stacker for astrophotography. Upload a SER, AVI, or MP4 video of Jupiter, Saturn, Mars, the Moon, or the Sun, and it uses lucky imaging - combining the sharpest frames - to produce a detailed final image. Runs entirely in your browser using WebGPU. No install, no upload, no signup.</p>

		<div class="comparison-images">
			<figure class="comparison-figure">
				<img src="/jupiter-singleframe.png" alt="Single frame from video" width="150" height="150" />
				<figcaption>Single frame</figcaption>
			</figure>
			<span class="arrow">&rarr;</span>
			<figure class="comparison-figure">
				<img src="/jupiter-stacked.png" alt="Stacked and sharpened result" width="150" height="150" />
				<figcaption>Stacked + Sharpened</figcaption>
			</figure>
		</div>
		<p class="sample-credit">
			The example above was shot with a <a href="https://www.astroshop.eu/telescopes/ts-optics-telescope-n-150-750-photon-ota/p,64564?affiliate_id=Eiseapp" target="_blank" rel="noopener sponsored">TS Optics Photon 150/750 Newtonian</a>.
		</p>

		<div class="how-it-works">
			<p>Under the hood, Eise.app automatically analyzes, crops, centers, and ranks every frame, then aligns and stacks the best ones. After stacking, the post processor opens for wavelet sharpening, RGB alignment, and color adjustments.</p>
			<ul>
				<li><strong>SER or AVI files</strong> for stacking + post processing. Multiple files open batch mode.</li>
				<li><strong>Video files</strong> (MP4, MOV, etc.) for stacking + post processing.</li>
				<li><strong>Image files</strong> (TIFF, PNG, JPG) for stacking, or a single image to go straight to the <NuxtLink to="/post-processor/">post processor</NuxtLink>.</li>
			</ul>
			<p><strong>Tip:</strong> For Moon or Sun surface closeups, select "Surface" mode to handle larger frame-to-frame drift.</p>
		</div>

		<h3>More information, bugs and feature requests?</h3>
		<p>Read more on the <NuxtLink to="/about/">About page</NuxtLink>, or head over to <a href="https://github.com/timing/eise.app" target="_blank">Eise.app on Github</a>. If you have feedback or you run into issues, <a href="#" @click.prevent="openFeedback()">Let me know!</a></p>

		<aside class="home-testimonial">
			<p class="home-testimonial-quote">"Very good app — it helped me massively improve my image of the Moon."</p>
			<p class="home-testimonial-cite">
				<span>— Santhiago, astrophotographer from Costa Rica</span>
				<NuxtLink to="/about/#testimonials">Read more testimonials &rarr;</NuxtLink>
			</p>
		</aside>
	</div>
</div>
</template>

<script setup>
import { fetchFile } from '@ffmpeg/ffmpeg';
import { computed, defineEmits, ref, onMounted, watch, inject } from 'vue';
import { useEventBus } from '@/composables/eventBus';
// useSerReader removed - now using useSerParser + useDebayerReader
import { useAviReader } from '@/composables/useAviReader';
import { useFFmpegReader } from '@/composables/useFFmpegReader';
import { useMediabunnyReader } from '@/composables/useMediabunnyReader';
import { useImageReader } from '@/composables/useImageReader';
import { useProcessingState } from '@/composables/useProcessingState';
import { useBatchProcessing, formatFileSize } from '@/composables/useBatchProcessing';
import { reportError, UserError } from '@/composables/useSentryReporting';
import { FFmpegUnsupportedError } from '@/plugins/ffmpeg';
import { useFeedback } from '@/composables/useFeedback';
import { useTracking } from '@/composables/useTracking';
import { useAbTest } from '@/composables/useAbTest';
import { useLiteMemoryLimits } from '@/composables/useLiteMemoryLimits';

// Lite mode: auto-enabled on mobile OR when WebGPU unavailable
// Limitations: max 100 frames, no drizzle, 8-bit, limited UI
const liteMode = inject('liteMode', ref(false));

/// GPU vs CPU: use GPU when available (even in lite mode on mobile)
const useGPU = inject('useGPU', ref(false));
const isMobile = inject('isMobile', ref(false));
const isMobileClient = ref(false); // Only true after mount to avoid hydration mismatch
const liteModeClient = ref(false); // Only true after mount to avoid hydration mismatch

const { track } = useTracking();
const homepageVariant = useAbTest('homepage');
const advancedExpanded = ref(false);
const showAdvanced = computed(() => homepageVariant.value !== 'B' || advancedExpanded.value);
function toggleAdvanced() {
	advancedExpanded.value = !advancedExpanded.value;
	try {
		localStorage.setItem('eise-advanced-expanded', advancedExpanded.value ? 'true' : 'false');
	} catch {}
}
const { detectPlatform, checkFileSize } = useLiteMemoryLimits();

const { openFeedback } = useFeedback();
const { $ffmpeg, $loadFFmpeg, $recycleFFmpeg } = useNuxtApp();

async function openErrorFeedback(event) {
	const opened = await openFeedback({
		formTitle: 'Report an issue',
		messagePlaceholder: 'What were you trying to do when this error occurred?',
	});
	if (opened) {
		event.preventDefault();
	}
}

async function openCancelFeedback(event) {
	const opened = await openFeedback({
		formTitle: 'What went wrong?',
		messagePlaceholder: 'Why did you cancel? Was something not working or taking too long?',
	});
	if (opened) {
		event.preventDefault();
	}
}

const enableMaxFrames = ref(false);
const selectedMaxFrames = ref(100);

const errorMessage = ref(null);
const errorIsUserFault = ref(false);
const errorAlternatives = ref([]); // [{ label, description, url?, external? }]
const mismatchedFileNames = ref(new Set());
const showCancelledMessage = ref(false);

// Info toggle state
const showMaxFramesInfo = ref(false);
const showCropMarginInfo = ref(false);
const showPreCropInfo = ref(false);
const showTargetInfo = ref(false);
const showFrameSelectionInfo = ref(false);
const showStackingModeInfo = ref(false);
const showContinuousInfo = ref(false);
const showProcessingBackendInfo = ref(false);

// User-selectable backend. Only takes effect when GPU is otherwise available;
// effectiveUseGpu below computes what actually gets used.
const processingBackend = ref('gpu');
const effectiveUseGpu = computed(() => useGPU.value && processingBackend.value !== 'cpu');

// Crop margin setting (percentage of detected object size to add as margin)
const cropMarginPercent = ref(10);

// Quality threshold mode: 'manual' for interactive selection, 'percentage' for automatic, 'continuous' for batch
const qualityMode = ref('manual');
const stackPercentage = ref(30);
const drizzleMode = ref('1.5x'); // kept for backward compat with saved settings migration
const minApQuality = ref(0.3); // Alignment point quality threshold (NCC score)
const apPatchSize = ref(30); // Alignment point patch size in pixels
const drizzleMethod = ref('normal'); // 'normal', 'bicubic', or 'drizzle'
const pixfrac = ref(0.7); // Drizzle drop shrink factor (Fruchter & Hook)

// Target type: 'planet' or 'sun-moon' - affects cut-off frame detection
const targetType = ref('planet');
const surfaceMode = computed(() => targetType.value === 'sun-moon');

// Lite mode enforced settings (applies to mobile + no-GPU desktop)
const effectiveDrizzleScale = computed(() => liteMode.value ? 1.0 : (drizzleMethod.value === 'normal' ? 1.0 : 1.5));
const effectiveMaxFrames = computed(() => liteMode.value ? 100 : (enableMaxFrames.value ? selectedMaxFrames.value : -1));
const effectiveCropMargin = computed(() => liteMode.value ? 15 : cropMarginPercent.value);
const effectiveQualityMode = computed(() => {
	if (liteMode.value) return 'percentage';
	return qualityMode.value;
});
const effectiveStackPercentage = computed(() => liteMode.value ? 30 : stackPercentage.value);

// Memory optimized pre-crop for mobile videos
const enablePreCrop = ref(false);
const preCropAutoEnabled = ref(false); // Track if it was auto-enabled
// Load settings from localStorage
function loadSettings() {
	try {
		const saved = localStorage.getItem('eise-settings');
		if (saved) {
			const settings = JSON.parse(saved);
			if (settings.qualityMode) qualityMode.value = settings.qualityMode;
			if (settings.stackPercentage) stackPercentage.value = settings.stackPercentage;
			// Migrate old drizzleMode to drizzleMethod
			if (settings.drizzleMethod) {
				drizzleMethod.value = settings.drizzleMethod;
			} else if (settings.drizzleMode) {
				drizzleMethod.value = settings.drizzleMode === '1x' ? 'normal' : 'bicubic';
			}
			if (settings.cropMarginPercent) cropMarginPercent.value = settings.cropMarginPercent;
			if (settings.enableMaxFrames !== undefined) enableMaxFrames.value = settings.enableMaxFrames;
			if (settings.selectedMaxFrames) selectedMaxFrames.value = settings.selectedMaxFrames;
			if (settings.targetType) targetType.value = settings.targetType;
			if (settings.minApQuality !== undefined) minApQuality.value = settings.minApQuality;
			if (settings.apPatchSize !== undefined) apPatchSize.value = settings.apPatchSize;
			if (settings.pixfrac !== undefined) pixfrac.value = settings.pixfrac;
			if (settings.drizzleMethod) drizzleMethod.value = settings.drizzleMethod;
			if (settings.processingBackend === 'gpu' || settings.processingBackend === 'cpu') {
				processingBackend.value = settings.processingBackend;
			}
		}
	} catch (e) {
		console.warn('Failed to load settings:', e);
	}
}

// Save settings to localStorage
function saveSettings() {
	try {
		const settings = {
			qualityMode: qualityMode.value,
			stackPercentage: stackPercentage.value,
			drizzleMethod: drizzleMethod.value,
			cropMarginPercent: cropMarginPercent.value,
			enableMaxFrames: enableMaxFrames.value,
			selectedMaxFrames: selectedMaxFrames.value,
			targetType: targetType.value,
			minApQuality: minApQuality.value,
			apPatchSize: apPatchSize.value,
			pixfrac: pixfrac.value,
			drizzleMethod: drizzleMethod.value,
			processingBackend: processingBackend.value
		};
		localStorage.setItem('eise-settings', JSON.stringify(settings));
	} catch (e) {
		console.warn('Failed to save settings:', e);
	}
}

// Watch all settings and save on change
watch([qualityMode, stackPercentage, drizzleMethod, cropMarginPercent, enableMaxFrames, selectedMaxFrames, targetType, minApQuality, apPatchSize, pixfrac, processingBackend], saveSettings);

onMounted(async () => {
	loadSettings();
	try {
		advancedExpanded.value = localStorage.getItem('eise-advanced-expanded') === 'true';
	} catch {}
	isMobileClient.value = isMobile.value;
	liteModeClient.value = liteMode.value;

	// In lite mode, enable max frames with default of 100
	if (liteMode.value) {
		enableMaxFrames.value = true;
		selectedMaxFrames.value = 100;
	}
});

const selectedFiles = ref([]);
const isProcessing = ref(false);
const fileInput = ref(null);

// Batch mode state
const isBatchMode = ref(false);
const showBatchChoice = ref(false);
const pendingBatchFiles = ref([]);

// Batch processing composable
const { addFiles: addBatchFiles, clearBatch, isActive: isBatchActive } = useBatchProcessing();

// Batch settings computed from current UI settings
const batchSettings = computed(() => ({
	stackPercentage: effectiveStackPercentage.value,
	drizzleScale: effectiveDrizzleScale.value,
	cropMarginPercent: effectiveCropMargin.value,
	surfaceMode: surfaceMode.value,
	manualThreshold: false, // Batch mode uses automatic threshold
	maxFrames: effectiveMaxFrames.value
}));

const emit = defineEmits(['postProcessing', 'processing-started']);

const selectedFilesDescription = computed(() => {
	if (selectedFiles.value.length === 0) return '';
	if (selectedFiles.value.length === 1) return selectedFiles.value[0].name;
	return `${selectedFiles.value.length} files`;
});

const startButtonText = computed(() => {
	if (selectedFiles.value.length === 1) {
		const file = selectedFiles.value[0];
		if (file.type.startsWith('image/')) {
			return 'Post process';
		}
	}
	return 'Stack';
});

// Show pre-crop option for video files that might need FFmpeg (not SER)
const showPreCropOption = computed(() => {
	if (selectedFiles.value.length !== 1) return false;
	const file = selectedFiles.value[0];
	if (file.name.toLowerCase().endsWith('.ser')) return false;
	// Show for any video file (including AVI that might need FFmpeg)
	return file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.avi');
});

// Detect mobile device
const isMobileDevice = computed(() => {
	if (typeof navigator === 'undefined') return false;
	return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
});

// Show memory optimization box only on mobile (hidden in lite mode - already constrained)
const showMemoryOptimization = computed(() => {
	if (liteMode.value) return false;
	if (!showPreCropOption.value) return false;
	return isMobileDevice.value;
});

// Auto-enable pre-crop for mobile devices OR lite mode (saves memory)
watch([selectedFiles, isMobileDevice, liteMode], () => {
	if (showPreCropOption.value && (isMobileDevice.value || liteMode.value)) {
		enablePreCrop.value = true;
		preCropAutoEnabled.value = true;
	} else {
		// Reset pre-crop when not needed
		if (preCropAutoEnabled.value) {
			enablePreCrop.value = false;
		}
		preCropAutoEnabled.value = false;
	}
}, { immediate: true });

const { addLog, emit: eventBusEmit, on, logs } = useEventBus();
const { setMinApQuality: setSharedMinApQuality, setApPatchSize: setSharedApPatchSize, setPixfrac: setSharedPixfrac, getTrackingContext } = useProcessingState();

// Sync stacking settings to shared state for stacker to use
watch(minApQuality, (val) => setSharedMinApQuality(val), { immediate: true });
watch(apPatchSize, (val) => setSharedApPatchSize(val), { immediate: true });
// Effective pixfrac: bicubic method uses 1.0, drizzle method uses user value
const effectivePixfrac = computed(() => drizzleMethod.value === 'drizzle' ? pixfrac.value : 1.0);
// Migrate old drizzleMode setting to new drizzleMethod
watch(effectivePixfrac, (val) => setSharedPixfrac(val), { immediate: true });

// Listen for upload errors to display them
on('upload-error', (message) => {
	errorMessage.value = message;
});

function onFileChanged(event){
	clearError(); // Clear previous error state (message + user-fault flag + mismatch set)
	const files = Array.from(event.target.files);
	selectedFiles.value = files;
	eventBusEmit('stop-loading');

	// Categorize files
	const videoFiles = files.filter(f => f.type.startsWith('video/') || f.name.toLowerCase().endsWith('.ser') || f.name.toLowerCase().endsWith('.avi'));
	const imageFiles = files.filter(f => f.type.startsWith('image/'));
	const serFiles = files.filter(f => f.name.toLowerCase().endsWith('.ser'));
	const aviFiles = files.filter(f => f.name.toLowerCase().endsWith('.avi'));
	const batchableFiles = [...serFiles, ...aviFiles];
	const nonSerVideos = videoFiles.filter(f => !f.name.toLowerCase().endsWith('.ser') && !f.name.toLowerCase().endsWith('.avi'));

	// Validate file combinations upfront
	if (batchableFiles.length > 0 && nonSerVideos.length > 0) {
		alert('Please select either SER/AVI files or other video files, not both.');
		clearSelection();
		return;
	}

	if (nonSerVideos.length > 1) {
		alert('Please select only one video file (multiple SER/AVI files are supported for batch processing).');
		clearSelection();
		return;
	}

	if (videoFiles.length >= 1 && imageFiles.length > 0) {
		alert('Please select either video files or image files, not both.');
		clearSelection();
		return;
	}

	// Immediately show batch choice dialog if multiple SER/AVI files selected
	if (batchableFiles.length > 1) {
		pendingBatchFiles.value = batchableFiles;
		showBatchChoice.value = true;
	}
}

// Pre-crop detection: sample frames and find planet bounds
async function detectPreCropRegion(filename) {
	addLog('Sampling frames to detect crop region...');
	eventBusEmit('set-caption', 'Detecting crop region...');

	// Get video info from FFmpeg output
	let videoWidth = 0;
	let videoHeight = 0;
	let duration = 0;

	// Probe video by running FFmpeg briefly
	$ffmpeg.setLogger(({ type, message }) => {
		if (typeof message !== 'string') return;
		// Parse resolution: "Stream #0:0: Video: h264, 1920x1080"
		const resMatch = message.match(/(\d{3,4})x(\d{3,4})/);
		if (resMatch && !videoWidth) {
			videoWidth = parseInt(resMatch[1], 10);
			videoHeight = parseInt(resMatch[2], 10);
		}
		// Parse duration: "Duration: 00:01:30.50"
		const durMatch = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
		if (durMatch) {
			duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
		}
	});

	// Run brief probe
	try {
		await $ffmpeg.run('-i', filename, '-f', 'null', '-t', '0.001', '-');
	} catch (e) {
		// FFmpeg exits with error for -f null, that's fine
	}

	addLog(`Video: ${videoWidth}x${videoHeight}, duration: ${duration.toFixed(1)}s`);

	if (!videoWidth || !videoHeight) {
		addLog('Could not detect video dimensions, skipping pre-crop');
		return null;
	}

	// Sample 10 frames spread across the video, extracting ONE AT A TIME to minimize memory
	const sampleCount = 10;
	const allBounds = [];

	// Calculate time positions for each sample (skip first/last 10% of video)
	const startTime = duration * 0.1;
	const endTime = duration * 0.9;
	const timeStep = (endTime - startTime) / (sampleCount - 1);

	eventBusEmit('update-loading', { progress: 10, current: 0, total: sampleCount });

	// Suppress FFmpeg info output during sampling
	$ffmpeg.setLogger(() => {});

	// Extract and process one frame at a time to minimize peak memory
	for (let i = 0; i < sampleCount; i++) {
		const seekTime = startTime + (i * timeStep);
		const sampleFile = 'sample.png';

		eventBusEmit('set-caption', `Sampling frame ${i + 1}/${sampleCount}...`);
		eventBusEmit('update-loading', { progress: 10 + ((i + 1) / sampleCount) * 40, current: i + 1, total: sampleCount });

		try {
			// Extract single frame at this time position
			await $ffmpeg.run(
				'-ss', seekTime.toFixed(2),
				'-i', filename,
				'-vframes', '1',
				'-y',  // Overwrite previous sample
				sampleFile
			);

			const pngData = $ffmpeg.FS('readFile', sampleFile);
			$ffmpeg.FS('unlink', sampleFile);

			// Decode PNG and detect bounds using canvas
			const blob = new Blob([pngData], { type: 'image/png' });
			const bitmap = await createImageBitmap(blob);

			// Create canvas to get pixel data
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const ctx = canvas.getContext('2d');
			ctx.drawImage(bitmap, 0, 0);
			const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

			// Simple bright object detection
			const bounds = detectBrightObjectBounds(imageData.data, bitmap.width, bitmap.height);
			if (bounds) {
				allBounds.push(bounds);
				addLog(`Sample ${i + 1}: planet at (${bounds.x}, ${bounds.y}) size ${bounds.width}x${bounds.height}`);
			}
		} catch (e) {
			addLog(`Sample ${i + 1} extraction failed: ${e.message}`);
		}
	}

	if (allBounds.length === 0) {
		addLog('No planet detected in samples, skipping pre-crop');
		return null;
	}

	// Calculate encompassing region with margin
	const minX = Math.min(...allBounds.map(b => b.x));
	const minY = Math.min(...allBounds.map(b => b.y));
	const maxX = Math.max(...allBounds.map(b => b.x + b.width));
	const maxY = Math.max(...allBounds.map(b => b.y + b.height));

	const regionWidth = maxX - minX;
	const regionHeight = maxY - minY;
	const margin = Math.max(regionWidth, regionHeight) * (cropMarginPercent.value / 100);

	// Calculate crop with margin, ensuring it stays within bounds and is even (for video codecs)
	let cropX = Math.max(0, Math.floor(minX - margin));
	let cropY = Math.max(0, Math.floor(minY - margin));
	let cropW = Math.min(videoWidth - cropX, Math.ceil(regionWidth + margin * 2));
	let cropH = Math.min(videoHeight - cropY, Math.ceil(regionHeight + margin * 2));

	// Make dimensions even for video codec compatibility
	cropW = Math.floor(cropW / 2) * 2;
	cropH = Math.floor(cropH / 2) * 2;

	addLog(`Pre-crop region: ${cropW}x${cropH} at (${cropX}, ${cropY})`);
	addLog(`Memory reduction: ${((1 - (cropW * cropH) / (videoWidth * videoHeight)) * 100).toFixed(0)}%`);

	return { x: cropX, y: cropY, width: cropW, height: cropH };
}

// Simple bright object detection for pre-crop sampling
function detectBrightObjectBounds(pixels, width, height) {
	// Convert to grayscale and find threshold
	const gray = new Uint8Array(width * height);
	let maxVal = 0;

	for (let i = 0; i < width * height; i++) {
		const r = pixels[i * 4];
		const g = pixels[i * 4 + 1];
		const b = pixels[i * 4 + 2];
		gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
		if (gray[i] > maxVal) maxVal = gray[i];
	}

	// Threshold at 30% of max brightness
	const threshold = maxVal * 0.3;

	let minX = width, minY = height, maxX = 0, maxY = 0;
	let found = false;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (gray[y * width + x] > threshold) {
				found = true;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}

	if (!found || maxX <= minX || maxY <= minY) return null;

	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY
	};
}

// Sample file — served from public/samples/. See public/samples/README.md.
const SAMPLE_URL = '/samples/jupiter-sample.mp4';
const SAMPLE_NAME = 'jupiter-sample.mp4';
const SAMPLE_MIME = 'video/mp4';
const loadingSample = ref(false);

async function loadSample() {
	if (loadingSample.value) return;

	// Fire analytics on click (before fetch) so intent is captured even if the
	// sample download fails.
	track('try_sample', { source: 'homepage' });

	// Force sensible defaults for the demo: Planet target, no frame limit.
	// Everything else is left as the user configured it.
	targetType.value = 'planet';
	enableMaxFrames.value = false;

	loadingSample.value = true;
	errorMessage.value = null;
	try {
		const res = await fetch(SAMPLE_URL);
		if (!res.ok) throw new Error(`Sample not available (HTTP ${res.status})`);
		const blob = await res.blob();
		const file = new File([blob], SAMPLE_NAME, { type: SAMPLE_MIME });
		selectedFiles.value = [file];
		await startProcessing();
	} catch (err) {
		errorMessage.value = `Could not load sample: ${err.message}`;
	} finally {
		loadingSample.value = false;
	}
}

async function startProcessing() {
	if (selectedFiles.value.length === 0) return;
	clearError();

	if (liteMode.value) {
		addLog('Lite Mode: max 100 frames, best 30%, 1x stacking, CPU processing');
	}

	try {
		await processFiles(selectedFiles.value);
	} catch (error) {
		console.error('Processing error:', error);
		const filename = selectedFiles.value?.[0]?.name;
		reportError(error, {
			component: 'FileUploader',
			action: 'processFiles',
			filename,
			logs: logs.value
		});
		track('stack_failed', getTrackingContext());
		const errorMsg = error.message || 'An error occurred during processing';
		// Set error and stop processing - FileUploader will show with error visible
		isProcessing.value = false;
		setErrorFromException(error, errorMsg);
		eventBusEmit('stop-loading');
		eventBusEmit('show-error');
	}
}

function cancelProcessing() {
	track('stack_cancelled', getTrackingContext());
	isProcessing.value = false;
	selectedFiles.value = [];
	if (fileInput.value) {
		fileInput.value.value = '';
	}
	eventBusEmit('stop-loading');
	eventBusEmit('cancel-processing');
	showCancelledMessage.value = true;
}

function reloadPage() {
	window.location.reload();
}

function clearSelection() {
	selectedFiles.value = [];
	if (fileInput.value) {
		fileInput.value.value = '';
	}
	clearError();
	// Also clear batch mode
	isBatchMode.value = false;
	showBatchChoice.value = false;
	pendingBatchFiles.value = [];
}

function clearError() {
	errorMessage.value = null;
	errorIsUserFault.value = false;
	errorAlternatives.value = [];
	mismatchedFileNames.value = new Set();
}

// Show an error that the user can act on without reloading (e.g. the browser
// can't run FFmpeg). `alternatives` become clickable options in the error card.
function showActionableError(message, alternatives) {
	errorMessage.value = message;
	errorIsUserFault.value = true; // suppress the "let me know" feedback prompt + reload button
	errorAlternatives.value = alternatives;
	eventBusEmit('stop-loading');
	eventBusEmit('show-error');
}

function ffmpegUnsupportedAlternatives({ context = 'video' } = {}) {
	const fileHint = context === 'image'
		? {
			label: 'Convert the image first',
			description: 'Save as PNG, JPEG or TIFF (any format your browser opens natively) and try again.'
		}
		: {
			label: 'Use a file format that runs in your browser',
			description: 'SER and AVI files from capture software (SharpCap, FireCapture, etc.) work directly, no FFmpeg needed.'
		};
	return [
		fileHint,
		{
			label: 'Download the Eise desktop app',
			description: 'The Mac, Windows and Linux builds ship their own decoder and handle any format.',
			url: '/download/'
		},
		{
			label: 'Open eise.app in Chrome or Firefox on a laptop',
			description: 'Most desktop browsers support the feature this file needs.'
		}
	];
}

function setErrorFromException(error, fallbackMessage) {
	errorMessage.value = error?.message || fallbackMessage;
	errorIsUserFault.value = error instanceof UserError;
	const names = error?.details?.mismatchedFileNames;
	mismatchedFileNames.value = new Set(Array.isArray(names) ? names : []);
}

function removeSelectedFile(index) {
	const removed = selectedFiles.value[index];
	if (!removed) return;
	selectedFiles.value = selectedFiles.value.filter((_, i) => i !== index);
	if (mismatchedFileNames.value.has(removed.name)) {
		const next = new Set(mismatchedFileNames.value);
		next.delete(removed.name);
		mismatchedFileNames.value = next;
	}
	// If the user cleared the mismatched files, hide the error so they can retry.
	if (errorIsUserFault.value && mismatchedFileNames.value.size === 0) {
		clearError();
	}
	if (selectedFiles.value.length === 0) {
		clearSelection();
	}
}

// Batch mode handlers
function processBatchMode() {
	showBatchChoice.value = false;
	isBatchMode.value = true;
	// Add files to batch queue
	addBatchFiles(pendingBatchFiles.value);
	pendingBatchFiles.value = [];
	// Clear the main file selection since batch panel handles it
	selectedFiles.value = [];
}

async function processCombinedMode() {
	showBatchChoice.value = false;
	pendingBatchFiles.value = [];
	// Continue with existing multi-SER combined processing (skip batch dialog)
	if (selectedFiles.value.length === 0) return;
	clearError();

	try {
		await processFiles(selectedFiles.value, { skipBatchChoice: true });
	} catch (error) {
		console.error('Processing error:', error);
		const filename = selectedFiles.value?.[0]?.name;
		reportError(error, {
			component: 'FileUploader',
			action: 'processFiles',
			filename,
			logs: logs.value
		});
		track('stack_failed', getTrackingContext());
		const errorMsg = error.message || 'An error occurred during processing';
		isProcessing.value = false;
		setErrorFromException(error, errorMsg);
		eventBusEmit('stop-loading');
		eventBusEmit('show-error');
	}
}

function cancelBatchChoice() {
	// Clear file selection so user can start fresh
	clearSelection();
}

function handleBatchStart() {
	isProcessing.value = true;
	emit('processing-started');
}

function handleBatchClear() {
	isBatchMode.value = false;
	clearBatch();
}

// Unsupported RAW camera formats
const RAW_EXTENSIONS = ['.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf'];
const isRawFile = (file) => RAW_EXTENSIONS.some(ext => file.name.toLowerCase().endsWith(ext));

async function processFiles(files, options = {}) {
	const { skipBatchChoice = false } = options;
	const { setInputFilename, setTrackingContext, setStackingMode } = useProcessingState();

	setStackingMode(qualityMode.value === 'continuous' ? 'continuous' : 'single');

	const videoFiles = files.filter(file => file.type.startsWith('video/') || file.name.endsWith('.ser') || file.name.endsWith('.avi'));
	const imageFiles = files.filter(file => file.type.startsWith('image/'));

	// Set the input filename for output file naming
	const primaryFile = videoFiles[0] || imageFiles[0];
	if (primaryFile) {
		setInputFilename(primaryFile.name);
		addLog(`File: ${primaryFile.name}`);
	}

	// Multiple SER/AVI files - offer batch mode choice (unless already chosen)
	const serFiles = videoFiles.filter(f => f.name.toLowerCase().endsWith('.ser'));
	const aviFiles = videoFiles.filter(f => f.name.toLowerCase().endsWith('.avi'));
	const batchableFiles = [...serFiles, ...aviFiles];

	// Show batch choice dialog if multiple SER/AVI and user hasn't already chosen
	if (batchableFiles.length > 1 && !skipBatchChoice && !isBatchMode.value) {
		pendingBatchFiles.value = batchableFiles;
		showBatchChoice.value = true;
		isProcessing.value = false;
		eventBusEmit('stop-loading');
		return;
	}

	// Handle multiple SER files (combined stacking) - when user chose "Combine" option
	if (serFiles.length > 1) {
		if (!effectiveUseGpu.value) {
			eventBusEmit('upload-error', 'SER files require GPU processing. Please switch Processing to GPU in settings, or convert your SER file to MP4/MOV.');
			eventBusEmit('show-error');
			isProcessing.value = false;
			return;
		}
		setTrackingContext({ file_type: 'ser', reader: 'debayer', gpu_enabled: effectiveUseGpu.value });
		// Note: processing-started is emitted via eventBus after color profile selection
		addLog(`Processing ${serFiles.length} SER files for combined stacking`);

		const { useMultiSerParser } = await import('@/composables/useSerParser');
		const { useDebayerReader } = await import('@/composables/useDebayerReader');

		const parser = useMultiSerParser();
		await parser.init(serFiles);

		const reader = useDebayerReader();
		await reader.init(serFiles[0], parser);  // First file for reference, parser handles all
		await reader.processFile({
			maxFrames: effectiveMaxFrames.value,
			manualThreshold: effectiveQualityMode.value === 'manual' || effectiveQualityMode.value === 'continuous',
			cropMarginPercent: effectiveCropMargin.value,
			stackPercentage: effectiveStackPercentage.value,
			drizzleScale: effectiveDrizzleScale.value,
			surfaceMode: surfaceMode.value,
		});
		return;
	}

	if( videoFiles.length == 1 ){
		let fileToProcess = videoFiles[0];

		const MAX_SIZE = 1.9 * 1024 * 1024 * 1024;
		if (!fileToProcess.name.endsWith('.ser') && !fileToProcess.name.endsWith('.avi') && fileToProcess.size > MAX_SIZE) {
			if (confirm('The selected file is larger than 2GB. Do you want to trim it to 2GB? This might not work for all video formats.')) {
				const trimmedBlob = fileToProcess.slice(0, MAX_SIZE);
				fileToProcess = new File([trimmedBlob], fileToProcess.name, { type: fileToProcess.type });
				addLog('File trimmed to fit within the memory limit');
			}
		}

		// Handle SER files with unified debayer reader
		if (fileToProcess.name.endsWith('.ser')) {
			if (!effectiveUseGpu.value) {
				eventBusEmit('upload-error', 'SER files require GPU processing. Please switch Processing to GPU in settings, or convert your SER file to MP4/MOV.');
				eventBusEmit('show-error');
				isProcessing.value = false;
				return;
			}
			setTrackingContext({ file_type: 'ser', reader: 'debayer', gpu_enabled: effectiveUseGpu.value });
			// Note: processing-started is emitted via eventBus after color profile selection (if needed)

			// Use new unified debayer reader
			const { useSerParser } = await import('@/composables/useSerParser');
			const { useDebayerReader } = await import('@/composables/useDebayerReader');

			const parser = useSerParser();
			await parser.init(fileToProcess);

			const reader = useDebayerReader();
			await reader.init(fileToProcess, parser);
			await reader.processFile({
				maxFrames: effectiveMaxFrames.value,
				manualThreshold: effectiveQualityMode.value === 'manual' || effectiveQualityMode.value === 'continuous',
				cropMarginPercent: effectiveCropMargin.value,
				stackPercentage: effectiveStackPercentage.value,
				drizzleScale: effectiveDrizzleScale.value,
								surfaceMode: surfaceMode.value,
			});
			return;
		}

		let needsFfmpeg = !fileToProcess.name.endsWith('.avi'); // Non-AVI always needs FFmpeg
		let expectedFrameCount = null; // From AVI header if available

		if (fileToProcess.name.endsWith('.avi') && !liteMode.value && effectiveUseGpu.value) {
			// First, just check the header (only 5MB) to see if we can process directly
			const { readAviFile, checkAviFormat } = useAviReader();

			addLog('Checking AVI format...');
			const headerProbeSize = Math.min(fileToProcess.size, 1024 * 1024 * 5);
			const headerSlice = fileToProcess.slice(0, headerProbeSize);
			const headerBuffer = await headerSlice.arrayBuffer();

			const formatInfo = await checkAviFormat(headerBuffer, fileToProcess.size);

			if (formatInfo.isSupported) {
				// Check if it's 8-bit raw Bayer that needs the unified debayer reader
				const { is8bitRawFormat } = await import('@/composables/useAviParser');
				const is8bitRaw = is8bitRawFormat(formatInfo.aviHeader.fourCC, formatInfo.aviHeader.bpp);

				if (is8bitRaw) {
					// Route 8-bit raw Bayer AVI through unified debayer reader
					setTrackingContext({ file_type: 'avi', reader: 'debayer', gpu_enabled: effectiveUseGpu.value });
					// Note: processing-started is emitted via eventBus after color profile selection
					addLog('8-bit raw Bayer AVI detected. Using unified debayer reader.');

					const { useAviParser } = await import('@/composables/useAviParser');
					const { useDebayerReader } = await import('@/composables/useDebayerReader');

					const parser = useAviParser();
					await parser.init(fileToProcess);

					const reader = useDebayerReader();
					await reader.init(fileToProcess, parser);
					await reader.processFile({
						maxFrames: effectiveMaxFrames.value,
						manualThreshold: effectiveQualityMode.value === 'manual' || effectiveQualityMode.value === 'continuous',
						cropMarginPercent: effectiveCropMargin.value,
						stackPercentage: effectiveStackPercentage.value,
						drizzleScale: effectiveDrizzleScale.value,
												surfaceMode: surfaceMode.value,
					});
					return;
				}

				// Non-Bayer AVI: use old reader for uncompressed BGR or MJPEG
				setTrackingContext({ file_type: 'avi', reader: 'avi', gpu_enabled: effectiveUseGpu.value });
				emit('processing-started');
				await readAviFile(fileToProcess, effectiveMaxFrames.value, effectiveQualityMode.value === 'manual' || effectiveQualityMode.value === 'continuous', effectiveCropMargin.value, effectiveStackPercentage.value, effectiveDrizzleScale.value, effectiveUseGpu.value, null, surfaceMode.value, formatInfo.aviHeader);
				return;
			} else {
				addLog(`AVI format '${formatInfo.fourCC}' needs FFmpeg processing.`);
				needsFfmpeg = true;
				expectedFrameCount = formatInfo.frameCount; // Use frame count from header
			}
		} else if (fileToProcess.name.endsWith('.avi') && liteMode.value) {
			// Lite mode: force FFmpeg for AVI files too
			addLog('Lite mode: using FFmpeg for AVI processing');
			needsFfmpeg = true;
		} else if (fileToProcess.name.endsWith('.avi') && !effectiveUseGpu.value) {
			// User selected CPU: route AVI through FFmpeg so it hits the fixed CPU path
			addLog('CPU mode: using FFmpeg for AVI processing');
			needsFfmpeg = true;
		}

		if (!needsFfmpeg) return;

		// Try Mediabunny + WebCodecs first (lighter than FFmpeg, ~50KB vs ~25MB)
		// Works in both normal and lite mode - especially beneficial for mobile.
		// When user selected CPU, skip mediabunny entirely and go straight to FFmpeg.
		if (effectiveUseGpu.value) {
			const { canHandle, processVideoFrames } = useMediabunnyReader();
			const check = await canHandle(fileToProcess);

			if (check.supported) {
				addLog('Using Mediabunny + WebCodecs (lightweight decoder)');
				setTrackingContext({ file_type: 'video', reader: 'mediabunny', gpu_enabled: effectiveUseGpu.value });
				emit('processing-started');
				eventBusEmit('start-loading', 'Opening video...');

				try {
					await processVideoFrames(fileToProcess, {
						maxFrames: effectiveMaxFrames.value,
						manualThreshold: effectiveQualityMode.value === 'manual' || effectiveQualityMode.value === 'continuous',
						cropMarginPercent: effectiveCropMargin.value,
						stackPercentage: effectiveStackPercentage.value,
						drizzleScale: effectiveDrizzleScale.value,
						surfaceMode: surfaceMode.value,
						useWebGPU: effectiveUseGpu.value
					});
					return;
				} catch (mediabunnyErr) {
					addLog(`Mediabunny failed: ${mediabunnyErr.message}, falling back to FFmpeg`);
				}
			} else {
				addLog(`Mediabunny cannot handle this file: ${check.reason}`);
				addLog('Falling back to FFmpeg...');
			}
		} else {
			addLog('CPU mode: using FFmpeg directly');
		}

		// Show loading indicator for FFmpeg path (SER files handle this after color profile selection)
		eventBusEmit('start-loading', 'Loading FFmpeg...');
		try {
			await $loadFFmpeg();
		} catch (err) {
			if (err instanceof FFmpegUnsupportedError) {
				showActionableError(
					"Your browser can't run the video decoder needed for this file. It's missing a feature (SharedArrayBuffer) that FFmpeg needs. You have a few options:",
					ffmpegUnsupportedAlternatives()
				);
				return;
			}
			reportError(err, { component: 'FileUploader', action: 'loadFFmpeg', logs: logs.value });
			eventBusEmit('upload-error', err.message || 'Failed to load FFmpeg. Please refresh and try again.');
			eventBusEmit('show-error');
			return;
		}

		eventBusEmit('set-caption', 'Importing frames from video');

		addLog('Storing video in memory');
		try {
			// Fetch file content first - Safari can throw InvalidStateError if file changed after selection
			let fileData;
			try {
				fileData = await fetchFile(fileToProcess);
			} catch (fetchErr) {
				// Safari-specific: InvalidStateError when file handle becomes invalid
				const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
				if (fetchErr.name === 'InvalidStateError' || fetchErr.code === 11) {
					console.error('File fetch error (possible file change):', fetchErr);
					const msg = isSafari
						? 'The file could not be read. Safari may have lost access to the file. Please re-select the file and try again.'
						: 'The file could not be read. It may have been modified or moved. Please re-select the file.';
					eventBusEmit('upload-error', msg);
					eventBusEmit('show-error');
					return;
				}
				throw fetchErr; // Re-throw other errors
			}
			$ffmpeg.FS('writeFile', fileToProcess.name, fileData);
		} catch(err) {
			console.error('FFmpeg writeFile error:', err);
			reportError(err, {
				component: 'FileUploader',
				action: 'ffmpegWriteFile',
				filename: fileToProcess.name,
				logs: logs.value,
				extra: { fileSize: fileToProcess.size }
			});
			addLog(`ffmpeg: Storing video in memory failed: ${err.message || err}`);
			eventBusEmit('upload-error', 'Failed to load video into memory. The file may be too large. Try using a SER file instead, or enable frame limiting.');
			eventBusEmit('show-error');
			return;
		}
		addLog('Storing video in memory done');

		// Only switch to processing view after we know the file loaded successfully
		// Determine file type for tracking (could be AVI needing FFmpeg or other video format)
		const ffmpegFileType = fileToProcess.name.endsWith('.avi') ? 'avi' : 'video';
		setTrackingContext({ file_type: ffmpegFileType, reader: 'ffmpeg', gpu_enabled: effectiveUseGpu.value });
		emit('processing-started');

		// Run pre-crop detection if enabled
		let preCropRegion = null;
		if (enablePreCrop.value) {
			preCropRegion = await detectPreCropRegion(fileToProcess.name);
			addLog('Pre-crop detection complete, continuing with extraction...');
		}

		// Set up progress tracking for FFmpeg
		let lastFrameCount = 0;
		let lastLoggedFrame = 0;
		const totalFramesTarget = effectiveMaxFrames.value > 0 ? effectiveMaxFrames.value : expectedFrameCount;

		// Also captured here so an OOM during bulk extract can hand off to the streamed
		// path without needing a separate pre-flight probe run.
		let capturedDuration = 0;
		let capturedFps = 30;

		$ffmpeg.setLogger(({ type, message }) => {
			if (typeof message !== 'string') return;

			// Log ALL FFmpeg output for debugging
			console.log(`[ffmpeg ${type}] ${message}`);

			// Log important FFmpeg messages
			if (type === 'fferr') {
				if (message.includes('Stream') || message.includes('Duration') || message.includes('Output') || message.includes('Error') || message.includes('error') || message.includes('crop')) {
					addLog(`[ffmpeg] ${message}`);
				}
			}

			const durMatch = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
			if (durMatch) {
				capturedDuration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
			}
			// Only match fps from the Stream metadata line ("... 30 fps, 30 tbr ..."),
			// not from progress lines ("frame= 1 fps= 1.0"), by requiring a trailing comma.
			if (message.includes('Video:')) {
				const fpsMatch = message.match(/(\d+(?:\.\d+)?)\s+fps,/);
				if (fpsMatch) {
					capturedFps = parseFloat(fpsMatch[1]);
				}
			}

			// Parse frame count from FFmpeg output: "frame=  304 fps= 36 ..."
			const frameMatch = message.match(/frame=\s*(\d+)/);
			if (frameMatch) {
				const currentFrame = parseInt(frameMatch[1], 10);
				if (currentFrame !== lastFrameCount) {
					lastFrameCount = currentFrame;
					// Log approximately every 500 frames (handles jumps in frame count)
					if (currentFrame - lastLoggedFrame >= 500) {
						addLog(`Extracting frame ${currentFrame}...`);
						lastLoggedFrame = currentFrame;
					}
					if (totalFramesTarget) {
						const progress = Math.min((currentFrame / totalFramesTarget) * 100, 100);
						eventBusEmit('update-loading', { progress, current: currentFrame, total: totalFramesTarget });
					} else {
						eventBusEmit('update-loading', { progress: -1, current: currentFrame, total: '?' });
					}
				}
			}
		});

		// Lite mode: check file size fits in FFmpeg WASM memory
		if (liteMode.value) {
			const fileSizeMB = fileToProcess.size / (1024 * 1024);
			const platform = detectPlatform();
			const sizeCheck = checkFileSize(fileSizeMB, platform);
			if (!sizeCheck.canProcess) {
				addLog(`File too large for Lite mode: ${Math.round(fileSizeMB)}MB`);
				eventBusEmit('upload-error', sizeCheck.reason);
				eventBusEmit('stop-loading');
				return;
			}
			addLog(`File size OK for Lite mode: ${Math.round(fileSizeMB)}MB (${platform})`);
		}

		// Lite mode: use memory-optimized batched extraction + analysis
		if (liteMode.value) {
			// Get video duration for batched processing
			let videoDuration = 0;
			$ffmpeg.setLogger(({ type, message }) => {
				if (typeof message !== 'string') return;
				const durMatch = message.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
				if (durMatch) {
					videoDuration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3]);
				}
			});
			try {
				await $ffmpeg.run('-i', fileToProcess.name, '-f', 'null', '-t', '0.001', '-');
			} catch (e) { /* FFmpeg exits with error for -f null */ }

			if (videoDuration <= 0) {
				addLog('Could not determine video duration, using fallback');
				videoDuration = 60; // Assume 1 minute
			}
			addLog(`Video duration: ${videoDuration.toFixed(1)}s`);

			const { processBatchedVideoFrames } = useFFmpegReader();
			const totalFrames = effectiveMaxFrames.value > 0 ? effectiveMaxFrames.value : 100;

			await processBatchedVideoFrames($ffmpeg, fileToProcess.name, totalFrames, videoDuration, {
				preCropRegion,
				manualThreshold: effectiveQualityMode.value === 'manual' || effectiveQualityMode.value === 'continuous',
				stackPercentage: effectiveStackPercentage.value,
				drizzleScale: effectiveDrizzleScale.value,
				surfaceMode: surfaceMode.value,
				cropMarginPercent: effectiveCropMargin.value
			});

		} else {
			// Normal mode: extract all frames first, then process
			eventBusEmit('set-caption', 'Extracting frames from video');
			eventBusEmit('update-loading', { progress: 0, current: 0, total: effectiveMaxFrames.value > 0 ? effectiveMaxFrames.value : '?' });

			// Try the fast bulk-extract path (`ffmpeg -i in out%d.png`). It's much faster than
			// streamed per-frame extraction, but it decodes every frame into FFmpeg-WASM's
			// heap/MEMFS before any frame is consumed and can therefore hit an internal OOM
			// on large clips (e.g. 4K ProRes). If that happens the wasm instance is poisoned,
			// so we recycle and hand off to the streamed GPU path — which extracts one frame
			// at a time with periodic instance recycling. Reactive fallback (rather than a
			// pre-flight size heuristic) avoids misrouting normal clips to the slower path
			// just because raw-uncompressed math overestimates their real PNG footprint.
			let hitOOM = false;
			try {
				const frameLimit = effectiveMaxFrames.value > 0 ? ['-vframes', '' + effectiveMaxFrames.value + ''] : [];

				// Build video filter chain
				const videoFilters = [];
				if (preCropRegion) {
					videoFilters.push(`crop=${preCropRegion.width}:${preCropRegion.height}:${preCropRegion.x}:${preCropRegion.y}`);
				}
				const vfArgs = videoFilters.length > 0 ? ['-vf', videoFilters.join(',')] : [];

				// Output PNG files
				const ffmpegArgs = ['-i', videoFiles[0].name, ...vfArgs, ...frameLimit, 'out%d.png'];
				addLog(`FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

				addLog('Starting FFmpeg extraction...');
				await $ffmpeg.run(...ffmpegArgs);
				addLog('FFmpeg extraction completed');
			} catch(err){
				const msg = err?.message || String(err);
				// wasm OOM aborts throw as WebAssembly.RuntimeError with "abort(OOM)" in the message
				hitOOM = /OOM|out of memory|abort\(OOM\)/i.test(msg);
				if (hitOOM) {
					addLog(`FFmpeg-WASM ran out of memory during bulk extraction — falling back to streamed GPU extraction (${capturedDuration.toFixed(1)}s @ ${capturedFps} fps).`);
				} else {
					console.log(err);
					addLog('FFmpeg forcefully exited, but continuing!');
				}
			}

			// Clear the logger
			$ffmpeg.setLogger(({ message }) => {});

			if (hitOOM) {
				if (!capturedDuration) {
					addLog('Could not determine video duration from FFmpeg output — cannot recover from OOM.');
					eventBusEmit('upload-error', 'FFmpeg ran out of memory and the video duration could not be parsed for the streamed-extraction retry. Try again with a max-frames limit.');
					eventBusEmit('show-error');
					return;
				}
				if (!effectiveUseGpu.value) {
					// Streamed extraction path is GPU-only. In CPU mode, give a clean
					// error instead of pretending we can recover.
					eventBusEmit('upload-error', 'FFmpeg ran out of memory. The streamed-extraction recovery path requires GPU processing. Please switch Processing to GPU or lower the Max frames limit and try again.');
					eventBusEmit('show-error');
					return;
				}
				// Bulk extract poisoned the wasm instance; recycle and reload the source file
				// into the fresh instance before handing off to the streamed path.
				const fresh = await $recycleFFmpeg();
				fresh.FS('writeFile', videoFiles[0].name, await fetchFile(fileToProcess));
				const { processVideoStreamedGpu } = useFFmpegReader();
				await processVideoStreamedGpu(fresh, $recycleFFmpeg, fileToProcess, capturedDuration, {
					preCropRegion,
					manualThreshold: effectiveQualityMode.value === 'manual' || effectiveQualityMode.value === 'continuous',
					stackPercentage: effectiveStackPercentage.value,
					drizzleScale: effectiveDrizzleScale.value,
					surfaceMode: surfaceMode.value,
					cropMarginPercent: effectiveCropMargin.value,
					maxFrames: effectiveMaxFrames.value > 0 ? effectiveMaxFrames.value : 0,
					fps: capturedFps
				});
				return;
			}

			// Get list of PNG files created by FFmpeg
			const pngFiles = $ffmpeg.FS('readdir', '/').filter(f => f.endsWith('.png')).sort((a, b) => {
				const numA = parseInt(a.match(/\d+/)?.[0] || '0');
				const numB = parseInt(b.match(/\d+/)?.[0] || '0');
				return numA - numB;
			});

			// Free source video memory
			$ffmpeg.FS('unlink', videoFiles[0].name);

			addLog(`Extracted ${pngFiles.length} PNG frames`);

			if (pngFiles.length === 0) {
				addLog('No frames extracted from video');
				eventBusEmit('upload-error', 'Failed to extract frames from video. The file may be corrupted or unsupported.');
				eventBusEmit('show-error');
				return;
			}

			// Route PNG frames through FFmpeg reader
			const { processFFmpegFrames } = useFFmpegReader();

			await processFFmpegFrames($ffmpeg, pngFiles, effectiveQualityMode.value === 'manual' || effectiveQualityMode.value === 'continuous', effectiveCropMargin.value, effectiveStackPercentage.value, effectiveDrizzleScale.value, effectiveUseGpu.value, surfaceMode.value);
		}
	
	} else if (imageFiles.length > 1) {
		// Multiple images selected - analyze and stack them
		const rawFile = imageFiles.find(isRawFile);
		if (rawFile) {
			eventBusEmit('upload-error', `RAW camera files (${rawFile.name.split('.').pop().toUpperCase()}) are not supported. For planetary imaging, please use SER or AVI format from your capture software.`);
			eventBusEmit('stop-loading');
			return;
		}

		if (!effectiveUseGpu.value) {
			eventBusEmit('upload-error', 'Image sequence stacking requires GPU processing. Please switch Processing to GPU in settings, or convert your images to an MP4/MOV video.');
			eventBusEmit('show-error');
			isProcessing.value = false;
			return;
		}
		setTrackingContext({ file_type: 'images', reader: 'image', gpu_enabled: effectiveUseGpu.value });
		emit('processing-started');
		addLog(`${imageFiles.length} images selected for stacking`);

		const { readImageFiles } = useImageReader();
		await readImageFiles(imageFiles, $ffmpeg, $loadFFmpeg, effectiveQualityMode.value === 'manual' || effectiveQualityMode.value === 'continuous', effectiveCropMargin.value, effectiveStackPercentage.value, effectiveDrizzleScale.value, effectiveUseGpu.value, surfaceMode.value);

	} else if (imageFiles.length == 1) {
		// Single image - go directly to post processing
		if (isRawFile(imageFiles[0])) {
			eventBusEmit('upload-error', `RAW camera files (${imageFiles[0].name.split('.').pop().toUpperCase()}) are not supported. For planetary imaging, please use SER or AVI format from your capture software.`);
			eventBusEmit('stop-loading');
			return;
		}

		const file = imageFiles[0];
		const fileName = file.name?.toLowerCase() || '';
		const isTiff = file.type === 'image/tiff' || fileName.endsWith('.tif') || fileName.endsWith('.tiff');
		const isNativeFormat = ['image/png', 'image/jpg', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(file.type);

		if (isTiff) {
			addLog('One TIFF image selected, load post processing');
			emit('postProcessing', file);
		} else if (!isNativeFormat) {
			addLog('One image selected that is not natively supported by browsers, converting..');

			try {
				await $loadFFmpeg();
			} catch (err) {
				if (err instanceof FFmpegUnsupportedError) {
					showActionableError(
						"Your browser can't run the image converter needed for this format. It's missing a feature (SharedArrayBuffer) that FFmpeg needs. You have a few options:",
						ffmpegUnsupportedAlternatives({ context: 'image' })
					);
					return;
				}
				throw err;
			}

			let imageData;
			try {
				imageData = await fetchFile(file);
			} catch (fetchErr) {
				if (fetchErr.name === 'InvalidStateError' || fetchErr.code === 11) {
					eventBusEmit('upload-error', 'The file could not be read. Please re-select the file and try again.');
					eventBusEmit('show-error');
					return;
				}
				throw fetchErr;
			}
			$ffmpeg.FS('writeFile', file.name, imageData);

			await $ffmpeg.run('-i', file.name, file.name + '.png');

			const data = $ffmpeg.FS('readFile', file.name + '.png');

			const blob = new Blob([data.buffer], { type: 'image/png' });

			$ffmpeg.FS('unlink', file.name);
			$ffmpeg.FS('unlink', file.name + '.png');

			addLog('Load post processing');

			emit('postProcessing', blob);
		} else {
			addLog('One image selected that is supported right away, load post processing');
			emit('postProcessing', file);
		}
	}
}
</script>

<style>
/* Batch choice dialog */
.batch-choice-dialog {
	background: #f9f9f9;
	border: 1px solid #ddd;
	border-radius: 8px;
	padding: 15px;
	margin: 15px 0;
	text-align: center;
}
.batch-choice-dialog h4 {
	margin: 0 0 8px 0;
}
.batch-choice-dialog p {
	margin: 0 0 15px 0;
	color: #666;
}
.batch-choice-buttons {
	display: flex;
	flex-direction: column;
	gap: 10px;
	margin-bottom: 10px;
}
.batch-choice-buttons button {
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 12px 15px;
}
.batch-choice-buttons button small {
	font-weight: normal;
	font-size: 11px;
	opacity: 0.8;
	margin-top: 4px;
}
.btn-text {
	background: none;
	border: none;
	color: #666;
	cursor: pointer;
	font-size: 13px;
	text-decoration: underline;
}
.btn-text:hover {
	color: #333;
}

.status-indicators {
	display: flex;
	gap: 12px;
	margin-bottom: 15px;
	flex-wrap: wrap;
	font-size: 11px;
}
.status-item {
	display: flex;
	align-items: center;
	gap: 3px;
	color: #999;
}
.status-item .status-check {
	font-size: 10px;
}
.status-item.active {
	color: #333;
}
.status-item.active .status-check {
	color: #8CCF7E;
}
.error-message {
	background-color: #ffcccc;
	color: #D9534F;
	padding: 10px;
	margin-top: 10px;
	border-radius: 5px;
	font-weight: bold;
}
.error-message .feedback-prompt {
	font-weight: normal;
	font-size: 0.9em;
	margin-top: 8px;
}
.error-message .feedback-prompt a {
	color: #D9534F;
	text-decoration: underline;
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
.error-message .reload-button:hover {
	background-color: #c9302c;
}
.error-message .error-alternatives {
	list-style: none;
	padding: 0;
	margin: 10px 0 0 0;
	font-weight: normal;
}
.error-message .error-alternatives li {
	padding: 8px 0;
	border-top: 1px solid rgba(217, 83, 79, 0.25);
}
.error-message .error-alternatives li:first-child {
	border-top: none;
}
.error-message .error-alternatives a {
	color: #D9534F;
	text-decoration: underline;
	font-weight: bold;
}
.error-message .error-alternatives small {
	display: block;
	margin-top: 2px;
	font-size: 0.85em;
	color: #a34641;
}
.cancelled-message {
	background-color: #fff3cd;
	color: #856404;
	padding: 10px;
	margin-top: 10px;
	border-radius: 5px;
	text-align: left;
	font-weight: bold;
}
.cancelled-message .feedback-prompt {
	font-weight: normal;
	font-size: 0.9em;
	margin-top: 8px;
}
.cancelled-message .feedback-prompt a {
	color: #856404;
	text-decoration: underline;
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
.cancelled-message .reload-button:hover {
	background-color: #6d5203;
}
.supported-formats {
	font-size: 12px;
	color: #888;
	margin: 0 0 15px 0;
}

.lite-mode-warning {
	background: #fff3cd;
	border: 1px solid #ffc107;
	color: #856404;
	padding: 10px 12px;
	border-radius: 5px;
	font-size: 12px;
	line-height: 1.4;
	margin-bottom: 15px;
}

.selected-files {
	margin-top: 15px;
	padding: 10px;
	background-color: #f0f8ff;
	border-radius: 5px;
}
.selected-file-list {
	max-height: 240px;
	overflow-y: auto;
	margin-bottom: 10px;
}
.selected-file-item {
	display: flex;
	align-items: center;
	gap: 8px;
	background: white;
	border: 1px solid #e0e0e0;
	border-radius: 6px;
	padding: 6px 10px;
	margin-bottom: 6px;
}
.selected-file-item:last-child {
	margin-bottom: 0;
}
.selected-file-item.is-mismatched {
	border-color: #D9534F;
	background: #fff5f5;
}
.selected-file-item .file-name {
	flex: 1;
	font-size: 13px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.selected-file-item .file-size {
	flex-shrink: 0;
	font-size: 11px;
	color: #888;
}
.selected-file-item .remove-btn {
	flex-shrink: 0;
	width: 22px;
	height: 22px;
	padding: 0;
	border: none;
	background: #f0f0f0;
	border-radius: 50%;
	cursor: pointer;
	font-size: 15px;
	line-height: 1;
	color: #666;
}
.selected-file-item .remove-btn:hover {
	background: #D9534F;
	color: white;
}
.action-buttons {
	display: flex;
	gap: 10px;
	margin-top: 10px;
}
.processing-actions {
	flex-direction: column;
	align-items: center;
	margin-top: 20px;
}
.processing-hint {
	font-size: 12px;
	color: #888;
	margin: 8px 0 0 0;
	text-align: center;
}
.info-icon {
	cursor: pointer;
	color: #666;
	font-size: 0.9em;
	user-select: none;
}
.info-icon:hover {
	color: #333;
}
.info-text {
	font-size: 0.9em;
	color: #555;
	margin-top: 5px;
	padding: 8px;
	background: #f5f5f5;
	border-radius: 4px;
}
.info-text ul {
	margin: 0;
	padding-left: 20px;
}
.radio-group {
	display: flex;
	flex-direction: column;
	gap: 8px;
	margin: 10px 0;
}
.radio-option {
	display: flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
}
.radio-option input[type="radio"] {
	margin: 0;
}
.checkbox-option {
	display: flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
	margin: 10px 0;
}
.checkbox-option.disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
.checkbox-option input[type="checkbox"] {
	margin: 0;
}
.memory-optimization-box {
	background: #fff8e1;
	border: 1px solid #ffcc80;
	border-radius: 5px;
	padding: 10px;
	margin: 10px 0;
}
.memory-optimization-box .checkbox-option {
	margin: 5px 0;
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
	vertical-align: middle;
}
.intro {
	font-size: 1.1em;
	color: #c6fffd;
	margin-bottom: 5px;
}
.sample-credit {
	font-size: 12px;
	color: rgba(198, 255, 253, 0.75);
	margin: -15px 0 20px;
}
.sample-credit a {
	color: inherit;
	text-decoration: underline;
}
.how-it-works {
	margin: 15px 0;
}
.how-it-works summary {
	cursor: pointer;
	color: #8ababa;
	font-weight: 500;
}
.how-it-works summary:hover {
	color: #c6fffd;
}
.how-it-works ul {
	margin: 10px 0;
	padding-left: 20px;
}
.how-it-works li {
	margin-bottom: 5px;
}
.try-sample-line {
	margin-top: 10px;
	margin-bottom: 0;
	font-size: 12px;
	color: #777;
	text-align: center;
}
.try-sample-link {
	color: #1a5a99 !important;
	text-decoration: none;
	white-space: nowrap;
	font-weight: 500;
}
.try-sample-link:hover {
	text-decoration: underline;
}

/* Advanced settings toggle (variant B) */
.advanced-toggle-wrapper {
	margin-top: 14px;
	text-align: left;
}
.advanced-toggle {
	background: transparent;
	border: none;
	border-radius: 0;
	color: #1a5a99;
	font: inherit;
	padding: 4px 0;
	cursor: pointer;
	text-decoration: none;
	border-bottom: 1px solid rgba(26, 90, 153, 0.3);
}
.advanced-toggle:hover {
	background: transparent;
	color: #0d3d6e;
	border-bottom-color: #0d3d6e;
}
</style>

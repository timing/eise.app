<template>
	<div>
		<div v-if="isMounted && liteMode" class="lite-mode-banner">
			<strong>Lite Mode</strong><span v-if="forceLiteMode"> (forced)</span><span v-else-if="isMobile"> ({{ useGPU ? 'GPU' : 'CPU' }})</span><span v-else> (no WebGPU)</span> · Frame limit auto-adjusted for memory.
		</div>

		<FileUploader v-show="!isProcessing && !isSelectingQuality" @frames="handleFrames" @postProcessing="handlePostProcessing" @processing-started="handleProcessingStarted" @showAbout="navigateTo('/about')" />
		<ColorProfileSelector v-show="isSelectingColorProfile" />
		<QualitySelector v-show="isSelectingQuality" :frames="qualityFrames" @threshold-selected="handleThresholdSelected" />
		<VideoFrameProcessor ref="videoProcessorRef" v-show="isProcessing && !isSelectingColorProfile && !isSelectingQuality"
			:currentFrame="currentFrame" :frames="frames" @postProcessing="handlePostProcessing" />

		<!-- WebGPU Unavailable Choice Dialog -->
		<div v-if="showWebGPUChoice" class="webgpu-dialog-overlay">
			<div class="webgpu-dialog">
				<h3>GPU Acceleration Unavailable</h3>
				<p>Your browser doesn't support WebGPU, which is needed for fast GPU-accelerated stacking.</p>
				<p>You can continue with <strong>CPU processing</strong>, which will work but is slower. This may still work fine for smaller files.</p>
				<p class="browser-tip">For faster processing, try using a recent version of Chrome, Edge, or Safari 18+.</p>
				<div class="webgpu-dialog-buttons">
					<button class="continue-button" @click="handleWebGPUContinueCPU">Continue with CPU (slower)</button>
					<button class="cancel-button" @click="handleWebGPUCancel">Cancel</button>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup>
import FileUploader from '@/components/FileUploader.vue';
import VideoFrameProcessor from '@/components/VideoFrameProcessor.vue';
import ColorProfileSelector from '@/components/ColorProfileSelector.vue';
import QualitySelector from '@/components/QualitySelector.vue';

const liteMode = inject('liteMode');
const useGPU = inject('useGPU');
const isMobile = inject('isMobile');
const forceLiteMode = inject('forceLiteMode');
const isMounted = inject('isMounted');

const frames = inject('frames');
const currentFrame = inject('currentFrame');
const isProcessing = inject('isProcessing');
const isSelectingColorProfile = inject('isSelectingColorProfile');
const isSelectingQuality = inject('isSelectingQuality');
const qualityFrames = inject('qualityFrames');
const showWebGPUChoice = inject('showWebGPUChoice');

const handleFrames = inject('handleFrames');
const handlePostProcessing = inject('handlePostProcessing');
const handleProcessingStarted = inject('handleProcessingStarted');
const handleThresholdSelected = inject('handleThresholdSelected');
const handleWebGPUContinueCPU = inject('handleWebGPUContinueCPU');
const handleWebGPUCancel = inject('handleWebGPUCancel');

const videoProcessorRef = ref(null);

useHead({
	title: 'eise.app - Easy (planetary) Image Stacker in your browser for your Astrophotography',
	meta: [
		{ name: 'description', content: 'Easy (planetary) Image Stacker Engine, made to work in your browser. Turn your blurry videos of planets into sharp images. Perfect for beginners in Astrophotography. Using Planetary System Stacker under the hood.' },
	],
});
</script>

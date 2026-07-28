<template>
	<div>
		<div v-if="isMounted && liteMode" class="lite-mode-banner">
			<strong>Lite Mode</strong><span v-if="forceLiteMode"> (forced)</span><span v-else-if="isMobile"> ({{ useGPU ? 'GPU' : 'CPU' }})</span><span v-else> (no WebGPU)</span> · Frame limit auto-adjusted for memory.
		</div>

		<FileUploader v-show="!isProcessing && !isSelectingQuality && !isSelectingColorProfile && !isShowingContinuousResults" @postProcessing="handlePostProcessing" @processing-started="handleProcessingStarted" />
		<ColorProfileSelector v-show="isSelectingColorProfile" />
		<QualitySelector v-show="isSelectingQuality" :frames="qualityFrames" :frameReReader="qualityFrameReReader" @threshold-selected="handleThresholdSelected" />
		<VideoFrameProcessor ref="videoProcessorRef" v-show="isProcessing && !isSelectingColorProfile && !isSelectingQuality && !isShowingContinuousResults"
			:currentFrame="currentFrame" :frames="frames" @postProcessing="handlePostProcessing" />
		<ContinuousStackingResults v-if="isShowingContinuousResults" 
			:results="continuousResults" 
			:isProcessing="isContinuousProcessing"
			:currentPercentage="continuousPercentage"
			@selected="handleContinuousSelected"
			@cancel="handleCancelContinuous"
            @abort="handleAbortContinuous" />

		<!-- WebGPU Unavailable Choice Dialog -->
		<div v-if="showWebGPUChoice" class="webgpu-dialog-overlay">
			<div class="webgpu-dialog">
				<h3>GPU Acceleration Unavailable</h3>
				<p>Your browser doesn't support WebGPU, which is needed for fast GPU-accelerated stacking.</p>
				<p>You can continue with <strong>CPU processing</strong>, which will work but is slower. This may still work fine for smaller files.</p>
				<p class="browser-tip">For faster processing, try using a recent version of Chrome, Edge, or Safari 18+.</p>
				<div class="webgpu-dialog-buttons">
					<button class="continue-button" @click="handleWebGPUContinueCPU">Continue with CPU (slower)</button>
					<button class="btn-secondary" @click="handleWebGPUCancel">Cancel</button>
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
import ContinuousStackingResults from '@/components/ContinuousStackingResults.vue';

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
const isShowingContinuousResults = inject('isShowingContinuousResults');
const continuousResults = inject('continuousResults');
const isContinuousProcessing = inject('isContinuousProcessing');
const continuousPercentage = inject('continuousPercentage');
const qualityFrames = inject('qualityFrames');
const qualityFrameReReader = inject('qualityFrameReReader');
const showWebGPUChoice = inject('showWebGPUChoice');

const handlePostProcessing = inject('handlePostProcessing');
const handleProcessingStarted = inject('handleProcessingStarted');
const handleThresholdSelected = inject('handleThresholdSelected');
const handleWebGPUContinueCPU = inject('handleWebGPUContinueCPU');
const handleWebGPUCancel = inject('handleWebGPUCancel');
const handleContinuousSelected = inject('handleContinuousSelected');
const handleCancelContinuous = inject('handleCancelContinuous');
const handleAbortContinuous = inject('handleAbortContinuous');

const videoProcessorRef = ref(null);

useHead({
	title: 'Planetary Image Stacking in Your Browser - Free, No Install | Eise.app',
	meta: [
		{ name: 'description', content: 'Free online planetary image stacker. Upload SER, AVI, or MP4 videos of planets, Moon, or Sun and get sharp stacked images. Runs entirely in your browser - no upload, no install, no signup.' },
	],
	script: [
		{
			type: 'application/ld+json',
			innerHTML: JSON.stringify({
				'@context': 'https://schema.org',
				'@graph': [
					{
						'@type': 'Organization',
						'@id': 'https://eise.app/#organization',
						name: 'Eise.app',
						url: 'https://eise.app/',
						logo: 'https://eise.app/favicon.png',
						description: 'Free browser-based planetary image stacking tool for astrophotography.',
						sameAs: [
							'https://github.com/timing/eise.app',
						],
					},
					{
						'@type': 'SoftwareApplication',
						'@id': 'https://eise.app/#software',
						name: 'Eise.app',
						url: 'https://eise.app/',
						operatingSystem: 'Web, macOS, Windows, Linux',
						applicationCategory: 'MultimediaApplication',
						applicationSubCategory: 'AstrophotographyStacking',
						offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
						description: 'Browser-based planetary image stacking tool. Turn videos of planets, the Moon, and the Sun into sharp images using WebGPU-accelerated processing.',
						publisher: { '@id': 'https://eise.app/#organization' },
						review: [
							{
								'@type': 'Review',
								author: { '@type': 'Person', name: 'Santhiago', address: { '@type': 'PostalAddress', addressCountry: 'CR' } },
								reviewBody: 'Very good app — it helped me massively improve my image of the Moon.',
							},
							{
								'@type': 'Review',
								author: { '@type': 'Person', name: 'Alexis', address: { '@type': 'PostalAddress', addressCountry: 'FR' } },
								reviewBody: 'Very satisfied with the result.',
							},
							{
								'@type': 'Review',
								author: { '@type': 'Person', name: 'Astroyouda', address: { '@type': 'PostalAddress', addressCountry: 'ID' } },
								reviewBody: 'Happy this is easy to use.',
							},
						],
					},
				],
			}),
		},
	],
});
</script>

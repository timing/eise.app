<template>
	<div>
		<div class="top-bar">
			<header>
				<h1><a href="/">eise.app</a> <span class="subtitle">- Easy (planetary) Image Stacker Engine</span></h1>
			</header>
			<nav class="tabs">
				<NuxtLink to="/" :class="{ active: route.path === '/' }">Stack</NuxtLink>
				<NuxtLink to="/post-processor/" :class="{ active: route.path.startsWith('/post-processor') }">Post Processor</NuxtLink>
				<NuxtLink to="/tools/" :class="{ active: route.path.startsWith('/tools') }">Tools</NuxtLink>
				<NuxtLink to="/about/" :class="{ active: route.path.startsWith('/about') }">About</NuxtLink>
			</nav>
		</div>

		<slot />

		<div class="clearb"></div>

		<Logger />

		<img v-if="loadPixel" src="https://analytics.tijmentiming.workers.dev/pixel.gif"/>
	</div>
</template>

<script setup>
import Logger from '@/components/Logger.vue';

const route = useRoute();
const loadPixel = ref(false);

onMounted(() => {
	loadPixel.value = true;
});
</script>

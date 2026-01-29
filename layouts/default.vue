<template>
	<div>
		<nav class="tabs">
			<NuxtLink to="/" :class="{ active: route.path === '/' }">✨ &nbsp; Stack & Process</NuxtLink>
			<NuxtLink to="/tools" :class="{ active: route.path === '/tools' }">🛠️ &nbsp; Tools</NuxtLink>
			<NuxtLink to="/about" style="float:right;" :class="{ active: route.path === '/about' }">ℹ️  &nbsp; About</NuxtLink>
		</nav>

		<header>
			<h1><a href="/">eise.app</a> <span class="subtitle">- Easy (planetary) Image Stacker Engine</span></h1>
		</header>

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

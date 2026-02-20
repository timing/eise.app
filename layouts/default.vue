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
				<div class="dropdown" :class="{ active: route.path.startsWith('/about'), open: aboutDropdownOpen }">
					<span class="dropdown-toggle" @click="aboutDropdownOpen = !aboutDropdownOpen">About <span class="dropdown-arrow">▾</span></span>
					<div class="dropdown-backdrop" @click="aboutDropdownOpen = false"></div>
					<div class="dropdown-menu">
						<NuxtLink to="/about/" @click="aboutDropdownOpen = false">About eise.app</NuxtLink>
						<NuxtLink to="/about/help/" @click="aboutDropdownOpen = false">Help & How it Works</NuxtLink>
						<NuxtLink to="/about/planetary-stacking-software-comparison/" @click="aboutDropdownOpen = false">Stacking Software Comparison</NuxtLink>
					</div>
				</div>
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
const aboutDropdownOpen = ref(false);

onMounted(() => {
	loadPixel.value = true;
});

// Close dropdown when route changes
watch(() => route.path, () => {
	aboutDropdownOpen.value = false;
});
</script>

<style scoped>
.dropdown {
	position: relative;
	display: inline-block;
}
.dropdown-toggle {
	/* Match .tabs a styling from app.vue */
	background-color: #eee;
	border: none;
	color: #333;
	padding: 10px 20px;
	cursor: pointer;
	transition: background-color 0.3s;
	text-decoration: none;
	font-size: 13px;
	border-radius: 0;
	border-right: 1px solid #ccc;
	font-weight: bold;
	display: inline-block;
}
.dropdown-toggle:hover {
	background-color: #70f1ec;
}
.dropdown.active .dropdown-toggle {
	background-color: #8CCF7E;
	color: #111;
}
.dropdown-arrow {
	font-size: 0.8em;
	margin-left: 4px;
}
.dropdown-backdrop {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 99;
	display: none;
}
.dropdown.open .dropdown-backdrop {
	display: block;
}
.dropdown-menu {
	position: absolute;
	top: 100%;
	right: 0;
	background: #2a2a2a;
	border: 1px solid #444;
	border-radius: 6px;
	box-shadow: 0 4px 12px rgba(0,0,0,0.3);
	z-index: 100;
	min-width: 240px;
	overflow: hidden;
	margin-top: 4px;
	display: none;
}
.dropdown.open .dropdown-menu {
	display: block;
}
.dropdown-menu a {
	display: block;
	padding: 10px 16px;
	color: #ccc;
	text-decoration: none;
	font-size: 13px;
	border-bottom: 1px solid #333;
	background: transparent;
}
.dropdown-menu a:last-child {
	border-bottom: none;
}
.dropdown-menu a:hover {
	background: #333;
	color: #fff;
}
@media (max-width: 700px) {
	.dropdown {
		flex: 1;
	}
	.dropdown-toggle {
		width: 100%;
		text-align: center;
		padding: 8px 5px;
		font-size: 11px;
		white-space: nowrap;
	}
	.dropdown-menu {
		right: auto;
		left: 0;
	}
}
</style>

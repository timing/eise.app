<template>
	<div>
		<div class="top-bar">
			<header>
				<h1><a href="/">Eise.app</a> <span class="subtitle">- Easy Image Stacker Engine</span></h1>
			</header>
			<nav class="tabs">
				<NuxtLink to="/" :class="{ active: route.path === '/' }">Stack</NuxtLink>
				<NuxtLink to="/post-processor/" :class="{ active: route.path.startsWith('/post-processor') }">Post Processor</NuxtLink>
				<NuxtLink to="/download/" :class="{ active: route.path.startsWith('/download') }">Download</NuxtLink>
				<div class="hamburger-menu" :class="{ open: menuOpen }">
					<button class="hamburger-toggle" @click="menuOpen = !menuOpen" aria-label="Menu">
						<span class="hamburger-icon">☰</span>
					</button>
					<div class="menu-backdrop" @click="menuOpen = false"></div>
					<div class="menu-dropdown">
						<NuxtLink to="/about/" @click="menuOpen = false">About Eise.app</NuxtLink>
						<NuxtLink to="/about/help/" @click="menuOpen = false">Help & How it Works</NuxtLink>
						<NuxtLink to="/about/architecture/" @click="menuOpen = false">Technical Architecture</NuxtLink>
						<NuxtLink to="/about/planetary-stacking-software-comparison/" @click="menuOpen = false">Stacking Software Comparison</NuxtLink>
						<div class="menu-divider"></div>
						<NuxtLink to="/tools/" @click="menuOpen = false">SER Tools</NuxtLink>
					</div>
				</div>
			</nav>
		</div>

		<slot />

		<div class="clearb"></div>

		<Logger />
	</div>
</template>

<script setup>
import Logger from '@/components/Logger.vue';

const route = useRoute();
const menuOpen = ref(false);

// Close menu when route changes
watch(() => route.path, () => {
	menuOpen.value = false;
});
</script>

<style scoped>
.hamburger-menu {
	position: relative;
	display: inline-block;
	vertical-align: top;
}
.hamburger-toggle {
	background-color: #fefefe;
	border: none;
	color: #333;
	padding: 8px 15px 10px 15px;
	cursor: pointer;
	transition: background-color 0.3s;
	font-size: 18px;
	line-height: 1;
	vertical-align: top;
}
.hamburger-toggle:hover {
	background-color: #70f1ec;
}
.hamburger-menu.open .hamburger-toggle {
	background-color: #70f1ec;
}
.menu-backdrop {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 99;
	display: none;
}
.hamburger-menu.open .menu-backdrop {
	display: block;
}
.menu-dropdown {
	position: absolute;
	top: 100%;
	right: 0;
	background: #fefefe;
	border-radius: 6px;
	box-shadow: 0 2px 10px rgba(0,0,0,0.2);
	z-index: 100;
	min-width: 240px;
	overflow: hidden;
	margin-top: 4px;
	display: none;
}
.hamburger-menu.open .menu-dropdown {
	display: block;
}
.menu-dropdown a {
	display: block;
	padding: 12px 16px;
	color: #333;
	text-decoration: none;
	font-size: 14px;
	background: none;
}
.menu-dropdown a:hover {
	background: #f5f5f5;
	color: #333;
}
.menu-divider {
	height: 1px;
	background: #e0e0e0;
	margin: 4px 0;
}
@media (max-width: 700px) {
	.hamburger-menu {
		flex: 0;
	}
	.hamburger-toggle {
		padding: 8px 12px;
	}
	.menu-dropdown {
		right: 0;
		left: auto;
	}
}
</style>

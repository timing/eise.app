// Emits BreadcrumbList JSON-LD via useHead. Call from any page under a
// hierarchical route (about/*, download, etc.).
//
// Usage:
//   useBreadcrumbSchema([
//     { name: 'Home', url: 'https://eise.app/' },
//     { name: 'About', url: 'https://eise.app/about/' },
//     { name: 'AutoStakkert! vs Eise.app', url: 'https://eise.app/about/autostakkert-vs-eise/' },
//   ]);

export function useBreadcrumbSchema(items) {
	useHead({
		script: [
			{
				type: 'application/ld+json',
				innerHTML: JSON.stringify({
					'@context': 'https://schema.org',
					'@type': 'BreadcrumbList',
					itemListElement: items.map((item, i) => ({
						'@type': 'ListItem',
						position: i + 1,
						name: item.name,
						item: item.url,
					})),
				}),
			},
		],
	});
}

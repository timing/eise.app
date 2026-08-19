// Detects browser + OS for logging and error reports.
//
// Brave hides itself from navigator.userAgentData.brands (and the sec-ch-ua header)
// when fingerprinting protection is enabled, so we check navigator.brave.isBrave()
// first — that API is deliberately exposed by Brave.

let cached = null;
let inFlight = null;

const detectBrowserAndOS = async () => {
	const uaData = navigator.userAgentData;
	let os = 'Unknown OS';
	let browser = 'Unknown Browser';

	if (uaData) {
		try {
			const high = await uaData.getHighEntropyValues(['platform', 'platformVersion']);
			os = high.platformVersion ? `${high.platform} ${high.platformVersion}` : high.platform;
		} catch {
			os = uaData.platform || os;
		}
	} else {
		const ua = navigator.userAgent || '';
		if (/Windows NT ([\d.]+)/.test(ua)) os = `Windows ${RegExp.$1}`;
		else if (/Mac OS X ([\d_]+)/.test(ua)) os = `macOS ${RegExp.$1.replace(/_/g, '.')}`;
		else if (/Android ([\d.]+)/.test(ua)) os = `Android ${RegExp.$1}`;
		else if (/(?:iPhone|iPad|iPod).* OS ([\d_]+)/.test(ua)) os = `iOS ${RegExp.$1.replace(/_/g, '.')}`;
		else if (/Linux/.test(ua)) os = 'Linux';
	}

	if (navigator.brave?.isBrave) {
		try {
			if (await navigator.brave.isBrave()) {
				const v = uaData?.brands?.find(b => b.brand === 'Chromium')?.version;
				return { os, browser: v ? `Brave ${v}` : 'Brave' };
			}
		} catch { /* ignore */ }
	}

	if (uaData?.brands?.length) {
		const brands = uaData.brands.filter(b => !/Not.?A.?Brand/i.test(b.brand));
		const preferred = brands.find(b => b.brand !== 'Chromium') || brands[0];
		if (preferred) browser = `${preferred.brand} ${preferred.version}`;
	} else {
		const ua = navigator.userAgent || '';
		if (/Firefox\/([\d.]+)/.test(ua)) browser = `Firefox ${RegExp.$1}`;
		else if (/Edg\/([\d.]+)/.test(ua)) browser = `Edge ${RegExp.$1}`;
		else if (/OPR\/([\d.]+)/.test(ua)) browser = `Opera ${RegExp.$1}`;
		else if (/Chrome\/([\d.]+)/.test(ua)) browser = `Chrome ${RegExp.$1}`;
		else if (/Version\/([\d.]+).*Safari/.test(ua)) browser = `Safari ${RegExp.$1}`;
	}

	return { os, browser };
};

export const useEnvironmentInfo = () => {
	const getEnvironmentInfo = () => {
		if (cached) return Promise.resolve(cached);
		if (inFlight) return inFlight;
		inFlight = detectBrowserAndOS().then((info) => {
			cached = info;
			inFlight = null;
			return info;
		});
		return inFlight;
	};

	return { getEnvironmentInfo };
};

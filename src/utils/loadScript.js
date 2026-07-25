const pendingScripts = new Map();

export function loadScript(url) {
	url = String(url || '').trim();
	if (!url) {
		return Promise.resolve();
	}
	if (pendingScripts.has(url)) {
		return pendingScripts.get(url);
	}

	const promise = new Promise((resolve, reject) => {
		const existing = document.querySelector(`script[data-base3-module-resource="${CSS.escape(url)}"]`);
		if (existing) {
			if (existing.dataset.loaded === '1') {
				resolve();
				return;
			}
			existing.addEventListener('load', resolve, { once: true });
			existing.addEventListener('error', reject, { once: true });
			return;
		}

		const script = document.createElement('script');
		script.src = url;
		script.async = true;
		script.dataset.base3ModuleResource = url;
		script.addEventListener('load', () => {
			script.dataset.loaded = '1';
			resolve();
		}, { once: true });
		script.addEventListener('error', () => {
			reject(new Error(`Unable to load script "${url}".`));
		}, { once: true });
		document.head.appendChild(script);
	});

	pendingScripts.set(url, promise);
	return promise;
}

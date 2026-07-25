export function resolveElement(target) {
	if (typeof target === 'string') {
		const element = document.querySelector(target);
		if (!element) {
			throw new Error(`Chatbot root "${target}" was not found.`);
		}
		return element;
	}

	if (target instanceof HTMLElement) {
		return target;
	}

	throw new Error('Chatbot root must be a selector string or an HTMLElement.');
}

export function createElement(tagName, options = {}) {
	const element = document.createElement(tagName);

	if (options.className) {
		element.className = options.className;
	}
	if (options.text !== undefined) {
		element.textContent = String(options.text);
	}
	if (options.attributes) {
		Object.entries(options.attributes).forEach(([name, value]) => {
			if (value !== null && value !== undefined) {
				element.setAttribute(name, String(value));
			}
		});
	}

	return element;
}

export function patchExternalLinks(scope) {
	if (!(scope instanceof Element)) {
		return;
	}

	scope.querySelectorAll('a[href]').forEach((link) => {
		const href = String(link.getAttribute('href') || '').trim();
		if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) {
			return;
		}

		link.target = '_blank';
		const rel = new Set(String(link.rel || '').split(/\s+/).filter(Boolean));
		rel.add('noopener');
		rel.add('noreferrer');
		link.rel = [...rel].join(' ');
	});
}

export function scrollElementToBottom(element) {
	if (!(element instanceof HTMLElement)) {
		return;
	}

	element.scrollTo({
		top: element.scrollHeight,
		behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
	});
}

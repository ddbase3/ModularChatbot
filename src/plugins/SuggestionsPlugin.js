function renderSuggestions(context, suggestions) {
	const container = context.chatbot.elements.suggestions;
	container.replaceChildren();
	container.classList.remove('is-loading');

	if (!Array.isArray(suggestions) || suggestions.length === 0) {
		container.classList.remove('has-suggestions');
		return;
	}

	container.classList.add('has-suggestions');
	suggestions.slice(0, 3).forEach((value) => {
		const text = typeof value === 'string' ? value.trim() : '';
		if (!text) {
			return;
		}

		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'base3-chatbot-suggestion';
		button.textContent = text;
		button.addEventListener('click', () => {
			const current = context.chatbot.elements.input.value.trim();
			context.setComposerValue(current ? `${current} ${text}` : text);
			context.focusComposer();
		}, { signal: context.signal });
		button.addEventListener('dblclick', () => {
			context.setComposerValue(text);
			context.send();
		}, { signal: context.signal });
		container.appendChild(button);
	});
}

export const SuggestionsPlugin = {
	name: 'suggestions',

	install(context) {
		context.events.on('message:starting', () => {
			const container = context.chatbot.elements.suggestions;
			container.replaceChildren();
			container.classList.remove('has-suggestions', 'is-loading');
		});

		context.events.on('message:completed', async (message) => {
			if (message.interaction || message.error || !context.getOptions().serviceUrl) {
				return;
			}

			const container = context.chatbot.elements.suggestions;
			container.classList.add('is-loading');
			try {
				const payload = context.transformRequest({
					suggestions: 1,
					after: message.id || ''
				});
				const url = new URL(context.getOptions().serviceUrl, window.location.href);
				Object.entries(payload).forEach(([key, value]) => {
					if (value !== null && value !== undefined && value !== '') {
						url.searchParams.set(key, String(value));
					}
				});
				const response = await fetch(url, {
					credentials: 'include',
					signal: context.signal
				});
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				renderSuggestions(context, await response.json());
			} catch (error) {
				if (error?.name !== 'AbortError') {
					renderSuggestions(context, []);
				}
			}
		});
	}
};

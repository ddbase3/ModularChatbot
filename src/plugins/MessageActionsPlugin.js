function createIconButton(label, icon) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'base3-chatbot-message-action';
	button.setAttribute('aria-label', label);
	button.title = label;

	const image = document.createElement('img');
	image.src = icon;
	image.alt = '';
	image.setAttribute('aria-hidden', 'true');
	button.appendChild(image);

	return { button, image };
}

async function sendFeedback(context, messageId, type) {
	if (!messageId || !context.getOptions().serviceUrl) {
		return;
	}

	await fetch(context.getOptions().serviceUrl, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
		},
		body: new URLSearchParams({
			feedback: type,
			messageid: messageId
		}),
		signal: context.signal
	});
}

export const MessageActionsPlugin = {
	name: 'message-actions',

	install(context) {
		context.events.on('message:completed', (message) => {
			if (message.interaction || message.error || !message.actions) {
				return;
			}

			const options = context.getPluginOptions();
			const icons = options.icons || {};
			const copy = createIconButton('Antwort kopieren', icons.copy || '');
			const like = createIconButton('Antwort hilfreich', icons.thumbsup || '');
			const dislike = createIconButton('Antwort nicht hilfreich', icons.thumbsdown || '');
			like.button.setAttribute('aria-pressed', 'false');
			dislike.button.setAttribute('aria-pressed', 'false');

			copy.button.addEventListener('click', async () => {
				await navigator.clipboard.writeText(message.rawText);
				if (icons.check) {
					copy.image.src = icons.check;
					window.setTimeout(() => {
						copy.image.src = icons.copy || '';
					}, 1000);
				}
			}, { signal: context.signal });

			const setFeedback = async (type) => {
				const active = message.element.dataset.feedback === type;
				message.element.dataset.feedback = active ? 'none' : type;
				const likeActive = message.element.dataset.feedback === 'like';
				const dislikeActive = message.element.dataset.feedback === 'dislike';
				like.button.setAttribute('aria-pressed', likeActive ? 'true' : 'false');
				dislike.button.setAttribute('aria-pressed', dislikeActive ? 'true' : 'false');
				like.image.src = likeActive && icons.thumbsupfill ? icons.thumbsupfill : (icons.thumbsup || '');
				dislike.image.src = dislikeActive && icons.thumbsdownfill ? icons.thumbsdownfill : (icons.thumbsdown || '');
				try {
					await sendFeedback(context, message.id, type);
				} catch (error) {
					context.events.emit('chatbot:error', error);
				}
			};

			like.button.addEventListener('click', () => setFeedback('like'), { signal: context.signal });
			dislike.button.addEventListener('click', () => setFeedback('dislike'), { signal: context.signal });
			message.actions.append(copy.button, like.button, dislike.button);
		});
	}
};

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

	const payload = context.transformRequest({
		feedback: type,
		messageid: messageId,
		config_group: String(context.getOptions().configGroup || ''),
		config_name: String(context.getOptions().configName || '')
	});
	await fetch(context.getOptions().serviceUrl, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
		},
		body: new URLSearchParams(payload),
		signal: context.signal
	});
}

function addActions(context, message) {
	if (message.interaction || message.error || !message.actions || message.actions.children.length > 0) {
		return;
	}

	const options = context.getPluginOptions();
	const icons = options.icons || {};
	const copy = createIconButton('Antwort kopieren', icons.copy || '');
	const like = createIconButton('Antwort hilfreich', icons.thumbsup || '');
	const dislike = createIconButton('Antwort nicht hilfreich', icons.thumbsdown || '');
	const initialFeedback = String(message.feedback || message.element.dataset.feedback || '');
	message.element.dataset.feedback = ['like', 'dislike'].includes(initialFeedback) ? initialFeedback : 'none';

	const updateButtons = () => {
		const likeActive = message.element.dataset.feedback === 'like';
		const dislikeActive = message.element.dataset.feedback === 'dislike';
		like.button.setAttribute('aria-pressed', likeActive ? 'true' : 'false');
		dislike.button.setAttribute('aria-pressed', dislikeActive ? 'true' : 'false');
		like.image.src = likeActive && icons.thumbsupfill ? icons.thumbsupfill : (icons.thumbsup || '');
		dislike.image.src = dislikeActive && icons.thumbsdownfill ? icons.thumbsdownfill : (icons.thumbsdown || '');
	};
	updateButtons();

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
		updateButtons();
		try {
			await sendFeedback(context, message.id, active ? '' : type);
		} catch (error) {
			context.events.emit('chatbot:error', error);
		}
	};

	like.button.addEventListener('click', () => setFeedback('like'), { signal: context.signal });
	dislike.button.addEventListener('click', () => setFeedback('dislike'), { signal: context.signal });
	message.actions.append(copy.button, like.button, dislike.button);
}

export const MessageActionsPlugin = {
	name: 'message-actions',

	install(context) {
		context.events.on('message:completed', (message) => addActions(context, message));
		context.events.on('message:hydrated', (message) => {
			if (message.role === 'assistant') {
				addActions(context, message);
			}
		});
	}
};

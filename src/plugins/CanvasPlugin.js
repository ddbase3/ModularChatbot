function normalizeBlocks(payload) {
	if (Array.isArray(payload?.blocks)) {
		return payload.blocks;
	}
	if (payload?.content !== undefined) {
		return [{
			type: payload.type || 'text',
			content: payload.content
		}];
	}
	return [];
}

function renderBlock(block) {
	const wrapper = document.createElement('section');
	wrapper.className = 'base3-chatbot-canvas-block';
	if (block?.title) {
		const heading = document.createElement('h3');
		heading.textContent = String(block.title);
		wrapper.appendChild(heading);
	}

	if (block?.type === 'html') {
		const content = document.createElement('div');
		content.innerHTML = String(block.content || '');
		wrapper.appendChild(content);
	} else if (block?.type === 'code') {
		const pre = document.createElement('pre');
		const code = document.createElement('code');
		code.textContent = String(block.content || '');
		pre.appendChild(code);
		wrapper.appendChild(pre);
	} else {
		const paragraph = document.createElement('p');
		paragraph.textContent = String(block?.content || '');
		wrapper.appendChild(paragraph);
	}

	return wrapper;
}

export const CanvasPlugin = {
	name: 'canvas',
	transportEvents: ['canvas.open', 'canvas.close', 'canvas.render'],

	install(context) {
		const closeButton = context.chatbot.elements.canvasClose;
		if (closeButton) {
			closeButton.addEventListener('click', () => {
				this.close(context);
			}, { signal: context.signal });
		}
	},

	onTransportEvent(context, eventName, payload) {
		if (eventName === 'canvas.open') {
			this.open(context, payload || {});
			return true;
		}
		if (eventName === 'canvas.close') {
			this.close(context);
			return true;
		}
		if (eventName === 'canvas.render') {
			this.render(context, payload || {});
			return true;
		}
		return false;
	},

	open(context, payload = {}) {
		const canvas = context.chatbot.elements.canvas;
		if (!canvas) {
			return;
		}
		if (context.chatbot.elements.canvasTitle && payload.title) {
			context.chatbot.elements.canvasTitle.textContent = String(payload.title);
		}
		canvas.hidden = false;
		canvas.setAttribute('aria-hidden', 'false');
		context.root.classList.add('has-canvas');
	},

	close(context) {
		const canvas = context.chatbot.elements.canvas;
		if (!canvas) {
			return;
		}
		canvas.hidden = true;
		canvas.setAttribute('aria-hidden', 'true');
		context.root.classList.remove('has-canvas');
	},

	render(context, payload = {}) {
		const content = context.chatbot.elements.canvasContent;
		if (!content) {
			return;
		}
		const blocks = normalizeBlocks(payload);
		if (payload.mode !== 'append') {
			content.replaceChildren();
		}
		blocks.forEach((block) => content.appendChild(renderBlock(block)));
		this.open(context, payload);
	}
};

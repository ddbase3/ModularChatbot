export class ChatbotUiRegistry {
	constructor(chatbot) {
		this.chatbot = chatbot;
		this.slots = new Map();
		this.controls = new Map();
	}

	registerSlot(name, element) {
		if (!(element instanceof HTMLElement)) {
			return this;
		}

		this.slots.set(name, element);
		return this;
	}

	getSlot(name) {
		return this.slots.get(name) || null;
	}

	addElement(slotName, id, element, order = 100) {
		const slot = this.getSlot(slotName);
		if (!slot || !(element instanceof Node)) {
			return null;
		}

		id = String(id || '').trim();
		if (!id) {
			throw new Error('UI contributions require an id.');
		}
		if (this.controls.has(id)) {
			throw new Error(`UI contribution "${id}" is already registered.`);
		}

		const record = {
			id,
			order: Number.isFinite(Number(order)) ? Number(order) : 100,
			element,
			slotName
		};
		this.controls.set(id, record);
		this.renderSlot(slotName);

		return element;
	}

	addControl(slotName, definition) {
		const id = String(definition?.id || '').trim();
		const label = String(definition?.label || '').trim();
		if (!label) {
			throw new Error(`UI control "${id || 'unknown'}" requires an accessible label.`);
		}

		const button = document.createElement('button');
		button.type = 'button';
		button.className = definition.className || 'base3-chatbot-control';
		button.setAttribute('aria-label', label);
		button.title = definition.title || label;

		if (definition.icon) {
			const image = document.createElement('img');
			image.src = definition.icon;
			image.alt = '';
			image.setAttribute('aria-hidden', 'true');
			button.appendChild(image);
		}
		if (definition.text) {
			const text = document.createElement('span');
			text.textContent = definition.text;
			button.appendChild(text);
		}
		if (definition.pressed !== undefined) {
			button.setAttribute('aria-pressed', definition.pressed ? 'true' : 'false');
		}
		if (typeof definition.onActivate === 'function') {
			button.addEventListener('click', (event) => {
				definition.onActivate(event, button);
			}, {
				signal: this.chatbot.signal
			});
		}

		return this.addElement(slotName, id, button, definition.order);
	}

	remove(id) {
		const record = this.controls.get(id);
		if (!record) {
			return;
		}

		record.element.remove();
		this.controls.delete(id);
		this.renderSlot(record.slotName);
	}

	renderSlot(slotName) {
		const slot = this.getSlot(slotName);
		if (!slot) {
			return;
		}

		const records = [...this.controls.values()]
			.filter((record) => record.slotName === slotName)
			.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

		records.forEach((record) => {
			slot.appendChild(record.element);
		});
	}

	clear() {
		this.controls.forEach((record) => {
			record.element.remove();
		});
		this.controls.clear();
		this.slots.clear();
	}
}

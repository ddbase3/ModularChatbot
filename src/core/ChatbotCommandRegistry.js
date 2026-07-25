export class ChatbotCommandRegistry {
	constructor(chatbot) {
		this.chatbot = chatbot;
		this.commands = new Map();
	}

	register(name, handler) {
		name = String(name || '').trim();
		if (!name) {
			throw new Error('Commands require a name.');
		}
		if (typeof handler !== 'function') {
			throw new Error(`Command "${name}" requires a handler.`);
		}
		if (this.commands.has(name)) {
			throw new Error(`Command "${name}" is already registered.`);
		}

		this.commands.set(name, handler);
		return this;
	}

	has(name) {
		return this.commands.has(name);
	}

	execute(name, payload) {
		const handler = this.commands.get(name);
		if (!handler) {
			throw new Error(`Unknown chatbot command "${name}".`);
		}

		return handler({
			chatbot: this.chatbot,
			events: this.chatbot.events,
			ui: this.chatbot.ui
		}, payload);
	}

	clear() {
		this.commands.clear();
	}
}

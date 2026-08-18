export class ChatbotPluginManager {
	constructor(chatbot) {
		this.chatbot = chatbot;
		this.plugins = [];
	}

	createContext(pluginName = null) {
		return {
			chatbot: this.chatbot,
			root: this.chatbot.root,
			events: this.chatbot.events,
			commands: this.chatbot.commands,
			ui: this.chatbot.ui,
			signal: this.chatbot.signal,
			getOptions: () => this.chatbot.options,
			getString: (key, replacements = {}) => this.chatbot.getString(key, replacements),
			getPluginOptions: (name = pluginName) => {
				if (!name) {
					return {};
				}
				return this.chatbot.options.pluginOptions?.[name] || {};
			},
			getConversationId: () => this.chatbot.getConversationId(),
			getActiveAssistant: () => this.chatbot.getActiveAssistant(),
			isSending: () => this.chatbot.isSending(),
			send: (options) => this.chatbot.send(options),
			setConversation: (conversation) => this.chatbot.setConversation(conversation),
			clearConversation: () => this.chatbot.clearConversation(),
			replaceMessages: (messages) => this.chatbot.replaceMessages(messages),
			setOpeningMessage: (message) => this.chatbot.setOpeningMessage(message),
			setComposerValue: (value) => this.chatbot.setComposerValue(value),
			focusComposer: () => this.chatbot.focusComposer(),
			resolveGlobal: (path) => this.chatbot.resolveGlobal(path),
			transformRequest: (payload) => this.transformRequest(payload)
		};
	}

	async installAll(pluginDefinitions) {
		for (const pluginDefinition of pluginDefinitions || []) {
			await this.install(pluginDefinition);
		}
	}

	async install(pluginDefinition) {
		if (!pluginDefinition || typeof pluginDefinition !== 'object') {
			throw new Error('Plugins must be objects.');
		}

		const name = String(pluginDefinition.name || '').trim();
		if (!name) {
			throw new Error('Plugins require a unique name.');
		}
		if (this.plugins.some((record) => record.plugin.name === name)) {
			throw new Error(`Plugin "${name}" is already installed.`);
		}

		const context = this.createContext(name);
		const commands = pluginDefinition.commands || {};
		Object.entries(commands).forEach(([commandName, handler]) => {
			this.chatbot.commands.register(commandName, (commandContext, payload) => {
				return handler(context, payload, commandContext);
			});
		});

		const record = {
			plugin: pluginDefinition,
			context
		};
		this.plugins.push(record);

		try {
			if (typeof pluginDefinition.install === 'function') {
				await pluginDefinition.install(context);
			}
		} catch (error) {
			if (typeof pluginDefinition.destroy === 'function') {
				pluginDefinition.destroy(context);
			}
			this.plugins = this.plugins.filter((candidate) => candidate !== record);
			throw error;
		}
	}

	getTransportEvents() {
		const events = new Set();
		this.plugins.forEach(({ plugin, context }) => {
			const values = typeof plugin.transportEvents === 'function'
				? plugin.transportEvents(context)
				: plugin.transportEvents;

			if (Array.isArray(values)) {
				values.forEach((eventName) => {
					events.add(String(eventName));
				});
			}
		});

		return [...events];
	}

	async prepareRequest(payload) {
		let current = { ...payload };
		for (const { plugin, context } of this.plugins) {
			if (typeof plugin.prepareRequest !== 'function') {
				continue;
			}

			const prepared = await plugin.prepareRequest(context, current);
			if (prepared && typeof prepared === 'object') {
				current = prepared;
			}
		}

		return current;
	}

	transformRequest(payload) {
		return this.plugins.reduce((current, { plugin, context }) => {
			if (typeof plugin.transformRequest !== 'function') {
				return current;
			}

			const transformed = plugin.transformRequest(context, current);
			return transformed && typeof transformed === 'object' ? transformed : current;
		}, { ...payload });
	}

	renderMessageContent(renderContext) {
		const contextData = { ...renderContext };

		for (const { plugin, context } of this.plugins) {
			if (typeof plugin.prepareMessageContent === 'function') {
				plugin.prepareMessageContent(context, contextData);
			}
		}

		let handled = false;
		for (const { plugin, context } of this.plugins) {
			if (typeof plugin.renderMessageContent !== 'function') {
				continue;
			}

			if (plugin.renderMessageContent(context, contextData) === true) {
				handled = true;
				break;
			}
		}

		for (const { plugin, context } of this.plugins) {
			if (typeof plugin.finalizeMessageContent === 'function') {
				plugin.finalizeMessageContent(context, contextData, handled);
			}
		}

		return handled;
	}

	handleTransportEvent(eventName, payload, eventContext) {
		for (const { plugin, context } of this.plugins) {
			if (typeof plugin.onTransportEvent !== 'function') {
				continue;
			}

			const result = plugin.onTransportEvent(context, eventName, payload, eventContext);
			if (result && typeof result === 'object' && result.handled) {
				return result;
			}
			if (result === true) {
				return { handled: true };
			}
		}

		return { handled: false };
	}

	destroyAll() {
		this.plugins
			.slice()
			.reverse()
			.forEach(({ plugin, context }) => {
				if (typeof plugin.destroy === 'function') {
					plugin.destroy(context);
				}
			});

		this.plugins = [];
	}
}

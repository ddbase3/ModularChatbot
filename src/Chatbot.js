import { ChatbotCommandRegistry } from './core/ChatbotCommandRegistry.js';
import { ChatbotEventBus } from './core/ChatbotEventBus.js';
import { ChatbotPluginManager } from './core/ChatbotPluginManager.js';
import { ChatbotUiRegistry } from './core/ChatbotUiRegistry.js';
import { RestChatTransport } from './transport/RestChatTransport.js';
import { SseChatTransport } from './transport/SseChatTransport.js';
import { createElement, resolveElement, scrollElementToBottom } from './utils/dom.js';

const defaultStrings = {
	emptyResponse: 'Es konnte keine sichtbare Antwort erzeugt werden. Bitte versuche die Anfrage erneut.',
	requestError: 'Es ist ein technischer Fehler aufgetreten. Die Anfrage konnte nicht vollständig abgeschlossen werden.'
};

const defaultOptions = {
	serviceUrl: '',
	serviceId: '',
	turnPrepareUrl: '',
	transportMode: 'auto',
	configGroup: '',
	configName: '',
	plugins: [],
	pluginOptions: {},
	strings: defaultStrings
};

function createId(prefix) {
	if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
		return `${prefix}-${globalThis.crypto.randomUUID()}`;
	}

	return `${prefix}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export class Chatbot {
	constructor(root, options = {}) {
		this.root = resolveElement(root);
		this.options = {
			...defaultOptions,
			...options,
			strings: {
				...defaultStrings,
				...(options.strings || {})
			},
			pluginOptions: {
				...(options.pluginOptions || {})
			}
		};
		this.instanceId = this.root.id || createId('base3-chatbot');
		if (!this.root.id) {
			this.root.id = this.instanceId;
		}

		this.abortController = new AbortController();
		this.signal = this.abortController.signal;
		this.events = new ChatbotEventBus();
		this.commands = new ChatbotCommandRegistry(this);
		this.ui = new ChatbotUiRegistry(this);
		this.pluginManager = new ChatbotPluginManager(this);
		this.transport = null;
		this.initialized = false;
		this.sending = false;
		this.pendingInteraction = null;
		this.activeAssistant = null;
		this.renderTimer = null;
		this.conversationStorageKey = [
			'base3.chatbot.conversation',
			String(this.options.configGroup || 'default'),
			String(this.options.configName || 'default')
		].join('.');
		this.conversationId = this.loadConversationId();

		this.elements = this.resolveElements();
		this.registerBuiltInCommands();
	}

	resolveElements() {
		const query = (selector, required = true) => {
			const element = this.root.querySelector(selector);
			if (!element && required) {
				throw new Error(`Chatbot element "${selector}" is missing.`);
			}
			return element;
		};

		return {
			basePrompt: query('[data-chatbot-base-prompt]'),
			main: query('[data-chatbot-main]'),
			messages: query('[data-chatbot-messages]'),
			suggestions: query('[data-chatbot-suggestions]'),
			composer: query('[data-chatbot-composer]'),
			input: query('[data-chatbot-input]'),
			sendButton: query('[data-chatbot-send]'),
			canvas: query('[data-chatbot-canvas]', false),
			canvasTitle: query('[data-chatbot-canvas-title]', false),
			canvasContent: query('[data-chatbot-canvas-content]', false),
			canvasClose: query('[data-chatbot-canvas-close]', false)
		};
	}

	registerBuiltInCommands() {
		this.commands
			.register('send', ({ chatbot }, payload) => chatbot.send(payload || {}))
			.register('newConversation', ({ chatbot }) => chatbot.startNewConversation())
			.register('setComposerValue', ({ chatbot }, payload) => chatbot.setComposerValue(payload ?? ''))
			.register('focusComposer', ({ chatbot }) => chatbot.focusComposer());
	}

	async init() {
		if (this.initialized) {
			return this;
		}

		this.registerUiSlots();
		this.pluginManager.installAll(this.options.plugins);
		this.bindDomEvents();
		this.initialized = true;
		this.root.dataset.chatbotState = 'ready';

		await this.loadBasePrompt();
		this.events.emit('chatbot:ready', {
			chatbot: this,
			conversationId: this.conversationId
		});

		return this;
	}

	registerUiSlots() {
		this.root.querySelectorAll('[data-chatbot-slot]').forEach((element) => {
			this.ui.registerSlot(element.dataset.chatbotSlot, element);
		});
	}

	bindDomEvents() {
		this.elements.sendButton.addEventListener('click', (event) => {
			event.preventDefault();
			this.send();
		}, { signal: this.signal });

		this.elements.input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				this.send();
			}
		}, { signal: this.signal });

		this.elements.input.addEventListener('input', () => {
			this.resizeComposer();
		}, { signal: this.signal });

		this.resizeComposer();
	}

	resizeComposer() {
		const input = this.elements.input;
		input.style.height = 'auto';
		input.style.height = `${Math.max(50, Math.min(input.scrollHeight, 150))}px`;
	}

	async loadBasePrompt() {
		if (!this.options.serviceUrl || !this.elements.basePrompt) {
			return;
		}

		try {
			const payload = this.pluginManager.transformRequest({ baseprompt: 1 });
			const url = new URL(this.options.serviceUrl, window.location.href);
			Object.entries(payload).forEach(([key, value]) => {
				if (value !== null && value !== undefined) {
					url.searchParams.set(key, String(value));
				}
			});

			const response = await fetch(url, {
				credentials: 'include',
				signal: this.signal
			});
			if (!response.ok) {
				return;
			}

			this.elements.basePrompt.innerHTML = await response.text();
			this.events.emit('baseprompt:loaded', {
				element: this.elements.basePrompt
			});
		} catch (error) {
			if (error?.name !== 'AbortError') {
				this.events.emit('chatbot:error', error);
			}
		}
	}

	getConversationId() {
		return this.conversationId;
	}

	loadConversationId() {
		try {
			const stored = String(window.localStorage.getItem(this.conversationStorageKey) || '').trim();
			if (stored) {
				return stored;
			}
		} catch (error) {
		}

		const id = createId('conversation');
		this.persistConversationId(id);
		return id;
	}

	persistConversationId(id) {
		try {
			window.localStorage.setItem(this.conversationStorageKey, id);
		} catch (error) {
		}
	}

	startNewConversation() {
		this.closeTransport();
		this.conversationId = createId('conversation');
		this.persistConversationId(this.conversationId);
		this.pendingInteraction = null;
		this.activeAssistant = null;
		this.elements.messages.replaceChildren();
		this.elements.messages.classList.add('is-empty');
		this.elements.suggestions.replaceChildren();
		this.elements.basePrompt.hidden = false;
		this.root.classList.remove('is-started');
		this.events.emit('conversation:changed', {
			conversationId: this.conversationId
		});
		this.focusComposer();
		return this.conversationId;
	}

	setComposerValue(value) {
		this.elements.input.value = String(value || '');
		this.resizeComposer();
		return this;
	}

	focusComposer() {
		this.elements.input.focus();
		return this;
	}

	resolveGlobal(path) {
		if (!path || typeof path !== 'string') {
			return null;
		}

		return path.split('.').reduce((value, part) => {
			if (!part || value === null || value === undefined) {
				return null;
			}
			return value[part];
		}, window);
	}

	getActiveAssistant() {
		return this.activeAssistant;
	}

	async send(options = {}) {
		if (this.sending) {
			return;
		}

		const raw = options.text !== undefined
			? String(options.text)
			: String(this.elements.input.value || '');
		const text = raw.trim();
		if (!text) {
			return;
		}

		const resumeContext = this.pendingInteraction?.resume_handle
			? { ...this.pendingInteraction }
			: null;
		if (options.interactionDecision === true) {
			this.pendingInteraction = null;
		}

		this.events.emit('message:starting', { text });
		this.elements.suggestions.replaceChildren();
		this.elements.suggestions.classList.remove('has-suggestions', 'is-loading');
		this.elements.basePrompt.hidden = true;
		this.elements.messages.classList.remove('is-empty');
		this.root.classList.add('is-started');

		if (options.displayUserMessage !== false) {
			this.appendUserMessage(raw);
		}
		this.setComposerValue('');
		this.scrollToBottom();

		const assistant = this.createAssistantMessage();
		this.activeAssistant = assistant;
		this.setSending(true);

		let payload = {
			prompt: text,
			transport_mode: this.resolveTransportMode(),
			config_group: String(this.options.configGroup || ''),
			config_name: String(this.options.configName || ''),
			conversation_id: this.conversationId
		};
		if (resumeContext) {
			payload.resume_handle = resumeContext.resume_handle;
			payload.resume_response = text;
			if (resumeContext.explicit_decision) {
				payload.resume_responses = JSON.stringify(
					resumeContext.interaction_requests.map((request) => ({
						request_id: String(request.id || ''),
						decision: resumeContext.explicit_decision,
						input: {},
						note: text,
						metadata: {}
					}))
				);
			}
		}
		payload = this.pluginManager.transformRequest(payload);

		try {
			this.transport = this.createTransport();
			await this.transport.send({
				payload,
				events: this.pluginManager.getTransportEvents(),
				onEvent: (eventName, eventPayload) => this.handleTransportEvent(eventName, eventPayload),
				signal: this.signal
			});
		} finally {
			if (this.sending) {
				this.setSending(false);
			}
		}
	}

	resolveTransportMode() {
		if (this.options.transportMode === 'rest') {
			return 'rest';
		}
		if (this.options.transportMode === 'sse') {
			return 'sse';
		}

		return typeof EventSource !== 'undefined'
			&& Boolean(this.options.turnPrepareUrl)
			&& Boolean(this.options.serviceId)
			? 'sse'
			: 'rest';
	}

	createTransport() {
		if (this.resolveTransportMode() === 'sse') {
			return new SseChatTransport({
				prepareUrl: this.options.turnPrepareUrl,
				service: this.options.serviceId
			});
		}

		return new RestChatTransport({
			serviceUrl: this.options.serviceUrl
		});
	}

	handleTransportEvent(eventName, payload) {
		const eventContext = {
			chatbot: this,
			assistant: this.activeAssistant
		};
		this.events.emit('transport:event', {
			eventName,
			payload,
			...eventContext
		});

		const pluginResult = this.pluginManager.handleTransportEvent(eventName, payload, eventContext);
		if (pluginResult.handled) {
			if (pluginResult.complete) {
				this.finishActiveMessage({ interaction: true });
				return { close: true };
			}
			return pluginResult;
		}

		if (eventName === 'msgid') {
			this.setActiveMessageId(payload);
			return {};
		}
		if (eventName === 'token' || eventName === 'message') {
			this.appendToken(payload);
			return {};
		}
		if (eventName === 'done') {
			this.finishActiveMessage();
			return { close: true };
		}
		if (eventName === 'error') {
			this.renderError(payload);
			return { close: true };
		}

		return {};
	}

	setActiveMessageId(payload) {
		if (!this.activeAssistant) {
			return;
		}

		const id = payload && typeof payload === 'object'
			? String(payload.id || payload.msgid || '')
			: '';
		this.activeAssistant.id = id || createId('message');
		this.activeAssistant.element.dataset.messageId = this.activeAssistant.id;
		this.events.emit('message:id', {
			...this.activeAssistant
		});
	}

	appendToken(payload) {
		if (!this.activeAssistant) {
			return;
		}

		const text = typeof payload === 'string'
			? payload
			: String(payload?.text ?? payload?.token ?? payload?.content ?? '');
		if (!text) {
			return;
		}

		this.activeAssistant.rawText += text;
		this.hideThinking(this.activeAssistant);
		this.scheduleActiveRender();
		this.events.emit('message:token', {
			text,
			assistant: this.activeAssistant
		});
	}

	scheduleActiveRender() {
		if (this.renderTimer) {
			return;
		}

		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			this.renderAssistant(this.activeAssistant);
			this.scrollToBottom();
		}, 60);
	}

	finishActiveMessage(options = {}) {
		const assistant = this.activeAssistant;
		if (!assistant || assistant.completed) {
			return;
		}

		if (this.renderTimer) {
			window.clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		assistant.completed = true;
		this.hideThinking(assistant);
		if (!assistant.id) {
			assistant.id = createId('message');
			assistant.element.dataset.messageId = assistant.id;
		}
		if (!options.interaction && !assistant.rawText.trim()) {
			assistant.rawText = this.options.strings.emptyResponse;
		}
		if (!options.interaction) {
			this.renderAssistant(assistant);
		}
		this.setSending(false);
		this.events.emit('message:completed', {
			...assistant,
			interaction: options.interaction === true
		});
		this.scrollToBottom();
	}

	renderError(payload) {
		const assistant = this.activeAssistant;
		if (!assistant || assistant.completed) {
			return;
		}

		assistant.completed = true;
		assistant.error = true;
		this.hideThinking(assistant);
		assistant.content.replaceChildren();

		const userMessage = payload && typeof payload === 'object' && payload.user_message
			? String(payload.user_message)
			: this.options.strings.requestError;
		assistant.content.appendChild(createElement('div', {
			className: 'base3-chatbot-error',
			text: userMessage
		}));

		const technicalMessage = payload && typeof payload === 'object'
			? String(payload.message || '')
			: String(payload || '');
		if (technicalMessage && technicalMessage !== userMessage) {
			const details = createElement('details', { className: 'base3-chatbot-error-details' });
			details.appendChild(createElement('summary', { text: 'Technische Details' }));
			details.appendChild(createElement('pre', { text: technicalMessage }));
			assistant.content.appendChild(details);
		}

		this.setSending(false);
		this.events.emit('message:error', {
			...assistant,
			payload
		});
		this.scrollToBottom();
	}

	appendUserMessage(text) {
		const message = createElement('div', {
			className: 'base3-chatbot-message base3-chatbot-message-user'
		});
		message.appendChild(createElement('div', {
			className: 'base3-chatbot-message-content',
			text
		}));
		this.elements.messages.appendChild(message);
		return message;
	}

	createAssistantMessage() {
		const element = createElement('div', {
			className: 'base3-chatbot-message base3-chatbot-message-assistant'
		});
		const activity = createElement('div', {
			className: 'base3-chatbot-message-activity',
			attributes: {
				'data-chatbot-message-activity': '',
				'aria-live': 'polite'
			}
		});
		const content = createElement('div', {
			className: 'base3-chatbot-message-content',
			attributes: {
				'data-chatbot-message-content': ''
			}
		});
		const thinking = createElement('div', {
			className: 'base3-chatbot-thinking',
			attributes: {
				role: 'status',
				'aria-label': 'Antwort wird vorbereitet'
			}
		});
		thinking.appendChild(createElement('span', {
			className: 'base3-chatbot-thinking-dots',
			text: '…',
			attributes: { 'aria-hidden': 'true' }
		}));
		content.appendChild(thinking);

		const actions = createElement('div', {
			className: 'base3-chatbot-message-actions',
			attributes: {
				'data-chatbot-message-actions': ''
			}
		});
		element.append(activity, content, actions);
		this.elements.messages.appendChild(element);

		return {
			id: '',
			element,
			activity,
			content,
			actions,
			thinking,
			rawText: '',
			completed: false,
			error: false
		};
	}

	hideThinking(assistant) {
		if (assistant?.thinking?.isConnected) {
			assistant.thinking.remove();
		}
	}

	renderAssistant(assistant) {
		if (!assistant) {
			return;
		}

		const handled = this.pluginManager.renderMessageContent({
			element: assistant.content,
			text: assistant.rawText,
			assistant
		});
		if (!handled) {
			assistant.content.textContent = assistant.rawText;
		}
		this.events.emit('message:rendered', {
			...assistant
		});
	}

	resumeInteraction(interaction, decision) {
		if (!interaction?.resume_handle) {
			return;
		}
		decision = String(decision || '').trim();
		if (!['approve', 'deny'].includes(decision)) {
			return;
		}

		this.pendingInteraction = {
			...interaction,
			explicit_decision: decision
		};
		return this.send({
			text: decision === 'approve' ? 'Zustimmen' : 'Abbrechen',
			displayUserMessage: false,
			interactionDecision: true
		});
	}

	setSending(sending) {
		this.sending = Boolean(sending);
		this.elements.sendButton.disabled = this.sending;
		this.elements.input.disabled = this.sending;
		this.root.dataset.chatbotState = this.sending ? 'sending' : 'ready';
		if (!this.sending) {
			this.focusComposer();
		}
	}

	scrollToBottom() {
		scrollElementToBottom(this.elements.messages);
	}

	closeTransport() {
		if (this.transport) {
			this.transport.close();
			this.transport = null;
		}
	}

	destroy() {
		if (!this.initialized) {
			return;
		}

		this.closeTransport();
		if (this.renderTimer) {
			window.clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
		this.pluginManager.destroyAll();
		this.abortController.abort();
		this.ui.clear();
		this.commands.clear();
		this.events.clear();
		this.root.dataset.chatbotState = 'destroyed';
		this.initialized = false;
	}
}

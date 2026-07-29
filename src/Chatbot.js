import { ChatbotCommandRegistry } from './core/ChatbotCommandRegistry.js?build=conversation-draft-1';
import { ChatbotEventBus } from './core/ChatbotEventBus.js?build=conversation-draft-1';
import { ChatbotPluginManager } from './core/ChatbotPluginManager.js?build=conversation-draft-1';
import { ChatbotUiRegistry } from './core/ChatbotUiRegistry.js?build=conversation-draft-1';
import { RestChatTransport } from './transport/RestChatTransport.js?build=conversation-draft-1';
import { SseChatTransport } from './transport/SseChatTransport.js?build=conversation-draft-1';
import { createElement, resolveElement, scrollElementToBottom } from './utils/dom.js?build=conversation-draft-1';

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

function normalizeMessage(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}

	const role = String(value.role || '').trim().toLowerCase();
	if (!['user', 'assistant'].includes(role)) {
		return null;
	}

	return {
		id: String(value.id || value.message_id || '').trim(),
		role,
		content: String(value.content || ''),
		timestamp: String(value.timestamp || value.created_at || '').trim(),
		feedback: value.feedback === null || value.feedback === undefined
			? null
			: String(value.feedback)
	};
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
		this.conversation = null;
		this.conversationId = '';
		this.conversationManaged = false;

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
			openingMessage: query('[data-chatbot-opening-message]'),
			main: query('[data-chatbot-main]'),
			messages: query('[data-chatbot-messages]'),
			suggestions: query('[data-chatbot-suggestions]'),
			composer: query('[data-chatbot-composer]'),
			input: query('[data-chatbot-input]'),
			sendButton: query('[data-chatbot-send]'),
			status: query('[data-chatbot-status]', false),
			canvas: query('[data-chatbot-canvas]', false),
			canvasTitle: query('[data-chatbot-canvas-title]', false),
			canvasContent: query('[data-chatbot-canvas-content]', false),
			canvasClose: query('[data-chatbot-canvas-close]', false)
		};
	}

	registerBuiltInCommands() {
		this.commands
			.register('send', ({ chatbot }, payload) => chatbot.send(payload || {}))
			.register('setComposerValue', ({ chatbot }, payload) => chatbot.setComposerValue(payload ?? ''))
			.register('focusComposer', ({ chatbot }) => chatbot.focusComposer());
	}

	async init() {
		if (this.initialized) {
			return this;
		}

		this.registerUiSlots();
		await this.pluginManager.installAll(this.options.plugins);
		this.bindDomEvents();
		this.initialized = true;
		this.root.dataset.chatbotState = 'ready';

		if (!this.conversationManaged) {
			await this.loadOpeningMessage();
		}
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

	async loadOpeningMessage() {
		if (!this.options.serviceUrl || !this.elements.openingMessage) {
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

			this.setOpeningMessage(await response.text());
		} catch (error) {
			if (error?.name !== 'AbortError') {
				this.events.emit('chatbot:error', error);
			}
		}
	}

	getConversationId() {
		return this.conversationId;
	}

	setConversation(conversation) {
		if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) {
			throw new Error('Conversation metadata is required.');
		}
		const id = String(conversation.id || '').trim();
		if (!id) {
			throw new Error('Conversation metadata requires an id.');
		}

		const changed = this.conversationId !== id;
		this.conversation = { ...conversation, id };
		this.conversationId = id;
		if (changed) {
			this.pendingInteraction = null;
			this.activeAssistant = null;
		}
		this.events.emit(changed ? 'conversation:changed' : 'conversation:updated', {
			conversation: this.conversation,
			conversationId: this.conversationId
		});
		return this;
	}


	clearConversation() {
		const changed = this.conversationId !== '';
		this.conversation = null;
		this.conversationId = '';
		this.pendingInteraction = null;
		this.activeAssistant = null;
		if (changed) {
			this.events.emit('conversation:changed', {
				conversation: null,
				conversationId: ''
			});
		}
		return this;
	}

	setOpeningMessage(message) {
		const text = String(message || '').trim();
		this.elements.openingMessage.textContent = text;
		this.elements.openingMessage.hidden = text === '' || this.elements.messages.children.length > 0;
		this.events.emit('opening-message:loaded', {
			element: this.elements.openingMessage,
			message: text
		});
		return this;
	}

	replaceMessages(messages) {
		this.closeTransport();
		this.pendingInteraction = null;
		this.activeAssistant = null;
		this.elements.messages.replaceChildren();
		this.elements.suggestions.replaceChildren();
		this.elements.suggestions.classList.remove('has-suggestions', 'is-loading');

		const normalized = Array.isArray(messages)
			? messages.map(normalizeMessage).filter(Boolean)
			: [];
		normalized.forEach((message) => this.renderHydratedMessage(message));

		const hasMessages = normalized.length > 0;
		this.elements.messages.classList.toggle('is-empty', !hasMessages);
		this.root.classList.toggle('is-started', hasMessages);
		this.elements.openingMessage.hidden = hasMessages || this.elements.openingMessage.textContent.trim() === '';
		this.events.emit('conversation:messages-replaced', {
			conversationId: this.conversationId,
			messages: normalized
		});
		this.scrollToBottom();
		return this;
	}

	renderHydratedMessage(message) {
		if (message.role === 'user') {
			const element = this.appendUserMessage(message.content, message);
			this.events.emit('message:hydrated', {
				id: message.id,
				element,
				content: element.querySelector('.base3-chatbot-message-content'),
				actions: null,
				rawText: message.content,
				role: message.role,
				feedback: message.feedback,
				completed: true,
				error: false,
				interaction: false
			});
			return element;
		}

		const assistant = this.createAssistantMessage();
		assistant.id = message.id || createId('message');
		assistant.element.dataset.messageId = assistant.id;
		if (message.timestamp) {
			assistant.element.dataset.messageTimestamp = message.timestamp;
		}
		if (message.feedback) {
			assistant.element.dataset.feedback = message.feedback;
		}
		assistant.rawText = message.content;
		assistant.completed = true;
		this.hideThinking(assistant);
		this.renderAssistant(assistant);
		this.events.emit('message:hydrated', {
			...assistant,
			role: message.role,
			feedback: message.feedback,
			interaction: false
		});
		return assistant.element;
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

	announce(message) {
		if (!this.elements.status) {
			return this;
		}
		this.elements.status.textContent = '';
		window.setTimeout(() => {
			if (this.elements.status) {
				this.elements.status.textContent = String(message || '');
			}
		}, 20);
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

	isSending() {
		return this.sending;
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

		let payload = {
			prompt: text,
			transport_mode: this.resolveTransportMode(),
			config_group: String(this.options.configGroup || ''),
			config_name: String(this.options.configName || '')
		};
		if (this.conversationId) {
			payload.conversation_id = this.conversationId;
		}
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

		this.setSending(true);
		try {
			payload = await this.pluginManager.prepareRequest(payload);
			payload = this.pluginManager.transformRequest(payload);
		} catch (error) {
			this.setSending(false);
			if (error?.name !== 'AbortError') {
				this.events.emit('chatbot:error', error);
				this.announce(error?.message || this.options.strings.requestError);
			}
			return;
		}

		this.events.emit('message:starting', {
			text,
			conversationId: this.conversationId
		});
		this.elements.suggestions.replaceChildren();
		this.elements.suggestions.classList.remove('has-suggestions', 'is-loading');
		this.elements.openingMessage.hidden = true;
		this.elements.messages.classList.remove('is-empty');
		this.root.classList.add('is-started');

		if (options.displayUserMessage !== false) {
			this.appendUserMessage(raw);
		}
		this.setComposerValue('');
		this.scrollToBottom();

		const assistant = this.createAssistantMessage();
		this.activeAssistant = assistant;

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

		this.pendingInteraction = null;

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

		if (!options.interaction) {
			this.pendingInteraction = null;
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
			interaction: options.interaction === true,
			conversationId: this.conversationId
		});
		this.scrollToBottom();
	}

	renderError(payload) {
		const assistant = this.activeAssistant;
		if (!assistant || assistant.completed) {
			return;
		}

		this.pendingInteraction = null;

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
			payload,
			conversationId: this.conversationId
		});
		this.scrollToBottom();
	}

	appendUserMessage(text, metadata = {}) {
		const message = createElement('div', {
			className: 'base3-chatbot-message base3-chatbot-message-user'
		});
		const id = String(metadata.id || '').trim();
		const timestamp = String(metadata.timestamp || '').trim();
		if (id) {
			message.dataset.messageId = id;
		}
		if (timestamp) {
			message.dataset.messageTimestamp = timestamp;
		}
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

		this.events.emit('message:rendering', {
			...assistant
		});

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
		this.events.emit('chatbot:sending-changed', {
			sending: this.sending,
			conversationId: this.conversationId
		});
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

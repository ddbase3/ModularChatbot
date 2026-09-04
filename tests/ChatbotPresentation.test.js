import assert from 'node:assert/strict';
import test from 'node:test';

import { Chatbot, formatMessageTimestamp, normalizeDomClasses } from '../src/Chatbot.js';
import { ChatbotEventBus } from '../src/core/ChatbotEventBus.js';
import { MessageActionsPlugin } from '../src/plugins/MessageActionsPlugin.js';

function createClassList(initial = []) {
	const values = new Set(initial);

	return {
		add(...classNames) {
			classNames.forEach((className) => values.add(className));
		},
		remove(...classNames) {
			classNames.forEach((className) => values.delete(className));
		},
		contains(className) {
			return values.has(className);
		}
	};
}

test('formats message timestamps as time, yesterday, or date without seconds', () => {
	const now = new Date(2026, 7, 18, 10, 30, 0);
	const sameDay = new Date(2026, 7, 18, 9, 5, 0).toISOString();
	const yesterday = new Date(2026, 7, 17, 20, 15, 0).toISOString();
	const older = new Date(2026, 7, 16, 20, 15, 0).toISOString();

	assert.equal(formatMessageTimestamp(sameDay, now, 'de-DE'), '09:05');
	assert.match(formatMessageTimestamp(yesterday, now, 'de-DE'), /^gestern, 20:15$/i);
	assert.match(formatMessageTimestamp(older, now, 'de-DE'), /^16\.08\.2026, 20:15$/);
});


test('treats an unresolved layout width as compact until a real width is available', () => {
	const previousWindow = globalThis.window;
	const previousDocument = globalThis.document;
	let width = 0;
	const classes = new Set();
	const events = [];
	globalThis.window = {
		getComputedStyle() {
			return { fontSize: '16px' };
		}
	};
	globalThis.document = {
		documentElement: {}
	};

	try {
		const chatbot = {
			root: {
				clientWidth: 0,
				getBoundingClientRect() {
					return { width };
				},
				classList: {
					toggle(name, enabled) {
						if (enabled) {
							classes.add(name);
						} else {
							classes.delete(name);
						}
					}
				}
			},
			compactLayout: false,
			events: {
				emit(name, payload) {
					events.push({ name, payload });
				}
			}
		};

		Chatbot.prototype.updateLayoutMode.call(chatbot);
		assert.equal(chatbot.compactLayout, true);
		assert.equal(classes.has('is-compact-layout'), true);
		assert.deepEqual(events.at(-1), {
			name: 'layout:changed',
			payload: { compact: true, width: 0 }
		});

		width = 1200;
		Chatbot.prototype.updateLayoutMode.call(chatbot);
		assert.equal(chatbot.compactLayout, false);
		assert.equal(classes.has('is-compact-layout'), false);
		assert.deepEqual(events.at(-1), {
			name: 'layout:changed',
			payload: { compact: false, width: 1200 }
		});
	} finally {
		globalThis.window = previousWindow;
		globalThis.document = previousDocument;
	}
});

test('normalizes semantic DOM class configuration', () => {
	assert.deepEqual(normalizeDomClasses({
		root: 'customer-chatbot theme-dark',
		main: ['customer-chat', 'customer-chat'],
		composer: ['customer-prompt']
	}), {
		root: ['customer-chatbot', 'theme-dark'],
		main: ['customer-chat'],
		composer: ['customer-prompt']
	});

	assert.throws(
		() => normalizeDomClasses({ unknown: 'customer-class' }),
		/Unknown Chatbot DOM class target/
	);
});

test('applies configured classes to semantic DOM targets and clears only added classes', () => {
	const root = {
		classList: createClassList(['base3-chatbot', 'host-existing']),
		querySelector(selector) {
			return elements[selector] || null;
		}
	};
	const elements = {
		'[data-chatbot-main]': { classList: createClassList(['base3-chatbot-main']) },
		'[data-chatbot-composer]': { classList: createClassList(['base3-chatbot-composer', 'host-prompt']) },
		'[data-chatbot-actions]': { classList: createClassList(['base3-chatbot-actions']) },
		'[data-chatbot-ai-notice]': { classList: createClassList(['base3-chatbot-ai-notice']) }
	};
	const chatbot = {
		root,
		domClasses: normalizeDomClasses({
			root: ['customer-chatbot', 'host-existing'],
			main: 'customer-chat',
			composer: ['customer-prompt', 'host-prompt'],
			actions: 'customer-actions',
			ai_notice: 'customer-notice'
		}),
		domClassAssignments: []
	};

	Chatbot.prototype.applyDomClasses.call(chatbot);

	assert.equal(root.classList.contains('customer-chatbot'), true);
	assert.equal(root.classList.contains('host-existing'), true);
	assert.equal(elements['[data-chatbot-main]'].classList.contains('customer-chat'), true);
	assert.equal(elements['[data-chatbot-composer]'].classList.contains('customer-prompt'), true);
	assert.equal(elements['[data-chatbot-actions]'].classList.contains('customer-actions'), true);
	assert.equal(elements['[data-chatbot-ai-notice]'].classList.contains('customer-notice'), true);

	Chatbot.prototype.clearDomClasses.call(chatbot);

	assert.equal(root.classList.contains('customer-chatbot'), false);
	assert.equal(root.classList.contains('host-existing'), true);
	assert.equal(elements['[data-chatbot-main]'].classList.contains('customer-chat'), false);
	assert.equal(elements['[data-chatbot-composer]'].classList.contains('customer-prompt'), false);
	assert.equal(elements['[data-chatbot-composer]'].classList.contains('host-prompt'), true);
});

test('resets streamed assistant text without removing the currently visible progress', () => {
	const previousWindow = globalThis.window;
	const clearedTimers = [];
	const renderedTexts = [];
	globalThis.window = {
		clearTimeout(timer) {
			clearedTimers.push(timer);
		}
	};

	try {
		const chatbot = Object.create(Chatbot.prototype);
		chatbot.activeAssistant = {
			rawText: 'Let me fetch the course members.',
			completed: false
		};
		chatbot.renderTimer = 42;
		chatbot.renderAssistant = (assistant) => {
			renderedTexts.push(assistant.rawText);
		};

		chatbot.resetActiveAssistantTextBuffer();

		assert.deepEqual(clearedTimers, [42]);
		assert.deepEqual(renderedTexts, ['Let me fetch the course members.']);
		assert.equal(chatbot.renderTimer, null);
		assert.equal(chatbot.activeAssistant.rawText, '');
	} finally {
		globalThis.window = previousWindow;
	}
});

test('creates configured branding for the initial assistant message', () => {
	const previousDocument = globalThis.document;
	globalThis.document = {
		createElement(tagName) {
			return {
				tagName: String(tagName).toUpperCase(),
				className: '',
				textContent: '',
				children: [],
				appendChild(child) {
					this.children.push(child);
				}
			};
		}
	};

	try {
		const chatbot = Object.create(Chatbot.prototype);
		chatbot.options = {
			initialAssistantBranding: {
				logo: '/kim-positive.svg',
				title: '<strong>KIM</strong> fragen'
			}
		};
		chatbot.createConfiguredIcon = (src, className) => ({ src, className });

		const branding = chatbot.createInitialAssistantBranding();

		assert.equal(branding.className, 'base3-chatbot-initial-assistant-branding');
		assert.equal(branding.children[0].src, '/kim-positive.svg');
		assert.equal(branding.children[0].className, 'base3-chatbot-initial-assistant-logo');
		assert.equal(branding.children[1].className, 'base3-chatbot-initial-assistant-title');
		assert.equal(branding.children[1].innerHTML, '<strong>KIM</strong> fragen');
	} finally {
		globalThis.document = previousDocument;
	}
});

test('renders plain initial assistant text with br elements for line breaks', () => {
	const document = {
		createElement(tagName) {
			return { nodeName: String(tagName).toUpperCase() };
		},
		createTextNode(text) {
			return { nodeName: '#text', textContent: String(text) };
		}
	};
	const content = {
		ownerDocument: document,
		children: [],
		replaceChildren(...children) {
			this.children = children;
		}
	};
	const chatbot = Object.create(Chatbot.prototype);
	chatbot.showAssistant = () => {};
	chatbot.events = { emit() {} };
	chatbot.pluginManager = { renderMessageContent: () => false };
	const assistant = {
		element: {
			classList: {
				contains(className) {
					return className === 'base3-chatbot-initial-message';
				}
			}
		},
		content,
		rawText: 'First line\n\nSecond paragraph'
	};

	chatbot.renderAssistant(assistant);

	assert.deepEqual(content.children.map((node) => node.nodeName), [
		'#text',
		'BR',
		'#text',
		'BR',
		'#text'
	]);
	assert.equal(content.children[0].textContent, 'First line');
	assert.equal(content.children[4].textContent, 'Second paragraph');
});

test('does not add message actions to the initial assistant message', () => {
	const events = new ChatbotEventBus();
	MessageActionsPlugin.install({ events });

	assert.doesNotThrow(() => events.emit('message:hydrated', {
		role: 'assistant',
		interaction: false,
		error: false,
		actions: { children: { length: 0 } },
		element: {
			classList: {
				contains(className) {
					return className === 'base3-chatbot-initial-message';
				}
			}
		}
	}));
});

test('sending leaves the composer editable and turns the primary action into stop', () => {
	const button = {
		disabled: false,
		title: '',
		dataset: {},
		attributes: new Map(),
		setAttribute(name, value) {
			this.attributes.set(name, String(value));
		}
	};
	const icon = { src: '/send.svg' };
	const emitted = [];
	let focusCount = 0;
	const chatbot = Object.create(Chatbot.prototype);
	chatbot.sending = false;
	chatbot.activeTurnId = 'turn-1';
	chatbot.cancellationRequested = false;
	chatbot.conversationId = 'conversation-1';
	chatbot.options = {
		turnCancelUrl: '/cancel',
		sendButtonIcons: {
			send: '/send.svg',
			stop: '/stop.svg'
		}
	};
	chatbot.elements = {
		input: { disabled: true },
		sendButton: button,
		sendButtonIcon: icon
	};
	chatbot.root = { dataset: {} };
	chatbot.events = {
		emit(name, payload) {
			emitted.push({ name, payload });
		}
	};
	chatbot.getString = (key) => ({
		sendMessage: 'Send message',
		stopResponse: 'Stop response'
	}[key] || key);
	chatbot.focusComposer = () => {
		focusCount += 1;
	};

	chatbot.setSending(true);
	assert.equal(chatbot.elements.input.disabled, false);
	assert.equal(button.disabled, false);
	assert.equal(button.dataset.chatbotAction, 'stop');
	assert.equal(button.attributes.get('aria-label'), 'Stop response');
	assert.equal(icon.src, '/stop.svg');
	assert.equal(chatbot.root.dataset.chatbotState, 'sending');

	chatbot.cancellationRequested = true;
	chatbot.updateSendButton();
	assert.equal(button.disabled, true);

	chatbot.setSending(false);
	assert.equal(button.disabled, false);
	assert.equal(button.dataset.chatbotAction, 'send');
	assert.equal(icon.src, '/send.svg');
	assert.equal(chatbot.activeTurnId, '');
	assert.equal(chatbot.cancellationRequested, false);
	assert.equal(chatbot.root.dataset.chatbotState, 'ready');
	assert.equal(focusCount, 1);
	assert.equal(emitted.at(-1).payload.sending, false);
});

test('send clears only the submitted composer text while request preparation is pending', async () => {
	let rejectPrepare;
	const prepare = new Promise((resolve, reject) => {
		rejectPrepare = reject;
	});
	const chatbot = Object.create(Chatbot.prototype);
	chatbot.sending = false;
	chatbot.pendingInteraction = null;
	chatbot.activeTurnId = '';
	chatbot.cancellationRequested = false;
	chatbot.conversationId = '';
	chatbot.options = {
		configGroup: '',
		configName: ''
	};
	chatbot.elements = {
		input: { value: 'first message' }
	};
	chatbot.resolveTransportMode = () => 'rest';
	chatbot.setComposerValue = (value) => {
		chatbot.elements.input.value = value;
	};
	chatbot.setSending = (sending) => {
		chatbot.sending = Boolean(sending);
		if (!chatbot.sending) {
			chatbot.activeTurnId = '';
			chatbot.cancellationRequested = false;
		}
	};
	chatbot.pluginManager = {
		prepareRequest() {
			return prepare;
		},
		transformRequest(payload) {
			return payload;
		}
	};
	chatbot.events = { emit() {} };
	chatbot.announce = () => {};

	const sending = chatbot.send();
	assert.equal(chatbot.elements.input.value, '');
	assert.equal(chatbot.sending, true);
	assert.match(chatbot.activeTurnId, /^turn-/);

	chatbot.elements.input.value = 'next draft';
	const error = new Error('cancel preparation');
	error.name = 'AbortError';
	rejectPrepare(error);
	await sending;

	assert.equal(chatbot.elements.input.value, 'next draft');
	assert.equal(chatbot.sending, false);
});

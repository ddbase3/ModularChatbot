import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ConversationView,
	formatDeleteQuestion,
	resolveConversationTitle
} from '../src/conversation/ConversationView.js';

test('formatDeleteQuestion composes localized parts with the conversation title', () => {
	assert.equal(
		formatDeleteQuestion('Soll der Chat „', 'Chat 29.07.2026', '“ gelöscht werden?'),
		'Soll der Chat „Chat 29.07.2026“ gelöscht werden?'
	);
});

test('resolveConversationTitle prefers the conversation contract', () => {
	assert.equal(
		resolveConversationTitle({ title: ' Chat 29.07.2026 ' }),
		'Chat 29.07.2026'
	);
});

test('resolveConversationTitle reads the rendered delete control title', () => {
	const trigger = {
		dataset: { conversationTitle: 'Renamed chat' }
	};
	assert.equal(resolveConversationTitle({ title: '' }, trigger), 'Renamed chat');
});

test('resolveConversationTitle falls back to the visible list label', () => {
	const trigger = {
		dataset: {},
		closest() {
			return {
				querySelector() {
					return { textContent: 'Visible chat title' };
				}
			};
		}
	};
	assert.equal(resolveConversationTitle({ title: '' }, trigger), 'Visible chat title');
});

test('responsive panel refreshes layout before deciding its initial visibility', () => {
	let compact = false;
	let layoutHandler = null;
	const openClasses = new Set();
	const panel = {
		hidden: true,
		setAttribute() {}
	};
	const list = {};
	const root = {
		querySelector(selector) {
			if (selector === '[data-chatbot-conversation-panel]') {
				return panel;
			}
			if (selector === '[data-chatbot-conversation-list]') {
				return list;
			}
			return null;
		},
		classList: {
			add(name) {
				openClasses.add(name);
			},
			toggle(name, enabled) {
				if (enabled) {
					openClasses.add(name);
				} else {
					openClasses.delete(name);
				}
			}
		}
	};
	const context = {
		root,
		chatbot: {
			updateLayoutMode() {
				compact = true;
			},
			isCompactLayout() {
				return compact;
			}
		},
		events: {
			on(name, handler) {
				assert.equal(name, 'layout:changed');
				layoutHandler = handler;
				return () => {};
			}
		},
		signal: new AbortController().signal
	};
	const view = new ConversationView(context, {
		multiple: true,
		panelMode: 'responsive'
	});

	view.enable();

	assert.equal(panel.hidden, true);
	assert.equal(openClasses.has('is-conversation-panel-open'), false);
	assert.equal(typeof layoutHandler, 'function');

	compact = false;
	layoutHandler({ compact: false });

	assert.equal(panel.hidden, false);
	assert.equal(openClasses.has('is-conversation-panel-open'), true);
});

test('delete control opens the dialog with the rendered chat title', () => {
	class FakeElement {
		constructor(tagName = 'div') {
			this.tagName = tagName;
			this.dataset = {};
			this.attributes = {};
			this.children = [];
			this.listeners = {};
			this.className = '';
			this.textContent = '';
			this.title = '';
			this.parentElement = null;
			this.open = false;
		}

		setAttribute(name, value) {
			this.attributes[name] = String(value);
		}

		getAttribute(name) {
			return this.attributes[name] ?? null;
		}

		addEventListener(type, listener) {
			this.listeners[type] = listener;
		}

		append(...children) {
			children.forEach((child) => {
				child.parentElement = this;
				this.children.push(child);
			});
		}

		querySelector(selector) {
			if (selector.startsWith('.')) {
				const className = selector.slice(1);
				for (const child of this.children) {
					if (String(child.className).split(/\s+/).includes(className)) {
						return child;
					}
					const nested = child.querySelector?.(selector);
					if (nested) {
						return nested;
					}
				}
			}
			return null;
		}

		closest(selector) {
			if (!selector.startsWith('.')) {
				return null;
			}
			const className = selector.slice(1);
			let element = this;
			while (element) {
				if (String(element.className).split(/\s+/).includes(className)) {
					return element;
				}
				element = element.parentElement;
			}
			return null;
		}

		showModal() {
			this.open = true;
		}

		focus() {}
	}

	const previousDocument = globalThis.document;
	const previousWindow = globalThis.window;
	const dialog = new FakeElement('dialog');
	const dialogText = new FakeElement('p');
	const dialogCancel = new FakeElement('button');
	const selectors = new Map([
		['[data-chatbot-conversation-delete-dialog]', dialog],
		['[data-chatbot-conversation-delete-text]', dialogText],
		['[data-chatbot-conversation-delete-cancel]', dialogCancel]
	]);
	globalThis.document = {
		createElement(tagName) {
			return new FakeElement(tagName);
		}
	};
	globalThis.window = {
		matchMedia() {
			return {
				matches: true,
				addEventListener() {}
			};
		}
	};

	try {
		const context = {
			chatbot: { instanceId: 'chatbot-test' },
			root: {
				querySelector(selector) {
					return selectors.get(selector) || null;
			}
			},
			signal: new AbortController().signal
		};
		const view = new ConversationView(context, {
			multiple: true,
			strings: {
				renameConversation: 'Chat umbenennen',
				deleteConversation: 'Chat löschen',
				deleteQuestionPrefix: 'Soll der Chat „',
				deleteQuestionSuffix: '“ gelöscht werden?'
			},
			icons: {}
		});
		const item = view.createConversationItem({
			id: 'chat-1',
			title: 'BASE3 Chatbot Assistance Request'
		});
		const actions = item.children[1];
		const deleteButton = actions.children[1];
		deleteButton.listeners.click({ currentTarget: deleteButton });

		assert.equal(
			dialogText.textContent,
			'Soll der Chat „BASE3 Chatbot Assistance Request“ gelöscht werden?'
		);
		assert.equal(deleteButton.getAttribute('aria-label'), 'Chat löschen');
		assert.equal(dialog.open, true);
	} finally {
		globalThis.document = previousDocument;
		globalThis.window = previousWindow;
	}
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { Chatbot, formatMessageTimestamp } from '../src/Chatbot.js';
import { ChatbotEventBus } from '../src/core/ChatbotEventBus.js';
import { MessageActionsPlugin } from '../src/plugins/MessageActionsPlugin.js';

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

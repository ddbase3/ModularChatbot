import assert from 'node:assert/strict';
import test from 'node:test';

import { formatMessageTimestamp } from '../src/Chatbot.js';
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

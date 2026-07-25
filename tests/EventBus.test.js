import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatbotEventBus } from '../src/core/ChatbotEventBus.js';

test('event bus subscribes and unsubscribes handlers', () => {
	const events = new ChatbotEventBus();
	const values = [];
	const unsubscribe = events.on('value', (value) => values.push(value));

	events.emit('value', 1);
	unsubscribe();
	events.emit('value', 2);

	assert.deepEqual(values, [1]);
});

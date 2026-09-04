import assert from 'node:assert/strict';
import test from 'node:test';
import { RestChatTransport } from '../src/transport/RestChatTransport.js';

test('REST transport normalizes a successful response into events', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: true,
		async json() {
			return { id: 'message-1', text: 'Hello' };
		}
	});

	try {
		const events = [];
		const transport = new RestChatTransport({ serviceUrl: '/chatbot' });
		await transport.send({
			payload: { prompt: 'Hi' },
			onEvent: (eventName, payload) => events.push([eventName, payload])
		});

		assert.equal(events[0][0], 'msgid');
		assert.equal(events[1][0], 'token');
		assert.equal(events[1][1].text, 'Hello');
		assert.equal(events[2][0], 'done');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('REST transport emits a cancelled terminal event without assistant content', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => ({
		ok: true,
		async json() {
			return { status: 'cancelled', type: 'cancelled', text: '' };
		}
	});

	try {
		const events = [];
		const transport = new RestChatTransport({ serviceUrl: '/chatbot' });
		await transport.send({
			payload: { prompt: 'Hi', turn_id: 'turn-1' },
			onEvent: (eventName, payload) => events.push([eventName, payload])
		});

		assert.deepEqual(events, [
			['done', { status: 'cancelled' }]
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

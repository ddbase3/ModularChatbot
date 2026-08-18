import assert from 'node:assert/strict';
import test from 'node:test';
import { SseChatTransport } from '../src/transport/SseChatTransport.js';

class EventSourceMock {
	static instances = [];

	constructor(url, options) {
		this.url = url;
		this.options = options;
		this.listeners = new Map();
		this.closed = false;
		this.onmessage = null;
		EventSourceMock.instances.push(this);
	}

	addEventListener(name, listener) {
		this.listeners.set(name, listener);
	}

	emit(name, data) {
		const listener = this.listeners.get(name);
		if (listener) {
			listener({ data: JSON.stringify(data) });
		}
	}

	close() {
		this.closed = true;
	}
}

test('SSE transport always subscribes to core protocol events', async () => {
	const originalFetch = globalThis.fetch;
	const originalEventSource = globalThis.EventSource;
	globalThis.fetch = async () => ({
		ok: true,
		async json() {
			return { ok: true, stream: '/stream/turn-1' };
		}
	});
	globalThis.EventSource = EventSourceMock;
	EventSourceMock.instances = [];

	try {
		const events = [];
		const transport = new SseChatTransport({
			prepareUrl: '/prepare',
			service: 'chatbot'
		});
		const sending = transport.send({
			payload: { prompt: 'Hi' },
			events: ['stage.started'],
			onEvent: (eventName, payload) => {
				events.push([eventName, payload]);
				return eventName === 'done' ? { close: true } : {};
			}
		});

		await new Promise((resolve) => setImmediate(resolve));
		const source = EventSourceMock.instances[0];
		assert.ok(source);
		assert.deepEqual([...source.listeners.keys()], [
			'msgid',
			'token',
			'done',
			'error',
			'stage.started'
		]);

		source.emit('msgid', { id: 'message-1' });
		source.emit('token', { text: 'Hello' });
		source.emit('done', { status: 'completed' });
		await sending;

		assert.deepEqual(events, [
			['msgid', { id: 'message-1' }],
			['token', { text: 'Hello' }],
			['done', { status: 'completed' }]
		]);
		assert.equal(source.closed, true);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.EventSource = originalEventSource;
	}
});

test('SSE transport does not treat a done event as terminal without an explicit close decision', async () => {
	const originalFetch = globalThis.fetch;
	const originalEventSource = globalThis.EventSource;
	globalThis.fetch = async () => ({
		ok: true,
		async json() {
			return { ok: true, stream: '/stream/turn-2' };
		}
	});
	globalThis.EventSource = EventSourceMock;
	EventSourceMock.instances = [];

	try {
		const events = [];
		const transport = new SseChatTransport({
			prepareUrl: '/prepare',
			service: 'chatbot'
		});
		const sending = transport.send({
			payload: { prompt: 'Change something' },
			events: ['agent.interaction.required'],
			onEvent: (eventName, payload) => {
				events.push([eventName, payload]);
				return eventName === 'agent.interaction.required' ? { close: true } : {};
			}
		});

		await new Promise((resolve) => setImmediate(resolve));
		const source = EventSourceMock.instances[0];
		assert.ok(source);

		source.emit('done', { status: 'awaiting_approval' });
		assert.equal(source.closed, false);

		source.emit('agent.interaction.required', {
			status: 'awaiting_approval',
			resume_handle: 'resume-2',
			interaction_requests: [{ id: 'request-1', kind: 'approval' }]
		});
		await sending;

		assert.equal(source.closed, true);
		assert.deepEqual(events.map(([name]) => name), [
			'done',
			'agent.interaction.required'
		]);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.EventSource = originalEventSource;
	}
});

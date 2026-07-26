import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeSpeechToTextSocket } from '../src/speech/RealtimeSpeechToTextSocket.js';

class WebSocketMock {
	static OPEN = 1;
	static instances = [];

	constructor(url, protocols) {
		this.url = url;
		this.protocols = protocols;
		this.readyState = WebSocketMock.OPEN;
		this.sent = [];
		this.closed = false;
		WebSocketMock.instances.push(this);
	}

	send(value) {
		this.sent.push(JSON.parse(value));
	}

	close() {
		this.closed = true;
	}
}

test('realtime socket resolves only after the provider marks the handshake ready', async () => {
	const original = globalThis.WebSocket;
	globalThis.WebSocket = WebSocketMock;
	WebSocketMock.instances = [];

	try {
		let connection;
		connection = new RealtimeSpeechToTextSocket({
			providerName: 'Test provider',
			endpoint: 'wss://example.invalid/realtime',
			protocols: ['realtime'],
			onMessage: (message) => {
				if (message.type === 'ready') {
					connection.markReady();
				}
			}
		});

		const opening = connection.open();
		const socket = WebSocketMock.instances[0];
		assert.equal(connection.ready, false);
		await socket.onmessage({ data: JSON.stringify({ type: 'ready' }) });
		await opening;
		assert.equal(connection.ready, true);
		connection.send({ type: 'audio' });
		assert.deepEqual(socket.sent, [{ type: 'audio' }]);
	} finally {
		globalThis.WebSocket = original;
	}
});

test('realtime socket reports the close code during initialization', async () => {
	const original = globalThis.WebSocket;
	globalThis.WebSocket = WebSocketMock;
	WebSocketMock.instances = [];

	try {
		const connection = new RealtimeSpeechToTextSocket({
			providerName: 'Test provider',
			endpoint: 'wss://example.invalid/realtime',
			protocols: ['realtime']
		});
		const opening = connection.open();
		const socket = WebSocketMock.instances[0];
		socket.onclose({ code: 1008, reason: 'invalid token' });
		await assert.rejects(opening, /code 1008: invalid token/);
	} finally {
		globalThis.WebSocket = original;
	}
});

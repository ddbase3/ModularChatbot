import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiRealtimeSpeechToTextProvider } from '../src/speech/OpenAiRealtimeSpeechToTextProvider.js';

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

class AudioWorkletNodeMock {
	constructor() {
		this.port = { onmessage: null };
	}
	connect() {}
	disconnect() {}
}

class AudioContextMock {
	constructor() {
		this.sampleRate = 48000;
		this.destination = {};
		this.audioWorklet = { addModule: async () => {} };
	}
	createMediaStreamSource() {
		return { connect() {}, disconnect() {} };
	}
	createGain() {
		return { gain: { value: 1 }, connect() {}, disconnect() {} };
	}
	close() {}
}

function waitFor(predicate) {
	return new Promise((resolve, reject) => {
		let attempts = 0;
		const next = () => {
			if (predicate()) {
				resolve();
				return;
			}
			attempts += 1;
			if (attempts > 20) {
				reject(new Error('Condition was not reached.'));
				return;
			}
			setImmediate(next);
		};
		next();
	});
}

async function runSessionCreatedTest() {
	const originals = {
		WebSocket: globalThis.WebSocket,
		AudioContext: globalThis.AudioContext,
		AudioWorkletNode: globalThis.AudioWorkletNode,
		navigator: globalThis.navigator
	};
	const partial = [];
	const final = [];
	const track = { stopped: false, stop() { this.stopped = true; } };

	globalThis.WebSocket = WebSocketMock;
	globalThis.AudioContext = AudioContextMock;
	globalThis.AudioWorkletNode = AudioWorkletNodeMock;
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: { mediaDevices: { async getUserMedia() { return { getTracks: () => [track] }; } } }
	});
	WebSocketMock.instances = [];

	try {
		const provider = new OpenAiRealtimeSpeechToTextProvider({
			session: {
				provider: 'openai',
				transport: 'websocket',
				endpoint: 'wss://api.openai.com/v1/realtime',
				clientToken: 'ek_test',
				audioEncoding: 'pcm_s16le',
				sampleRate: 24000,
				options: {}
			},
			onPartial: (text) => partial.push(text),
			onFinal: (text) => final.push(text)
		});
		const start = provider.start();
		await waitFor(() => WebSocketMock.instances.length === 1);
		const socket = WebSocketMock.instances[0];
		assert.deepEqual(socket.protocols, [
			'realtime',
			'openai-insecure-api-key.ek_test'
		]);

		await socket.onmessage({ data: JSON.stringify({ type: 'session.created' }) });
		await start;
		assert.equal(provider.recording, true);

		await socket.onmessage({
			data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Hallo ' })
		});
		assert.deepEqual(partial, ['Hallo']);

		provider.sendAudio(new Int16Array([1, 2, 3]));
		provider.stop();
		assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.commit');
		await socket.onmessage({
			data: JSON.stringify({
				type: 'conversation.item.input_audio_transcription.completed',
				transcript: 'Hallo Welt'
			})
		});
		assert.deepEqual(final, ['Hallo Welt']);
		assert.equal(track.stopped, true);
		assert.equal(socket.closed, true);
	} finally {
		globalThis.WebSocket = originals.WebSocket;
		globalThis.AudioContext = originals.AudioContext;
		globalThis.AudioWorkletNode = originals.AudioWorkletNode;
		Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originals.navigator });
	}
}

test('openai provider starts recording after session.created', async () => {
	await runSessionCreatedTest();
});

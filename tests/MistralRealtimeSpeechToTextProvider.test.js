import assert from 'node:assert/strict';
import test from 'node:test';
import { MistralRealtimeSpeechToTextProvider } from '../src/speech/MistralRealtimeSpeechToTextProvider.js';

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

test('mistral realtime provider creates a browser session and emits live transcript', async () => {
	const originals = {
		fetch: globalThis.fetch,
		WebSocket: globalThis.WebSocket,
		AudioContext: globalThis.AudioContext,
		AudioWorkletNode: globalThis.AudioWorkletNode,
		navigator: globalThis.navigator
	};
	const partial = [];
	const final = [];
	const ended = [];
	const track = { stopped: false, stop() { this.stopped = true; } };

	globalThis.fetch = async () => ({
		ok: true,
		async json() {
			return {
				status: 'ok',
				data: {
					session: {
						provider: 'mistral',
						transport: 'websocket',
						endpoint: 'wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=test',
						clientToken: 'rt_test',
						audioEncoding: 'pcm_s16le',
						sampleRate: 16000,
						options: { targetStreamingDelayMs: 480, silenceDurationMs: 900 }
					}
				}
			};
		}
	});
	globalThis.WebSocket = WebSocketMock;
	globalThis.AudioContext = AudioContextMock;
	globalThis.AudioWorkletNode = AudioWorkletNodeMock;
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {
			mediaDevices: {
				async getUserMedia() {
					return { getTracks: () => [track] };
				}
			}
		}
	});
	WebSocketMock.instances = [];

	try {
		const provider = new MistralRealtimeSpeechToTextProvider({
			sessionUrl: '/stt/session',
			onPartial: (text) => partial.push(text),
			onFinal: (text) => final.push(text),
			onEnd: (data) => ended.push(data)
		});
		const start = provider.start();
		await waitFor(() => WebSocketMock.instances.length === 1);
		const socket = WebSocketMock.instances[0];
		assert.equal(socket.url.includes('api.mistral.ai'), true);
		assert.deepEqual(socket.protocols, ['realtime', 'rt_test']);

		await socket.onmessage({ data: JSON.stringify({ type: 'session.created' }) });
		await start;
		assert.equal(socket.sent[0].type, 'session.update');
		assert.equal(socket.sent[0].session.audio_format.sample_rate, 16000);

		await socket.onmessage({ data: JSON.stringify({ type: 'transcription.text.delta', text: 'Hallo ' }) });
		await socket.onmessage({ data: JSON.stringify({ type: 'transcription.text.delta', text: 'Welt' }) });
		assert.deepEqual(partial, ['Hallo ', 'Hallo Welt']);

		await socket.onmessage({ data: JSON.stringify({ type: 'transcription.done', text: 'Hallo Welt' }) });
		assert.deepEqual(final, ['Hallo Welt']);
		assert.equal(ended.length, 1);
		assert.equal(track.stopped, true);
		assert.equal(socket.closed, true);
	} finally {
		globalThis.fetch = originals.fetch;
		globalThis.WebSocket = originals.WebSocket;
		globalThis.AudioContext = originals.AudioContext;
		globalThis.AudioWorkletNode = originals.AudioWorkletNode;
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true,
			value: originals.navigator
		});
	}
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { MistralRealtimeSpeechToTextProvider } from '../src/speech/MistralRealtimeSpeechToTextProvider.js';
import { VocabularyNormalizer } from '../src/speech/MistralTranscript.js';

class EventTargetMock {
	constructor() {
		this.listeners = new Map();
	}

	addEventListener(name, handler) {
		const handlers = this.listeners.get(name) || [];
		handlers.push(handler);
		this.listeners.set(name, handlers);
	}

	emit(name, event = {}) {
		for (const handler of this.listeners.get(name) || []) {
			handler(event);
		}
	}
}

class WebSocketMock extends EventTargetMock {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSED = 3;
	static instances = [];

	constructor(url, protocols) {
		super();
		this.url = url;
		this.protocols = protocols;
		this.readyState = WebSocketMock.OPEN;
		this.bufferedAmount = 0;
		this.sent = [];
		this.closed = false;
		WebSocketMock.instances.push(this);
	}

	send(value) {
		this.sent.push(value);
	}

	close() {
		this.closed = true;
		this.readyState = WebSocketMock.CLOSED;
	}

	message(payload) {
		this.emit('message', { data: JSON.stringify(payload) });
	}
}

class AudioWorkletNodeMock {
	static instances = [];

	constructor(context, name, options) {
		this.context = context;
		this.name = name;
		this.options = options;
		this.port = {
			onmessage: null,
			postMessage: (message) => {
				if (message?.type === 'stop') {
					queueMicrotask(() => this.port.onmessage?.({ data: { type: 'stopped' } }));
				}
			}
		};
		AudioWorkletNodeMock.instances.push(this);
	}

	connect() {}
	 disconnect() {}
}

class AudioContextMock {
	static instances = [];

	constructor(options) {
		this.options = options;
		this.sampleRate = 48000;
		this.destination = {};
		this.state = 'running';
		this.audioWorklet = { addModule: async () => {} };
		AudioContextMock.instances.push(this);
	}

	createMediaStreamSource() {
		return { connect() {}, disconnect() {} };
	}

	createGain() {
		return { gain: { value: 1 }, connect() {}, disconnect() {} };
	}

	async resume() {}

	async close() {
		this.state = 'closed';
	}
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
			if (attempts > 500) {
				reject(new Error('Condition was not reached.'));
				return;
			}
			setImmediate(next);
		};
		next();
	});
}

function parsedEvents(socket) {
	return socket.sent.map((value) => JSON.parse(value));
}

test('mistral provider sends one 20 ms capture to two independent realtime streams', async () => {
	const originals = {
		WebSocket: globalThis.WebSocket,
		AudioContext: globalThis.AudioContext,
		AudioWorkletNode: globalThis.AudioWorkletNode
	};
	const final = [];
	const partial = [];
	const ended = [];
	const levels = [];
	const track = new EventTargetMock();
	track.stopped = false;
	track.stop = () => {
		track.stopped = true;
	};
	const mediaStream = {
		getAudioTracks: () => [track],
		getTracks: () => [track]
	};

	WebSocketMock.instances = [];
	AudioWorkletNodeMock.instances = [];
	AudioContextMock.instances = [];
	globalThis.WebSocket = WebSocketMock;
	globalThis.AudioContext = AudioContextMock;
	globalThis.AudioWorkletNode = AudioWorkletNodeMock;
	try {
		const provider = new MistralRealtimeSpeechToTextProvider({
			mediaStream,
			session: {
				provider: 'mistral',
				transport: 'websocket',
				endpoint: 'wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=test',
				clientToken: 'rt_fast',
				expiresAt: '2099-01-01T00:00:00Z',
				model: 'voxtral-mini-transcribe-realtime-2602',
				audioEncoding: 'pcm_s16le',
				sampleRate: 48000,
				options: {
					clientTokens: {
						fast: { value: 'rt_fast', expiresAt: '2099-01-01T00:00:00Z' },
						slow: { value: 'rt_slow', expiresAt: '2099-01-01T00:00:00Z' }
					},
					fastStreamingDelayMs: 240,
					slowStreamingDelayMs: 2400,
					chunkDurationMs: 20,
					supportedSampleRates: [8000, 16000, 22050, 44100, 48000],
					sessionTimeoutMs: 12000,
					finalizationTimeoutMs: 25000,
					maxQueueBytes: 524288,
					webSocketHighWaterBytes: 196608,
					vocabulary: ['ILIAS']
				}
			},
			onPartial: (text) => partial.push(text),
			onFinal: (text) => final.push(text),
			onEnd: (data) => ended.push(data),
			onLevel: (rms, peak) => levels.push({ rms, peak })
		});
		const starting = provider.start();
		await waitFor(() => WebSocketMock.instances.length === 2);
		const [fastSocket, slowSocket] = WebSocketMock.instances;
		assert.deepEqual(fastSocket.protocols, ['realtime', 'rt_fast']);
		assert.deepEqual(slowSocket.protocols, ['realtime', 'rt_slow']);
		assert.notEqual(fastSocket.protocols[1], slowSocket.protocols[1]);

		fastSocket.message({ type: 'session.created' });
		slowSocket.message({ type: 'session.created' });
		await waitFor(() => fastSocket.sent.length === 1 && slowSocket.sent.length === 1);
		assert.deepEqual(parsedEvents(fastSocket)[0].session, {
			audio_format: {
				encoding: 'pcm_s16le',
				sample_rate: 48000
			},
			target_streaming_delay_ms: 240
		});
		assert.deepEqual(parsedEvents(slowSocket)[0].session, {
			audio_format: {
				encoding: 'pcm_s16le',
				sample_rate: 48000
			},
			target_streaming_delay_ms: 2400
		});
		fastSocket.message({ type: 'session.updated' });
		slowSocket.message({ type: 'session.updated' });
		await starting;
		assert.equal(provider.recording, true);
		assert.equal(AudioContextMock.instances[0].options.sampleRate, 48000);
		assert.equal(AudioWorkletNodeMock.instances[0].options.processorOptions.chunkMs, 20);

		const audioBuffer = new Int16Array([1, -2, 3, -4]).buffer;
		AudioWorkletNodeMock.instances[0].port.onmessage({
			data: { type: 'audio', buffer: audioBuffer }
		});
		await waitFor(() => parsedEvents(fastSocket).some((event) => event.type === 'input_audio.append'));
		const fastAudio = fastSocket.sent.find((value) => JSON.parse(value).type === 'input_audio.append');
		const slowAudio = slowSocket.sent.find((value) => JSON.parse(value).type === 'input_audio.append');
		assert.equal(fastAudio, slowAudio);

		AudioWorkletNodeMock.instances[0].port.onmessage({
			data: { type: 'level', rms: 0.08, peak: 0.3 }
		});
		assert.deepEqual(levels.at(-1), { rms: 0.08, peak: 0.3 });

		fastSocket.message({ type: 'transcription.text.delta', text: 'Wir nutzen Elias' });
		await waitFor(() => partial.includes('Wir nutzen ILIAS'));

		provider.stop();
		await waitFor(() => parsedEvents(fastSocket).some((event) => event.type === 'input_audio.end'));
		assert.equal(parsedEvents(fastSocket).at(-2).type, 'input_audio.flush');
		assert.equal(parsedEvents(fastSocket).at(-1).type, 'input_audio.end');
		assert.equal(parsedEvents(slowSocket).at(-2).type, 'input_audio.flush');
		assert.equal(parsedEvents(slowSocket).at(-1).type, 'input_audio.end');

		fastSocket.message({ type: 'transcription.done', text: 'Wir nutzen Elias' });
		slowSocket.message({ type: 'transcription.done', text: 'Wir nutzen ILIAS' });
		await waitFor(() => ended.length === 1);
		assert.deepEqual(final, ['Wir nutzen ILIAS']);
		assert.equal(ended[0].text, 'Wir nutzen ILIAS');
		assert.equal(track.stopped, true);
		assert.equal(fastSocket.closed, true);
		assert.equal(slowSocket.closed, true);
	} finally {
		globalThis.WebSocket = originals.WebSocket;
		globalThis.AudioContext = originals.AudioContext;
		globalThis.AudioWorkletNode = originals.AudioWorkletNode;
	}
});

test('mistral vocabulary normalizer corrects the configured ILIAS term', () => {
	const normalizer = new VocabularyNormalizer(['ILIAS']);
	assert.equal(normalizer.apply('Elias Administration'), 'ILIAS Administration');
	assert.equal(normalizer.apply('ILIAS Administration'), 'ILIAS Administration');
});

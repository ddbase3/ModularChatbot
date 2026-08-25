import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiRealtimeSpeechToTextProvider } from '../src/speech/OpenAiRealtimeSpeechToTextProvider.js';

class EventTargetMock {
	constructor() {
		this.listeners = new Map();
	}

	addEventListener(name, handler) {
		const handlers = this.listeners.get(name) || [];
		handlers.push(handler);
		this.listeners.set(name, handlers);
	}

	removeEventListener(name, handler) {
		const handlers = this.listeners.get(name) || [];
		this.listeners.set(name, handlers.filter((candidate) => candidate !== handler));
	}

	emit(name, event = {}) {
		for (const handler of this.listeners.get(name) || []) {
			handler(event);
		}
	}
}

class DataChannelMock extends EventTargetMock {
	constructor() {
		super();
		this.readyState = 'connecting';
		this.sent = [];
	}

	send(value) {
		this.sent.push(JSON.parse(value));
	}

	open() {
		this.readyState = 'open';
		this.emit('open');
	}

	close() {
		this.readyState = 'closed';
	}
}

class PeerConnectionMock extends EventTargetMock {
	static instances = [];

	constructor() {
		super();
		this.connectionState = 'new';
		this.localDescription = null;
		this.remoteDescription = null;
		this.addedTracks = [];
		this.dataChannel = null;
		PeerConnectionMock.instances.push(this);
	}

	addTrack(track, stream) {
		this.addedTracks.push({ track, stream });
	}

	createDataChannel(label, options) {
		this.dataChannel = new DataChannelMock();
		this.dataChannel.label = label;
		this.dataChannel.options = options;
		return this.dataChannel;
	}

	async createOffer() {
		return { type: 'offer', sdp: 'v=0\r\no=browser-offer' };
	}

	async setLocalDescription(description) {
		this.localDescription = description;
	}

	async setRemoteDescription(description) {
		this.remoteDescription = description;
		this.connectionState = 'connected';
	}

	close() {
		this.connectionState = 'closed';
	}
}

class AudioContextMock {
	constructor() {
		this.state = 'running';
		this.analyser = null;
	}

	createMediaStreamSource() {
		return {
			connect() {},
			disconnect() {}
		};
	}

	createAnalyser() {
		this.analyser = {
			fftSize: 0,
			smoothingTimeConstant: 0,
			getByteTimeDomainData(samples) {
				samples.fill(128);
			},
			disconnect() {}
		};
		return this.analyser;
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

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('openai provider uses the original microphone track over WebRTC and commits explicitly', async () => {
	const originals = {
		fetch: globalThis.fetch,
		RTCPeerConnection: globalThis.RTCPeerConnection,
		AudioContext: globalThis.AudioContext,
		requestAnimationFrame: globalThis.requestAnimationFrame,
		cancelAnimationFrame: globalThis.cancelAnimationFrame
	};
	const track = new EventTargetMock();
	track.enabled = true;
	track.stopCount = 0;
	track.stop = () => {
		track.stopCount += 1;
	};
	const stream = {
		getAudioTracks: () => [track],
		getTracks: () => [track]
	};
	let sdpRequest = null;
	const partial = [];
	const final = [];
	const ended = [];
	let provider = null;

	PeerConnectionMock.instances = [];
	globalThis.fetch = async (url, options) => {
		sdpRequest = { url, options };
		return {
			ok: true,
			async text() {
				return 'v=0\r\no=openai-answer';
			}
		};
	};
	globalThis.RTCPeerConnection = PeerConnectionMock;
	globalThis.AudioContext = AudioContextMock;
	globalThis.requestAnimationFrame = () => 1;
	globalThis.cancelAnimationFrame = () => {};
	try {
		provider = new OpenAiRealtimeSpeechToTextProvider({
			mediaStream: stream,
			session: {
				provider: 'openai',
				transport: 'webrtc',
				endpoint: 'https://api.openai.com/v1/realtime/calls',
				clientToken: 'ek_test',
				expiresAt: '2099-01-01T00:00:00Z',
				model: 'gpt-live-transcribe',
				audioEncoding: 'audio/pcm',
				sampleRate: 24000,
				options: {
					commitDrainMs: 1,
					transcriptQuietMs: 1,
					finalizationTimeoutMs: 10000
				}
			},
			onPartial: (text) => partial.push(text),
			onFinal: (text) => final.push(text),
			onEnd: (data) => ended.push(data)
		});
		const starting = provider.start();
		await waitFor(() => PeerConnectionMock.instances[0]?.dataChannel?.listeners.has('open'));
		const peer = PeerConnectionMock.instances[0];
		peer.dataChannel.open();
		await starting;

		assert.equal(provider.recording, true);
		assert.equal(peer.addedTracks.length, 1);
		assert.equal(peer.addedTracks[0].track, track);
		assert.equal(peer.addedTracks[0].stream, stream);
		assert.equal(peer.dataChannel.label, 'oai-events');
		assert.deepEqual(peer.dataChannel.options, { ordered: true });
		assert.equal(sdpRequest.url, 'https://api.openai.com/v1/realtime/calls');
		assert.equal(sdpRequest.options.headers.Authorization, 'Bearer ek_test');
		assert.equal(sdpRequest.options.headers['Content-Type'], 'application/sdp');
		assert.equal(sdpRequest.options.body, 'v=0\r\no=browser-offer');

		peer.dataChannel.emit('message', {
			data: JSON.stringify({
				type: 'conversation.item.added',
				item: { id: 'item-1', role: 'user' },
				previous_item_id: null
			})
		});
		peer.dataChannel.emit('message', {
			data: JSON.stringify({
				type: 'conversation.item.input_audio_transcription.delta',
				item_id: 'item-1',
				delta: 'Hallo '
			})
		});
		assert.deepEqual(partial, ['Hallo']);

		provider.stop();
		await waitFor(() => peer.dataChannel.sent.some((event) => event.type === 'input_audio_buffer.commit'));
		assert.equal(track.enabled, false);
		peer.dataChannel.emit('message', {
			data: JSON.stringify({
				type: 'input_audio_buffer.committed',
				item_id: 'item-1'
			})
		});
		peer.dataChannel.emit('message', {
			data: JSON.stringify({
				type: 'conversation.item.input_audio_transcription.completed',
				item_id: 'item-1',
				transcript: 'Hallo Welt'
			})
		});
		await delay(170);
		await waitFor(() => ended.length === 1);

		assert.deepEqual(final, ['Hallo Welt']);
		assert.equal(ended[0].text, 'Hallo Welt');
		assert.ok(track.stopCount > 0);
		assert.equal(peer.dataChannel.readyState, 'closed');
		assert.equal(peer.connectionState, 'closed');
	} finally {
		provider?.destroy();
		globalThis.fetch = originals.fetch;
		globalThis.RTCPeerConnection = originals.RTCPeerConnection;
		globalThis.AudioContext = originals.AudioContext;
		globalThis.requestAnimationFrame = originals.requestAnimationFrame;
		globalThis.cancelAnimationFrame = originals.cancelAnimationFrame;
	}
});

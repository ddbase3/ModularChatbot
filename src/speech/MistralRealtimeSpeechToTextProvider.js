import { arrayBufferToBase64, Pcm16AudioCapture } from './Pcm16AudioCapture.js';
import { TranscriptState } from './MistralTranscript.js';

const AUDIO_ENCODING = 'pcm_s16le';
const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 44100, 48000];
const AUDIO_CHUNK_MS = 20;
const SESSION_TIMEOUT_MS = 12000;
const FINAL_TIMEOUT_MS = 25000;
const MAX_QUEUE_BYTES = 512 * 1024;
const WS_HIGH_WATER_BYTES = 192 * 1024;

class Deferred {
	constructor() {
		this.settled = false;
		this.promise = new Promise((resolve, reject) => {
			this.resolveInternal = resolve;
			this.rejectInternal = reject;
		});
		this.promise.catch(() => {});
	}

	resolve(value) {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.resolveInternal(value);
	}

	reject(error) {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.rejectInternal(error);
	}
}

function now() {
	return globalThis.performance?.now?.() ?? Date.now();
}

function withTimeout(promise, milliseconds, message) {
	return new Promise((resolve, reject) => {
		const timer = globalThis.setTimeout(() => reject(new Error(message)), milliseconds);
		promise.then((value) => {
			globalThis.clearTimeout(timer);
			resolve(value);
		}, (error) => {
			globalThis.clearTimeout(timer);
			reject(error);
		});
	});
}

function getErrorMessage(payload) {
	if (!payload) {
		return 'Unknown Mistral error.';
	}
	if (typeof payload === 'string') {
		return payload;
	}
	if (typeof payload.message === 'string') {
		return payload.message;
	}
	if (payload.message && typeof payload.message.detail === 'string') {
		return payload.message.detail;
	}
	try {
		return JSON.stringify(payload);
	} catch (error) {
		return 'Unknown Mistral error.';
	}
}

function dataToText(data) {
	if (typeof data === 'string') {
		return Promise.resolve(data);
	}
	if (typeof Blob !== 'undefined' && data instanceof Blob) {
		return data.text();
	}
	if (data instanceof ArrayBuffer) {
		return Promise.resolve(new TextDecoder().decode(new Uint8Array(data)));
	}
	return Promise.reject(new Error('Mistral returned an unsupported WebSocket payload.'));
}

class RealtimeStream {
	constructor(options) {
		this.name = options.name;
		this.endpoint = options.endpoint;
		this.token = options.token;
		this.model = options.model;
		this.sampleRate = options.sampleRate;
		this.delay = options.delay;
		this.sessionTimeoutMs = options.sessionTimeoutMs;
		this.finalizationTimeoutMs = options.finalizationTimeoutMs;
		this.onDelta = options.onDelta;
		this.onFinal = options.onFinal;
		this.onFatal = options.onFatal;
		this.socket = null;
		this.ready = new Deferred();
		this.done = new Deferred();
		this.readyTimer = 0;
		this.transportErrorTimer = 0;
		this.sessionUpdated = false;
		this.ending = false;
		this.completed = false;
		this.failed = false;
		this.closing = false;
		this.opened = false;
		this.phase = 'created';
		this.messageChain = Promise.resolve();
	}

	connect() {
		this.phase = 'connecting';
		try {
			this.socket = new WebSocket(this.endpoint, ['realtime', this.token]);
		} catch (error) {
			this.fail(error);
			return this.ready.promise;
		}

		this.readyTimer = globalThis.setTimeout(() => {
			this.fail(new Error(`Mistral ${this.name} stream handshake timed out in phase ${this.phase}.`));
		}, this.sessionTimeoutMs);

		this.socket.addEventListener('open', () => {
			this.opened = true;
			this.phase = 'socket-open';
		});
		this.socket.addEventListener('message', (event) => {
			this.messageChain = this.messageChain
				.then(() => this.processMessage(event.data))
				.catch((error) => this.fail(error));
		});
		this.socket.addEventListener('error', () => {
			if (this.closing || this.completed || this.failed) {
				return;
			}
			this.phase = `${this.phase}:transport-error`;
			globalThis.clearTimeout(this.transportErrorTimer);
			this.transportErrorTimer = globalThis.setTimeout(() => {
				if (!this.closing && !this.completed && !this.failed) {
					this.fail(new Error(`Mistral ${this.name} stream transport error.`));
				}
			}, 1500);
		});
		this.socket.addEventListener('close', (event) => {
			globalThis.clearTimeout(this.transportErrorTimer);
			if (this.closing || this.completed || this.failed) {
				return;
			}
			const reason = typeof event.reason === 'string' ? event.reason : '';
			this.fail(new Error(
				`Mistral ${this.name} stream closed with code ${event.code}${reason ? `: ${reason}` : ''}.`
			));
		});
		return this.ready.promise;
	}

	async processMessage(data) {
		const text = await dataToText(data);
		let event;
		try {
			event = JSON.parse(text);
		} catch (error) {
			throw new Error('Mistral returned invalid realtime JSON.');
		}
		if (!event || typeof event.type !== 'string') {
			throw new Error('Mistral returned an invalid realtime event.');
		}

		if (event.type === 'session.created') {
			this.phase = 'session-created';
			this.sendJson({
				type: 'session.update',
				session: {
					audio_format: {
						encoding: AUDIO_ENCODING,
						sample_rate: this.sampleRate
					},
					target_streaming_delay_ms: this.delay
				}
			});
			this.phase = 'session-update-sent';
			return;
		}
		if (event.type === 'session.updated') {
			this.phase = 'ready';
			if (!this.sessionUpdated) {
				this.sessionUpdated = true;
				globalThis.clearTimeout(this.readyTimer);
				this.ready.resolve();
			}
			return;
		}
		if (event.type === 'transcription.text.delta') {
			this.phase = 'transcribing';
			if (typeof event.text === 'string' && event.text !== '') {
				this.onDelta(event.text);
			}
			return;
		}
		if (event.type === 'transcription.done') {
			this.phase = 'done';
			const finalText = typeof event.text === 'string' ? event.text : '';
			this.completed = true;
			this.onFinal(finalText);
			this.done.resolve(finalText);
			return;
		}
		if (event.type === 'error') {
			throw new Error(`Mistral realtime error: ${getErrorMessage(event.error)}`);
		}
	}

	sendJson(payload) {
		this.sendJsonString(JSON.stringify(payload));
	}

	sendAudio(message) {
		if (!this.sessionUpdated || this.ending || this.completed || this.failed) {
			throw new Error(`Mistral ${this.name} stream cannot accept audio.`);
		}
		this.sendJsonString(message);
	}

	sendJsonString(message) {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error(`Mistral ${this.name} WebSocket is not open.`);
		}
		this.socket.send(message);
	}

	endAudio() {
		if (this.ending || this.completed || this.failed) {
			return;
		}
		this.ending = true;
		this.phase = 'ending';
		this.sendJson({ type: 'input_audio.flush' });
		this.sendJson({ type: 'input_audio.end' });
	}

	waitDone() {
		return withTimeout(
			this.done.promise,
			this.finalizationTimeoutMs,
			`Mistral ${this.name} stream did not finish in time.`
		);
	}

	fail(error) {
		if (this.failed || this.completed) {
			return;
		}
		this.failed = true;
		globalThis.clearTimeout(this.readyTimer);
		globalThis.clearTimeout(this.transportErrorTimer);
		this.ready.reject(error);
		this.done.reject(error);
		try {
			this.onFatal(error, this.name);
		} finally {
			this.close();
		}
	}

	close() {
		this.closing = true;
		globalThis.clearTimeout(this.readyTimer);
		globalThis.clearTimeout(this.transportErrorTimer);
		if (!this.socket) {
			return;
		}
		if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
			try {
				this.socket.close(1000, 'done');
			} catch (error) {
			}
		}
	}

	get bufferedAmount() {
		return Number(this.socket?.bufferedAmount || 0);
	}
}

class AudioQueue {
	constructor(streams, options) {
		this.streams = streams;
		this.onFatal = options.onFatal;
		this.maxQueueBytes = options.maxQueueBytes;
		this.highWaterBytes = options.highWaterBytes;
		this.items = [];
		this.bytes = 0;
		this.accepting = true;
		this.timer = 0;
		this.failed = false;
	}

	enqueue(buffer) {
		if (!this.accepting || this.failed) {
			return;
		}
		const message = JSON.stringify({
			type: 'input_audio.append',
			audio: arrayBufferToBase64(buffer)
		});
		if (this.bytes + message.length > this.maxQueueBytes) {
			this.failed = true;
			this.onFatal(new Error('Mistral audio queue overflow.'));
			return;
		}
		this.items.push(message);
		this.bytes += message.length;
		this.pump();
	}

	pump() {
		globalThis.clearTimeout(this.timer);
		this.timer = 0;
		if (this.failed) {
			return;
		}
		try {
			while (this.items.length && this.streams.every((stream) => {
				return stream.sessionUpdated
					&& !stream.ending
					&& !stream.failed
					&& stream.bufferedAmount < this.highWaterBytes;
			})) {
				const message = this.items.shift();
				this.bytes -= message.length;
				this.streams.forEach((stream) => stream.sendAudio(message));
			}
		} catch (error) {
			this.failed = true;
			this.onFatal(error);
			return;
		}
		if (this.items.length) {
			this.timer = globalThis.setTimeout(() => this.pump(), 8);
		}
	}

	stop() {
		this.accepting = false;
		this.pump();
	}

	drain() {
		this.stop();
		return new Promise((resolve, reject) => {
			const started = now();
			const check = () => {
				if (this.failed) {
					reject(new Error('Mistral audio queue failed.'));
					return;
				}
				this.pump();
				const drained = this.items.length === 0
					&& this.streams.every((stream) => stream.bufferedAmount < 1024);
				if (drained) {
					resolve();
					return;
				}
				if (now() - started > 8000) {
					reject(new Error('Mistral audio queue drain timed out.'));
					return;
				}
				globalThis.setTimeout(check, 12);
			};
			check();
		});
	}

	close() {
		this.accepting = false;
		globalThis.clearTimeout(this.timer);
		this.items = [];
		this.bytes = 0;
	}
}

export class MistralRealtimeSpeechToTextProvider {
	constructor(options = {}) {
		this.options = {
			session: null,
			onPartial() {},
			onFinal() {},
			onStart() {},
			onEnd() {},
			onError() {},
			onLevel() {},
			...options
		};
		this.session = this.options.session;
		this.mediaStream = null;
		this.capture = null;
		this.queue = null;
		this.fastStream = null;
		this.slowStream = null;
		this.transcript = null;
		this.readyPromise = null;
		this.recording = false;
		this.starting = false;
		this.stopping = false;
		this.finished = false;
		this.destroyed = false;
		this.finalizing = null;
		this.lastText = '';
	}

	async start() {
		if (this.starting || this.recording) {
			return;
		}
		if (!this.isSupportedSession(this.session)) {
			throw new Error('Unsupported Mistral realtime speech-to-text session.');
		}
		this.assertBrowserSupport();
		this.resetState();
		this.starting = true;

		try {
			this.mediaStream = this.options.mediaStream;
			if (!this.mediaStream) {
				throw new Error('A microphone stream is required.');
			}
			if (this.finished || this.destroyed) {
				this.stopTracks(this.mediaStream);
				return;
			}
			this.mediaStream.getAudioTracks?.().forEach((track) => {
				track.addEventListener?.('ended', () => {
					if (!this.stopping && !this.finished && !this.destroyed) {
						void this.fail(new Error('The microphone was disconnected.'));
					}
				}, { once: true });
			});

			const sessionOptions = this.session.options || {};
			this.capture = new Pcm16AudioCapture({
				chunkDurationMs: Number(sessionOptions.chunkDurationMs || AUDIO_CHUNK_MS),
				supportedSampleRates: sessionOptions.supportedSampleRates || SUPPORTED_SAMPLE_RATES,
				onChunk: (buffer) => this.queue?.enqueue(buffer),
				onLevel: (rms, peak) => this.options.onLevel(rms, peak)
			});
			await this.capture.start(this.mediaStream);
			if (this.finished || this.destroyed) {
				return;
			}

			this.transcript = new TranscriptState(sessionOptions.vocabulary || [], (text) => {
				this.lastText = text;
				if (text) {
					this.options.onPartial(text);
				}
			});
			const tokens = sessionOptions.clientTokens;
			const common = {
				endpoint: this.session.endpoint,
				model: this.session.model,
				sampleRate: this.capture.sampleRate,
				sessionTimeoutMs: Number(sessionOptions.sessionTimeoutMs || SESSION_TIMEOUT_MS),
				finalizationTimeoutMs: Number(sessionOptions.finalizationTimeoutMs || FINAL_TIMEOUT_MS),
				onFatal: (error) => void this.fail(error)
			};
			this.fastStream = new RealtimeStream({
				...common,
				name: 'fast',
				token: tokens.fast.value,
				delay: Number(sessionOptions.fastStreamingDelayMs || 240),
				onDelta: (text) => this.transcript.fastDelta(text),
				onFinal: (text) => this.transcript.fastFinal(text)
			});
			this.slowStream = new RealtimeStream({
				...common,
				name: 'slow',
				token: tokens.slow.value,
				delay: Number(sessionOptions.slowStreamingDelayMs || 2400),
				onDelta: (text) => this.transcript.slowDelta(text),
				onFinal: (text) => this.transcript.slowFinalText(text)
			});
			this.queue = new AudioQueue([this.fastStream, this.slowStream], {
				onFatal: (error) => void this.fail(error),
				maxQueueBytes: Number(sessionOptions.maxQueueBytes || MAX_QUEUE_BYTES),
				highWaterBytes: Number(sessionOptions.webSocketHighWaterBytes || WS_HIGH_WATER_BYTES)
			});
			this.readyPromise = Promise.all([
				this.fastStream.connect(),
				this.slowStream.connect()
			]);
			await this.readyPromise;
			if (this.finished || this.destroyed) {
				return;
			}
			this.starting = false;
			this.recording = true;
			this.options.onStart();
		} catch (error) {
			this.starting = false;
			if (this.finished || this.destroyed) {
				return;
			}
			await this.cleanupRuntime();
			throw error;
		}
	}

	stop() {
		if (this.stopping || this.finished || this.destroyed) {
			return;
		}
		this.stopping = true;
		this.recording = false;
		this.finalizing = this.finishRecording();
	}

	destroy() {
		if (this.destroyed) {
			return;
		}
		this.destroyed = true;
		this.finished = true;
		this.recording = false;
		this.starting = false;
		this.stopping = false;
		void this.cleanupRuntime();
	}

	async finishRecording() {
		try {
			await this.capture?.stop();
			this.stopTracks(this.mediaStream);
			if (this.readyPromise) {
				await this.readyPromise;
			}
			await this.queue?.drain();
			this.fastStream?.endAudio();
			this.slowStream?.endAudio();
			await Promise.all([
				this.fastStream?.waitDone() || Promise.resolve(''),
				this.slowStream?.waitDone() || Promise.resolve('')
			]);
			const text = this.transcript?.getText().trim() || '';
			if (text) {
				this.options.onFinal(text);
			}
			await this.finalize(text, null);
		} catch (error) {
			await this.fail(error);
		}
	}

	async fail(error) {
		if (this.finished || this.destroyed) {
			return;
		}
		this.options.onError(error);
		await this.finalize(this.transcript?.getText().trim() || '', error);
	}

	async finalize(text, error) {
		if (this.finished || this.destroyed) {
			return;
		}
		this.finished = true;
		this.starting = false;
		this.recording = false;
		this.stopping = false;
		await this.cleanupRuntime();
		this.options.onEnd({ text, error });
	}

	async cleanupRuntime() {
		this.queue?.close();
		this.fastStream?.close();
		this.slowStream?.close();
		this.stopTracks(this.mediaStream);
		if (this.capture) {
			this.capture.destroy();
		}
		this.options.onLevel(0, 0);
		this.mediaStream = null;
		this.capture = null;
		this.queue = null;
		this.fastStream = null;
		this.slowStream = null;
		this.readyPromise = null;
	}

	stopTracks(stream) {
		stream?.getTracks().forEach((track) => track.stop());
	}

	assertBrowserSupport() {
		if (!this.options.mediaStream) {
			throw new Error('A microphone stream is required.');
		}
		if (!globalThis.WebSocket) {
			throw new Error('WebSocket is not available.');
		}
		if (!(globalThis.AudioContext || globalThis.webkitAudioContext) || !globalThis.AudioWorkletNode) {
			throw new Error('AudioWorklet is not available.');
		}
	}

	resetState() {
		this.mediaStream = null;
		this.capture = null;
		this.queue = null;
		this.fastStream = null;
		this.slowStream = null;
		this.transcript = null;
		this.readyPromise = null;
		this.recording = false;
		this.starting = false;
		this.stopping = false;
		this.finished = false;
		this.destroyed = false;
		this.finalizing = null;
		this.lastText = '';
	}

	isSupportedSession(session) {
		const tokens = session?.options?.clientTokens;
		const fastToken = String(tokens?.fast?.value || '');
		const slowToken = String(tokens?.slow?.value || '');
		return session?.provider === 'mistral'
			&& session?.transport === 'websocket'
			&& Boolean(session.endpoint)
			&& Boolean(session.model)
			&& session.audioEncoding === AUDIO_ENCODING
			&& fastToken.startsWith('rt_')
			&& slowToken.startsWith('rt_')
			&& fastToken !== slowToken;
	}
}

import { Pcm16AudioCapture, pcm16ToBase64 } from './Pcm16AudioCapture.js';
import {
	getRealtimeErrorMessage,
	RealtimeSpeechToTextSocket
} from './RealtimeSpeechToTextSocket.js';

export class MistralRealtimeSpeechToTextProvider {
	constructor(options = {}) {
		this.options = {
			session: null,
			autoStop: false,
			speechThreshold: 0.004,
			minimumSpeechMs: 180,
			onPartial() {},
			onFinal() {},
			onStart() {},
			onEnd() {},
			onError() {},
			...options
		};
		this.session = this.options.session;
		this.connection = null;
		this.capture = null;
		this.transcript = '';
		this.recording = false;
		this.stopping = false;
		this.finished = false;
		this.sessionConfigured = false;
		this.startedSpeaking = false;
		this.speechCandidateAt = 0;
		this.lastSpeechAt = 0;
		this.noSpeechTimer = null;
		this.finalizationTimer = null;
	}

	async start() {
		if (this.recording || this.connection) {
			return;
		}
		if (!this.isSupportedSession(this.session)) {
			throw new Error('Unsupported Mistral realtime speech-to-text session.');
		}

		this.resetState();
		this.connection = new RealtimeSpeechToTextSocket({
			providerName: 'Mistral realtime speech-to-text',
			endpoint: this.session.endpoint,
			protocols: ['realtime', this.session.clientToken],
			handshakeTimeoutMs: Number(this.session.options?.handshakeTimeoutMs || 10000),
			onMessage: (message) => this.handleMessage(message),
			onError: (error) => this.fail(error),
			onClose: (event) => this.handleClose(event)
		});

		try {
			await this.connection.open();
		} catch (error) {
			this.cleanupAfterStartFailure();
			throw error;
		}
	}

	stop() {
		if (this.stopping || this.finished) {
			return;
		}

		this.stopping = true;
		this.stopCapture();
		if (this.connection?.isOpen()) {
			this.connection.send({ type: 'input_audio.flush' });
			this.connection.send({ type: 'input_audio.end' });
			this.startFinalizationTimer();
			return;
		}

		this.finish();
	}

	destroy() {
		this.finished = true;
		this.stopCapture();
		this.connection?.cancel();
		this.connection = null;
		this.clearTimers();
		this.stopping = false;
	}

	async handleMessage(message) {
		if (message.type === 'session.created') {
			if (this.sessionConfigured) {
				return;
			}

			this.sessionConfigured = true;
			const session = {
				audio_format: {
					encoding: this.session.audioEncoding,
					sample_rate: this.session.sampleRate
				},
				target_streaming_delay_ms: Number(
					this.session.options?.targetStreamingDelayMs || 480
				)
			};
			this.connection.send({
				type: 'session.update',
				session
			});
			await this.startCapture();
			this.connection.markReady();
			return;
		}

		if (message.type === 'transcription.text.delta') {
			const delta = String(message.text || message.delta || '');
			if (delta) {
				this.transcript += delta;
				this.options.onPartial(this.transcript);
			}
			return;
		}

		if (message.type === 'transcription.done') {
			const text = String(message.text || this.transcript || '').trim();
			this.transcript = text;
			if (text) {
				this.options.onFinal(text);
			}
			this.finish();
			return;
		}

		if (message.type === 'error') {
			this.fail(new Error(getRealtimeErrorMessage(
				message,
				'Mistral realtime transcription failed.'
			)));
		}
	}

	async startCapture() {
		const chunkDurationMs = Number(this.session.options?.chunkDurationMs || 480);
		this.capture = new Pcm16AudioCapture({
			sampleRate: Number(this.session.sampleRate),
			chunkDurationMs,
			onChunk: (chunk) => this.sendAudio(chunk),
			onLevel: (level, timestamp) => this.handleLevel(level, timestamp)
		});
		await this.capture.start();
		this.recording = true;
		this.startNoSpeechTimer();
		this.options.onStart();
	}

	sendAudio(chunk) {
		if (!chunk.length || !this.connection?.isOpen()) {
			return;
		}
		this.connection.send({
			type: 'input_audio.append',
			audio: pcm16ToBase64(chunk)
		});
	}

	handleLevel(level, timestamp) {
		if (!this.options.autoStop || this.stopping || this.finished) {
			return;
		}

		const threshold = Number(this.options.speechThreshold);
		if (level >= threshold) {
			if (!this.speechCandidateAt) {
				this.speechCandidateAt = timestamp;
			}
			if (timestamp - this.speechCandidateAt >= Number(this.options.minimumSpeechMs)) {
				this.startedSpeaking = true;
				this.lastSpeechAt = timestamp;
				clearTimeout(this.noSpeechTimer);
				this.noSpeechTimer = null;
			}
			return;
		}

		this.speechCandidateAt = 0;
		if (!this.startedSpeaking || !this.lastSpeechAt) {
			return;
		}
		const silenceDuration = Number(this.session.options?.silenceDurationMs || 1200);
		if (timestamp - this.lastSpeechAt >= silenceDuration) {
			this.stop();
		}
	}

	startNoSpeechTimer() {
		if (!this.options.autoStop) {
			return;
		}
		const timeout = Number(this.session.options?.noSpeechTimeoutMs || 10000);
		if (timeout > 0) {
			this.noSpeechTimer = setTimeout(() => this.stop(), timeout);
		}
	}

	startFinalizationTimer() {
		clearTimeout(this.finalizationTimer);
		this.finalizationTimer = setTimeout(() => {
			if (this.transcript) {
				this.options.onFinal(this.transcript.trim());
			}
			this.finish();
		}, Number(this.session.options?.finalizationTimeoutMs || 10000));
	}

	stopCapture() {
		this.recording = false;
		this.capture?.stop(true);
		this.capture = null;
		clearTimeout(this.noSpeechTimer);
		this.noSpeechTimer = null;
	}

	handleClose(event) {
		if (this.finished) {
			return;
		}
		if (this.stopping) {
			this.finish();
			return;
		}

		const code = Number(event?.code || 0);
		const reason = String(event?.reason || '').trim();
		const suffix = [code > 0 ? `code ${code}` : '', reason].filter(Boolean).join(': ');
		this.fail(new Error(
			`Mistral realtime speech-to-text connection closed unexpectedly${suffix ? ` (${suffix})` : ''}.`
		));
	}

	fail(error) {
		if (this.finished) {
			return;
		}
		this.options.onError(error);
		this.finish();
	}

	finish() {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.stopCapture();
		this.connection?.close();
		this.connection = null;
		this.clearTimers();
		this.stopping = false;
		this.options.onEnd({ text: this.transcript.trim() });
	}

	cleanupAfterStartFailure() {
		this.stopCapture();
		this.connection?.cancel();
		this.connection = null;
		this.clearTimers();
		this.stopping = false;
	}

	resetState() {
		this.transcript = '';
		this.recording = false;
		this.stopping = false;
		this.finished = false;
		this.sessionConfigured = false;
		this.startedSpeaking = false;
		this.speechCandidateAt = 0;
		this.lastSpeechAt = 0;
		this.clearTimers();
	}

	clearTimers() {
		clearTimeout(this.noSpeechTimer);
		clearTimeout(this.finalizationTimer);
		this.noSpeechTimer = null;
		this.finalizationTimer = null;
	}

	isSupportedSession(session) {
		return session?.provider === 'mistral'
			&& session?.transport === 'websocket'
			&& Boolean(session.endpoint)
			&& Boolean(session.clientToken)
			&& session.audioEncoding === 'pcm_s16le'
			&& Number(session.sampleRate) > 0;
	}
}

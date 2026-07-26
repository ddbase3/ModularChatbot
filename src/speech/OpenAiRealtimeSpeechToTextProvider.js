import { Pcm16AudioCapture, pcm16ToBase64 } from './Pcm16AudioCapture.js';
import {
	getRealtimeErrorMessage,
	RealtimeSpeechToTextSocket
} from './RealtimeSpeechToTextSocket.js';

export class OpenAiRealtimeSpeechToTextProvider {
	constructor(options = {}) {
		this.options = {
			session: null,
			autoStop: false,
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
		this.committedText = '';
		this.partialText = '';
		this.recording = false;
		this.stopping = false;
		this.finished = false;
		this.finalizationTimer = null;
		this.hasUncommittedAudio = false;
	}

	async start() {
		if (this.recording || this.connection) {
			return;
		}
		if (!this.isSupportedSession(this.session)) {
			throw new Error('Unsupported OpenAI realtime speech-to-text session.');
		}

		this.resetState();
		this.connection = new RealtimeSpeechToTextSocket({
			providerName: 'OpenAI realtime speech-to-text',
			endpoint: this.session.endpoint,
			protocols: [
				'realtime',
				`openai-insecure-api-key.${this.session.clientToken}`
			],
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
		this.stopCapture(true);
		if (this.connection?.isOpen() && this.hasUncommittedAudio) {
			this.connection.send({ type: 'input_audio_buffer.commit' });
			this.startFinalizationTimer();
			return;
		}
		this.finishWithCurrentText();
	}

	destroy() {
		this.finished = true;
		this.stopCapture();
		this.connection?.cancel();
		this.connection = null;
		clearTimeout(this.finalizationTimer);
		this.finalizationTimer = null;
		this.stopping = false;
	}

	async handleMessage(message) {
		if (message.type === 'session.created') {
			if (this.recording || this.finished) {
				return;
			}

			await this.startCapture();
			this.connection.markReady();
			return;
		}

		if (message.type === 'input_audio_buffer.committed') {
			this.hasUncommittedAudio = false;
			return;
		}

		if (message.type === 'conversation.item.input_audio_transcription.delta') {
			this.partialText += String(message.delta || '');
			this.options.onPartial(this.joinText(this.committedText, this.partialText));
			return;
		}

		if (message.type === 'conversation.item.input_audio_transcription.completed') {
			const segment = String(message.transcript || this.partialText || '').trim();
			this.partialText = '';
			this.committedText = this.joinText(this.committedText, segment);
			if (this.options.autoStop || this.stopping) {
				this.finishWithCurrentText();
			} else if (this.committedText) {
				this.options.onPartial(this.committedText);
			}
			return;
		}

		if (message.type === 'input_audio_buffer.speech_stopped' && this.options.autoStop) {
			this.stopping = true;
			this.stopCapture(false);
			this.startFinalizationTimer();
			return;
		}

		if (message.type === 'error' || message.type === 'conversation.item.input_audio_transcription.failed') {
			this.fail(new Error(getRealtimeErrorMessage(
				message,
				'OpenAI realtime transcription failed.'
			)));
		}
	}

	async startCapture() {
		this.capture = new Pcm16AudioCapture({
			sampleRate: Number(this.session.sampleRate),
			chunkDurationMs: Number(this.session.options?.chunkDurationMs || 100),
			onChunk: (chunk) => this.sendAudio(chunk)
		});
		await this.capture.start();
		this.recording = true;
		this.options.onStart();
	}

	sendAudio(chunk) {
		if (!chunk.length || !this.connection?.isOpen()) {
			return;
		}
		this.hasUncommittedAudio = true;
		this.connection.send({
			type: 'input_audio_buffer.append',
			audio: pcm16ToBase64(chunk)
		});
	}

	stopCapture(flush = true) {
		this.recording = false;
		this.capture?.stop(flush);
		this.capture = null;
	}

	startFinalizationTimer() {
		clearTimeout(this.finalizationTimer);
		this.finalizationTimer = setTimeout(
			() => this.finishWithCurrentText(),
			Number(this.session.options?.finalizationTimeoutMs || 10000)
		);
	}

	finishWithCurrentText() {
		const text = this.joinText(this.committedText, this.partialText).trim();
		if (text) {
			this.options.onFinal(text);
		}
		this.finish();
	}

	handleClose(event) {
		if (this.finished) {
			return;
		}
		if (this.stopping) {
			this.finishWithCurrentText();
			return;
		}

		const code = Number(event?.code || 0);
		const reason = String(event?.reason || '').trim();
		const suffix = [code > 0 ? `code ${code}` : '', reason].filter(Boolean).join(': ');
		this.fail(new Error(
			`OpenAI realtime speech-to-text connection closed unexpectedly${suffix ? ` (${suffix})` : ''}.`
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
		clearTimeout(this.finalizationTimer);
		this.finalizationTimer = null;
		this.stopping = false;
		this.options.onEnd({ text: this.joinText(this.committedText, this.partialText).trim() });
	}

	cleanupAfterStartFailure() {
		this.stopCapture();
		this.connection?.cancel();
		this.connection = null;
		clearTimeout(this.finalizationTimer);
		this.finalizationTimer = null;
		this.stopping = false;
	}

	resetState() {
		this.committedText = '';
		this.partialText = '';
		this.recording = false;
		this.stopping = false;
		this.finished = false;
		this.hasUncommittedAudio = false;
		clearTimeout(this.finalizationTimer);
		this.finalizationTimer = null;
	}

	joinText(left, right) {
		return [String(left || '').trim(), String(right || '').trim()].filter(Boolean).join(' ');
	}

	isSupportedSession(session) {
		return session?.provider === 'openai'
			&& session?.transport === 'websocket'
			&& Boolean(session.endpoint)
			&& Boolean(session.clientToken)
			&& session.audioEncoding === 'pcm_s16le'
			&& Number(session.sampleRate) === 24000;
	}
}

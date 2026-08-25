import { TranscriptModel } from './TranscriptModel.js';

const SDP_TIMEOUT_MS = 20000;
const DATA_CHANNEL_TIMEOUT_MS = 12000;
const STOP_DEADLINE_MS = 10000;
const COMMIT_DRAIN_MS = 180;
const TRANSCRIPT_QUIET_MS = 300;
const LOCAL_VOICE_RMS = 0.012;

class VoiceInputError extends Error {
	constructor(message, code = 'voice_input_error') {
		super(message);
		this.name = 'VoiceInputError';
		this.code = code;
	}
}

function now() {
	return globalThis.performance?.now?.() ?? Date.now();
}

function requestFrame(callback) {
	const request = globalThis.requestAnimationFrame || globalThis.window?.requestAnimationFrame;
	return request ? request(callback) : globalThis.setTimeout(callback, 16);
}

function cancelFrame(frame) {
	const cancel = globalThis.cancelAnimationFrame || globalThis.window?.cancelAnimationFrame;
	if (cancel) {
		cancel(frame);
		return;
	}
	globalThis.clearTimeout(frame);
}

async function fetchWithTimeout(url, options, timeoutMs, timeoutMessage, parentSignal) {
	const controller = new AbortController();
	let timedOut = false;
	const forwardAbort = () => controller.abort(parentSignal?.reason);

	if (parentSignal?.aborted) {
		forwardAbort();
	} else {
		parentSignal?.addEventListener('abort', forwardAbort, { once: true });
	}

	const timeout = globalThis.setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		return await fetch(url, {
			...options,
			signal: controller.signal
		});
	} catch (error) {
		if (timedOut) {
			throw new VoiceInputError(timeoutMessage, 'timeout');
		}
		throw error;
	} finally {
		globalThis.clearTimeout(timeout);
		parentSignal?.removeEventListener('abort', forwardAbort);
	}
}

function waitForDataChannelOpen(dataChannel, timeoutMs, signal) {
	if (signal?.aborted) {
		return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
	}
	if (dataChannel.readyState === 'open') {
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		const cleanup = () => {
			globalThis.clearTimeout(timeout);
			dataChannel.removeEventListener('open', handleOpen);
			dataChannel.removeEventListener('close', handleClose);
			dataChannel.removeEventListener('error', handleError);
			signal?.removeEventListener('abort', handleAbort);
		};
		const handleOpen = () => {
			cleanup();
			resolve();
		};
		const handleClose = () => {
			cleanup();
			reject(new VoiceInputError('The OpenAI realtime connection closed before it was ready.', 'data_channel_closed'));
		};
		const handleError = () => {
			cleanup();
			reject(new VoiceInputError('The OpenAI realtime data channel could not be opened.', 'data_channel_error'));
		};
		const handleAbort = () => {
			cleanup();
			reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		const timeout = globalThis.setTimeout(() => {
			cleanup();
			reject(new VoiceInputError('The OpenAI realtime data channel did not open in time.', 'data_channel_timeout'));
		}, timeoutMs);

		dataChannel.addEventListener('open', handleOpen, { once: true });
		dataChannel.addEventListener('close', handleClose, { once: true });
		dataChannel.addEventListener('error', handleError, { once: true });
		signal?.addEventListener('abort', handleAbort, { once: true });
	});
}

async function readErrorMessage(response, defaultMessage) {
	const responseText = await response.text();
	if (responseText === '') {
		return defaultMessage;
	}
	try {
		const data = JSON.parse(responseText);
		const message = data?.error?.message;
		if (typeof message === 'string' && message.trim() !== '') {
			return message.trim();
		}
	} catch (error) {
		const normalized = responseText.replace(/\s+/gu, ' ').trim();
		if (normalized !== '') {
			return normalized.slice(0, 500);
		}
	}
	return defaultMessage;
}

export class OpenAiRealtimeSpeechToTextProvider {
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
		this.model = null;
		this.peerConnection = null;
		this.dataChannel = null;
		this.captureStream = null;
		this.rtcTrack = null;
		this.audioContext = null;
		this.audioSource = null;
		this.analyser = null;
		this.meterFrame = null;
		this.startController = null;
		this.stopCheckTimer = null;
		this.stopDeadlineTimer = null;
		this.commitTimer = null;
		this.stopRequested = false;
		this.stopRequestedAt = 0;
		this.lastTranscriptEventAt = 0;
		this.localVoiceDetected = false;
		this.starting = false;
		this.recording = false;
		this.finished = false;
		this.closing = false;
		this.lastRenderedText = '';
	}

	async start() {
		if (this.starting || this.recording) {
			return;
		}
		if (!this.isSupportedSession(this.session)) {
			throw new Error('Unsupported OpenAI realtime speech-to-text session.');
		}
		this.assertBrowserSupport();
		this.resetState();
		this.starting = true;
		this.startController = new AbortController();

		try {
			const stream = this.options.mediaStream;
			if (!stream) {
				throw new VoiceInputError('A microphone stream is required.', 'missing_media_stream');
			}
			if (this.finished) {
				this.stopStream(stream);
				return;
			}

			this.captureStream = stream;
			const sourceTrack = stream.getAudioTracks?.()[0];
			if (!sourceTrack) {
				throw new VoiceInputError('The browser did not provide a usable microphone track.', 'missing_audio_track');
			}
			sourceTrack.addEventListener?.('ended', () => {
				if (!this.closing && !this.finished) {
					this.fail(new VoiceInputError('The microphone was disconnected.', 'microphone_ended'));
				}
			}, { once: true });

			await this.startMeter(stream);
			if (this.finished) {
				return;
			}

			this.rtcTrack = sourceTrack;
			if ('contentHint' in this.rtcTrack) {
				this.rtcTrack.contentHint = 'speech';
			}

			this.peerConnection = new RTCPeerConnection();
			this.bindPeerConnection(this.peerConnection);
			this.peerConnection.addTrack(this.rtcTrack, stream);
			this.dataChannel = this.peerConnection.createDataChannel('oai-events', { ordered: true });
			this.bindDataChannel(this.dataChannel);

			const localSdp = await this.createLocalOffer(this.peerConnection);
			const sdpResponse = await fetchWithTimeout(
				this.session.endpoint,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${this.session.clientToken}`,
						'Content-Type': 'application/sdp'
					},
					body: localSdp,
					cache: 'no-store',
					referrerPolicy: 'no-referrer'
				},
				Number(this.session.options?.sdpTimeoutMs || SDP_TIMEOUT_MS),
				'OpenAI did not confirm the WebRTC connection in time.',
				this.startController.signal
			);
			if (!sdpResponse.ok) {
				throw new VoiceInputError(
					await readErrorMessage(sdpResponse, 'OpenAI rejected the WebRTC connection.'),
					'openai_sdp_error'
				);
			}
			const answerSdp = await sdpResponse.text();
			if (!answerSdp.startsWith('v=0')) {
				throw new VoiceInputError('OpenAI returned an invalid WebRTC answer.', 'invalid_sdp_answer');
			}
			await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
			await waitForDataChannelOpen(
				this.dataChannel,
				Number(this.session.options?.dataChannelTimeoutMs || DATA_CHANNEL_TIMEOUT_MS),
				this.startController.signal
			);
			if (this.finished) {
				return;
			}

			this.starting = false;
			this.recording = true;
			this.options.onStart();
		} catch (error) {
			this.starting = false;
			if (this.finished && (error?.name === 'AbortError' || this.startController?.signal.aborted)) {
				return;
			}
			this.cleanupRuntime();
			throw error;
		}
	}

	stop() {
		if (this.stopRequested || this.finished) {
			return;
		}
		if (this.starting && this.dataChannel?.readyState !== 'open') {
			this.finishNormally();
			return;
		}
		this.stopRequested = true;
		this.stopRequestedAt = now();
		this.recording = false;
		this.stopMeter();
		this.stopDeadlineTimer = globalThis.setTimeout(
			() => this.finishAfterDeadline(),
			Number(this.session.options?.finalizationTimeoutMs || STOP_DEADLINE_MS)
		);
		this.commitTimer = globalThis.setTimeout(
			() => this.commitCurrentTurn(),
			Number(this.session.options?.commitDrainMs || COMMIT_DRAIN_MS)
		);
	}

	destroy() {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.cleanupRuntime();
	}

	assertBrowserSupport() {
		if (!this.options.mediaStream) {
			throw new Error('A microphone stream is required.');
		}
		if (!globalThis.RTCPeerConnection) {
			throw new Error('WebRTC is not available.');
		}
		if (!(globalThis.AudioContext || globalThis.webkitAudioContext)) {
			throw new Error('AudioContext is not available.');
		}
	}

	async createLocalOffer(peerConnection) {
		const offer = await peerConnection.createOffer();
		await peerConnection.setLocalDescription(offer);
		const localSdp = peerConnection.localDescription?.sdp;
		if (typeof localSdp !== 'string' || localSdp === '') {
			throw new VoiceInputError('The browser could not create a WebRTC offer.', 'missing_local_sdp');
		}
		return localSdp;
	}

	bindPeerConnection(peerConnection) {
		peerConnection.addEventListener?.('connectionstatechange', () => {
			if (this.closing || this.finished) {
				return;
			}
			if (peerConnection.connectionState === 'failed') {
				this.fail(new VoiceInputError('The OpenAI WebRTC connection failed.', 'peer_connection_failed'));
			}
		});
	}

	bindDataChannel(dataChannel) {
		dataChannel.addEventListener('message', (event) => this.handleRealtimeMessage(event.data));
		dataChannel.addEventListener('close', () => {
			if (this.closing || this.finished) {
				return;
			}
			if (this.stopRequested) {
				this.finishNormally();
				return;
			}
			this.fail(new VoiceInputError('The OpenAI realtime connection closed unexpectedly.', 'data_channel_closed'));
		});
		dataChannel.addEventListener('error', () => {
			if (!this.closing && !this.finished) {
				this.fail(new VoiceInputError('The OpenAI realtime data channel failed.', 'data_channel_error'));
			}
		});
	}

	handleRealtimeMessage(rawMessage) {
		if (this.finished || typeof rawMessage !== 'string') {
			return;
		}
		let event;
		try {
			event = JSON.parse(rawMessage);
		} catch (error) {
			this.fail(new VoiceInputError('OpenAI returned an invalid realtime event.', 'invalid_realtime_event'));
			return;
		}
		if (!event || typeof event.type !== 'string') {
			return;
		}

		switch (event.type) {
			case 'input_audio_buffer.committed':
				this.registerOrderedItem(event.item_id, event);
				this.maybeFinishStop();
				break;

			case 'conversation.item.added':
				this.handleConversationItem(event);
				break;

			case 'conversation.item.input_audio_transcription.delta':
				this.handleTranscriptDelta(event);
				break;

			case 'conversation.item.input_audio_transcription.completed':
				this.handleTranscriptCompleted(event);
				break;

			case 'conversation.item.input_audio_transcription.failed':
				this.handleTranscriptFailed(event);
				break;

			case 'error':
				this.fail(new VoiceInputError(
					typeof event.error?.message === 'string'
						? `OpenAI: ${event.error.message}`
						: 'OpenAI reported a realtime error.',
					'openai_realtime_error'
				));
				break;

			default:
				break;
		}
	}

	handleConversationItem(event) {
		const item = event.item;
		if (!item || typeof item.id !== 'string') {
			return;
		}
		if (typeof item.role === 'string' && item.role !== 'user') {
			return;
		}
		this.registerOrderedItem(item.id, event);
	}

	registerOrderedItem(itemId, event) {
		if (!this.model || typeof itemId !== 'string') {
			return;
		}
		const hasPreviousItem = Object.prototype.hasOwnProperty.call(event, 'previous_item_id');
		this.model.registerItem(itemId, hasPreviousItem ? event.previous_item_id : undefined);
		this.renderTranscript();
	}

	handleTranscriptDelta(event) {
		if (!this.model || typeof event.item_id !== 'string' || typeof event.delta !== 'string') {
			return;
		}
		this.model.appendDelta(event.item_id, event.delta);
		this.lastTranscriptEventAt = now();
		this.renderTranscript();
	}

	handleTranscriptCompleted(event) {
		if (!this.model || typeof event.item_id !== 'string') {
			return;
		}
		this.model.completeItem(
			event.item_id,
			typeof event.transcript === 'string' ? event.transcript : ''
		);
		this.lastTranscriptEventAt = now();
		this.renderTranscript();
		if (this.stopRequested) {
			this.maybeFinishStop();
		}
	}

	handleTranscriptFailed(event) {
		if (this.model && typeof event.item_id === 'string') {
			this.model.failItem(event.item_id);
			this.renderTranscript();
		}
		this.fail(new VoiceInputError(
			typeof event.error?.message === 'string'
				? `OpenAI transcription failed: ${event.error.message}`
				: 'OpenAI transcription failed.',
			'transcription_failed'
		));
	}

	commitCurrentTurn() {
		this.commitTimer = null;
		if (!this.stopRequested || this.closing || this.finished) {
			return;
		}
		if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
			this.fail(new VoiceInputError(
				'The OpenAI realtime connection could not commit the final audio.',
				'data_channel_not_open'
			));
			return;
		}
		this.dataChannel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
		if (this.rtcTrack) {
			this.rtcTrack.enabled = false;
		}
		this.scheduleStopCheck(150);
	}

	maybeFinishStop() {
		if (!this.stopRequested || !this.model || this.finished) {
			return;
		}
		const current = now();
		const elapsed = current - this.stopRequestedAt;
		const quietFor = this.lastTranscriptEventAt > 0
			? current - this.lastTranscriptEventAt
			: Number.POSITIVE_INFINITY;
		const serverHasItems = this.model.itemCount > 0;
		const serverIsSettled = !this.model.hasPendingItems;
		const quietMs = Number(this.session.options?.transcriptQuietMs || TRANSCRIPT_QUIET_MS);

		if (serverHasItems && serverIsSettled && quietFor >= quietMs) {
			this.finishNormally();
			return;
		}
		if (!serverHasItems && !this.localVoiceDetected && elapsed >= 1200) {
			this.finishNormally();
			return;
		}
		this.scheduleStopCheck(150);
	}

	scheduleStopCheck(delay) {
		globalThis.clearTimeout(this.stopCheckTimer);
		this.stopCheckTimer = globalThis.setTimeout(() => this.maybeFinishStop(), delay);
	}

	finishNormally() {
		this.finalizeSession(null);
	}

	finishAfterDeadline() {
		if (this.stopRequested) {
			this.finalizeSession(null);
		}
	}

	fail(error) {
		if (this.finished) {
			return;
		}
		this.options.onError(error);
		this.finalizeSession(error);
	}

	finalizeSession(error) {
		if (this.finished) {
			return;
		}
		const text = this.model?.getSpeechText().trim() || '';
		this.finished = true;
		this.starting = false;
		this.recording = false;
		if (text && !error) {
			this.options.onFinal(text);
		}
		this.cleanupRuntime();
		this.options.onEnd({ text, error });
	}

	async startMeter(stream) {
		const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
		this.audioContext = new AudioContextClass();
		this.audioSource = this.audioContext.createMediaStreamSource(stream);
		this.analyser = this.audioContext.createAnalyser();
		this.analyser.fftSize = 512;
		this.analyser.smoothingTimeConstant = 0.65;
		this.audioSource.connect(this.analyser);
		if (this.audioContext.state === 'suspended') {
			await this.audioContext.resume();
		}

		const samples = new Uint8Array(this.analyser.fftSize);
		const updateMeter = () => {
			if (!this.analyser || this.closing || this.stopRequested || this.finished) {
				return;
			}
			this.analyser.getByteTimeDomainData(samples);
			let sum = 0;
			let peak = 0;
			for (const sample of samples) {
				const normalized = (sample - 128) / 128;
				sum += normalized * normalized;
				peak = Math.max(peak, Math.abs(normalized));
			}
			const rms = Math.sqrt(sum / samples.length);
			if (rms >= LOCAL_VOICE_RMS) {
				this.localVoiceDetected = true;
			}
			this.options.onLevel(rms, peak);
			this.meterFrame = requestFrame(updateMeter);
		};
		this.meterFrame = requestFrame(updateMeter);
	}

	stopMeter() {
		if (this.meterFrame !== null) {
			cancelFrame(this.meterFrame);
			this.meterFrame = null;
		}
		try {
			this.audioSource?.disconnect();
		} catch (error) {
		}
		try {
			this.analyser?.disconnect();
		} catch (error) {
		}
		if (this.audioContext && this.audioContext.state !== 'closed') {
			void this.audioContext.close();
		}
		this.audioSource = null;
		this.analyser = null;
		this.audioContext = null;
		this.options.onLevel(0, 0);
	}

	cleanupRuntime() {
		this.closing = true;
		globalThis.clearTimeout(this.stopCheckTimer);
		globalThis.clearTimeout(this.stopDeadlineTimer);
		globalThis.clearTimeout(this.commitTimer);
		this.stopCheckTimer = null;
		this.stopDeadlineTimer = null;
		this.commitTimer = null;
		this.startController?.abort();
		this.startController = null;
		this.stopMeter();
		if (this.dataChannel && this.dataChannel.readyState !== 'closed') {
			this.dataChannel.close();
		}
		if (this.peerConnection && this.peerConnection.connectionState !== 'closed') {
			this.peerConnection.close();
		}
		this.rtcTrack?.stop();
		this.stopStream(this.captureStream);
		this.dataChannel = null;
		this.peerConnection = null;
		this.rtcTrack = null;
		this.captureStream = null;
	}

	stopStream(stream) {
		stream?.getTracks().forEach((track) => track.stop());
	}

	renderTranscript() {
		const text = this.model?.getSpeechText() || '';
		if (text === this.lastRenderedText) {
			return;
		}
		this.lastRenderedText = text;
		if (text) {
			this.options.onPartial(text);
		}
	}

	resetState() {
		this.model = new TranscriptModel('', 0, 0);
		this.stopRequested = false;
		this.stopRequestedAt = 0;
		this.lastTranscriptEventAt = 0;
		this.localVoiceDetected = false;
		this.starting = false;
		this.recording = false;
		this.finished = false;
		this.closing = false;
		this.lastRenderedText = '';
		globalThis.clearTimeout(this.stopCheckTimer);
		globalThis.clearTimeout(this.stopDeadlineTimer);
		globalThis.clearTimeout(this.commitTimer);
		this.stopCheckTimer = null;
		this.stopDeadlineTimer = null;
		this.commitTimer = null;
	}

	isSupportedSession(session) {
		if (session?.provider !== 'openai'
			|| session?.transport !== 'webrtc'
			|| !session.endpoint
			|| !session.clientToken
			|| session.audioEncoding !== 'audio/pcm'
			|| Number(session.sampleRate) !== 24000) {
			return false;
		}
		if (session.expiresAt) {
			const expiresAt = Date.parse(session.expiresAt);
			if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 5000) {
				return false;
			}
		}
		return true;
	}
}

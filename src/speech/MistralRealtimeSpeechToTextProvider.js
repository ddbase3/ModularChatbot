function toBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000;

	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}

	return btoa(binary);
}

function resample(input, sourceRate, targetRate) {
	if (sourceRate === targetRate) {
		return input;
	}

	const ratio = sourceRate / targetRate;
	const length = Math.max(1, Math.round(input.length / ratio));
	const output = new Float32Array(length);

	for (let index = 0; index < length; index += 1) {
		const start = Math.floor(index * ratio);
		const end = Math.min(input.length, Math.floor((index + 1) * ratio));
		let sum = 0;
		let count = 0;

		for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
			sum += input[sourceIndex];
			count += 1;
		}

		output[index] = count > 0 ? sum / count : input[Math.min(start, input.length - 1)] || 0;
	}

	return output;
}

function floatToPcm16(input) {
	const output = new ArrayBuffer(input.length * 2);
	const view = new DataView(output);

	input.forEach((sample, index) => {
		const value = Math.max(-1, Math.min(1, sample));
		view.setInt16(index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
	});

	return output;
}

function calculateRms(input) {
	if (!input.length) {
		return 0;
	}

	let sum = 0;
	input.forEach((sample) => {
		sum += sample * sample;
	});

	return Math.sqrt(sum / input.length);
}

function createWorkletModuleUrl() {
	const source = `
		class Base3PcmCaptureProcessor extends AudioWorkletProcessor {
			process(inputs) {
				const channel = inputs[0] && inputs[0][0];
				if (channel && channel.length) {
					this.port.postMessage(channel.slice(0));
				}
				return true;
			}
		}
		registerProcessor('base3-pcm-capture', Base3PcmCaptureProcessor);
	`;

	return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}

export class MistralRealtimeSpeechToTextProvider {
	constructor(options = {}) {
		this.options = {
			sessionUrl: '',
			language: '',
			speechThreshold: 0.015,
			onPartial() {},
			onFinal() {},
			onStart() {},
			onEnd() {},
			onError() {},
			...options
		};
		this.socket = null;
		this.stream = null;
		this.audioContext = null;
		this.sourceNode = null;
		this.workletNode = null;
		this.silentGain = null;
		this.workletModuleUrl = '';
		this.session = null;
		this.transcript = '';
		this.startedSpeaking = false;
		this.lastSpeechAt = 0;
		this.silenceTimer = null;
		this.noSpeechTimer = null;
		this.recording = false;
		this.stopping = false;
		this.finished = false;
	}

	async start() {
		if (this.recording || this.socket) {
			return;
		}
		if (!this.options.sessionUrl) {
			throw new Error('Realtime speech-to-text session URL is missing.');
		}

		this.transcript = '';
		this.startedSpeaking = false;
		this.lastSpeechAt = 0;
		this.stopping = false;
		this.finished = false;

		try {
			this.session = await this.createSession();
			await this.openSocket();
		} catch (error) {
			this.cleanup();
			throw error;
		}
	}

	stop() {
		if (this.stopping || this.finished) {
			return;
		}

		this.stopping = true;
		this.stopCapture();

		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify({ type: 'input_audio.flush' }));
			this.socket.send(JSON.stringify({ type: 'input_audio.end' }));
			return;
		}

		this.finish();
	}

	destroy() {
		this.finished = true;
		this.stopCapture();
		this.closeSocket();
		this.session = null;
		this.stopping = false;
	}

	async createSession() {
		const response = await fetch(this.options.sessionUrl, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
			},
			body: new URLSearchParams({ language: this.options.language || '' }).toString()
		});
		const payload = await response.json();

		if (!response.ok || payload?.status !== 'ok' || !payload?.data?.session) {
			throw new Error(payload?.message || 'Realtime speech-to-text session could not be created.');
		}

		const session = payload.data.session;
		if (session.provider !== 'mistral' || session.transport !== 'websocket' || !session.endpoint || !session.clientToken) {
			throw new Error('Unsupported realtime speech-to-text session.');
		}
		if (session.audioEncoding !== 'pcm_s16le' || Number(session.sampleRate) <= 0) {
			throw new Error('Unsupported realtime speech-to-text audio format.');
		}

		return session;
	}

	openSocket() {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(this.session.endpoint, ['realtime', this.session.clientToken]);
			this.socket = socket;
			let ready = false;

			socket.onmessage = async (event) => {
				let message;
				try {
					message = JSON.parse(event.data);
				} catch (error) {
					if (ready) {
						this.options.onError(error);
					} else {
						reject(error);
					}
					return;
				}

				if (message.type === 'session.created') {
					socket.send(JSON.stringify({
						type: 'session.update',
						session: {
							audio_format: {
								encoding: this.session.audioEncoding,
								sample_rate: this.session.sampleRate
							},
							target_streaming_delay_ms: this.session.options?.targetStreamingDelayMs
						}
					}));

					try {
						await this.startCapture();
						ready = true;
						resolve();
					} catch (error) {
						reject(error);
					}
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
					const error = new Error(message.error?.message || message.message || 'Realtime transcription failed.');
					if (ready) {
						this.options.onError(error);
						this.finish();
					} else {
						reject(error);
					}
				}
			};

			socket.onerror = () => {
				const error = new Error('Realtime speech-to-text connection failed.');
				if (ready) {
					this.options.onError(error);
					this.finish();
				} else {
					reject(error);
				}
			};

			socket.onclose = () => {
				if (!ready && !this.finished) {
					reject(new Error('Realtime speech-to-text connection closed before initialization.'));
					return;
				}
				if (!this.finished) {
					this.finish();
				}
			};
		});
	}

	async startCapture() {
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			}
		});
		this.audioContext = new AudioContext();
		if (this.audioContext.state === 'suspended') {
			await this.audioContext.resume();
		}
		this.workletModuleUrl = createWorkletModuleUrl();
		await this.audioContext.audioWorklet.addModule(this.workletModuleUrl);
		this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
		this.workletNode = new AudioWorkletNode(this.audioContext, 'base3-pcm-capture');
		this.silentGain = this.audioContext.createGain();
		this.silentGain.gain.value = 0;
		this.workletNode.port.onmessage = (event) => this.handleAudio(event.data);
		this.sourceNode.connect(this.workletNode);
		this.workletNode.connect(this.silentGain);
		this.silentGain.connect(this.audioContext.destination);
		this.recording = true;
		this.startNoSpeechTimer();
		this.options.onStart();
	}

	handleAudio(input) {
		if (!this.recording || this.socket?.readyState !== WebSocket.OPEN || !(input instanceof Float32Array)) {
			return;
		}

		const now = Date.now();
		const rms = calculateRms(input);
		if (rms >= Number(this.options.speechThreshold)) {
			this.startedSpeaking = true;
			this.lastSpeechAt = now;
			clearTimeout(this.noSpeechTimer);
			this.noSpeechTimer = null;
		}

		const targetRate = Number(this.session.sampleRate || 16000);
		const converted = floatToPcm16(resample(input, this.audioContext.sampleRate, targetRate));
		this.socket.send(JSON.stringify({
			type: 'input_audio.append',
			audio: toBase64(converted)
		}));

		if (this.startedSpeaking) {
			clearTimeout(this.silenceTimer);
			const silenceDuration = Number(this.session.options?.silenceDurationMs || 900);
			this.silenceTimer = setTimeout(() => {
				if (Date.now() - this.lastSpeechAt >= silenceDuration) {
					this.stop();
				}
			}, silenceDuration);
		}
	}

	startNoSpeechTimer() {
		clearTimeout(this.noSpeechTimer);
		const timeout = Number(this.session.options?.noSpeechTimeoutMs || 10000);
		if (timeout <= 0) {
			return;
		}
		this.noSpeechTimer = setTimeout(() => this.stop(), timeout);
	}

	stopCapture() {
		clearTimeout(this.silenceTimer);
		clearTimeout(this.noSpeechTimer);
		this.silenceTimer = null;
		this.noSpeechTimer = null;
		this.recording = false;
		if (this.workletNode) {
			this.workletNode.port.onmessage = null;
			this.workletNode.disconnect();
		}
		this.sourceNode?.disconnect();
		this.silentGain?.disconnect();
		this.stream?.getTracks().forEach((track) => track.stop());
		this.audioContext?.close();
		this.workletNode = null;
		this.sourceNode = null;
		this.silentGain = null;
		this.stream = null;
		this.audioContext = null;
		if (this.workletModuleUrl) {
			URL.revokeObjectURL(this.workletModuleUrl);
			this.workletModuleUrl = '';
		}
	}

	closeSocket() {
		if (!this.socket) {
			return;
		}
		this.socket.onopen = null;
		this.socket.onmessage = null;
		this.socket.onerror = null;
		this.socket.onclose = null;
		this.socket.close();
		this.socket = null;
	}

	finish() {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.stopCapture();
		this.closeSocket();
		this.stopping = false;
		this.options.onEnd({ text: this.transcript });
	}

	cleanup() {
		this.finished = true;
		this.stopCapture();
		this.closeSocket();
		this.session = null;
		this.stopping = false;
	}
}

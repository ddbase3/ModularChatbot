import { MistralRealtimeSpeechToTextProvider } from './MistralRealtimeSpeechToTextProvider.js';
import { OpenAiRealtimeSpeechToTextProvider } from './OpenAiRealtimeSpeechToTextProvider.js';

export class BackendRealtimeSpeechToTextProvider {
	constructor(options = {}) {
		this.options = {
			sessionUrl: '',
			language: '',
			context: '',
			onPartial() {},
			onFinal() {},
			onStart() {},
			onEnd() {},
			onError() {},
			onLevel() {},
			...options
		};
		this.provider = null;
		this.mediaStream = null;
		this.sessionController = null;
		this.destroyed = false;
		this.stopRequested = false;
		this.endedBeforeProvider = false;
	}

	async start() {
		if (!this.options.sessionUrl) {
			throw new Error('Realtime speech-to-text session URL is missing.');
		}
		this.destroyed = false;
		this.stopRequested = false;
		this.endedBeforeProvider = false;
		this.sessionController = new AbortController();

		try {
			this.mediaStream = await this.requestMicrophone();
			if (this.destroyed || this.stopRequested) {
				this.stopStream(this.mediaStream);
				this.mediaStream = null;
				return;
			}

			const session = await this.createSession(this.sessionController.signal);
			this.sessionController = null;
			if (this.destroyed || this.stopRequested) {
				this.stopStream(this.mediaStream);
				this.mediaStream = null;
				return;
			}

			const options = {
				...this.options,
				session,
				mediaStream: this.mediaStream
			};
			delete options.sessionUrl;
			delete options.language;
			delete options.context;

			if (session.provider === 'mistral') {
				this.provider = new MistralRealtimeSpeechToTextProvider(options);
			} else if (session.provider === 'openai') {
				this.provider = new OpenAiRealtimeSpeechToTextProvider(options);
			} else {
				throw new Error(`Unsupported realtime speech-to-text provider: ${session.provider || 'unknown'}.`);
			}

			this.mediaStream = null;
			await this.provider.start();
		} catch (error) {
			this.sessionController = null;
			if (!this.provider) {
				this.stopStream(this.mediaStream);
				this.mediaStream = null;
			}
			if (this.destroyed || this.stopRequested || error?.name === 'AbortError') {
				return;
			}
			throw error;
		}
	}

	stop() {
		if (this.provider) {
			this.provider.stop();
			return;
		}
		if (this.destroyed || this.stopRequested) {
			return;
		}
		this.stopRequested = true;
		this.sessionController?.abort();
		this.stopStream(this.mediaStream);
		this.mediaStream = null;
		this.endBeforeProvider();
	}

	destroy() {
		this.destroyed = true;
		this.sessionController?.abort();
		this.sessionController = null;
		this.stopStream(this.mediaStream);
		this.mediaStream = null;
		this.provider?.destroy();
		this.provider = null;
	}

	async requestMicrophone() {
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error('Microphone access is not available.');
		}

		return navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			},
			video: false
		});
	}

	async createSession(signal) {
		const response = await fetch(this.options.sessionUrl, {
			method: 'POST',
			credentials: 'same-origin',
			cache: 'no-store',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
			},
			body: new URLSearchParams({
				language: this.options.language || '',
				context: this.options.context || ''
			}).toString(),
			signal
		});
		const payload = await response.json();

		if (!response.ok || payload?.status !== 'ok' || !payload?.data?.session) {
			throw new Error(payload?.message || 'Realtime speech-to-text session could not be created.');
		}

		return payload.data.session;
	}

	endBeforeProvider() {
		if (this.endedBeforeProvider || this.destroyed) {
			return;
		}
		this.endedBeforeProvider = true;
		this.options.onEnd({ text: '', error: null });
	}

	stopStream(stream) {
		stream?.getTracks?.().forEach((track) => track.stop());
	}
}

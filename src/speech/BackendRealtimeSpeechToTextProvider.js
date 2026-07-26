import { MistralRealtimeSpeechToTextProvider } from './MistralRealtimeSpeechToTextProvider.js';
import { OpenAiRealtimeSpeechToTextProvider } from './OpenAiRealtimeSpeechToTextProvider.js';

export class BackendRealtimeSpeechToTextProvider {
	constructor(options = {}) {
		this.options = {
			sessionUrl: '',
			language: '',
			autoStop: false,
			onPartial() {},
			onFinal() {},
			onStart() {},
			onEnd() {},
			onError() {},
			...options
		};
		this.provider = null;
		this.destroyed = false;
	}

	async start() {
		if (!this.options.sessionUrl) {
			throw new Error('Realtime speech-to-text session URL is missing.');
		}
		this.destroyed = false;
		const session = await this.createSession();
		if (this.destroyed) {
			return;
		}

		const options = {
			...this.options,
			session
		};
		delete options.sessionUrl;
		delete options.language;

		if (session.provider === 'mistral') {
			this.provider = new MistralRealtimeSpeechToTextProvider(options);
		} else if (session.provider === 'openai') {
			this.provider = new OpenAiRealtimeSpeechToTextProvider(options);
		} else {
			throw new Error(`Unsupported realtime speech-to-text provider: ${session.provider || 'unknown'}.`);
		}

		await this.provider.start();
	}

	stop() {
		this.provider?.stop();
	}

	destroy() {
		this.destroyed = true;
		this.provider?.destroy();
		this.provider = null;
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

		return payload.data.session;
	}
}

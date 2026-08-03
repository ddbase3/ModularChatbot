import { StreamingWavAudioPlayer } from './StreamingWavAudioPlayer.js?build=tts-stream-2';

function splitText(text, maxLength = 3900) {
	const value = String(text || '').trim();
	if (!value) {
		return [];
	}
	if (value.length <= maxLength) {
		return [value];
	}

	const chunks = [];
	let remaining = value;
	while (remaining.length > maxLength) {
		const part = remaining.slice(0, maxLength);
		const candidates = [part.lastIndexOf('\n'), part.lastIndexOf('. '), part.lastIndexOf('! '), part.lastIndexOf('? '), part.lastIndexOf(' ')];
		const splitAt = Math.max(...candidates);
		const end = splitAt > Math.floor(maxLength * 0.5) ? splitAt + 1 : maxLength;
		chunks.push(remaining.slice(0, end).trim());
		remaining = remaining.slice(end).trim();
	}
	if (remaining) {
		chunks.push(remaining);
	}

	return chunks;
}

function createAbortError() {
	return new DOMException('Text-to-speech playback was aborted.', 'AbortError');
}

export class BackendTextToSpeechProvider {
	constructor(options = {}) {
		this.options = {
			speechUrl: '',
			maxChunkLength: 3900,
			responseFormat: 'wav',
			...options
		};
		this.controller = null;
		this.playback = null;
		this.audioContext = null;
		this.generation = 0;
	}

	async activate() {
		const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
		if (!AudioContextClass) {
			throw new Error('Streaming audio playback is not supported by this browser.');
		}
		if (!this.audioContext || this.audioContext.state === 'closed') {
			this.audioContext = new AudioContextClass();
		}
		if (this.audioContext.state === 'suspended') {
			await this.audioContext.resume();
		}
	}

	async speak(text, language = '') {
		if (!this.options.speechUrl) {
			throw new Error('Backend text-to-speech configuration is incomplete.');
		}

		this.stop();
		await this.activate();
		const generation = ++this.generation;
		this.controller = new AbortController();
		const chunks = splitText(text, Number(this.options.maxChunkLength) || 3900);

		for (const chunk of chunks) {
			if (generation !== this.generation || this.controller.signal.aborted) {
				throw createAbortError();
			}

			const response = await this.requestAudioStream(chunk, language, this.controller.signal);
			const playback = new StreamingWavAudioPlayer(response, this.controller.signal, this.audioContext);
			this.playback = playback;
			await playback.play();
			if (this.playback === playback) {
				this.playback = null;
			}
		}

		if (generation === this.generation) {
			this.controller = null;
		}
	}

	stop() {
		this.generation += 1;
		this.controller?.abort();
		this.controller = null;
		this.playback?.stop();
		this.playback = null;
	}

	destroy() {
		this.stop();
		this.audioContext?.close();
		this.audioContext = null;
	}

	async requestAudioStream(text, language, signal) {
		const response = await fetch(this.options.speechUrl, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				Accept: 'audio/wav, application/json',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				text,
				language,
				options: {
					responseFormat: this.options.responseFormat
				}
			}),
			signal
		});

		const contentType = String(response.headers.get('content-type') || '').toLowerCase();
		if (!response.ok || contentType.includes('application/json')) {
			let message = 'Text-to-speech request failed.';
			try {
				const payload = await response.json();
				message = payload?.message || message;
			} catch (error) {
			}
			throw new Error(message);
		}

		return response;
	}
}

export { splitText };

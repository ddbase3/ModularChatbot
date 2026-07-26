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
			...options
		};
		this.controller = null;
		this.audio = null;
		this.objectUrl = '';
		this.generation = 0;
	}

	async speak(text, language = '') {
		if (!this.options.speechUrl) {
			throw new Error('Backend text-to-speech configuration is incomplete.');
		}

		this.stop();
		const generation = ++this.generation;
		this.controller = new AbortController();
		const chunks = splitText(text, Number(this.options.maxChunkLength) || 3900);

		for (const chunk of chunks) {
			if (generation !== this.generation || this.controller.signal.aborted) {
				throw createAbortError();
			}
			const blob = await this.requestAudio(chunk, language, this.controller.signal);
			await this.playBlob(blob, generation, this.controller.signal);
		}

		if (generation === this.generation) {
			this.controller = null;
		}
	}

	stop() {
		this.generation += 1;
		this.controller?.abort();
		this.controller = null;
		if (this.audio) {
			this.audio.pause();
			this.audio.removeAttribute('src');
			this.audio.load();
			this.audio = null;
		}
		this.releaseObjectUrl();
	}

	destroy() {
		this.stop();
	}

	async requestAudio(text, language, signal) {
		const response = await fetch(this.options.speechUrl, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				Accept: 'audio/*, application/json',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				text,
				language
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

		const blob = await response.blob();
		if (!blob.size) {
			throw new Error('Text-to-speech response is empty.');
		}
		if (String(blob.type || contentType).includes('audio/pcm')) {
			throw new Error('Raw PCM text-to-speech output cannot be played by the browser client.');
		}

		return blob;
	}

	playBlob(blob, generation, signal) {
		return new Promise((resolve, reject) => {
			if (generation !== this.generation || signal.aborted) {
				reject(createAbortError());
				return;
			}

			this.releaseObjectUrl();
			this.objectUrl = URL.createObjectURL(blob);
			const audio = new Audio(this.objectUrl);
			this.audio = audio;

			const cleanup = () => {
				audio.onended = null;
				audio.onerror = null;
				signal.removeEventListener('abort', onAbort);
				if (this.audio === audio) {
					this.audio = null;
				}
				this.releaseObjectUrl();
			};
			const onAbort = () => {
				audio.pause();
				cleanup();
				reject(createAbortError());
			};

			audio.onended = () => {
				cleanup();
				resolve();
			};
			audio.onerror = () => {
				cleanup();
				reject(new Error('Text-to-speech audio could not be played.'));
			};
			signal.addEventListener('abort', onAbort, { once: true });
			audio.play().catch((error) => {
				cleanup();
				reject(error);
			});
		});
	}

	releaseObjectUrl() {
		if (!this.objectUrl) {
			return;
		}
		URL.revokeObjectURL(this.objectUrl);
		this.objectUrl = '';
	}
}

export { splitText };

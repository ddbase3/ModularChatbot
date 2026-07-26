import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendTextToSpeechProvider, splitText } from '../src/speech/BackendTextToSpeechProvider.js';

test('splitText keeps provider requests below the configured limit', () => {
	const chunks = splitText('Ein Satz. Noch ein Satz. Und noch einer.', 18);
	assert.ok(chunks.length > 1);
	assert.ok(chunks.every((chunk) => chunk.length <= 18));
	assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), 'Ein Satz. Noch ein Satz. Und noch einer.');
});

test('backend provider requests and plays generated audio', async () => {
	const originalFetch = globalThis.fetch;
	const originalAudio = globalThis.Audio;
	const originalUrl = globalThis.URL;
	const requests = [];
	const played = [];

	class AudioMock {
		constructor(url) {
			this.url = url;
			this.onended = null;
			this.onerror = null;
		}
		play() {
			played.push(this.url);
			queueMicrotask(() => this.onended?.());
			return Promise.resolve();
		}
		pause() {}
		removeAttribute() {}
		load() {}
	}

	globalThis.fetch = async (url, options) => {
		requests.push({ url, options, body: JSON.parse(options.body) });
		return new Response(new Blob(['audio'], { type: 'audio/mpeg' }), {
			status: 200,
			headers: { 'Content-Type': 'audio/mpeg' }
		});
	};
	globalThis.Audio = AudioMock;
	globalThis.URL = {
		createObjectURL() { return 'blob:test'; },
		revokeObjectURL() {}
	};

	try {
		const provider = new BackendTextToSpeechProvider({
			speechUrl: '/tts?config_group=chatbot-two&config_name=sidebar'
		});
		await provider.speak('Hallo Welt', 'de-DE');

		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, '/tts?config_group=chatbot-two&config_name=sidebar');
		assert.deepEqual(requests[0].body, {
			text: 'Hallo Welt',
			language: 'de-DE'
		});
		assert.deepEqual(played, ['blob:test']);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.Audio = originalAudio;
		globalThis.URL = originalUrl;
	}
});

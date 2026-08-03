import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendTextToSpeechProvider, splitText } from '../src/speech/BackendTextToSpeechProvider.js';

function createPcm16Wav(samples, sampleRate = 24000, channels = 1) {
	const dataSize = samples.length * 2;
	const bytes = new Uint8Array(44 + dataSize);
	const view = new DataView(bytes.buffer);
	const writeAscii = (offset, value) => {
		for (let index = 0; index < value.length; index += 1) {
			bytes[offset + index] = value.charCodeAt(index);
		}
	};

	writeAscii(0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, 'data');
	view.setUint32(40, dataSize, true);
	for (let index = 0; index < samples.length; index += 1) {
		view.setInt16(44 + index * 2, samples[index], true);
	}

	return bytes;
}

test('splitText keeps provider requests below the configured limit', () => {
	const chunks = splitText('Ein Satz. Noch ein Satz. Und noch einer.', 18);
	assert.ok(chunks.length > 1);
	assert.ok(chunks.every((chunk) => chunk.length <= 18));
	assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), 'Ein Satz. Noch ein Satz. Und noch einer.');
});

test('backend provider requests WAV and schedules streamed frames through Web Audio', async () => {
	const originalFetch = globalThis.fetch;
	const originalAudioContext = globalThis.AudioContext;
	const originalWebkitAudioContext = globalThis.webkitAudioContext;
	const requests = [];
	const copiedChannels = [];
	const starts = [];
	const wav = createPcm16Wav([0, 16384, -16384, 32767]);

	class AudioContextMock {
		constructor() {
			this.state = 'suspended';
			this.currentTime = 0;
			this.destination = {};
		}
		async resume() {
			this.state = 'running';
		}
		async close() {
			this.state = 'closed';
		}
		createBuffer(channels, length, sampleRate) {
			return {
				duration: length / sampleRate,
				copyToChannel(values) {
					copiedChannels.push(Array.from(values));
				}
			};
		}
		createBufferSource() {
			return {
				onended: null,
				buffer: null,
				connect() {},
				disconnect() {},
				start(time) {
					starts.push(time);
					queueMicrotask(() => this.onended?.());
				},
				stop() {
					queueMicrotask(() => this.onended?.());
				}
			};
		}
	}

	globalThis.fetch = async (url, options) => {
		requests.push({ url, options, body: JSON.parse(options.body) });
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(wav.slice(0, 21));
				controller.enqueue(wav.slice(21, 47));
				controller.enqueue(wav.slice(47));
				controller.close();
			}
		});
		return new Response(body, {
			status: 200,
			headers: { 'Content-Type': 'audio/wav' }
		});
	};
	globalThis.AudioContext = AudioContextMock;
	delete globalThis.webkitAudioContext;

	try {
		const provider = new BackendTextToSpeechProvider({
			speechUrl: '/tts?config_group=chatbot-two&config_name=sidebar'
		});
		await provider.activate();
		await provider.speak('Hallo Welt', 'de-DE');

		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, '/tts?config_group=chatbot-two&config_name=sidebar');
		assert.deepEqual(requests[0].body, {
			text: 'Hallo Welt',
			language: 'de-DE',
			options: {
				responseFormat: 'wav'
			}
		});
		assert.ok(starts.length >= 1);
		const samples = copiedChannels.flat();
		assert.equal(samples.length, 4);
		assert.ok(Math.abs(samples[1] - 0.5) < 0.0001);
		assert.ok(Math.abs(samples[2] + 0.5) < 0.0001);
	} finally {
		globalThis.fetch = originalFetch;
		globalThis.AudioContext = originalAudioContext;
		if (originalWebkitAudioContext === undefined) {
			delete globalThis.webkitAudioContext;
		} else {
			globalThis.webkitAudioContext = originalWebkitAudioContext;
		}
	}
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendRealtimeSpeechToTextProvider } from '../src/speech/BackendRealtimeSpeechToTextProvider.js';

for (const providerName of ['mistral', 'openai']) {
	test(`backend realtime provider accepts ${providerName} sessions`, async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => ({
			ok: true,
			async json() {
				return {
					status: 'ok',
					data: {
						session: {
							provider: providerName,
							transport: 'websocket',
							endpoint: 'wss://example.invalid/realtime',
							clientToken: 'token',
							audioEncoding: 'pcm_s16le',
							sampleRate: providerName === 'openai' ? 24000 : 16000,
							options: {}
						}
					}
				};
			}
		});

		const backend = new BackendRealtimeSpeechToTextProvider({ sessionUrl: '/session' });
		try {
			const session = await backend.createSession();
			assert.equal(session.provider, providerName);
		} finally {
			backend.destroy();
			globalThis.fetch = originalFetch;
		}
	});
}

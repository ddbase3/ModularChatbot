import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendRealtimeSpeechToTextProvider } from '../src/speech/BackendRealtimeSpeechToTextProvider.js';

for (const providerName of ['mistral', 'openai']) {
	test(`backend realtime provider accepts ${providerName} sessions`, async () => {
		const originalFetch = globalThis.fetch;
		let request = null;
		globalThis.fetch = async (url, options) => {
			request = { url, options };
			return {
				ok: true,
				async json() {
					return {
						status: 'ok',
						data: {
							session: {
								provider: providerName
							}
						}
					};
				}
			};
		};

		const backend = new BackendRealtimeSpeechToTextProvider({
			sessionUrl: '/session',
			language: 'de-DE',
			context: 'Vorhandener Text'
		});
		try {
			const session = await backend.createSession();
			assert.equal(session.provider, providerName);
			assert.equal(request.url, '/session');
			const body = new URLSearchParams(request.options.body);
			assert.equal(body.get('language'), 'de-DE');
			assert.equal(body.get('context'), 'Vorhandener Text');
		} finally {
			backend.destroy();
			globalThis.fetch = originalFetch;
		}
	});
}

test('backend realtime provider opens the microphone before requesting short-lived tokens', async () => {
	const backend = new BackendRealtimeSpeechToTextProvider({ sessionUrl: '/session' });
	const order = [];
	let stopped = false;
	const stream = {
		getTracks() {
			return [{ stop() { stopped = true; } }];
		}
	};
	backend.requestMicrophone = async () => {
		order.push('microphone');
		return stream;
	};
	backend.createSession = async () => {
		order.push('session');
		return { provider: 'unsupported' };
	};

	await assert.rejects(
		backend.start(),
		/Unsupported realtime speech-to-text provider/u
	);
	assert.deepEqual(order, ['microphone', 'session']);
	assert.equal(stopped, true);
});

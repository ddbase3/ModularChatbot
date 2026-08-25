import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatbotEventBus } from '../src/core/ChatbotEventBus.js';
import { VoicePlugin } from '../src/plugins/VoicePlugin.js';

class EventTargetMock {
	constructor() {
		this.listeners = new Map();
	}

	addEventListener(name, handler) {
		const handlers = this.listeners.get(name) || [];
		handlers.push(handler);
		this.listeners.set(name, handlers);
	}

	removeEventListener(name, handler) {
		const handlers = this.listeners.get(name) || [];
		this.listeners.set(name, handlers.filter((candidate) => candidate !== handler));
	}

	emit(name, event = {}) {
		for (const handler of this.listeners.get(name) || []) {
			handler(event);
		}
	}
}

class RecognitionMock {
	static instances = [];

	constructor() {
		this.started = false;
		this.stopped = false;
		RecognitionMock.instances.push(this);
	}

	start() {
		this.started = true;
	}

	stop() {
		this.stopped = true;
	}
}

class UtteranceMock {
	constructor(text) {
		this.text = text;
		this.lang = '';
		this.onend = null;
		this.onerror = null;
	}
}

class DataChannelMock extends EventTargetMock {
	constructor() {
		super();
		this.readyState = 'connecting';
		this.sent = [];
	}

	send(value) {
		this.sent.push(JSON.parse(value));
	}

	open() {
		this.readyState = 'open';
		this.emit('open');
	}

	close() {
		this.readyState = 'closed';
	}
}

class PeerConnectionMock extends EventTargetMock {
	static instances = [];

	constructor() {
		super();
		this.connectionState = 'new';
		this.localDescription = null;
		this.dataChannel = null;
		PeerConnectionMock.instances.push(this);
	}

	addTrack(track, stream) {
		this.track = track;
		this.stream = stream;
	}

	createDataChannel(label, options) {
		this.dataChannel = new DataChannelMock();
		this.dataChannel.label = label;
		this.dataChannel.options = options;
		return this.dataChannel;
	}

	async createOffer() {
		return { type: 'offer', sdp: 'v=0\r\no=browser-offer' };
	}

	async setLocalDescription(description) {
		this.localDescription = description;
	}

	async setRemoteDescription(description) {
		this.remoteDescription = description;
		this.connectionState = 'connected';
	}

	close() {
		this.connectionState = 'closed';
	}
}

class AudioContextMock {
	constructor() {
		this.state = 'running';
	}

	createMediaStreamSource() {
		return {
			connect() {},
			disconnect() {}
		};
	}

	createAnalyser() {
		return {
			fftSize: 0,
			smoothingTimeConstant: 0,
			getByteTimeDomainData(samples) {
				samples.fill(128);
			},
			disconnect() {}
		};
	}

	async resume() {}

	async close() {
		this.state = 'closed';
	}
}

function createClassList() {
	const values = new Set();
	return {
		toggle(name, force) {
			if (force === undefined ? !values.has(name) : Boolean(force)) {
				values.add(name);
				return true;
			}
			values.delete(name);
			return false;
		},
		contains(name) {
			return values.has(name);
		}
	};
}

function createStyle() {
	const values = new Map();
	return {
		setProperty(name, value) {
			values.set(name, String(value));
		},
		getPropertyValue(name) {
			return values.get(name) || '';
		}
	};
}

function createElement(tagName = 'div') {
	return {
		tagName: String(tagName).toUpperCase(),
		className: '',
		hidden: false,
		textContent: '',
		children: [],
		attributes: new Map(),
		style: createStyle(),
		appendChild(child) {
			this.children.push(child);
			return child;
		},
		setAttribute(name, value) {
			this.attributes.set(name, String(value));
		},
		getAttribute(name) {
			return this.attributes.get(name);
		}
	};
}

function createButton() {
	return {
		classList: createClassList(),
		style: createStyle(),
		disabled: false,
		attributes: new Map(),
		setAttribute(name, value) {
			this.attributes.set(name, String(value));
		},
		getAttribute(name) {
			return this.attributes.get(name);
		}
	};
}

function createInput(value = '') {
	return {
		value,
		selectionStart: value.length,
		selectionEnd: value.length,
		setSelectionRange(start, end) {
			this.selectionStart = start;
			this.selectionEnd = end;
		}
	};
}

function createContext(pluginOptions) {
	const controls = new Map();
	const elements = new Map();
	const events = new ChatbotEventBus();
	const sent = [];
	const input = createInput();
	const composer = {
		classList: createClassList()
	};
	const chatbot = {
		instanceId: `chatbot-${Math.random().toString(16).slice(2)}`,
		sending: false,
		elements: {
			composer,
			input
		}
	};
	let focusCount = 0;
	const context = {
		chatbot,
		events,
		getString: (key) => key,
		ui: {
			addControl(slot, definition) {
				const button = createButton();
				button.className = definition.className || 'base3-chatbot-control';
				controls.set(definition.id, { slot, button, definition });
				return button;
			},
			addElement(slot, id, element) {
				elements.set(id, { slot, element });
				return element;
			},
			remove(id) {
				elements.delete(id);
			}
		},
		getPluginOptions() {
			return pluginOptions;
		},
		send(options) {
			sent.push(options);
			chatbot.sending = true;
		},
		setComposerValue(value) {
			input.value = value;
		},
		focusComposer() {
			focusCount += 1;
		}
	};

	return {
		context,
		controls,
		elements,
		events,
		sent,
		input,
		composer,
		get focusCount() {
			return focusCount;
		}
	};
}

function waitFor(predicate, label = 'condition') {
	return new Promise((resolve, reject) => {
		let attempts = 0;
		const next = () => {
			if (predicate()) {
				resolve();
				return;
			}
			attempts += 1;
			if (attempts > 200) {
				reject(new Error(`${label} was not reached.`));
				return;
			}
			setImmediate(next);
		};
		next();
	});
}

function installBrowserEnvironment() {
	const originals = {
		window: globalThis.window,
		document: globalThis.document,
		SpeechSynthesisUtterance: globalThis.SpeechSynthesisUtterance,
		requestAnimationFrame: globalThis.requestAnimationFrame,
		cancelAnimationFrame: globalThis.cancelAnimationFrame
	};
	const spoken = [];

	RecognitionMock.instances = [];
	globalThis.window = {
		SpeechRecognition: RecognitionMock,
		speechSynthesis: {
			cancel() {},
			speak(utterance) {
				spoken.push(utterance);
			}
		}
	};
	globalThis.document = {
		documentElement: {
			lang: 'de-DE'
		},
		createElement
	};
	globalThis.SpeechSynthesisUtterance = UtteranceMock;
	globalThis.requestAnimationFrame = () => 1;
	globalThis.cancelAnimationFrame = () => {};

	return {
		spoken,
		restore() {
			globalThis.window = originals.window;
			globalThis.document = originals.document;
			globalThis.SpeechSynthesisUtterance = originals.SpeechSynthesisUtterance;
			globalThis.requestAnimationFrame = originals.requestAnimationFrame;
			globalThis.cancelAnimationFrame = originals.cancelAnimationFrame;
		}
	};
}

function installBackendEnvironment() {
	const originals = {
		fetch: globalThis.fetch,
		window: globalThis.window,
		document: globalThis.document,
		RTCPeerConnection: globalThis.RTCPeerConnection,
		AudioContext: globalThis.AudioContext,
		requestAnimationFrame: globalThis.requestAnimationFrame,
		cancelAnimationFrame: globalThis.cancelAnimationFrame,
		navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
		performanceDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'performance')
	};
	const track = new EventTargetMock();
	track.enabled = true;
	track.stop = () => {};
	const stream = {
		getAudioTracks: () => [track],
		getTracks: () => [track]
	};

	PeerConnectionMock.instances = [];
	globalThis.fetch = async (url) => {
		if (String(url) === '/stt-session') {
			return {
				ok: true,
				async json() {
					return {
						status: 'ok',
						data: {
							session: {
								provider: 'openai',
								transport: 'webrtc',
								endpoint: 'https://api.openai.com/v1/realtime/calls',
								clientToken: 'ek_test',
								expiresAt: '2099-01-01T00:00:00Z',
								model: 'gpt-live-transcribe',
								audioEncoding: 'audio/pcm',
								sampleRate: 24000,
								options: {
									commitDrainMs: 1,
									transcriptQuietMs: 1,
									finalizationTimeoutMs: 10000
								}
							}
						}
					};
				}
			};
		}
		return {
			ok: true,
			async text() {
				return 'v=0\r\no=openai-answer';
			}
		};
	};
	globalThis.window = {
		speechSynthesis: {
			cancel() {},
			speak() {}
		}
	};
	globalThis.document = {
		documentElement: {
			lang: 'de-DE'
		},
		createElement
	};
	globalThis.RTCPeerConnection = PeerConnectionMock;
	globalThis.AudioContext = AudioContextMock;
	globalThis.requestAnimationFrame = () => 1;
	globalThis.cancelAnimationFrame = () => {};
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {
			mediaDevices: {
				async getUserMedia() {
					return stream;
				}
			}
		}
	});
	Object.defineProperty(globalThis, 'performance', {
		configurable: true,
		value: {
			now: () => Date.now()
		}
	});

	return {
		track,
		restore() {
			globalThis.fetch = originals.fetch;
			globalThis.window = originals.window;
			globalThis.document = originals.document;
			globalThis.RTCPeerConnection = originals.RTCPeerConnection;
			globalThis.AudioContext = originals.AudioContext;
			globalThis.requestAnimationFrame = originals.requestAnimationFrame;
			globalThis.cancelAnimationFrame = originals.cancelAnimationFrame;
			if (originals.navigatorDescriptor) {
				Object.defineProperty(globalThis, 'navigator', originals.navigatorDescriptor);
			} else {
				delete globalThis.navigator;
			}
			if (originals.performanceDescriptor) {
				Object.defineProperty(globalThis, 'performance', originals.performanceDescriptor);
			} else {
				delete globalThis.performance;
			}
		}
	};
}

function backendOptions(dialog) {
	return {
		stt: {
			enabled: true,
			provider: 'backend',
			sessionUrl: '/stt-session'
		},
		tts: {
			enabled: true,
			provider: 'browser',
			speechUrl: ''
		},
		dialog,
		lang: 'de-DE'
	};
}

test('browser dialog sends only after recognition ends and then alternates speech and recognition', () => {
	const environment = installBrowserEnvironment();
	const fixture = createContext({
		stt: {
			enabled: true,
			provider: 'browser',
			sessionUrl: ''
		},
		tts: {
			enabled: true,
			provider: 'browser',
			speechUrl: ''
		},
		dialog: true,
		lang: 'de-DE'
	});

	try {
		VoicePlugin.install(fixture.context);
		const dialog = fixture.controls.get(`${fixture.context.chatbot.instanceId}-voice-dialog`);
		const microphone = fixture.controls.get(`${fixture.context.chatbot.instanceId}-voice-microphone`);
		const speaker = fixture.controls.get(`${fixture.context.chatbot.instanceId}-voice-speaker`);

		dialog.definition.onActivate();
		assert.equal(dialog.button.getAttribute('aria-pressed'), 'true');
		assert.equal(microphone.button.disabled, true);
		assert.equal(speaker.button.disabled, true);
		assert.equal(RecognitionMock.instances.length, 1);
		assert.equal(microphone.button.classList.contains('is-listening'), true);

		const result = [{ transcript: 'Hallo Chatbot' }];
		result.isFinal = true;
		RecognitionMock.instances[0].onresult({
			resultIndex: 0,
			results: [result]
		});
		assert.deepEqual(fixture.sent, []);

		RecognitionMock.instances[0].onend();
		assert.deepEqual(fixture.sent, [{ text: 'Hallo Chatbot' }]);
		assert.equal(microphone.button.classList.contains('is-listening'), false);

		fixture.context.chatbot.sending = false;
		fixture.events.emit('message:completed', {
			rawText: 'Hallo zurück',
			interaction: false,
			error: false
		});
		assert.equal(environment.spoken.length, 1);
		assert.equal(environment.spoken[0].text, 'Hallo zurück');
		assert.equal(environment.spoken[0].lang, 'de-DE');

		environment.spoken[0].onend();
		assert.equal(RecognitionMock.instances.length, 2);
		assert.equal(RecognitionMock.instances[1].started, true);
		assert.equal(microphone.button.classList.contains('is-listening'), true);

		dialog.definition.onActivate();
		assert.equal(dialog.button.getAttribute('aria-pressed'), 'false');
		assert.equal(microphone.button.disabled, false);
		assert.equal(speaker.button.disabled, false);
		assert.equal(RecognitionMock.instances[1].stopped, true);
		assert.equal(microphone.button.classList.contains('is-listening'), false);
	} finally {
		VoicePlugin.destroy(fixture.context);
		environment.restore();
	}
});

test('disabled voice features do not create their chatbot controls', () => {
	const environment = installBrowserEnvironment();
	const fixtures = [];

	try {
		const sttOff = createContext({
			stt: { enabled: false, provider: 'browser', sessionUrl: '' },
			tts: { enabled: true, provider: 'browser', speechUrl: '' },
			dialog: true,
			lang: 'de-DE'
		});
		fixtures.push(sttOff);
		VoicePlugin.install(sttOff.context);
		assert.equal(sttOff.controls.has(`${sttOff.context.chatbot.instanceId}-voice-microphone`), false);
		assert.equal(sttOff.controls.has(`${sttOff.context.chatbot.instanceId}-voice-speaker`), true);
		assert.equal(sttOff.controls.has(`${sttOff.context.chatbot.instanceId}-voice-dialog`), false);

		const ttsOff = createContext({
			stt: { enabled: true, provider: 'browser', sessionUrl: '' },
			tts: { enabled: false, provider: 'browser', speechUrl: '' },
			dialog: true,
			lang: 'de-DE'
		});
		fixtures.push(ttsOff);
		VoicePlugin.install(ttsOff.context);
		assert.equal(ttsOff.controls.has(`${ttsOff.context.chatbot.instanceId}-voice-microphone`), true);
		assert.equal(ttsOff.controls.has(`${ttsOff.context.chatbot.instanceId}-voice-speaker`), false);
		assert.equal(ttsOff.controls.has(`${ttsOff.context.chatbot.instanceId}-voice-dialog`), false);

		const dialogOff = createContext({
			stt: { enabled: true, provider: 'browser', sessionUrl: '' },
			tts: { enabled: true, provider: 'browser', speechUrl: '' },
			dialog: false,
			lang: 'de-DE'
		});
		fixtures.push(dialogOff);
		VoicePlugin.install(dialogOff.context);
		assert.equal(dialogOff.controls.has(`${dialogOff.context.chatbot.instanceId}-voice-microphone`), true);
		assert.equal(dialogOff.controls.has(`${dialogOff.context.chatbot.instanceId}-voice-speaker`), true);
		assert.equal(dialogOff.controls.has(`${dialogOff.context.chatbot.instanceId}-voice-dialog`), false);
	} finally {
		for (const fixture of fixtures) {
			VoicePlugin.destroy(fixture.context);
		}
		environment.restore();
	}
});

test('dialog mode stops realtime input after three seconds of silence and sends the final transcript', async (t) => {
	t.mock.timers.enable({
		apis: ['setTimeout', 'Date'],
		now: 1000
	});
	const environment = installBackendEnvironment();
	const fixture = createContext(backendOptions(true));

	try {
		VoicePlugin.install(fixture.context);
		const dialog = fixture.controls.get(`${fixture.context.chatbot.instanceId}-voice-dialog`);
		dialog.definition.onActivate();

		await waitFor(
			() => PeerConnectionMock.instances[0]?.dataChannel?.listeners.has('open'),
			'OpenAI data channel listener'
		);
		const peer = PeerConnectionMock.instances[0];
		peer.dataChannel.open();
		await waitFor(
			() => VoicePlugin.states.get(fixture.context.chatbot)?.realtimeProvider?.provider?.recording,
			'OpenAI recording state'
		);
		const provider = VoicePlugin.states.get(fixture.context.chatbot).realtimeProvider.provider;

		peer.dataChannel.emit('message', {
			data: JSON.stringify({
				type: 'conversation.item.added',
				item: { id: 'item-1', role: 'user' },
				previous_item_id: null
			})
		});
		peer.dataChannel.emit('message', {
			data: JSON.stringify({
				type: 'conversation.item.input_audio_transcription.delta',
				item_id: 'item-1',
				delta: 'Hallo ILIAS'
			})
		});
		provider.options.onLevel(0.02, 0.04);
		assert.ok(VoicePlugin.states.get(fixture.context.chatbot).levelTarget > 0);

		t.mock.timers.tick(2999);
		assert.equal(peer.dataChannel.sent.some((event) => event.type === 'input_audio_buffer.commit'), false);
		t.mock.timers.tick(1);
		assert.equal(peer.dataChannel.sent.some((event) => event.type === 'input_audio_buffer.commit'), false);
		t.mock.timers.tick(1);
		assert.equal(peer.dataChannel.sent.some((event) => event.type === 'input_audio_buffer.commit'), true);
		assert.equal(environment.track.enabled, false);

		peer.dataChannel.emit('message', {
			data: JSON.stringify({
				type: 'input_audio_buffer.committed',
				item_id: 'item-1'
			})
		});
		peer.dataChannel.emit('message', {
			data: JSON.stringify({
				type: 'conversation.item.input_audio_transcription.completed',
				item_id: 'item-1',
				transcript: 'Hallo ILIAS'
			})
		});
		t.mock.timers.tick(150);
		await Promise.resolve();

		assert.deepEqual(fixture.sent, [{ text: 'Hallo ILIAS' }]);
		assert.equal(dialog.button.getAttribute('aria-pressed'), 'true');
	} finally {
		VoicePlugin.destroy(fixture.context);
		environment.restore();
	}
});

test('realtime input without dialog mode stops only through the microphone control', async (t) => {
	t.mock.timers.enable({
		apis: ['setTimeout', 'Date'],
		now: 1000
	});
	const environment = installBackendEnvironment();
	const fixture = createContext(backendOptions(false));

	try {
		VoicePlugin.install(fixture.context);
		const microphone = fixture.controls.get(`${fixture.context.chatbot.instanceId}-voice-microphone`);
		assert.equal(fixture.controls.has(`${fixture.context.chatbot.instanceId}-voice-dialog`), false);
		microphone.definition.onActivate();
		let state = VoicePlugin.states.get(fixture.context.chatbot);
		assert.equal(state.starting, true);
		assert.equal(state.recording, false);
		assert.equal(microphone.button.getAttribute('aria-busy'), 'true');
		assert.equal(microphone.button.getAttribute('aria-pressed'), 'false');
		assert.equal(microphone.button.classList.contains('is-starting'), true);
		assert.equal(microphone.button.classList.contains('is-listening'), false);

		await waitFor(
			() => PeerConnectionMock.instances[0]?.dataChannel?.listeners.has('open'),
			'OpenAI data channel listener'
		);
		const peer = PeerConnectionMock.instances[0];
		const provider = VoicePlugin.states.get(fixture.context.chatbot).realtimeProvider.provider;
		provider.options.onLevel(0.03, 0.05);
		assert.equal(VoicePlugin.states.get(fixture.context.chatbot).levelTarget, 0);
		peer.dataChannel.open();
		await waitFor(
			() => VoicePlugin.states.get(fixture.context.chatbot)?.realtimeProvider?.provider?.recording,
			'OpenAI recording state'
		);
		state = VoicePlugin.states.get(fixture.context.chatbot);
		assert.equal(state.starting, false);
		assert.equal(state.recording, true);
		assert.equal(microphone.button.getAttribute('aria-busy'), 'false');
		assert.equal(microphone.button.getAttribute('aria-pressed'), 'true');
		assert.equal(microphone.button.classList.contains('is-starting'), false);
		assert.equal(microphone.button.classList.contains('is-listening'), true);
		provider.options.onLevel(0.03, 0.05);
		assert.ok(VoicePlugin.states.get(fixture.context.chatbot).levelTarget > 0);

		t.mock.timers.tick(5000);
		assert.equal(peer.dataChannel.sent.some((event) => event.type === 'input_audio_buffer.commit'), false);

		microphone.definition.onActivate();
		t.mock.timers.tick(1);
		assert.equal(peer.dataChannel.sent.some((event) => event.type === 'input_audio_buffer.commit'), true);
	} finally {
		VoicePlugin.destroy(fixture.context);
		environment.restore();
	}
});

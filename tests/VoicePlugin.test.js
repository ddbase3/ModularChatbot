import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatbotEventBus } from '../src/core/ChatbotEventBus.js';
import { VoicePlugin } from '../src/plugins/VoicePlugin.js';

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

function createButton() {
	return {
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

test('voice dialog alternates recognition, send, speech and recognition', () => {
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalUtterance = globalThis.SpeechSynthesisUtterance;
	const spoken = [];
	const controls = new Map();
	const events = new ChatbotEventBus();
	const sent = [];
	const chatbot = {
		instanceId: 'chatbot-test',
		sending: false,
		elements: {
			input: { value: '' }
		}
	};

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
		}
	};
	globalThis.SpeechSynthesisUtterance = UtteranceMock;

	const context = {
		chatbot,
		events,
		ui: {
			addControl(slot, definition) {
				const button = createButton();
				controls.set(definition.id, { button, definition });
				return button;
			}
		},
		getPluginOptions() {
			return {
				stt: true,
				tts: true,
				dialog: true,
				lang: 'de-DE'
			};
		},
		send(options) {
			sent.push(options);
			chatbot.sending = true;
		},
		setComposerValue() {},
		focusComposer() {}
	};

	try {
		VoicePlugin.install(context);
		const dialog = controls.get('chatbot-test-voice-dialog');
		const microphone = controls.get('chatbot-test-voice-microphone');
		const speaker = controls.get('chatbot-test-voice-speaker');

		dialog.definition.onActivate();
		assert.equal(dialog.button.getAttribute('aria-pressed'), 'true');
		assert.equal(microphone.button.disabled, true);
		assert.equal(speaker.button.disabled, true);
		assert.equal(RecognitionMock.instances.length, 1);
		assert.equal(RecognitionMock.instances[0].started, true);

		RecognitionMock.instances[0].onresult({
			resultIndex: 0,
			results: [[{ transcript: 'Hallo Chatbot' }]]
		});
		assert.deepEqual(sent, [{ text: 'Hallo Chatbot' }]);

		RecognitionMock.instances[0].onend();
		assert.equal(dialog.button.getAttribute('aria-pressed'), 'true');

		chatbot.sending = false;
		events.emit('message:completed', {
			rawText: 'Hallo zurück',
			interaction: false,
			error: false
		});
		assert.equal(spoken.length, 1);
		assert.equal(spoken[0].text, 'Hallo zurück');
		assert.equal(spoken[0].lang, 'de-DE');

		spoken[0].onend();
		assert.equal(RecognitionMock.instances.length, 2);
		assert.equal(RecognitionMock.instances[1].started, true);

		dialog.definition.onActivate();
		assert.equal(dialog.button.getAttribute('aria-pressed'), 'false');
		assert.equal(microphone.button.disabled, false);
		assert.equal(speaker.button.disabled, false);
		assert.equal(RecognitionMock.instances[1].stopped, true);
	} finally {
		VoicePlugin.destroy(context);
		globalThis.window = originalWindow;
		globalThis.document = originalDocument;
		globalThis.SpeechSynthesisUtterance = originalUtterance;
	}
});

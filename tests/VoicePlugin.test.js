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

function createElement(tagName = 'div') {
	return {
		tagName: String(tagName).toUpperCase(),
		className: '',
		hidden: false,
		textContent: '',
		children: [],
		attributes: new Map(),
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

test('voice dialog alternates recognition, send, speech and recognition with listening state', () => {
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalUtterance = globalThis.SpeechSynthesisUtterance;
	const spoken = [];
	const controls = new Map();
	const elements = new Map();
	const events = new ChatbotEventBus();
	const sent = [];
	const composer = {
		classList: createClassList()
	};
	const chatbot = {
		instanceId: 'chatbot-test',
		sending: false,
		elements: {
			composer,
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
		},
		createElement
	};
	globalThis.SpeechSynthesisUtterance = UtteranceMock;

	const context = {
		chatbot,
		events,
		getString: (key) => key,
		ui: {
			addControl(slot, definition) {
				const button = createButton();
				controls.set(definition.id, { button, definition });
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
		setComposerValue(value) {
			chatbot.elements.input.value = value;
		},
		focusComposer() {}
	};

	try {
		VoicePlugin.install(context);
		const dialog = controls.get('chatbot-test-voice-dialog');
		const microphone = controls.get('chatbot-test-voice-microphone');
		const speaker = controls.get('chatbot-test-voice-speaker');
		const listening = elements.get('chatbot-test-voice-listening').element;

		assert.equal(listening.hidden, true);
		assert.equal(composer.classList.contains('is-listening'), false);

		dialog.definition.onActivate();
		assert.equal(dialog.button.getAttribute('aria-pressed'), 'true');
		assert.equal(microphone.button.disabled, true);
		assert.equal(speaker.button.disabled, true);
		assert.equal(RecognitionMock.instances.length, 1);
		assert.equal(RecognitionMock.instances[0].started, true);
		assert.equal(listening.hidden, false);
		assert.equal(composer.classList.contains('is-listening'), true);

		RecognitionMock.instances[0].onresult({
			resultIndex: 0,
			results: [[{ transcript: 'Hallo Chatbot' }]]
		});
		assert.deepEqual(sent, [{ text: 'Hallo Chatbot' }]);

		RecognitionMock.instances[0].onend();
		assert.equal(dialog.button.getAttribute('aria-pressed'), 'true');
		assert.equal(listening.hidden, true);
		assert.equal(composer.classList.contains('is-listening'), false);

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
		assert.equal(listening.hidden, false);
		assert.equal(composer.classList.contains('is-listening'), true);

		dialog.definition.onActivate();
		assert.equal(dialog.button.getAttribute('aria-pressed'), 'false');
		assert.equal(microphone.button.disabled, false);
		assert.equal(speaker.button.disabled, false);
		assert.equal(RecognitionMock.instances[1].stopped, true);
		assert.equal(listening.hidden, true);
		assert.equal(composer.classList.contains('is-listening'), false);
	} finally {
		VoicePlugin.destroy(context);
		globalThis.window = originalWindow;
		globalThis.document = originalDocument;
		globalThis.SpeechSynthesisUtterance = originalUtterance;
	}
});

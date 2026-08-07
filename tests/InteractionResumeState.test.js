import assert from 'node:assert/strict';
import test from 'node:test';
import { Chatbot } from '../src/Chatbot.js';
import { AgentInteractionPlugin } from '../src/plugins/AgentInteractionPlugin.js';

function createChatbot() {
	const chatbot = Object.create(Chatbot.prototype);
	chatbot.pendingInteraction = {
		resume_handle: 'resume-1',
		interaction_requests: []
	};
	chatbot.activeAssistant = {
		id: 'message-1',
		element: { dataset: {} },
		content: {},
		rawText: '',
		completed: false,
		error: false
	};
	chatbot.renderTimer = null;
	chatbot.options = {
		strings: {
			emptyResponse: 'Empty response'
		}
	};
	chatbot.events = {
		emit() {}
	};
	chatbot.hideThinking = () => {};
	chatbot.scheduleActiveRender = () => {};
	chatbot.renderAssistant = () => {};
	chatbot.setSending = () => {};
	chatbot.scrollToBottom = () => {};
	return chatbot;
}

test('normal output consumes a pending interaction resume handle', () => {
	const chatbot = createChatbot();

	chatbot.appendToken({ text: 'Mutation completed.' });

	assert.equal(chatbot.pendingInteraction, null);
	assert.equal(chatbot.activeAssistant.rawText, 'Mutation completed.');
});

test('normal completion consumes a pending interaction without tokens', () => {
	const chatbot = createChatbot();

	chatbot.finishActiveMessage();

	assert.equal(chatbot.pendingInteraction, null);
	assert.equal(chatbot.activeAssistant.completed, true);
});

test('interaction completion preserves the newly pending interaction', () => {
	const chatbot = createChatbot();
	const interaction = chatbot.pendingInteraction;

	chatbot.finishActiveMessage({ interaction: true });

	assert.equal(chatbot.pendingInteraction, interaction);
	assert.equal(chatbot.activeAssistant.completed, true);
});


class InteractionClassList {
	constructor() {
		this.values = new Set();
	}

	add(value) {
		this.values.add(value);
	}

	remove(value) {
		this.values.delete(value);
	}
}

class InteractionElement {
	constructor(tagName) {
		this.tagName = String(tagName).toUpperCase();
		this.children = [];
		this.className = '';
		this.classList = new InteractionClassList();
		this.textContent = '';
		this.disabled = false;
	}

	setAttribute() {}
	addEventListener() {}

	appendChild(child) {
		this.children.push(child);
		return child;
	}

	append(...children) {
		children.forEach((child) => this.appendChild(child));
	}

	replaceChildren(...children) {
		this.children = [...children];
	}
}

test('hydrated conversation state restores the existing pending interaction UI', () => {
	const originalDocument = globalThis.document;
	globalThis.document = {
		createElement(tagName) {
			return new InteractionElement(tagName);
		}
	};
	const listeners = new Map();
	const content = new InteractionElement('div');
	let createdAssistant = null;
	const chatbot = {
		pendingInteraction: null,
		elements: { messages: new InteractionElement('div') },
		root: new InteractionElement('section'),
		createAssistantMessage() {
			createdAssistant = {
				content,
				completed: false
			};
			return createdAssistant;
		},
		hideThinking() {},
		resumeInteraction() {}
	};
	const context = {
		chatbot,
		signal: new AbortController().signal,
		events: {
			on(name, listener) {
				listeners.set(name, listener);
				return () => listeners.delete(name);
			}
		}
	};
	const interaction = {
		status: 'awaiting_approval',
		resume_handle: 'scope.resume',
		interaction_requests: [{
			id: 'request-a',
			kind: 'approval',
			title: 'Confirm action',
			message: 'Apply the change.'
		}]
	};

	try {
		AgentInteractionPlugin.install(context);
		listeners.get('conversation:state-applied')({
			state: { pending_interaction: interaction },
			hydrated: true
		});

		assert.deepEqual(chatbot.pendingInteraction, interaction);
		assert.equal(createdAssistant.completed, true);
		assert.equal(content.children.length, 1);
		assert.equal(content.children[0].className, 'base3-chatbot-interaction');
		assert.equal(content.children[0].children[0].className, 'base3-chatbot-interaction-card');
	}
	finally {
		AgentInteractionPlugin.destroy(context);
		globalThis.document = originalDocument;
	}
});

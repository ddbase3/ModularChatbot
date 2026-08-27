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
	chatbot.scrollMessageToStart = () => {};
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

test('completion returns the viewport to the start of the completed assistant message', () => {
	const chatbot = createChatbot();
	let scrolledMessage = null;
	chatbot.scrollMessageToStart = (message) => {
		scrolledMessage = message;
	};

	chatbot.finishActiveMessage();

	assert.equal(scrolledMessage, chatbot.activeAssistant);
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

	add(...values) {
		values.forEach((value) => this.values.add(value));
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
		this.dataset = {};
		this.textContent = '';
		this.disabled = false;
	}

	setAttribute() {}
	addEventListener() {}

	querySelectorAll() {
		return [];
	}

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
				element: new InteractionElement('div'),
				content,
				completed: false
			};
			return createdAssistant;
		},
		hideThinking() {},
		showAssistant() {},
		resumeInteraction() {}
	};
	const context = {
		chatbot,
		getString: (key, replacements = {}) => {
			const strings = {
				interactionRequired: 'Confirmation required',
				riskLevel: 'Risk level: {level}',
				riskMedium: 'Medium'
			};
			return Object.entries(replacements).reduce(
				(text, [name, value]) => text.split('{' + name + '}').join(String(value)),
				strings[key] || key
			);
		},
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
			risk: 'medium',
			message: 'Apply the change.'
		}]
	};

	try {
		AgentInteractionPlugin.install(context);
		listeners.get('conversation:state-applied')({
			state: { pending_interaction: interaction },
			hydrated: true
		});

		assert.equal(chatbot.pendingInteraction.resume_handle, interaction.resume_handle);
		assert.equal(chatbot.pendingInteraction.interaction_requests.length, 1);
		assert.equal(createdAssistant.completed, true);
		assert.equal(content.children.length, 1);
		assert.equal(content.children[0].className, 'base3-chatbot-interaction');
		assert.equal(content.children[0].children[0].className, 'base3-chatbot-interaction-card');
		assert.equal(content.children[0].children[0].children[1].textContent, 'Risk level: Medium');
	}
	finally {
		AgentInteractionPlugin.destroy(context);
		globalThis.document = originalDocument;
	}
});

test('chat switching clears foreign HITL state and restores the complete pending request set when returning', () => {
	const originalDocument = globalThis.document;
	globalThis.document = {
		createElement(tagName) {
			return new InteractionElement(tagName);
		}
	};
	const listeners = new Map();
	const assistants = [];
	const chatbot = {
		pendingInteraction: null,
		elements: { messages: new InteractionElement('div') },
		root: new InteractionElement('section'),
		createAssistantMessage() {
			const assistant = {
				element: new InteractionElement('div'),
				content: new InteractionElement('div'),
				completed: false
			};
			assistants.push(assistant);
			return assistant;
		},
		hideThinking() {},
		showAssistant() {},
		resumeInteraction() {}
	};
	const context = {
		chatbot,
		getString: (key) => key,
		signal: new AbortController().signal,
		events: {
			on(name, listener) {
				listeners.set(name, listener);
				return () => listeners.delete(name);
			}
		}
	};
	const pending = {
		status: 'awaiting_approval',
		resume_handle: 'scope.multi',
		interaction_requests: [
			{
				id: 'request-a',
				kind: 'approval',
				title: 'Enable plugin',
				message: 'Enable ReadSpeaker.'
			},
			{
				id: 'request-b',
				kind: 'approval',
				title: 'Update language',
				message: 'Update Polish language support.'
			}
		]
	};

	try {
		AgentInteractionPlugin.install(context);
		const applyState = listeners.get('conversation:state-applied');

		applyState({ state: { pending_interaction: pending }, hydrated: true });
		assert.equal(chatbot.pendingInteraction.resume_handle, 'scope.multi');
		assert.equal(chatbot.pendingInteraction.interaction_requests.length, 2);
		assert.equal(assistants.length, 1);
		assert.equal(assistants[0].content.children[0].children.length, 3);
		assert.equal(assistants[0].content.children[0].children[0].children[0].textContent, 'Enable plugin');
		assert.equal(assistants[0].content.children[0].children[1].children[0].textContent, 'Update language');

		applyState({ state: { pending_interaction: null }, hydrated: true });
		assert.equal(chatbot.pendingInteraction, null);
		assert.equal(assistants.length, 1);

		applyState({ state: { pending_interaction: pending }, hydrated: true });
		assert.equal(chatbot.pendingInteraction.resume_handle, 'scope.multi');
		assert.equal(chatbot.pendingInteraction.interaction_requests.length, 2);
		assert.equal(assistants.length, 2);
		assert.equal(assistants[1].content.children[0].children.length, 3);
		assert.equal(assistants[1].content.children[0].children[0].children[0].textContent, 'Enable plugin');
		assert.equal(assistants[1].content.children[0].children[1].children[0].textContent, 'Update language');
	} finally {
		AgentInteractionPlugin.destroy(context);
		globalThis.document = originalDocument;
	}
});


test('hydrated conversation state restores terminal HITL history before the active request', () => {
	const originalDocument = globalThis.document;
	globalThis.document = {
		createElement(tagName) {
			return new InteractionElement(tagName);
		}
	};
	const listeners = new Map();
	const assistants = [];
	const chatbot = {
		pendingInteraction: null,
		elements: { messages: new InteractionElement('div') },
		root: new InteractionElement('section'),
		createAssistantMessage() {
			const assistant = {
				element: new InteractionElement('div'),
				content: new InteractionElement('div'),
				completed: false
			};
			assistants.push(assistant);
			return assistant;
		},
		hideThinking() {},
		showAssistant() {},
		resumeInteraction() {}
	};
	const context = {
		chatbot,
		getString: (key) => key,
		signal: new AbortController().signal,
		events: {
			on(name, listener) {
				listeners.set(name, listener);
				return () => listeners.delete(name);
			}
		}
	};
	const resolved = {
		id: 'suspension-resolved',
		lifecycle: 'resolved',
		status: 'awaiting_approval',
		created_at: '2026-08-26T08:00:00+02:00',
		interaction_requests: [{
			id: 'request-resolved',
			kind: 'approval',
			title: 'Resolved action',
			message: 'Was approved.'
		}],
		resolution: {
			outcome: 'approved',
			source: 'natural_language_ai',
			resolved_at: '2026-08-26T08:00:05+02:00',
			responses: [{ request_id: 'request-resolved', decision: 'approve' }]
		}
	};
	const active = {
		id: 'suspension-active',
		lifecycle: 'active',
		status: 'awaiting_approval',
		resume_handle: 'scope.active',
		created_at: '2026-08-26T08:01:00+02:00',
		interaction_requests: [{
			id: 'request-active',
			kind: 'approval',
			title: 'Active action',
			message: 'Still waiting.'
		}]
	};

	try {
		AgentInteractionPlugin.install(context);
		listeners.get('conversation:state-applied')({
			state: { interactions: [resolved, active], pending_interaction: active },
			hydrated: true
		});

		assert.equal(assistants.length, 2);
		assert.equal(assistants[0].content.children[0].classList.values.has('is-terminal'), true);
		assert.equal(assistants[0].content.children[0].children[0].children[0].textContent, 'interactionApproved');
		assert.equal(assistants[0].content.children[0].children[0].children[1].textContent, 'interactionViaChat');
		assert.equal(assistants[0].content.children[0].children[1].children[1].textContent, 'interactionApproved');
		assert.equal(assistants[1].content.children[0].classList.values.has('is-terminal'), false);
		assert.equal(chatbot.pendingInteraction.id, 'suspension-active');
	}
	finally {
		AgentInteractionPlugin.destroy(context);
		globalThis.document = originalDocument;
	}
});


test('expired active interaction compacts immediately and clears pending state', () => {
	const originalDocument = globalThis.document;
	globalThis.document = {
		createElement(tagName) {
			return new InteractionElement(tagName);
		}
	};
	const listeners = new Map();
	const assistants = [];
	const chatbot = {
		pendingInteraction: null,
		elements: { messages: new InteractionElement('div') },
		root: new InteractionElement('section'),
		createAssistantMessage() {
			const assistant = {
				element: new InteractionElement('div'),
				content: new InteractionElement('div'),
				completed: false
			};
			assistants.push(assistant);
			return assistant;
		},
		hideThinking() {},
		showAssistant() {},
		resumeInteraction() {}
	};
	const context = {
		chatbot,
		getString: (key) => key,
		signal: new AbortController().signal,
		events: {
			on(name, listener) {
				listeners.set(name, listener);
				return () => listeners.delete(name);
			}
		}
	};
	const active = {
		id: 'suspension-expired',
		lifecycle: 'active',
		status: 'awaiting_approval',
		resume_handle: 'scope.expired',
		created_at: '2026-08-26T08:00:00+02:00',
		expires_at: '2026-08-26T08:00:01+02:00',
		interaction_requests: [{
			id: 'request-expired',
			kind: 'approval',
			title: 'Expired action',
			message: 'No longer actionable.'
		}]
	};

	try {
		AgentInteractionPlugin.install(context);
		listeners.get('conversation:state-applied')({
			state: { interactions: [active], pending_interaction: active },
			hydrated: true
		});

		assert.equal(chatbot.pendingInteraction, null);
		assert.equal(assistants.length, 1);
		assert.equal(assistants[0].content.children[0].classList.values.has('is-terminal'), true);
		assert.equal(assistants[0].content.children[0].children[0].children[0].textContent, 'interactionExpired');
	}
	finally {
		AgentInteractionPlugin.destroy(context);
		globalThis.document = originalDocument;
	}
});

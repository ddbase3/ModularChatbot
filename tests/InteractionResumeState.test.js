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
		this.events = new Map();
	}

	setAttribute(name, value) { this[name] = value; }
	addEventListener(name, handler) { this.events.set(name, handler); }
	click() { this.events.get('click')?.(); }

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
		assert.equal(assistants[0].element.classList.values.has('has-terminal-interaction'), true);
		assert.equal(assistants[0].content.children[0].children[0].children[0].textContent, 'interactionApproved');
		assert.equal(assistants[0].content.children[0].children[0].children[1].textContent, 'interactionViaChat');
		assert.equal(assistants[0].content.children[0].children[1].children.length, 2);
		assert.equal(assistants[0].content.children[0].children[1].children[0].textContent, 'Resolved action');
		assert.equal(assistants[0].content.children[0].children[1].children[1].textContent, 'Was approved.');
		assert.equal(assistants[1].content.children[0].classList.values.has('is-terminal'), false);
		assert.equal(assistants[1].element.classList.values.has('has-terminal-interaction'), false);
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

function interactionButtons(element) {
	return element.children.flatMap((child) => [
		...(child.tagName === 'BUTTON' ? [child] : []),
		...interactionButtons(child)
	]);
}

function approvalUi(requests) {
	const originalDocument = globalThis.document;
	globalThis.document = { createElement: (tag) => new InteractionElement(tag) };
	const responses = [];
	const content = new InteractionElement('div');
	const assistant = { element: new InteractionElement('div'), content };
	const context = {
		chatbot: {
			showAssistant() {},
			hideThinking() {},
			resumeInteraction: (...args) => responses.push(args)
		},
		getString: (key) => key,
		signal: new AbortController().signal
	};
	const result = AgentInteractionPlugin.onTransportEvent(
		context, 'agent.interaction.required', {
			resume_handle: 'pending-review',
			interaction_requests: requests
		}, { assistant }
	);
	assert.equal(result.complete, true);
	return {
		root: content.children[0],
		responses,
		restore: () => { globalThis.document = originalDocument; }
	};
}

test('single approval exposes one-time, chat-scoped and denial actions', () => {
	const ui = approvalUi([{ id: 'req-one', kind: 'approval', title: 'Remote tool' }]);
	try {
		const buttons = interactionButtons(ui.root);
		assert.deepEqual(buttons.map((button) => button.textContent), ['approve', 'approveConversation', 'deny']);
		buttons[1].click();
		assert.deepEqual(ui.responses[0][1], [
			{ request_id: 'req-one', decision: 'approve', metadata: { approval_scope: 'conversation' } }
		]);
		assert.ok(buttons.every((button) => button.disabled));
	} finally {
		ui.restore();
	}
});

test('multiple approvals require separate decisions and preserve each approval scope', () => {
	const ui = approvalUi([
		{ id: 'req-write', kind: 'approval', title: 'Write item' },
		{ id: 'req-delete', kind: 'approval', title: 'Delete item' }
	]);
	try {
		const cards = ui.root.children.slice(0, 2);
		const [writeOnce, writeChat, writeDeny] = interactionButtons(cards[0]);
		const [deleteOnce, deleteChat, deleteDeny] = interactionButtons(cards[1]);
		const submit = interactionButtons(ui.root).at(-1);
		assert.equal(submit.textContent, 'submitDecisions');
		assert.equal(submit.disabled, true, 'nothing may be approved by default');
		writeChat.click();
		assert.equal(writeChat['aria-pressed'], 'true');
		assert.equal(writeOnce['aria-pressed'], 'false');
		assert.equal(submit.disabled, true);
		deleteDeny.click();
		assert.equal(submit.disabled, false);
		assert.deepEqual(ui.responses, []);
		submit.click();
		assert.equal(ui.responses.length, 1);
		assert.deepEqual(ui.responses[0][1], [
			{ request_id: 'req-write', decision: 'approve', metadata: { approval_scope: 'conversation' } },
			{ request_id: 'req-delete', decision: 'deny', metadata: {} }
		]);
		assert.ok(interactionButtons(ui.root).every((button) => button.disabled));
		assert.equal(deleteOnce['aria-pressed'], 'false');
		assert.equal(deleteChat['aria-pressed'], 'false');
		assert.equal(deleteDeny['aria-pressed'], 'true');
		assert.equal(writeDeny['aria-pressed'], 'false');
	} finally {
		ui.restore();
	}
});

test('batch decisions remain editable until their single explicit submission', () => {
	const ui = approvalUi([
		{ id: 'req-a', kind: 'approval', title: 'First tool' },
		{ id: 'req-b', kind: 'approval', title: 'Second tool' }
	]);
	try {
		const [once, chat, deny] = interactionButtons(ui.root.children[0]);
		const [otherOnce] = interactionButtons(ui.root.children[1]);
		const submit = interactionButtons(ui.root).at(-1);
		chat.click();
		once.click();
		otherOnce.click();
		submit.click();
		assert.deepEqual(ui.responses[0][1], [
			{ request_id: 'req-a', decision: 'approve', metadata: {} },
			{ request_id: 'req-b', decision: 'approve', metadata: {} }
		]);
		assert.equal(chat['aria-pressed'], 'false');
		assert.equal(deny['aria-pressed'], 'false');
	} finally {
		ui.restore();
	}
});

test('Chatbot.resumeInteraction denies incomplete, duplicate and invalid scoped approvals', async () => {
	const bot = Object.create(Chatbot.prototype);
	bot.getString = (key) => key;
	const calls = [];
	bot.send = async (options) => { calls.push(options); };
	const interaction = {
		resume_handle: 'pending-review',
		interaction_requests: [
			{ id: 'req-a', kind: 'approval' },
			{ id: 'req-b', kind: 'approval' }
		]
	};
	await bot.resumeInteraction(interaction, [
		{ request_id: 'req-a', decision: 'approve', metadata: {} }
	]);
	await bot.resumeInteraction(interaction, [
		{ request_id: 'req-a', decision: 'approve', metadata: {} },
		{ request_id: 'req-a', decision: 'approve', metadata: {} }
	]);
	await bot.resumeInteraction(interaction, [
		{ request_id: 'req-a', decision: 'deny', metadata: { approval_scope: 'conversation' } },
		{ request_id: 'req-b', decision: 'approve', metadata: {} }
	]);
	await bot.resumeInteraction(interaction, [
		{ request_id: 'req-a', decision: 'approve', metadata: {} },
		{ request_id: 'req-b', decision: 'approve', metadata: { approval_scope: 'agent' } }
	]);
	assert.equal(calls.length, 0);
	await bot.resumeInteraction(interaction, [
		{ request_id: 'req-b', decision: 'deny', metadata: {} },
		{ request_id: 'req-a', decision: 'approve', metadata: { approval_scope: 'conversation' } }
	]);
	assert.equal(calls.length, 1);
	assert.deepEqual(bot.pendingInteraction.explicit_responses, [
		{ request_id: 'req-a', decision: 'approve', metadata: { approval_scope: 'conversation' } },
		{ request_id: 'req-b', decision: 'deny', metadata: {} }
	]);
});

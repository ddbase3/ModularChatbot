import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationApi, normalizeConversationState } from '../src/conversation/ConversationApi.js';
import { ConversationPlugin } from '../src/plugins/ConversationPlugin.js';

function createState() {
	return {
		conversations: [
			{
				id: 'conversation-a',
				title: 'First chat',
				title_source: 'temporary',
				opening_message: 'Hello',
				created_at: '2026-07-29 10:00:00',
				updated_at: '2026-07-29 10:00:00',
				last_active_at: '2026-07-29 10:00:00'
			}
		],
		active_conversation: {
			id: 'conversation-a',
			title: 'First chat',
			title_source: 'temporary',
			opening_message: 'Hello',
			created_at: '2026-07-29 10:00:00',
			updated_at: '2026-07-29 10:00:00',
			last_active_at: '2026-07-29 10:00:00'
		},
		messages: [
			{
				id: 'message-a',
				role: 'user',
				content: 'Hi',
				timestamp: '2026-07-29T10:00:01+02:00',
				feedback: null
			},
			{
				id: 'message-b',
				role: 'assistant',
				content: 'Hello',
				timestamp: '2026-07-29T10:00:02+02:00',
				feedback: 'like'
			}
		],
		node_id: 'assistant',
		warnings: []
	};
}

test('conversation state normalization keeps one active chat and visible messages', () => {
	const state = normalizeConversationState(createState());

	assert.equal(state.active_conversation.id, 'conversation-a');
	assert.equal(state.conversations.length, 1);
	assert.deepEqual(state.messages.map((message) => message.role), ['user', 'assistant']);
	assert.equal(state.messages[1].feedback, 'like');
});



test('conversation state normalization preserves one pending interaction from server state', () => {
	const source = createState();
	source.pending_interaction = {
		status: 'awaiting_approval',
		resume_handle: 'scope.resume',
		interaction_requests: [{ id: 'request-a', kind: 'approval' }]
	};

	const state = normalizeConversationState(source);

	assert.equal(state.pending_interaction.status, 'awaiting_approval');
	assert.equal(state.pending_interaction.resume_handle, 'scope.resume');
	assert.equal(state.pending_interaction.interaction_requests.length, 1);
});

test('conversation state normalization accepts an unsaved draft without an active chat', () => {
	const state = normalizeConversationState({
		conversations: [],
		active_conversation: null,
		messages: [],
		draft: {
			id: '0123456789abcdef0123456789abcdef0123456789abcdef',
			opening_message: 'How can I help?',
			messages: [{
				id: 'message-draft',
				role: 'assistant',
				content: 'Hello',
				timestamp: '',
				feedback: null
			}]
		},
		node_id: 'assistant',
		warnings: []
	});

	assert.equal(state.active_conversation, null);
	assert.equal(state.draft.opening_message, 'How can I help?');
	assert.equal(state.draft.messages[0].content, 'Hello');
});

test('conversation API sends structured JSON and normalizes the response', async () => {
	const requests = [];
	const api = new ConversationApi({
		stateUrl: '/state',
		createUrl: '/create',
		materializeUrl: '/materialize',
		activateUrl: '/activate',
		renameUrl: '/rename',
		deleteUrl: '/delete',
		titleUrl: '/title',
		fetch: async (url, options) => {
			requests.push({ url, options });
			return {
				ok: true,
				async json() {
					return {
						ok: true,
						data: { state: createState() }
					};
				}
			};
		}
	});

	const state = await api.activate('conversation-a', { type: 'page', title: 'Example' });
	const body = JSON.parse(requests[0].options.body);

	assert.equal(requests[0].url, '/activate');
	assert.equal(requests[0].options.method, 'POST');
	assert.equal(body.conversation_id, 'conversation-a');
	assert.equal(body.reference.title, 'Example');
	assert.equal(state.active_conversation.id, 'conversation-a');
});

test('conversation API materializes a draft explicitly', async () => {
	const requests = [];
	const api = new ConversationApi({
		stateUrl: '/state',
		createUrl: '/create',
		materializeUrl: '/materialize',
		activateUrl: '/activate',
		renameUrl: '/rename',
		deleteUrl: '/delete',
		titleUrl: '/title',
		fetch: async (url, options) => {
			requests.push({ url, options });
			return {
				ok: true,
				async json() {
					return { ok: true, data: { state: createState() } };
				}
			};
		}
	});

	await api.materialize('draft-a');
	assert.equal(requests[0].url, '/materialize');
	assert.equal(JSON.parse(requests[0].options.body).draft_id, 'draft-a');
});

test('conversation API exposes server errors without replacing their message', async () => {
	const api = new ConversationApi({
		stateUrl: '/state',
		createUrl: '/create',
		materializeUrl: '/materialize',
		activateUrl: '/activate',
		renameUrl: '/rename',
		deleteUrl: '/delete',
		titleUrl: '/title',
		fetch: async () => ({
			ok: true,
			async json() {
				return {
					ok: false,
					error: {
						code: 'conversation_not_found',
						message: 'Conversation not found.'
					}
				};
			}
		})
	});

	await assert.rejects(
		() => api.activate('missing'),
		(error) => error.code === 'conversation_not_found' && error.message === 'Conversation not found.'
	);
});

test('conversation plugin injects only the active server conversation id', () => {
	const context = {
		getConversationId: () => 'conversation-a'
	};

	assert.deepEqual(
		ConversationPlugin.transformRequest(context, { prompt: 'Hi' }),
		{ prompt: 'Hi', conversation_id: 'conversation-a' }
	);
	assert.deepEqual(
		ConversationPlugin.transformRequest(context, { conversation_id: 'conversation-b' }),
		{ conversation_id: 'conversation-b' }
	);
});

test('conversation controls remain usable when initial history loading fails', async () => {
	const originalFetch = globalThis.fetch;
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	globalThis.fetch = async () => ({
		ok: false,
		status: 500
	});
	globalThis.window = {
		matchMedia() {
			return {
				matches: true,
				addEventListener() {}
			};
		},
		setTimeout
	};

	const createElement = () => ({
		hidden: false,
		open: false,
		inert: false,
		disabled: false,
		textContent: '',
		children: [],
		addEventListener() {},
		setAttribute() {},
		replaceChildren(...children) { this.children = children; },
		querySelector() { return null; },
		querySelectorAll() { return []; }
	});
	globalThis.document = {
		createElement
	};
	const panel = createElement();
	const list = createElement();
	const elements = new Map([
		['[data-chatbot-conversation-panel]', panel],
		['[data-chatbot-conversation-list]', list],
		['[data-chatbot-conversation-backdrop]', createElement()],
		['[data-chatbot-conversation-collapse]', createElement()]
	]);
	const controls = [];
	let loadingCalls = 0;
	let replacedMessages = 0;
	const chatbot = {
		conversationManaged: false,
		announce() {},
		showConversationLoading() { loadingCalls += 1; },
		instanceId: 'chatbot-test',
		updateLayoutMode() {},
		isCompactLayout: () => false
	};
	const context = {
		chatbot,
		root: {
			querySelector(selector) {
				return elements.get(selector) || null;
			},
			addEventListener() {},
			classList: {
				add() {},
				remove() {},
				toggle() {}
			}
		},
		signal: new AbortController().signal,
		getOptions: () => ({ strings: {} }),
		getString: (key) => key,
		getPluginOptions: () => ({
			enabled: true,
			multiple: true,
			firstMessageMode: 'contextual_ai',
			urls: {
				state: '/state',
				create: '/create',
				materialize: '/materialize',
				activate: '/activate',
				rename: '/rename',
				delete: '/delete',
				title: '/title'
			},
			strings: {}
		}),
		isSending: () => false,
		getConversationId: () => '',
		replaceMessages() { replacedMessages += 1; },
		events: {
			emit() {},
			on() { return () => {}; }
		},
		ui: {
			addControl() {
				const control = createElement();
				controls.push(control);
				return control;
			}
		}
	};

	try {
		await ConversationPlugin.install(context);
		assert.equal(chatbot.conversationManaged, false);
		assert.equal(panel.hidden, false);
		assert.equal(controls.length, 2);
		assert.equal(controls.every((control) => control.disabled === false), true);
		assert.equal(list.children.length, 1);
		assert.equal(loadingCalls, 1);
		assert.equal(replacedMessages, 1);
	} finally {
		ConversationPlugin.destroy(context);
		globalThis.fetch = originalFetch;
		globalThis.window = originalWindow;
		globalThis.document = originalDocument;
	}
});

test('conversation API binds the browser fetch implementation to globalThis', async () => {
	const originalFetch = globalThis.fetch;
	let receiver = null;
	globalThis.fetch = function() {
		receiver = this;
		return Promise.resolve({
			ok: true,
			async json() {
				return {
					ok: true,
					data: { state: createState() }
				};
			}
		});
	};

	try {
		const api = new ConversationApi({
			stateUrl: '/state',
			createUrl: '/create',
		materializeUrl: '/materialize',
			activateUrl: '/activate',
			renameUrl: '/rename',
			deleteUrl: '/delete',
			titleUrl: '/title'
		});
		await api.getState();
		assert.equal(receiver, globalThis);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

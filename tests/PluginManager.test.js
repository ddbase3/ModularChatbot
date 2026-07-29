import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatbotEventBus } from '../src/core/ChatbotEventBus.js';
import { ChatbotPluginManager } from '../src/core/ChatbotPluginManager.js';

function createChatbot() {
	return {
		root: {},
		events: new ChatbotEventBus(),
		commands: {
			register() {}
		},
		ui: {},
		signal: new AbortController().signal,
		options: {
			pluginOptions: {
				first: { enabled: true }
			}
		},
		getConversationId: () => 'conversation',
		getActiveAssistant: () => null,
		isSending: () => false,
		send() {},
		setConversation() {},
		clearConversation() {},
		replaceMessages() {},
		setOpeningMessage() {},
		setComposerValue() {},
		focusComposer() {},
		resolveGlobal() {}
	};
}

test('plugin manager rejects duplicate plugin names', async () => {
	const manager = new ChatbotPluginManager(createChatbot());
	await manager.install({ name: 'example' });

	await assert.rejects(() => manager.install({ name: 'example' }), /already installed/);
});

test('plugin manager applies request transforms in installation order', async () => {
	const manager = new ChatbotPluginManager(createChatbot());
	await manager.install({
		name: 'first',
		transformRequest(context, payload) {
			assert.equal(context.getPluginOptions().enabled, true);
			return { ...payload, first: 1 };
		}
	});
	await manager.install({
		name: 'second',
		transformRequest(context, payload) {
			return { ...payload, second: payload.first + 1 };
		}
	});

	assert.deepEqual(manager.transformRequest({ value: 1 }), {
		value: 1,
		first: 1,
		second: 2
	});
});

test('plugin manager aggregates transport events', async () => {
	const manager = new ChatbotPluginManager(createChatbot());
	await manager.install({ name: 'a', transportEvents: ['tool.started', 'tool.finished'] });
	await manager.install({ name: 'b', transportEvents: ['tool.finished', 'canvas.open'] });

	assert.deepEqual(manager.getTransportEvents(), ['tool.started', 'tool.finished', 'canvas.open']);
});

test('plugin manager waits for asynchronous plugin installation', async () => {
	const manager = new ChatbotPluginManager(createChatbot());
	const order = [];

	await manager.installAll([
		{
			name: 'first',
			async install() {
				await Promise.resolve();
				order.push('first');
			}
		},
		{
			name: 'second',
			install() {
				order.push('second');
			}
		}
	]);

	assert.deepEqual(order, ['first', 'second']);
});

test('plugin context exposes the opening-message contract used by conversation plugins', () => {
	let openingMessage = '';
	const chatbot = createChatbot();
	chatbot.setOpeningMessage = (message) => {
		openingMessage = message;
	};
	const manager = new ChatbotPluginManager(chatbot);
	const context = manager.createContext('conversation');

	assert.equal(typeof context.setOpeningMessage, 'function');
	context.setOpeningMessage('Welcome');
	assert.equal(openingMessage, 'Welcome');
	assert.equal('setBasePrompt' in context, false);
});


test('plugin manager awaits request preparation in installation order', async () => {
	const manager = new ChatbotPluginManager(createChatbot());
	await manager.install({
		name: 'first',
		async prepareRequest(context, payload) {
			await Promise.resolve();
			return { ...payload, first: true };
		}
	});
	await manager.install({
		name: 'second',
		prepareRequest(context, payload) {
			return { ...payload, second: payload.first === true };
		}
	});

	assert.deepEqual(await manager.prepareRequest({ prompt: 'Hi' }), {
		prompt: 'Hi',
		first: true,
		second: true
	});
});

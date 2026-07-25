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
		send() {},
		startNewConversation() {},
		setComposerValue() {},
		focusComposer() {},
		resolveGlobal() {}
	};
}

test('plugin manager rejects duplicate plugin names', () => {
	const manager = new ChatbotPluginManager(createChatbot());
	manager.install({ name: 'example' });

	assert.throws(() => manager.install({ name: 'example' }), /already installed/);
});

test('plugin manager applies request transforms in installation order', () => {
	const manager = new ChatbotPluginManager(createChatbot());
	manager.install({
		name: 'first',
		transformRequest(context, payload) {
			assert.equal(context.getPluginOptions().enabled, true);
			return { ...payload, first: 1 };
		}
	});
	manager.install({
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

test('plugin manager aggregates transport events', () => {
	const manager = new ChatbotPluginManager(createChatbot());
	manager.install({ name: 'a', transportEvents: ['tool.started', 'tool.finished'] });
	manager.install({ name: 'b', transportEvents: ['tool.finished', 'canvas.open'] });

	assert.deepEqual(manager.getTransportEvents(), ['tool.started', 'tool.finished', 'canvas.open']);
});

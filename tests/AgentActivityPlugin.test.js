import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatbotEventBus } from '../src/core/ChatbotEventBus.js';
import {
	AgentActivityPlugin,
	DetailedAgentActivityPlugin,
	ShimmerAgentActivityPlugin,
	createAgentActivityPlugin
} from '../src/plugins/AgentActivityPlugin.js';
import { ShimmerAgentActivityRenderer } from '../src/plugins/agent-activity/ShimmerAgentActivityRenderer.js';

function createHarness(renderer) {
	const calls = [];
	const events = new ChatbotEventBus();
	const assistant = {
		activityState: null
	};
	const context = {
		events,
		getString: (key) => key,
		chatbot: {
			hideThinking(value) {
				calls.push(['hideThinking', value]);
			},
			resetActiveAssistantTextBuffer() {
				calls.push(['resetActiveAssistantTextBuffer']);
			},
			scrollToBottom() {
				calls.push(['scrollToBottom']);
			}
		}
	};
	const plugin = createAgentActivityPlugin(renderer);
	plugin.install(context);

	return {
		assistant,
		calls,
		context,
		events,
		plugin
	};
}

test('default agent activity plugin uses the shimmer variant', () => {
	assert.equal(AgentActivityPlugin, ShimmerAgentActivityPlugin);
	assert.notEqual(AgentActivityPlugin, DetailedAgentActivityPlugin);
});

test('agent activity plugin keeps msgid available to the core while forwarding the turn id', () => {
	const calls = [];
	const renderer = {
		createState() {
			calls.push(['createState']);
			return {};
		},
		setTurnId(state, turnId) {
			calls.push(['setTurnId', turnId]);
		},
		update() {},
		onToken() {},
		complete() {}
	};
	const harness = createHarness(renderer);
	const handled = harness.plugin.onTransportEvent(
		harness.context,
		'msgid',
		{ id: 'turn-42' },
		{ assistant: harness.assistant }
	);

	assert.equal(handled, false);
	assert.deepEqual(calls, [
		['createState'],
		['setTurnId', 'turn-42']
	]);
	assert.deepEqual(harness.calls.map(([name]) => name), [
		'hideThinking',
		'scrollToBottom'
	]);
});

test('agent activity plugin normalizes tool activity once before rendering', () => {
	let activity = null;
	const renderer = {
		createState() {
			return {};
		},
		setTurnId() {},
		update(state, value) {
			activity = value;
		},
		onToken() {},
		complete() {}
	};
	const harness = createHarness(renderer);
	const handled = harness.plugin.onTransportEvent(
		harness.context,
		'tool.started',
		{
			call_id: 'call-1',
			tool: 'search',
			args: { query: 'BASE3' },
			iteration: 2,
			call_index: 1
		},
		{ assistant: harness.assistant }
	);

	assert.equal(handled, true);
	assert.equal(activity.kind, 'tool');
	assert.equal(activity.key, 'tool:call-1');
	assert.equal(activity.status, 'running');
	assert.equal(activity.label, 'search');
	assert.deepEqual(activity.args, { query: 'BASE3' });
	assert.equal(activity.iteration, 2);
	assert.equal(activity.callIndex, 1);
	assert.deepEqual(harness.calls.map(([name]) => name), [
		'hideThinking',
		'scrollToBottom'
	]);
});

test('agent activity resets streamed progress only after terminal tool events', () => {
	const renderer = {
		name: 'shimmer',
		createState() {
			return {};
		},
		setTurnId() {},
		update() {},
		onToken() {},
		complete() {}
	};

	for (const eventName of ['tool.started', 'tool.finished', 'tool.error', 'tool.failed']) {
		const harness = createHarness(renderer);
		harness.plugin.onTransportEvent(
			harness.context,
			eventName,
			{ call_id: 'call-1', tool: 'search' },
			{ assistant: harness.assistant }
		);

		const resetCalls = harness.calls.filter(([name]) => name === 'resetActiveAssistantTextBuffer');
		assert.equal(resetCalls.length, eventName === 'tool.started' ? 0 : 1);
	}
});

test('agent activity lifecycle is delegated to the selected renderer', () => {
	const calls = [];
	const renderer = {
		createState() {
			return {};
		},
		setTurnId() {},
		update() {},
		onToken(state) {
			calls.push(['token', state]);
		},
		complete(state, result) {
			calls.push(['complete', result.error]);
		}
	};
	const harness = createHarness(renderer);
	harness.assistant.activityState = { id: 'state' };

	harness.events.emit('message:token', { assistant: harness.assistant });
	harness.events.emit('message:completed', harness.assistant);
	harness.events.emit('message:error', harness.assistant);

	assert.deepEqual(calls, [
		['token', harness.assistant.activityState],
		['complete', false],
		['complete', true]
	]);
});


test('shimmer agent activity keeps the existing thinking element visible', () => {
	const renderer = {
		name: 'shimmer',
		createState() {
			return {};
		},
		setTurnId() {},
		update() {},
		onToken() {},
		complete() {}
	};
	const harness = createHarness(renderer);

	harness.plugin.onTransportEvent(
		harness.context,
		'tool.started',
		{ call_id: 'call-1', tool: 'search' },
		{ assistant: harness.assistant }
	);

	assert.deepEqual(harness.calls.map(([name]) => name), [
		'scrollToBottom'
	]);
});

test('shimmer agent activity created after streamed text starts below the assistant message', () => {
	const previousDocument = globalThis.document;
	const inserted = [];
	const activityChildren = [];

	function createElement() {
		return {
			isConnected: false,
			children: [],
			classList: {
				add() {},
				remove() {}
			},
			setAttribute() {},
			querySelector() {
				return null;
			},
			appendChild(child) {
				child.isConnected = this.isConnected;
				this.children.push(child);
			},
			remove() {
				this.isConnected = false;
			}
		};
	}

	globalThis.document = {
		createElement
	};

	try {
		const assistant = {
			thinking: { isConnected: false },
			element: {
				isConnected: true,
				after(element) {
					element.isConnected = true;
					inserted.push(element);
				}
			},
			activity: {
				appendChild(element) {
					element.isConnected = true;
					activityChildren.push(element);
				}
			}
		};

		const state = ShimmerAgentActivityRenderer.createState(assistant, {
			getString: (key) => key
		});

		assert.deepEqual(inserted, [state.element]);
		assert.deepEqual(activityChildren, []);
		assert.equal(assistant.thinking, state.element);
		assert.equal(state.element.isConnected, true);
	} finally {
		globalThis.document = previousDocument;
	}
});

test('shimmer agent activity restores the same working indicator below streamed progress', () => {
	const inserted = [];
	const anchor = {
		isConnected: true,
		after(element) {
			element.isConnected = true;
			inserted.push(element);
		}
	};
	const element = {
		isConnected: false,
		classList: {
			remove() {}
		}
	};
	const text = { textContent: '' };
	const state = {
		element,
		text,
		anchor,
		turnId: ''
	};

	ShimmerAgentActivityRenderer.update(state, {
		kind: 'tool',
		status: 'running',
		label: 'search',
		description: 'Searching'
	}, {
		getString: (key) => key
	});

	assert.deepEqual(inserted, [element]);
	assert.equal(element.isConnected, true);
	assert.equal(text.textContent, 'agentRetrievingInformation');
});

test('shimmer agent activity does not restore itself when final response tokens arrive', () => {
	const inserted = [];
	const element = {
		isConnected: false,
		classList: {
			remove() {}
		}
	};
	const state = {
		element,
		text: { textContent: '' },
		anchor: {
			isConnected: true,
			after(value) {
				inserted.push(value);
			}
		},
		turnId: ''
	};

	ShimmerAgentActivityRenderer.onToken(state, {
		getString: (key) => key
	});

	assert.deepEqual(inserted, []);
	assert.equal(state.text.textContent, 'agentCreatingResponse');
});

test('agent activity keeps a suspended review stage out of completed state', () => {
	let activity = null;
	const renderer = {
		createState() {
			return {};
		},
		setTurnId() {},
		update(state, value) {
			activity = value;
		},
		onToken() {},
		complete() {}
	};
	const harness = createHarness(renderer);

	harness.plugin.onTransportEvent(
		harness.context,
		'stage.finished',
		{
			stage_id: 'action-review',
			label: 'Action review',
			status: 'completed',
			phase_before: 'review',
			phase_after: 'awaiting-approval'
		},
		{ assistant: harness.assistant }
	);

	assert.equal(activity.status, 'awaiting_approval');
	assert.equal(activity.description, 'agentAwaitingApproval');
});

test('agent activity does not finalize the activity renderer when the message suspends for interaction', () => {
	const calls = [];
	const renderer = {
		createState() {
			return {};
		},
		setTurnId() {},
		update() {},
		onToken() {},
		complete() {
			calls.push('complete');
		}
	};
	const harness = createHarness(renderer);
	harness.assistant.activityState = { id: 'state' };

	harness.events.emit('message:completed', {
		...harness.assistant,
		interaction: true
	});

	assert.deepEqual(calls, []);
});

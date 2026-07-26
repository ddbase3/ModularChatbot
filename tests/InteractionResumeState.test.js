import assert from 'node:assert/strict';
import test from 'node:test';
import { Chatbot } from '../src/Chatbot.js';

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

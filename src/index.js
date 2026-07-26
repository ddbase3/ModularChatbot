import { Chatbot } from './Chatbot.js';

const mountedChatbots = new WeakMap();

export async function mountChatbot(root, options = {}) {
	const existing = mountedChatbots.get(root);
	if (existing) {
		existing.destroy();
	}

	const chatbot = new Chatbot(root, options);
	mountedChatbots.set(chatbot.root, chatbot);
	await chatbot.init();
	return chatbot;
}

export function getMountedChatbot(root) {
	return mountedChatbots.get(root) || null;
}

export function unmountChatbot(root) {
	const chatbot = mountedChatbots.get(root);
	if (!chatbot) {
		return;
	}

	chatbot.destroy();
	mountedChatbots.delete(root);
}

export { Chatbot } from './Chatbot.js';
export { ChatbotCommandRegistry } from './core/ChatbotCommandRegistry.js';
export { ChatbotEventBus } from './core/ChatbotEventBus.js';
export { ChatbotPluginManager } from './core/ChatbotPluginManager.js';
export { ChatbotUiRegistry } from './core/ChatbotUiRegistry.js';
export { RestChatTransport } from './transport/RestChatTransport.js';
export { SseChatTransport } from './transport/SseChatTransport.js';
export { AgentActivityPlugin } from './plugins/AgentActivityPlugin.js';
export { AgentInteractionPlugin } from './plugins/AgentInteractionPlugin.js';
export { CanvasPlugin } from './plugins/CanvasPlugin.js';
export { MarkdownPlugin } from './plugins/MarkdownPlugin.js';
export { MessageActionsPlugin } from './plugins/MessageActionsPlugin.js';
export { ReferencePlugin } from './plugins/ReferencePlugin.js';
export { SuggestionsPlugin } from './plugins/SuggestionsPlugin.js';
export { ThreadsPlugin } from './plugins/ThreadsPlugin.js';
export { VoicePlugin } from './plugins/VoicePlugin.js';

export { MistralRealtimeSpeechToTextProvider } from './speech/MistralRealtimeSpeechToTextProvider.js';

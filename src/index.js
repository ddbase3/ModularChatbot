import { Chatbot } from './Chatbot.js?build=initial-message-multiline-1';

const mountedChatbots = new WeakMap();

export async function mountChatbot(root, options = {}) {
	const existing = mountedChatbots.get(root);
	if (existing) {
		existing.destroy();
	}

	const chatbot = new Chatbot(root, options);
	mountedChatbots.set(chatbot.root, chatbot);
	try {
		await chatbot.init();
		return chatbot;
	} catch (error) {
		chatbot.destroy();
		mountedChatbots.delete(chatbot.root);
		throw error;
	}
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

export { Chatbot } from './Chatbot.js?build=initial-message-multiline-1';
export { ChatbotCommandRegistry } from './core/ChatbotCommandRegistry.js?build=conversation-draft-1';
export { ChatbotEventBus } from './core/ChatbotEventBus.js?build=conversation-draft-1';
export { ChatbotPluginManager } from './core/ChatbotPluginManager.js?build=plugin-context-i18n-1';
export { ChatbotUiRegistry } from './core/ChatbotUiRegistry.js?build=conversation-draft-1';
export { RestChatTransport } from './transport/RestChatTransport.js?build=conversation-draft-1';
export { SseChatTransport } from './transport/SseChatTransport.js?build=hitl-terminal-state-1';
export { ConversationApi, normalizeConversationState } from './conversation/ConversationApi.js?build=conversation-draft-1';
export { ConversationView } from './conversation/ConversationView.js?build=responsive-panel-initial-2';
export { AgentActivityPlugin, DetailedAgentActivityPlugin, ShimmerAgentActivityPlugin, createAgentActivityPlugin } from './plugins/AgentActivityPlugin.js?build=tool-activity-reentry-3';
export { DetailedAgentActivityRenderer } from './plugins/agent-activity/DetailedAgentActivityRenderer.js?build=agent-activity-renderers-1';
export { ShimmerAgentActivityRenderer } from './plugins/agent-activity/ShimmerAgentActivityRenderer.js?build=tool-activity-reentry-3';
export { AgentInteractionPlugin } from './plugins/AgentInteractionPlugin.js?build=hitl-terminal-state-1';
export { CanvasPlugin } from './plugins/CanvasPlugin.js?build=conversation-draft-1';
export { ConversationPlugin } from './plugins/ConversationPlugin.js?build=responsive-panel-initial-2';
export { MarkdownPlugin } from './plugins/MarkdownPlugin.js?build=initial-message-multiline-1';
export { MessageActionsPlugin } from './plugins/MessageActionsPlugin.js?build=initial-no-actions-1';
export { ReferencePlugin } from './plugins/ReferencePlugin.js?build=conversation-draft-1';
export { SuggestionsPlugin } from './plugins/SuggestionsPlugin.js?build=conversation-draft-1';
export { VoicePlugin } from './plugins/VoicePlugin.js?build=voice-services-1';

export { BackendTextToSpeechProvider } from './speech/BackendTextToSpeechProvider.js?build=tts-stream-2';
export { BackendRealtimeSpeechToTextProvider } from './speech/BackendRealtimeSpeechToTextProvider.js?build=conversation-draft-1';
export { MistralRealtimeSpeechToTextProvider } from './speech/MistralRealtimeSpeechToTextProvider.js?build=conversation-draft-1';
export { OpenAiRealtimeSpeechToTextProvider } from './speech/OpenAiRealtimeSpeechToTextProvider.js?build=conversation-draft-1';

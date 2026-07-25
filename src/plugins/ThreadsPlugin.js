export const ThreadsPlugin = {
	name: 'threads',

	install(context) {
		const options = context.getPluginOptions();
		context.ui.addControl('composer-start', {
			id: `${context.chatbot.instanceId}-threads-list`,
			label: 'Chatverläufe anzeigen',
			icon: options.icons?.list || '',
			order: 10,
			onActivate: () => {
				context.events.emit('threads:list-requested', {
					conversationId: context.getConversationId()
				});
			}
		});
		context.ui.addControl('composer-start', {
			id: `${context.chatbot.instanceId}-threads-new`,
			label: 'Neuen Chat starten',
			icon: options.icons?.plus || '',
			order: 20,
			onActivate: () => context.startNewConversation()
		});
	}
};

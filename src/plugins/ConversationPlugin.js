import { ConversationApi } from '../conversation/ConversationApi.js?build=conversation-draft-1';
import { ConversationView } from '../conversation/ConversationView.js?build=conversation-title-contract-1';
import { resolveReference } from './ReferencePlugin.js?build=conversation-draft-1';

function getReference(context) {
	return resolveReference(context);
}

function getStateConversation(state, conversationId) {
	return state.conversations.find((conversation) => conversation.id === conversationId) || null;
}

export const ConversationPlugin = {
	name: 'conversation',

	transformRequest(context, payload) {
		const conversationId = context.getConversationId();
		if (!conversationId || payload.conversation_id) {
			return payload;
		}

		return {
			...payload,
			conversation_id: conversationId
		};
	},

	async prepareRequest(context, payload) {
		const state = this.states?.get(context.chatbot);
		if (!state?.available || context.getConversationId()) {
			return payload;
		}
		if (!state.draftId) {
			throw new Error(state.options.strings?.conversationUnavailable || 'Chat history is not available.');
		}

		const conversationState = await state.api.materialize(
			state.draftId,
			getReference(context)
		);
		state.applyState(conversationState, { hydrate: true });
		const conversationId = context.getConversationId();
		if (!conversationId) {
			throw new Error('Conversation draft could not be materialized.');
		}

		return {
			...payload,
			conversation_id: conversationId
		};
	},

	async install(context) {
		const options = context.getPluginOptions();
		if (options.enabled !== true) {
			return;
		}

		const api = new ConversationApi({
			stateUrl: options.urls?.state,
			createUrl: options.urls?.create,
			materializeUrl: options.urls?.materialize,
			activateUrl: options.urls?.activate,
			renameUrl: options.urls?.rename,
			deleteUrl: options.urls?.delete,
			titleUrl: options.urls?.title,
			signal: context.signal
		});
		const state = {
			api,
			options,
			view: null,
			busy: false,
			available: false,
			draftId: '',
			applyState: null,
			unsubscribe: []
		};
		this.states ??= new WeakMap();
		this.states.set(context.chatbot, state);

		const setBusy = (busy) => {
			state.busy = Boolean(busy);
			state.view?.setBusy(state.busy || context.isSending());
		};
		const applyState = (conversationState, settings = {}) => {
			const active = conversationState.active_conversation;
			const draft = conversationState.draft;
			context.chatbot.conversationManaged = true;
			state.draftId = draft?.id || '';
			if (active) {
				context.setConversation(active);
				context.setOpeningMessage(active.opening_message);
				if (settings.hydrate !== false) {
					context.replaceMessages(conversationState.messages);
				}
			} else {
				context.clearConversation();
				context.setOpeningMessage(draft?.opening_message || '');
				if (settings.hydrate !== false) {
					context.replaceMessages(draft?.messages || []);
				}
			}
			state.view.render(conversationState, settings.focusConversationId || '');
			context.events.emit('conversation:state-applied', {
				state: conversationState,
				hydrated: settings.hydrate !== false
			});
			if (conversationState.warnings.length > 0) {
				context.chatbot.announce(conversationState.warnings[0]);
			}
		};
		state.applyState = applyState;
		const runOperation = async (operation, settings = {}) => {
			if (!state.available) {
				context.chatbot.announce(options.strings?.conversationUnavailable || 'Chat history is not available.');
				return null;
			}
			if (state.busy || context.isSending()) {
				context.chatbot.announce(options.strings?.busy || 'The current request must finish first.');
				return null;
			}

			setBusy(true);
			try {
				const conversationState = await operation();
				const appliedSettings = settings.focusConversationId === '__active__'
					? { ...settings, focusConversationId: conversationState.active_conversation?.id || '' }
					: settings;
				applyState(conversationState, appliedSettings);
				if (settings.announcement) {
					context.chatbot.announce(settings.announcement);
				}
				return conversationState;
			} catch (error) {
				if (error?.name !== 'AbortError') {
					context.events.emit('chatbot:error', error);
					context.chatbot.announce(error?.message || options.strings?.requestFailed || 'Conversation request failed.');
				}
				return null;
			} finally {
				setBusy(false);
			}
		};

		state.view = new ConversationView(context, {
			multiple: options.multiple === true,
			panelMode: options.panelMode,
			strings: options.strings,
			icons: options.icons,
			onActivate: async (conversation) => {
				const result = await runOperation(
					() => api.activate(conversation.id, getReference(context)),
					{
						hydrate: true,
						announcement: options.strings?.conversationLoaded
					}
				);
				if (result) {
					if (!state.view.media.matches) {
						state.view.setOpen(false, false);
					}
					context.focusComposer();
				}
			},
			onRename: async (conversation, title) => {
				await runOperation(
					() => api.rename(conversation.id, title, getReference(context)),
					{
						hydrate: false,
						focusConversationId: conversation.id,
						announcement: options.strings?.conversationRenamed
					}
				);
			},
			onDelete: async (conversation) => {
				return runOperation(
					() => api.delete(conversation.id, getReference(context)),
					{
						hydrate: true,
						focusConversationId: '__active__',
						announcement: options.strings?.conversationDeleted
					}
				);
			}
		});
		state.view.init();

		let toggleButton = null;
		let newButton = null;
		if (options.multiple === true) {
			toggleButton = context.ui.addControl('composer-start', {
				id: `${context.chatbot.instanceId}-conversation-list`,
				label: options.strings?.showConversations || 'Show conversations',
				icon: options.icons?.list || '',
				order: 10,
				onActivate: () => state.view.toggle()
			});
			newButton = context.ui.addControl('composer-start', {
				id: `${context.chatbot.instanceId}-conversation-new`,
				label: options.strings?.newConversation || 'Start new conversation',
				icon: options.icons?.plus || '',
				order: 20,
				onActivate: async () => {
					const result = await runOperation(
						() => api.create(getReference(context)),
						{
							hydrate: true,
							announcement: options.strings?.conversationCreated
						}
					);
					if (result) {
						context.focusComposer();
					}
				}
			});
		}
		state.view.setControls(toggleButton, newButton);

		if (!api.isAvailable()) {
			state.view.setAvailable(false);
			state.view.renderStatus(options.strings?.conversationUnavailable || 'Chat history is not available.');
			context.events.emit('chatbot:error', new Error('Conversation endpoints are incomplete.'));
			context.chatbot.announce(options.strings?.conversationUnavailable || 'Chat history is not available.');
			return;
		}

		state.available = true;
		state.view.setAvailable(true);
		state.view.enable();
		state.view.renderStatus(options.strings?.conversationLoading || 'Loading chats…');
		setBusy(true);
		let initialState = null;
		try {
			initialState = await api.getState('', getReference(context));
		} catch (error) {
			if (error?.name !== 'AbortError') {
				state.view.renderStatus(error?.message || options.strings?.conversationUnavailable || 'Chat history is not available.');
				context.events.emit('chatbot:error', error);
				context.chatbot.announce(options.strings?.conversationUnavailable || 'Chat history is not available.');
			}
			return;
		} finally {
			setBusy(false);
		}

		applyState(initialState, { hydrate: true });

		state.unsubscribe.push(
			context.events.on('chatbot:sending-changed', ({ sending }) => {
				state.view.setBusy(state.busy || sending);
			}),
			context.events.on('message:completed', async (message) => {
				if (message.interaction || message.error || !context.getConversationId()) {
					return;
				}

				const conversationId = context.getConversationId();
				try {
					const conversationState = options.automaticTitles === true
						? await api.generateTitle(conversationId, getReference(context))
						: await api.getState(conversationId, getReference(context));
					if (context.getConversationId() !== conversationId) {
						return;
					}
					const active = getStateConversation(conversationState, conversationId);
					if (!active) {
						return;
					}
					applyState({
						...conversationState,
						active_conversation: active
					}, { hydrate: false });
				} catch (error) {
					if (error?.name !== 'AbortError') {
						context.events.emit('chatbot:error', error);
					}
				}
			})
		);
	},

	destroy(context) {
		const state = this.states?.get(context.chatbot);
		if (!state) {
			return;
		}

		state.unsubscribe.forEach((unsubscribe) => unsubscribe());
		state.view?.destroy();
		this.states.delete(context.chatbot);
	}
};

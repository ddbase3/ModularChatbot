import { ConversationApi } from '../conversation/ConversationApi.js?build=hitl-lifecycle-1';
import { ConversationView } from '../conversation/ConversationView.js?build=responsive-panel-initial-2';
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
			throw new Error(state.options.strings?.conversationUnavailable || context.getString('conversationUnavailable'));
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
		const pluginOptions = context.getPluginOptions();
		const options = {
			...pluginOptions,
			strings: {
				...(context.getOptions().strings || {}),
				...(pluginOptions.strings || {})
			}
		};
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
			hasUserMessage: false,
			applyState: null,
			unsubscribe: []
		};
		this.states ??= new WeakMap();
		this.states.set(context.chatbot, state);

		const contextualOpening = String(options.firstMessageMode || '') === 'contextual_ai';
		const showOpeningLoading = () => {
			if (!contextualOpening) {
				return false;
			}

			context.chatbot.showConversationLoading();
			return true;
		};

		const setBusy = (busy) => {
			state.busy = Boolean(busy);
			state.view?.setBusy(state.busy || context.isSending());
		};
		const applyState = (conversationState, settings = {}) => {
			const active = conversationState.active_conversation;
			const draft = conversationState.draft;
			const messages = active ? conversationState.messages : (draft?.messages || []);
			context.chatbot.conversationManaged = true;
			state.draftId = draft?.id || '';
			state.hasUserMessage = messages.some((message) =>
				String(message?.role || '').toLowerCase() === 'user'
				&& String(message?.content || '').trim() !== ''
			);
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
				context.chatbot.announce(options.strings?.conversationUnavailable || context.getString('conversationUnavailable'));
				return null;
			}
			if (state.busy || context.isSending()) {
				context.chatbot.announce(options.strings?.busy || context.getString('busy'));
				return null;
			}

			const openingLoading = settings.openingLoading === true && showOpeningLoading();
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
				if (openingLoading) {
					context.replaceMessages([]);
				}
				if (error?.name !== 'AbortError') {
					context.events.emit('chatbot:error', error);
					context.chatbot.announce(error?.message || options.strings?.requestFailed || context.getString('requestFailed'));
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
					if (state.view.isCompactLayout()) {
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
				label: options.strings?.showConversations || context.getString('showConversations'),
				icon: options.icons?.list || '',
				order: 10,
				onActivate: () => state.view.toggle()
			});
			newButton = context.ui.addControl('composer-start', {
				id: `${context.chatbot.instanceId}-conversation-new`,
				label: options.strings?.newConversation || context.getString('newConversation'),
				icon: options.icons?.plus || '',
				order: 20,
				onActivate: async () => {
					const result = await runOperation(
						() => api.create(getReference(context)),
						{
							hydrate: true,
							openingLoading: true,
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
			state.view.renderStatus(options.strings?.conversationUnavailable || context.getString('conversationUnavailable'));
			context.events.emit('chatbot:error', new Error('Conversation endpoints are incomplete.'));
			context.chatbot.announce(options.strings?.conversationUnavailable || context.getString('conversationUnavailable'));
			return;
		}

		state.available = true;
		state.view.setAvailable(true);
		state.view.enable();
		state.view.renderStatus(options.strings?.conversationLoading || context.getString('conversationLoading'));
		const initialOpeningLoading = showOpeningLoading();
		setBusy(true);
		let initialState = null;
		try {
			initialState = await api.getState('', getReference(context));
		} catch (error) {
			if (initialOpeningLoading) {
				context.replaceMessages([]);
			}
			if (error?.name !== 'AbortError') {
				state.view.renderStatus(error?.message || options.strings?.conversationUnavailable || context.getString('conversationUnavailable'));
				context.events.emit('chatbot:error', error);
				context.chatbot.announce(options.strings?.conversationUnavailable || context.getString('conversationUnavailable'));
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
			context.events.on('message:starting', ({ text }) => {
				if (String(text || '').trim() !== '') {
					state.hasUserMessage = true;
				}
			}),
			context.events.on('message:completed', async (message) => {
				if (message.interaction || message.error || !context.getConversationId()) {
					return;
				}

				const conversationId = context.getConversationId();
				try {
					const conversationState = options.automaticTitles === true && state.hasUserMessage
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

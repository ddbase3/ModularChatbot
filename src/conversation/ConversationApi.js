function normalizeConversation(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}

	const id = String(value.id || '').trim();
	const title = String(value.title || '').trim();
	if (!id || !title) {
		return null;
	}

	return {
		id,
		title,
		title_source: String(value.title_source || 'temporary'),
		opening_message: String(value.opening_message || ''),
		created_at: String(value.created_at || ''),
		updated_at: String(value.updated_at || ''),
		last_active_at: String(value.last_active_at || '')
	};
}

function normalizeMessage(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}

	const role = String(value.role || '').trim().toLowerCase();
	if (!['user', 'assistant'].includes(role)) {
		return null;
	}

	return {
		id: String(value.id || value.message_id || '').trim(),
		role,
		content: String(value.content || ''),
		timestamp: String(value.timestamp || value.created_at || ''),
		feedback: value.feedback === null || value.feedback === undefined
			? null
			: String(value.feedback)
	};
}

function normalizeDraft(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}

	const id = String(value.id || '').trim();
	if (!id) {
		return null;
	}

	return {
		id,
		opening_message: String(value.opening_message || ''),
		messages: Array.isArray(value.messages)
			? value.messages.map(normalizeMessage).filter(Boolean)
			: []
	};
}

function normalizePendingInteraction(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const resumeHandle = String(value.resume_handle || '').trim();
	const requests = Array.isArray(value.interaction_requests)
		? value.interaction_requests.filter((request) => request && typeof request === 'object' && !Array.isArray(request))
		: [];
	if (!resumeHandle || requests.length === 0) {
		return null;
	}
	return {
		status: String(value.status || ''),
		resume_handle: resumeHandle,
		interaction_requests: requests
	};
}

export function normalizeConversationState(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Conversation response does not contain a valid state.');
	}

	const conversations = Array.isArray(value.conversations)
		? value.conversations.map(normalizeConversation).filter(Boolean)
		: [];
	const activeConversation = normalizeConversation(value.active_conversation);
	const draft = normalizeDraft(value.draft);
	const messages = Array.isArray(value.messages)
		? value.messages.map(normalizeMessage).filter(Boolean)
		: [];

	if (activeConversation && !conversations.some((conversation) => conversation.id === activeConversation.id)) {
		conversations.unshift(activeConversation);
	}
	if (!activeConversation && !draft) {
		throw new Error('Conversation response contains neither an active conversation nor a draft.');
	}

	return {
		conversations,
		active_conversation: activeConversation,
		draft,
		messages,
		node_id: String(value.node_id || ''),
		warnings: Array.isArray(value.warnings)
			? value.warnings.map((warning) => String(warning))
			: [],
		pending_interaction: normalizePendingInteraction(value.pending_interaction)
	};
}

export class ConversationApi {
	constructor(options = {}) {
		this.urls = {
			state: String(options.stateUrl || '').trim(),
			create: String(options.createUrl || '').trim(),
			materialize: String(options.materializeUrl || '').trim(),
			activate: String(options.activateUrl || '').trim(),
			rename: String(options.renameUrl || '').trim(),
			delete: String(options.deleteUrl || '').trim(),
			title: String(options.titleUrl || '').trim()
		};
		this.signal = options.signal || null;
		if (typeof options.fetch === 'function') {
			this.fetch = options.fetch;
		} else if (typeof globalThis.fetch === 'function') {
			this.fetch = globalThis.fetch.bind(globalThis);
		} else {
			throw new Error('Conversation API requires fetch().');
		}
	}

	isAvailable() {
		return Object.values(this.urls).every((url) => url !== '');
	}

	getState(conversationId = '', reference = null) {
		return this.request(this.urls.state, {
			conversation_id: String(conversationId || ''),
			reference
		});
	}

	create(reference = null) {
		return this.request(this.urls.create, { reference });
	}

	materialize(draftId, reference = null) {
		return this.request(this.urls.materialize, {
			draft_id: String(draftId || ''),
			reference
		});
	}

	activate(conversationId, reference = null) {
		return this.request(this.urls.activate, {
			conversation_id: String(conversationId || ''),
			reference
		});
	}

	rename(conversationId, title, reference = null) {
		return this.request(this.urls.rename, {
			conversation_id: String(conversationId || ''),
			title: String(title || ''),
			reference
		});
	}

	delete(conversationId, reference = null) {
		return this.request(this.urls.delete, {
			conversation_id: String(conversationId || ''),
			reference
		});
	}

	generateTitle(conversationId, reference = null) {
		return this.request(this.urls.title, {
			conversation_id: String(conversationId || ''),
			reference
		});
	}

	async request(url, payload) {
		if (!url) {
			throw new Error('Conversation endpoint is not configured.');
		}

		const response = await this.fetch(url, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json; charset=UTF-8',
				'Accept': 'application/json'
			},
			body: JSON.stringify(payload),
			signal: this.signal
		});
		if (!response.ok) {
			throw new Error(`Conversation endpoint returned HTTP ${response.status}.`);
		}

		const result = await response.json();
		if (!result || result.ok !== true) {
			const message = String(result?.error?.message || 'Conversation request failed.');
			const error = new Error(message);
			error.code = String(result?.error?.code || 'conversation_error');
			throw error;
		}

		return normalizeConversationState(result.data?.state);
	}
}

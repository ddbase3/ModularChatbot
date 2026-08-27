function normalizeResolution(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}

	return {
		outcome: String(value.outcome || 'resolved').trim().toLowerCase(),
		source: String(value.source || '').trim(),
		resolved_at: String(value.resolved_at || '').trim(),
		responses: Array.isArray(value.responses)
			? value.responses
				.filter((response) => response && typeof response === 'object' && !Array.isArray(response))
				.map((response) => ({
					request_id: String(response.request_id || response.id || '').trim(),
					decision: String(response.decision || '').trim().toLowerCase()
				}))
			: []
	};
}

function normalizeInteraction(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return null;
	}

	const lifecycle = String(payload.lifecycle || 'active').trim().toLowerCase();
	const resumeHandle = String(payload.resume_handle || '').trim();
	const requests = Array.isArray(payload.interaction_requests)
		? payload.interaction_requests.filter((request) => request && typeof request === 'object' && !Array.isArray(request))
		: [];
	if (requests.length === 0 || (lifecycle === 'active' && !resumeHandle)) {
		return null;
	}

	return {
		id: String(payload.interaction_id || payload.id || '').trim(),
		lifecycle,
		status: String(payload.status || ''),
		resume_handle: resumeHandle,
		created_at: String(payload.created_at || '').trim(),
		expires_at: String(payload.expires_at || '').trim(),
		interaction_requests: requests,
		resolution: normalizeResolution(payload.resolution)
	};
}

function interactionKey(interaction) {
	if (interaction.id) {
		return `id:${interaction.id}`;
	}
	if (interaction.resume_handle) {
		return `handle:${interaction.resume_handle}`;
	}
	const requestId = String(interaction.interaction_requests[0]?.id || '').trim();
	return `history:${interaction.created_at}:${requestId}`;
}

function sameInteraction(left, right) {
	if (!left || !right) {
		return false;
	}
	if (left.id && right.id) {
		return left.id === right.id;
	}
	if (left.resume_handle && right.resume_handle) {
		return left.resume_handle === right.resume_handle;
	}
	return interactionKey(left) === interactionKey(right);
}

function formatValue(context, value) {
	if (value === null || value === undefined || value === '') {
		return '-';
	}
	if (typeof value === 'boolean') {
		return value ? context.getString('yesLabel') : context.getString('noLabel');
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

function formatRisk(context, value) {
	const risk = String(value || '').trim();
	if (!risk) {
		return '';
	}

	const labels = {
		low: 'riskLow',
		medium: 'riskMedium',
		high: 'riskHigh'
	};
	const key = labels[risk.toLowerCase()];
	const level = key ? context.getString(key) : risk;
	return context.getString('riskLevel', { level });
}

function terminalStatus(context, interaction) {
	if (interaction.lifecycle === 'expired') {
		return context.getString('interactionExpired');
	}

	const outcome = String(interaction.resolution?.outcome || 'resolved').toLowerCase();
	const labels = {
		approved: 'interactionApproved',
		denied: 'interactionDenied',
		submitted: 'interactionSubmitted',
		mixed: 'interactionResolved'
	};
	return context.getString(labels[outcome] || 'interactionResolved');
}

function terminalRequestStatus(context, interaction, request) {
	const response = interaction.resolution?.responses?.find(
		(item) => item.request_id === String(request.id || '').trim()
	);
	if (!response) {
		return '';
	}
	const labels = {
		approve: 'interactionApproved',
		deny: 'interactionDenied',
		submit: 'interactionSubmitted'
	};
	const key = labels[String(response.decision || '').toLowerCase()];
	return key ? context.getString(key) : '';
}

function renderTerminalInteraction(context, container, interaction) {
	const header = document.createElement('div');
	header.className = 'base3-chatbot-interaction-terminal-header';
	const status = document.createElement('strong');
	status.className = 'base3-chatbot-interaction-status';
	status.textContent = terminalStatus(context, interaction);
	header.appendChild(status);

	if (interaction.resolution?.source === 'natural_language_ai') {
		const source = document.createElement('span');
		source.className = 'base3-chatbot-interaction-source';
		source.textContent = context.getString('interactionViaChat');
		header.appendChild(source);
	}
	container.appendChild(header);

	interaction.interaction_requests.forEach((request) => {
		const card = document.createElement('section');
		card.className = 'base3-chatbot-interaction-card base3-chatbot-interaction-card-compact';

		const heading = document.createElement('h3');
		heading.textContent = String(request.title || context.getString('interactionRequired'));
		card.appendChild(heading);

		const requestStatus = terminalRequestStatus(context, interaction, request);
		if (requestStatus) {
			const result = document.createElement('span');
			result.className = 'base3-chatbot-interaction-request-status';
			result.textContent = requestStatus;
			card.appendChild(result);
		}

		if (request.risk) {
			const risk = document.createElement('span');
			risk.className = 'base3-chatbot-interaction-risk';
			risk.textContent = formatRisk(context, request.risk);
			card.appendChild(risk);
		}
		if (request.message) {
			const message = document.createElement('p');
			message.className = 'base3-chatbot-interaction-compact-message';
			message.textContent = String(request.message);
			card.appendChild(message);
		}
		container.appendChild(card);
	});
}

function renderActiveInteraction(context, container, interaction) {
	interaction.interaction_requests.forEach((request) => {
		const card = document.createElement('section');
		card.className = 'base3-chatbot-interaction-card';

		const heading = document.createElement('h3');
		heading.textContent = String(request.title || context.getString('interactionRequired'));
		card.appendChild(heading);

		if (request.risk) {
			const risk = document.createElement('p');
			risk.className = 'base3-chatbot-interaction-risk';
			risk.textContent = formatRisk(context, request.risk);
			card.appendChild(risk);
		}
		if (request.message) {
			const message = document.createElement('p');
			message.textContent = String(request.message);
			card.appendChild(message);
		}
		if (request.summary && typeof request.summary === 'object' && !Array.isArray(request.summary)) {
			const summary = document.createElement('dl');
			summary.className = 'base3-chatbot-interaction-summary';
			Object.entries(request.summary).forEach(([label, value]) => {
				const term = document.createElement('dt');
				term.textContent = label;
				const description = document.createElement('dd');
				description.textContent = formatValue(context, value);
				summary.append(term, description);
			});
			card.appendChild(summary);
		}
		container.appendChild(card);
	});

	const approvalOnly = interaction.interaction_requests.every((request) => String(request.kind || '') === 'approval');
	if (!approvalOnly) {
		return;
	}

	const actions = document.createElement('div');
	actions.className = 'base3-chatbot-interaction-actions';
	const approve = document.createElement('button');
	approve.type = 'button';
	approve.className = 'base3-chatbot-button base3-chatbot-button-primary';
	approve.textContent = context.getString('approve');
	const deny = document.createElement('button');
	deny.type = 'button';
	deny.className = 'base3-chatbot-button';
	deny.textContent = context.getString('deny');

	const submit = (decision) => {
		approve.disabled = true;
		deny.disabled = true;
		container.classList.add('is-submitting');
		context.chatbot.resumeInteraction(interaction, decision);
	};
	approve.addEventListener('click', () => submit('approve'), { signal: context.signal });
	deny.addEventListener('click', () => submit('deny'), { signal: context.signal });
	actions.append(approve, deny);
	container.appendChild(actions);
}

function renderInteraction(context, assistant, interaction) {
	context.chatbot.showAssistant(assistant);
	assistant.content.replaceChildren();
	const container = document.createElement('div');
	container.className = 'base3-chatbot-interaction';
	container.dataset.interactionKey = interactionKey(interaction);
	if (interaction.id) {
		container.dataset.interactionId = interaction.id;
	}
	if (interaction.resume_handle) {
		container.dataset.resumeHandle = interaction.resume_handle;
	}
	container.setAttribute('role', 'group');
	container.setAttribute('aria-label', context.getString('interactionRequired'));

	if (interaction.lifecycle === 'active') {
		renderActiveInteraction(context, container, interaction);
	} else {
		container.classList.add('is-terminal', `is-${interaction.lifecycle}`);
		renderTerminalInteraction(context, container, interaction);
	}

	assistant.content.appendChild(container);
	return container;
}

function insertInteractionByTimestamp(context, assistant, interaction) {
	const timestamp = Date.parse(interaction.created_at);
	if (!Number.isFinite(timestamp)) {
		return;
	}

	assistant.element.dataset.messageTimestamp = interaction.created_at;
	const messages = Array.from(context.chatbot.elements.messages.querySelectorAll(
		'.base3-chatbot-message[data-message-timestamp]'
	));
	const next = messages.find((element) => {
		if (element === assistant.element) {
			return false;
		}
		const candidate = Date.parse(element.dataset.messageTimestamp || '');
		return Number.isFinite(candidate) && candidate > timestamp;
	});
	if (!next) {
		return;
	}

	let target = next;
	const previous = next.previousElementSibling;
	if (previous?.matches('time.base3-chatbot-message-timestamp')) {
		target = previous;
	}
	context.chatbot.elements.messages.insertBefore(assistant.element, target);
}

function restoreInteraction(context, interaction) {
	const assistant = context.chatbot.createAssistantMessage();
	assistant.completed = true;
	context.chatbot.hideThinking(assistant);
	assistant.activity?.remove();
	renderInteraction(context, assistant, interaction);
	insertInteractionByTimestamp(context, assistant, interaction);
	context.chatbot.elements.messages.classList.remove('is-empty');
	context.chatbot.root.classList.add('is-started');
	scheduleExpiry(context, assistant, interaction);
	return assistant;
}

function getPluginState(context) {
	return AgentInteractionPlugin.states?.get(context.chatbot) || null;
}

function clearTimers(context) {
	const state = getPluginState(context);
	if (!state) {
		return;
	}
	state.timers.forEach((timer) => window.clearTimeout(timer));
	state.timers.clear();
}

function clearInteractionTimer(context, interaction) {
	const state = getPluginState(context);
	if (!state) {
		return;
	}
	const key = interactionKey(interaction);
	const timer = state.timers.get(key);
	if (timer) {
		window.clearTimeout(timer);
		state.timers.delete(key);
	}
}

function scheduleExpiry(context, assistant, interaction) {
	clearInteractionTimer(context, interaction);
	if (interaction.lifecycle !== 'active' || !interaction.expires_at) {
		return;
	}
	const expiresAt = Date.parse(interaction.expires_at);
	if (!Number.isFinite(expiresAt)) {
		return;
	}

	const expire = () => {
		const terminal = {
			...interaction,
			lifecycle: 'expired',
			resume_handle: '',
			resolution: null
		};
		if (sameInteraction(context.chatbot.pendingInteraction, interaction)) {
			context.chatbot.pendingInteraction = null;
		}
		renderInteraction(context, assistant, terminal);
	};
	const remaining = expiresAt - Date.now();
	if (remaining <= 0) {
		expire();
		return;
	}

	const state = getPluginState(context);
	if (!state) {
		return;
	}
	const key = interactionKey(interaction);
	state.timers.set(key, window.setTimeout(() => {
		state.timers.delete(key);
		expire();
	}, remaining));
}

function findRenderedInteraction(context, interaction) {
	if (!interaction) {
		return null;
	}
	const containers = context.chatbot.elements.messages.querySelectorAll('.base3-chatbot-interaction');
	for (const container of containers) {
		const sameId = interaction.id && container.dataset.interactionId === interaction.id;
		const sameHandle = interaction.resume_handle && container.dataset.resumeHandle === interaction.resume_handle;
		const sameKey = container.dataset.interactionKey === interactionKey(interaction);
		if (!sameId && !sameHandle && !sameKey) {
			continue;
		}
		const element = container.closest('.base3-chatbot-message-assistant');
		const content = element?.querySelector('[data-chatbot-message-content]');
		if (!element || !content) {
			return null;
		}
		return {
			element,
			content,
			activity: null,
			thinking: null,
			completed: true
		};
	}
	return null;
}

function stateInteractions(state) {
	const interactions = Array.isArray(state?.interactions)
		? state.interactions.map(normalizeInteraction).filter(Boolean)
		: [];
	const pending = normalizeInteraction(state?.pending_interaction);
	if (pending && !interactions.some((interaction) => sameInteraction(interaction, pending))) {
		interactions.push(pending);
	}
	return interactions;
}

function hydrateInteractions(context, state) {
	clearTimers(context);
	const interactions = stateInteractions(state);
	interactions.sort((left, right) => {
		const leftTime = Date.parse(left.created_at);
		const rightTime = Date.parse(right.created_at);
		return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
	});

	const active = interactions.find((interaction) => interaction.lifecycle === 'active') || null;
	context.chatbot.pendingInteraction = active;
	interactions.forEach((interaction) => restoreInteraction(context, interaction));
}

function reconcileInteractions(context, state) {
	const interactions = stateInteractions(state);
	const active = interactions.find((interaction) => interaction.lifecycle === 'active') || null;
	context.chatbot.pendingInteraction = active;

	interactions.forEach((interaction) => {
		const assistant = findRenderedInteraction(context, interaction);
		if (!assistant) {
			return;
		}
		renderInteraction(context, assistant, interaction);
		scheduleExpiry(context, assistant, interaction);
	});
}

export const AgentInteractionPlugin = {
	name: 'agent-interaction',
	transportEvents: ['agent.interaction.required', 'agent.interaction.resolved'],

	install(context) {
		this.states ??= new WeakMap();
		const unsubscribe = context.events.on('conversation:state-applied', ({ state, hydrated }) => {
			if (hydrated) {
				hydrateInteractions(context, state);
				return;
			}
			reconcileInteractions(context, state);
		});
		this.states.set(context.chatbot, {
			unsubscribe,
			timers: new Map()
		});
	},

	destroy(context) {
		const state = this.states?.get(context.chatbot);
		if (state) {
			state.timers.forEach((timer) => window.clearTimeout(timer));
			state.unsubscribe?.();
			this.states.delete(context.chatbot);
		}
	},

	onTransportEvent(context, eventName, payload, eventContext) {
		if (eventName === 'agent.interaction.resolved') {
			const interaction = normalizeInteraction({ ...payload, lifecycle: 'resolved' });
			if (!interaction) {
				return true;
			}

			clearInteractionTimer(context, interaction);
			const assistant = findRenderedInteraction(context, interaction);
			if (assistant) {
				renderInteraction(context, assistant, interaction);
			}
			if (sameInteraction(context.chatbot.pendingInteraction, interaction)) {
				context.chatbot.pendingInteraction = null;
			}
			return {
				handled: true,
				complete: false
			};
		}

		if (eventName !== 'agent.interaction.required') {
			return false;
		}

		const interaction = normalizeInteraction({ ...payload, lifecycle: 'active' });
		if (!interaction || !eventContext.assistant) {
			return true;
		}

		context.chatbot.pendingInteraction = interaction;
		context.chatbot.hideThinking(eventContext.assistant);
		renderInteraction(context, eventContext.assistant, interaction);
		scheduleExpiry(context, eventContext.assistant, interaction);
		return {
			handled: true,
			complete: true
		};
	}
};

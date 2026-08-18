function normalizeInteraction(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return null;
	}

	const resumeHandle = String(payload.resume_handle || '').trim();
	const requests = Array.isArray(payload.interaction_requests)
		? payload.interaction_requests.filter((request) => request && typeof request === 'object')
		: [];
	if (!resumeHandle || requests.length === 0) {
		return null;
	}

	return {
		status: String(payload.status || ''),
		resume_handle: resumeHandle,
		interaction_requests: requests
	};
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

function renderInteraction(context, assistant, interaction) {
	context.chatbot.showAssistant(assistant);
	assistant.content.replaceChildren();
	const container = document.createElement('div');
	container.className = 'base3-chatbot-interaction';
	container.setAttribute('role', 'group');
	container.setAttribute('aria-label', context.getString('interactionRequired'));

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
	if (approvalOnly) {
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

	assistant.content.appendChild(container);
}

function restoreInteraction(context, interaction) {
	context.chatbot.pendingInteraction = interaction;
	const assistant = context.chatbot.createAssistantMessage();
	assistant.completed = true;
	context.chatbot.hideThinking(assistant);
	renderInteraction(context, assistant, interaction);
	context.chatbot.elements.messages.classList.remove('is-empty');
	context.chatbot.root.classList.add('is-started');
}

export const AgentInteractionPlugin = {
	name: 'agent-interaction',
	transportEvents: ['agent.interaction.required'],

	install(context) {
		this.states ??= new WeakMap();
		const unsubscribe = context.events.on('conversation:state-applied', ({ state, hydrated }) => {
			if (!hydrated) {
				return;
			}

			const interaction = normalizeInteraction(state?.pending_interaction);
			context.chatbot.pendingInteraction = interaction;
			if (interaction) {
				restoreInteraction(context, interaction);
			}
		});
		this.states.set(context.chatbot, unsubscribe);
	},

	destroy(context) {
		const unsubscribe = this.states?.get(context.chatbot);
		if (unsubscribe) {
			unsubscribe();
			this.states.delete(context.chatbot);
		}
	},

	onTransportEvent(context, eventName, payload, eventContext) {
		if (eventName !== 'agent.interaction.required') {
			return false;
		}

		const interaction = normalizeInteraction(payload);
		if (!interaction || !eventContext.assistant) {
			return true;
		}

		context.chatbot.pendingInteraction = interaction;
		context.chatbot.hideThinking(eventContext.assistant);
		renderInteraction(context, eventContext.assistant, interaction);
		return {
			handled: true,
			complete: true
		};
	}
};

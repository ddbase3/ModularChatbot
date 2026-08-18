function stageText(activity, context) {
	if (activity.status === 'awaiting_approval') {
		return context.getString('agentAwaitingApproval');
	}
	if (activity.status === 'awaiting_input') {
		return context.getString('agentAwaitingInput');
	}

	const source = `${activity.label} ${activity.description}`.toLowerCase();

	if (/final|output|response|answer|compose/.test(source)) {
		return context.getString('agentCreatingResponse');
	}
	if (/verify|review|check|guard|validat/.test(source)) {
		return context.getString('agentReviewingResult');
	}
	if (/plan|strategy|orchestrat|decid/.test(source)) {
		return context.getString('agentPlanning');
	}
	if (/context|memory|prompt|prepare|input/.test(source)) {
		return context.getString('agentPreparingContext');
	}
	if (/tool|execute|action|retriev|search/.test(source)) {
		return context.getString('agentProcessingInformation');
	}
	if (activity.status === 'completed') {
		return context.getString('agentPreparingNextStep');
	}

	return context.getString('agentProcessingRequest');
}

function resolveText(activity, context) {
	if (activity.status === 'failed') {
		return context.getString('agentReviewingNextStep');
	}
	if (activity.kind === 'tool') {
		return activity.status === 'completed'
			? context.getString('agentProcessingInformation')
			: context.getString('agentRetrievingInformation');
	}
	return stageText(activity, context);
}

function setText(state, text) {
	state.text.textContent = text;
	state.element.classList.remove('is-leaving');
}

export const ShimmerAgentActivityRenderer = {
	name: 'shimmer',

	createState(assistant, context) {
		const thinking = assistant?.thinking?.isConnected ? assistant.thinking : null;
		const element = thinking || document.createElement('div');
		element.classList.add('base3-chatbot-activity', 'base3-chatbot-activity-shimmer');
		element.setAttribute('role', 'status');
		element.setAttribute('aria-live', 'polite');

		let icon = element.querySelector('.base3-chatbot-thinking-icon');
		if (!icon) {
			icon = document.createElement('span');
			icon.className = 'base3-chatbot-activity-shimmer-icon';
			icon.setAttribute('aria-hidden', 'true');
			icon.textContent = '✦';
		}

		const dots = element.querySelector('.base3-chatbot-thinking-dots');
		if (dots) {
			dots.remove();
		}

		const text = document.createElement('span');
		text.className = 'base3-chatbot-activity-shimmer-text';
		text.textContent = context.getString('agentPreparing');
		if (!icon.isConnected) {
			element.appendChild(icon);
		}
		element.appendChild(text);

		if (!thinking) {
			assistant.activity.appendChild(element);
		}

		return {
			element,
			text,
			turnId: ''
		};
	},

	setTurnId(state, turnId) {
		state.turnId = turnId;
	},

	update(state, activity, context) {
		setText(state, resolveText(activity, context));
	},

	onToken(state, context) {
		setText(state, context.getString('agentCreatingResponse'));
	},

	complete(state) {
		if (!state.element.isConnected) {
			return;
		}
		state.element.classList.add('is-leaving');
		globalThis.setTimeout(() => {
			state.element.remove();
		}, 180);
	}
};

function createSpan(className, text = '') {
	const element = document.createElement('span');
	element.className = className;
	element.textContent = text;
	return element;
}

function createLine(activity) {
	const line = document.createElement('div');
	line.className = 'base3-chatbot-activity-line';

	const label = createSpan('base3-chatbot-activity-label');
	const description = createSpan('base3-chatbot-activity-description');
	const meta = createSpan('base3-chatbot-activity-meta');
	const status = createSpan('base3-chatbot-activity-state');
	status.setAttribute('aria-hidden', 'true');
	line.append(label, description, meta, status);

	return {
		activity,
		line,
		label,
		description,
		meta,
		status,
		params: null,
		paramsContent: null
	};
}

function createEntry(activity, context) {
	const entry = document.createElement('div');
	entry.className = `base3-chatbot-activity-entry base3-chatbot-activity-${activity.kind}`;
	entry.dataset.status = 'running';

	const record = createLine(activity);
	entry.appendChild(record.line);
	record.entry = entry;

	if (activity.kind === 'tool') {
		const params = document.createElement('details');
		params.className = 'base3-chatbot-activity-params';
		const summary = document.createElement('summary');
		summary.textContent = context.getString('agentParameters');
		const content = document.createElement('pre');
		content.textContent = '{}';
		params.append(summary, content);
		entry.appendChild(params);
		record.params = params;
		record.paramsContent = content;
	}

	return record;
}

function formatNumber(value) {
	return Number.isFinite(value) ? Math.round(value).toLocaleString() : '';
}

function resolveMeta(activity, context) {
	const parts = [];
	if (activity.iteration > 0) {
		parts.push(context.getString('agentLoop', { iteration: activity.iteration }));
	}

	if (activity.kind === 'stage') {
		if (activity.aiUsage === 'required') {
			parts.push('AI');
		} else if (activity.aiUsage === 'conditional') {
			parts.push(context.getString('agentAiIfNeeded'));
		} else if (activity.aiUsage === 'none') {
			parts.push(context.getString('agentNoAi'));
		}
		const duration = formatNumber(activity.durationMs);
		if (duration) {
			parts.push(`${duration} ms`);
		}
	} else {
		if (activity.callIndex > 0) {
			parts.push(`#${activity.callIndex}`);
		}
		if (activity.status === 'completed') {
			parts.push(activity.cached ? context.getString('agentCached') : context.getString('agentDone'));
		} else if (activity.status === 'failed') {
			parts.push(context.getString('agentFailed'));
		}
	}

	return parts.join(' · ');
}

function resolveStatusText(status) {
	if (status === 'completed') {
		return '✓';
	}
	if (status === 'failed') {
		return '!';
	}
	return '…';
}

function updateSummary(state) {
	state.count.textContent = state.rows.size > 0 ? `(${state.rows.size})` : '';
}

function updateArguments(record, args) {
	if (!record.paramsContent || args === null) {
		return;
	}

	record.paramsContent.textContent = JSON.stringify(args, null, 2);
}

export const DetailedAgentActivityRenderer = {
	name: 'detailed',

	createState(assistant, context) {
		const details = document.createElement('details');
		details.className = 'base3-chatbot-activity base3-chatbot-activity-detailed';
		details.open = true;

		const summary = document.createElement('summary');
		const summaryLabel = createSpan('base3-chatbot-activity-summary-label', context.getString('agentSteps'));
		const count = createSpan('base3-chatbot-activity-summary-count');
		summary.append(summaryLabel, count);

		const turn = document.createElement('div');
		turn.className = 'base3-chatbot-activity-turn';
		turn.hidden = true;
		turn.append(
			createSpan('base3-chatbot-activity-turn-label', context.getString('agentTurnId')),
			createSpan('base3-chatbot-activity-turn-value')
		);

		const log = document.createElement('div');
		log.className = 'base3-chatbot-activity-log';
		log.setAttribute('aria-label', context.getString('agentActivity'));
		log.setAttribute('aria-live', 'polite');
		details.append(summary, turn, log);
		assistant.activity.appendChild(details);

		return {
			details,
			count,
			turn,
			turnValue: turn.querySelector('.base3-chatbot-activity-turn-value'),
			log,
			rows: new Map()
		};
	},

	setTurnId(state, turnId) {
		if (!turnId) {
			return;
		}
		state.turnValue.textContent = turnId;
		state.turn.hidden = false;
	},

	update(state, activity, context) {
		let record = state.rows.get(activity.key);
		if (!record) {
			record = createEntry(activity, context);
			state.rows.set(activity.key, record);
			state.log.appendChild(record.entry);
		}

		record.entry.dataset.status = activity.status;
		record.label.textContent = activity.label;
		record.description.textContent = activity.description;
		record.meta.textContent = resolveMeta(activity, context);
		record.status.textContent = resolveStatusText(activity.status);
		updateArguments(record, activity.args);
		updateSummary(state);
		state.log.scrollTop = state.log.scrollHeight;
	},

	onToken(state) {
		if (state.rows.size > 0) {
			state.details.open = false;
		}
	},

	complete() {}
};

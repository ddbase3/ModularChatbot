const activityEvents = [
	'stage.started',
	'stage.finished',
	'stage.error',
	'tool.started',
	'tool.finished',
	'tool.error',
	'tool.failed'
];

function createActivityState(assistant) {
	const details = document.createElement('details');
	details.className = 'base3-chatbot-activity';
	details.open = true;

	const summary = document.createElement('summary');
	summary.textContent = 'Arbeitsschritte';
	const log = document.createElement('div');
	log.className = 'base3-chatbot-activity-log';
	log.setAttribute('aria-label', 'Agent activity');
	log.setAttribute('aria-live', 'polite');
	details.append(summary, log);
	assistant.activity.appendChild(details);

	return {
		details,
		summary,
		log,
		rows: new Map()
	};
}

function resolveKey(eventName, payload) {
	if (eventName.startsWith('stage.')) {
		return `stage:${payload?.stage_id || payload?.id || payload?.name || 'stage'}`;
	}

	return `tool:${payload?.call_id || [payload?.iteration || 0, payload?.call_index || 0, payload?.tool || payload?.label || 'tool'].join(':')}`;
}

function resolveStatus(eventName, payload) {
	if (eventName.endsWith('.error') || eventName.endsWith('.failed') || payload?.status === 'failed') {
		return 'failed';
	}
	if (eventName.endsWith('.finished')) {
		return 'completed';
	}
	return 'running';
}

function resolveLabel(eventName, payload) {
	if (eventName.startsWith('stage.')) {
		return String(payload?.label || payload?.name || payload?.stage || 'Stage');
	}
	return String(payload?.label || payload?.tool || 'Tool');
}

function resolveDescription(eventName, payload, status) {
	if (status === 'failed') {
		return String(payload?.error || payload?.message || 'fehlgeschlagen');
	}
	if (status === 'completed') {
		return payload?.cached ? 'cached' : 'abgeschlossen';
	}

	const args = payload?.args && typeof payload.args === 'object' ? payload.args : null;
	if (args) {
		const preview = args.query || args.q || args.text || args.prompt || args.input;
		if (typeof preview === 'string' && preview.trim()) {
			return preview.trim().slice(0, 120);
		}
	}

	return 'wird ausgeführt';
}

export const AgentActivityPlugin = {
	name: 'agent-activity',
	transportEvents: activityEvents,

	install(context) {
		context.events.on('message:token', ({ assistant }) => {
			const state = assistant?.activityState;
			if (state && state.log.children.length > 0) {
				state.details.open = false;
			}
		});
	},

	onTransportEvent(context, eventName, payload, eventContext) {
		if (!activityEvents.includes(eventName)) {
			return false;
		}

		const assistant = eventContext.assistant;
		if (!assistant) {
			return true;
		}
		context.chatbot.hideThinking(assistant);
		if (!assistant.activityState) {
			assistant.activityState = createActivityState(assistant);
		}

		const state = assistant.activityState;
		const key = resolveKey(eventName, payload || {});
		let row = state.rows.get(key);
		if (!row) {
			row = document.createElement('div');
			row.className = 'base3-chatbot-activity-entry';
			row.innerHTML = '<span class="base3-chatbot-activity-label"></span><span class="base3-chatbot-activity-description"></span><span class="base3-chatbot-activity-state" aria-hidden="true"></span>';
			state.rows.set(key, row);
			state.log.appendChild(row);
		}

		const status = resolveStatus(eventName, payload || {});
		row.dataset.status = status;
		row.querySelector('.base3-chatbot-activity-label').textContent = resolveLabel(eventName, payload || {});
		row.querySelector('.base3-chatbot-activity-description').textContent = resolveDescription(eventName, payload || {}, status);
		row.querySelector('.base3-chatbot-activity-state').textContent = status === 'completed' ? '✓' : (status === 'failed' ? '!' : '…');
		state.summary.textContent = `Arbeitsschritte (${state.log.children.length})`;
		state.log.scrollTop = state.log.scrollHeight;
		return true;
	}
};

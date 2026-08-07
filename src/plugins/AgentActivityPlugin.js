import { DetailedAgentActivityRenderer } from './agent-activity/DetailedAgentActivityRenderer.js?build=agent-activity-renderers-1';
import { ShimmerAgentActivityRenderer } from './agent-activity/ShimmerAgentActivityRenderer.js?build=agent-activity-renderers-1';

const activityEvents = [
	'stage.started',
	'stage.finished',
	'stage.error',
	'tool.started',
	'tool.finished',
	'tool.error',
	'tool.failed'
];

function normalizePayload(payload) {
	return payload && typeof payload === 'object' && !Array.isArray(payload)
		? payload
		: {};
}

function resolveKey(eventName, payload) {
	if (eventName.startsWith('stage.')) {
		return `stage:${payload.stage_id || payload.id || payload.name || 'stage'}:${payload.iteration || 0}`;
	}

	return `tool:${payload.call_id || [payload.iteration || 0, payload.call_index || 0, payload.tool || payload.label || 'tool'].join(':')}`;
}

function resolveStatus(eventName, payload) {
	if (eventName.endsWith('.error') || eventName.endsWith('.failed') || payload.status === 'failed') {
		return 'failed';
	}
	if (eventName.endsWith('.finished')) {
		return 'completed';
	}
	return 'running';
}

function resolveLabel(eventName, payload) {
	if (eventName.startsWith('stage.')) {
		return String(payload.label || payload.name || payload.stage || payload.id || 'Stage');
	}
	return String(payload.label || payload.tool || 'Tool');
}

function resolveDescription(eventName, payload, status) {
	if (status === 'failed') {
		return String(payload.error || payload.message || 'fehlgeschlagen');
	}

	const description = String(payload.description || '').trim();
	if (description) {
		return description;
	}

	if (status === 'completed') {
		return payload.cached ? 'cached' : 'abgeschlossen';
	}

	const args = payload.args && typeof payload.args === 'object' ? payload.args : null;
	if (args) {
		const preview = args.query || args.q || args.text || args.prompt || args.input;
		if (typeof preview === 'string' && preview.trim()) {
			return preview.trim().slice(0, 120);
		}
	}

	return 'wird ausgeführt';
}

function normalizeActivity(eventName, payload) {
	const data = normalizePayload(payload);
	const status = resolveStatus(eventName, data);

	return {
		eventName,
		kind: eventName.startsWith('stage.') ? 'stage' : 'tool',
		key: resolveKey(eventName, data),
		status,
		label: resolveLabel(eventName, data),
		description: resolveDescription(eventName, data, status),
		args: data.args && typeof data.args === 'object' ? data.args : null,
		iteration: Number(data.iteration || 0),
		callIndex: Number(data.call_index || 0),
		durationMs: Number(data.duration_ms),
		aiUsage: String(data.ai_usage || ''),
		cached: data.cached === true,
		error: String(data.error || data.message || ''),
		payload: data
	};
}

function resolveTurnId(payload) {
	if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
		return String(payload.turn_id || payload.turnId || payload.id || payload.msgid || '').trim();
	}
	return String(payload || '').trim();
}

function ensureState(renderer, assistant) {
	if (!assistant.activityState) {
		assistant.activityState = renderer.createState(assistant);
	}
	return assistant.activityState;
}

export function createAgentActivityPlugin(renderer) {
	return {
		name: 'agent-activity',
		transportEvents: activityEvents,

		install(context) {
			context.events.on('message:token', ({ assistant }) => {
				const state = assistant?.activityState;
				if (state) {
					renderer.onToken(state);
				}
			});

			context.events.on('message:completed', (message) => {
				const state = message?.activityState;
				if (state) {
					renderer.complete(state, { error: false });
				}
			});

			context.events.on('message:error', (message) => {
				const state = message?.activityState;
				if (state) {
					renderer.complete(state, { error: true });
				}
			});
		},

		onTransportEvent(context, eventName, payload, eventContext) {
			const assistant = eventContext.assistant;

			if (eventName === 'msgid') {
				if (assistant) {
					context.chatbot.hideThinking(assistant);
					const state = ensureState(renderer, assistant);
					renderer.setTurnId(state, resolveTurnId(payload));
				}
				return false;
			}

			if (!activityEvents.includes(eventName)) {
				return false;
			}
			if (!assistant) {
				return true;
			}

			context.chatbot.hideThinking(assistant);
			const state = ensureState(renderer, assistant);
			renderer.update(state, normalizeActivity(eventName, payload));
			return true;
		}
	};
}

export const DetailedAgentActivityPlugin = createAgentActivityPlugin(DetailedAgentActivityRenderer);
export const ShimmerAgentActivityPlugin = createAgentActivityPlugin(ShimmerAgentActivityRenderer);
export const AgentActivityPlugin = ShimmerAgentActivityPlugin;

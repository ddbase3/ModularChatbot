const coreEventNames = ['msgid', 'token', 'done', 'error'];

export class SseChatTransport {
	constructor(options = {}) {
		this.options = options;
		this.eventSource = null;
		this.prepareAbortController = null;
		this.resolveCurrentSend = null;
	}

	async send({ payload, events = [], onEvent, signal }) {
		this.close();
		this.prepareAbortController = new AbortController();
		const prepareSignal = this.resolveSignal(signal, this.prepareAbortController.signal);

		try {
			const response = await fetch(this.options.prepareUrl, {
				method: 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json; charset=UTF-8'
				},
				body: JSON.stringify({
					service: this.options.service,
					payload
				}),
				signal: prepareSignal
			});

			const info = await response.json();
			if (!response.ok || info?.ok !== true || !info.stream) {
				throw new Error(info?.error ? String(info.error) : 'Chatbot turn preparation failed.');
			}

			await this.openEventSource(String(info.stream), events, onEvent, signal);
		} catch (error) {
			if (error?.name === 'AbortError') {
				return;
			}

			onEvent('error', {
				message: error?.message ? String(error.message) : String(error),
				user_message: 'Der Chat-Stream konnte nicht gestartet werden.'
			});
		}
	}

	openEventSource(url, events, onEvent, signal) {
		return new Promise((resolve) => {
			this.resolveCurrentSend = resolve;
			const eventSource = new EventSource(url, { withCredentials: true });
			this.eventSource = eventSource;

			const dispatch = (eventName, rawValue) => {
				const result = onEvent(eventName, this.parseData(rawValue));
				if (result?.close || eventName === 'done' || eventName === 'error') {
					this.close();
				}
			};

			eventSource.onmessage = (event) => {
				dispatch('message', event.data);
			};

			const eventNames = new Set([
				...coreEventNames,
				...events.map((eventName) => String(eventName))
			]);
			eventNames.forEach((eventName) => {
				eventSource.addEventListener(eventName, (event) => {
					dispatch(eventName, event.data);
				});
			});

			if (signal) {
				if (signal.aborted) {
					this.close();
				} else {
					signal.addEventListener('abort', () => this.close(), { once: true });
				}
			}
		});
	}

	resolveSignal(primary, secondary) {
		if (!primary) {
			return secondary;
		}
		if (typeof AbortSignal.any === 'function') {
			return AbortSignal.any([primary, secondary]);
		}
		if (primary.aborted) {
			this.prepareAbortController.abort();
		} else {
			primary.addEventListener('abort', () => this.prepareAbortController.abort(), { once: true });
		}
		return secondary;
	}

	parseData(value) {
		try {
			return JSON.parse(value);
		} catch (error) {
			return value;
		}
	}

	close() {
		if (this.prepareAbortController) {
			this.prepareAbortController.abort();
			this.prepareAbortController = null;
		}
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
		}
		if (this.resolveCurrentSend) {
			const resolve = this.resolveCurrentSend;
			this.resolveCurrentSend = null;
			resolve();
		}
	}
}

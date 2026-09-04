export class RestChatTransport {
	constructor(options = {}) {
		this.options = options;
		this.abortController = null;
	}

	async send({ payload, onEvent, signal }) {
		this.close();
		this.abortController = new AbortController();
		const combinedSignal = this.resolveSignal(signal, this.abortController.signal);

		try {
			const response = await fetch(this.options.serviceUrl, {
				method: 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
				},
				body: new URLSearchParams(payload),
				signal: combinedSignal
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const data = await response.json();
			if (data?.id) {
				onEvent('msgid', { id: data.id });
			}

			if (data?.type === 'interaction_required') {
				onEvent('agent.interaction.required', data);
				return;
			}

			if (data?.type === 'cancelled' || data?.status === 'cancelled') {
				onEvent('done', {
					status: 'cancelled'
				});
				return;
			}

			onEvent('token', {
				text: String(data?.text || '')
			});
			onEvent('done', {
				status: String(data?.status || 'completed')
			});
		} catch (error) {
			if (error?.name === 'AbortError') {
				return;
			}

			onEvent('error', {
				message: error?.message ? String(error.message) : String(error),
				user_message: 'Fehler bei der Serveranfrage.'
			});
		}
	}

	resolveSignal(primary, secondary) {
		if (!primary) {
			return secondary;
		}
		if (typeof AbortSignal.any === 'function') {
			return AbortSignal.any([primary, secondary]);
		}
		if (primary.aborted) {
			this.abortController.abort();
		} else {
			primary.addEventListener('abort', () => this.abortController.abort(), { once: true });
		}
		return secondary;
	}

	close() {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}
}

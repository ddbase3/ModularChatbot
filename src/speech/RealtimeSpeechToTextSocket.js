function createAbortError(message) {
	const error = new Error(message);
	error.name = 'AbortError';
	return error;
}

function normalizeCloseReason(event) {
	const code = Number(event?.code || 0);
	const reason = String(event?.reason || '').trim();
	const parts = [];

	if (code > 0) {
		parts.push(`code ${code}`);
	}
	if (reason) {
		parts.push(reason);
	}

	return parts.length ? ` (${parts.join(': ')})` : '';
}

export function getRealtimeErrorMessage(message, fallback) {
	const direct = String(message?.error?.message || message?.message || '').trim();
	if (direct) {
		return direct;
	}

	const detail = String(message?.error?.detail || message?.detail || '').trim();
	return detail || fallback;
}

export class RealtimeSpeechToTextSocket {
	constructor(options = {}) {
		this.options = {
			providerName: 'Realtime speech-to-text',
			endpoint: '',
			protocols: [],
			handshakeTimeoutMs: 10000,
			onMessage() {},
			onError() {},
			onClose() {},
			...options
		};
		this.socket = null;
		this.ready = false;
		this.settled = false;
		this.cancelled = false;
		this.handshakeTimer = null;
		this.resolveReady = null;
		this.rejectReady = null;
	}

	open() {
		if (this.socket) {
			return Promise.reject(new Error(`${this.options.providerName} connection is already open.`));
		}

		return new Promise((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;

			try {
				this.socket = new WebSocket(this.options.endpoint, this.options.protocols);
			} catch (error) {
				this.rejectBeforeReady(error);
				return;
			}

			const timeout = Number(this.options.handshakeTimeoutMs);
			if (timeout > 0) {
				this.handshakeTimer = setTimeout(() => {
					this.rejectBeforeReady(new Error(
						`${this.options.providerName} connection timed out during initialization.`
					));
					this.closeSocket();
				}, timeout);
			}

			this.socket.onmessage = (event) => {
				let message;
				try {
					message = JSON.parse(event.data);
				} catch (error) {
					this.handleError(error);
					return;
				}

				Promise.resolve(this.options.onMessage(message)).catch((error) => {
					this.handleError(error);
				});
			};

			this.socket.onerror = () => {
				this.handleError(new Error(`${this.options.providerName} connection failed.`));
			};

			this.socket.onclose = (event) => {
				const wasReady = this.ready;
				this.socket = null;
				this.clearHandshakeTimer();

				if (this.cancelled) {
					return;
				}
				if (!wasReady) {
					this.rejectBeforeReady(new Error(
						`${this.options.providerName} connection closed before initialization${normalizeCloseReason(event)}.`
					));
					return;
				}

				this.options.onClose(event);
			};
		});
	}

	markReady() {
		if (this.settled || this.cancelled) {
			return;
		}

		this.ready = true;
		this.settled = true;
		this.clearHandshakeTimer();
		this.resolveReady?.();
		this.resolveReady = null;
		this.rejectReady = null;
	}

	isOpen() {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	send(message) {
		if (!this.isOpen()) {
			throw new Error(`${this.options.providerName} connection is not open.`);
		}

		this.socket.send(JSON.stringify(message));
	}

	cancel() {
		if (this.cancelled) {
			return;
		}

		this.cancelled = true;
		if (!this.settled) {
			this.rejectBeforeReady(createAbortError(`${this.options.providerName} connection was cancelled.`));
		}
		this.closeSocket();
	}

	close() {
		this.closeSocket();
	}

	handleError(error) {
		if (!this.ready) {
			this.rejectBeforeReady(error);
			this.closeSocket();
			return;
		}

		this.options.onError(error);
	}

	rejectBeforeReady(error) {
		if (this.settled) {
			return;
		}

		this.settled = true;
		this.clearHandshakeTimer();
		this.rejectReady?.(error);
		this.resolveReady = null;
		this.rejectReady = null;
	}

	clearHandshakeTimer() {
		clearTimeout(this.handshakeTimer);
		this.handshakeTimer = null;
	}

	closeSocket() {
		if (!this.socket) {
			return;
		}

		const socket = this.socket;
		this.socket = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		try {
			socket.close();
		} catch (error) {
		}
	}
}

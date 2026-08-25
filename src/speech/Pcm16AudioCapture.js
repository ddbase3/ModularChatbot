const DEFAULT_SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 44100, 48000];
const DEFAULT_CHUNK_DURATION_MS = 20;
const STOP_TIMEOUT_MS = 1500;

class Deferred {
	constructor() {
		this.settled = false;
		this.promise = new Promise((resolve, reject) => {
			this.resolveInternal = resolve;
			this.rejectInternal = reject;
		});
		this.promise.catch(() => {});
	}

	resolve(value) {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.resolveInternal(value);
	}

	reject(error) {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.rejectInternal(error);
	}
}

function withTimeout(promise, milliseconds, message) {
	return new Promise((resolve, reject) => {
		const timer = globalThis.setTimeout(() => reject(new Error(message)), milliseconds);
		promise.then((value) => {
			globalThis.clearTimeout(timer);
			resolve(value);
		}, (error) => {
			globalThis.clearTimeout(timer);
			reject(error);
		});
	});
}

function createWorkletModuleUrl(chunkDurationMs) {
	const source = [
		"class SttCaptureProcessor extends AudioWorkletProcessor {",
		"\tconstructor(options) {",
		"\t\tsuper();",
		"\t\tthis.active = true;",
		`\t\tthis.chunkSamples = Math.max(128, Math.round(sampleRate * ((options.processorOptions && options.processorOptions.chunkMs) || ${Number(chunkDurationMs) || DEFAULT_CHUNK_DURATION_MS}) / 1000));`,
		"\t\tthis.levelSamples = Math.max(128, Math.round(sampleRate * 0.04));",
		"\t\tthis.chunk = new Int16Array(this.chunkSamples);",
		"\t\tthis.offset = 0; this.square = 0; this.peak = 0; this.levelCount = 0;",
		"\t\tthis.port.onmessage = (event) => { if (event.data && event.data.type === 'stop') this.stopCapture(); };",
		"\t}",
		"\tprocess(inputs) {",
		"\t\tif (!this.active) return true;",
		"\t\tconst channels = inputs[0]; if (!channels || !channels.length) return true;",
		"\t\tconst frames = channels[0].length;",
		"\t\tfor (let frame = 0; frame < frames; frame++) {",
		"\t\t\tlet sample = 0; for (let channel = 0; channel < channels.length; channel++) sample += channels[channel][frame] || 0;",
		"\t\t\tsample = Math.max(-1, Math.min(1, sample / channels.length));",
		"\t\t\tthis.square += sample * sample; this.peak = Math.max(this.peak, Math.abs(sample)); this.levelCount++;",
		"\t\t\tthis.chunk[this.offset++] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);",
		"\t\t\tif (this.offset === this.chunkSamples) this.emitChunk();",
		"\t\t\tif (this.levelCount >= this.levelSamples) this.emitLevel();",
		"\t\t}",
		"\t\treturn true;",
		"\t}",
		"\temitChunk() { const buffer = this.chunk.buffer; this.port.postMessage({ type: 'audio', buffer }, [buffer]); this.chunk = new Int16Array(this.chunkSamples); this.offset = 0; }",
		"\temitLevel() { const rms = this.levelCount ? Math.sqrt(this.square / this.levelCount) : 0; this.port.postMessage({ type: 'level', rms, peak: this.peak }); this.square = 0; this.peak = 0; this.levelCount = 0; }",
		"\tstopCapture() { if (!this.active) return; this.active = false; if (this.offset) { const partial = new Int16Array(this.offset); partial.set(this.chunk.subarray(0, this.offset)); this.port.postMessage({ type: 'audio', buffer: partial.buffer }, [partial.buffer]); this.offset = 0; } this.emitLevel(); this.port.postMessage({ type: 'stopped' }); }",
		"}",
		"registerProcessor('stt-capture-processor', SttCaptureProcessor);"
	].join('\n');
	return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}

export function arrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const step = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += step) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)));
	}
	return btoa(binary);
}

export class Pcm16AudioCapture {
	constructor(options = {}) {
		this.options = {
			chunkDurationMs: DEFAULT_CHUNK_DURATION_MS,
			supportedSampleRates: DEFAULT_SUPPORTED_SAMPLE_RATES,
			onChunk() {},
			onLevel() {},
			...options
		};
		this.context = null;
		this.source = null;
		this.node = null;
		this.silentGain = null;
		this.workletUrl = '';
		this.stopped = null;
		this.running = false;
	}

	get sampleRate() {
		return Number(this.context?.sampleRate || 0);
	}

	async start(mediaStream) {
		if (this.running) {
			return;
		}
		if (!mediaStream) {
			throw new Error('A microphone stream is required for PCM capture.');
		}
		const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
		if (!AudioContextClass || !globalThis.AudioWorkletNode) {
			throw new Error('AudioWorklet is not available.');
		}

		this.context = new AudioContextClass({ latencyHint: 'interactive', sampleRate: 48000 });
		const supportedSampleRates = Array.isArray(this.options.supportedSampleRates)
			? this.options.supportedSampleRates.map(Number)
			: DEFAULT_SUPPORTED_SAMPLE_RATES;
		if (!supportedSampleRates.includes(this.context.sampleRate)) {
			const sampleRate = this.context.sampleRate;
			await this.context.close();
			this.context = null;
			throw new Error(`Unsupported microphone sample rate: ${sampleRate}.`);
		}

		this.workletUrl = createWorkletModuleUrl(this.options.chunkDurationMs);
		try {
			await this.context.audioWorklet.addModule(this.workletUrl);
		} catch (error) {
			URL.revokeObjectURL(this.workletUrl);
			this.workletUrl = '';
			await this.context.close();
			this.context = null;
			throw error;
		}
		URL.revokeObjectURL(this.workletUrl);
		this.workletUrl = '';

		this.source = this.context.createMediaStreamSource(mediaStream);
		this.node = new AudioWorkletNode(this.context, 'stt-capture-processor', {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [1],
			processorOptions: {
				chunkMs: Number(this.options.chunkDurationMs) || DEFAULT_CHUNK_DURATION_MS
			}
		});
		this.silentGain = this.context.createGain();
		this.silentGain.gain.value = 0;
		this.node.connect(this.silentGain);
		this.silentGain.connect(this.context.destination);
		this.stopped = new Deferred();
		this.node.port.onmessage = (event) => {
			if (!event.data) {
				return;
			}
			if (event.data.type === 'audio' && event.data.buffer instanceof ArrayBuffer) {
				this.options.onChunk(event.data.buffer);
				return;
			}
			if (event.data.type === 'level') {
				this.options.onLevel(event.data.rms, event.data.peak);
				return;
			}
			if (event.data.type === 'stopped') {
				this.stopped.resolve();
			}
		};

		if (this.context.state === 'suspended') {
			await this.context.resume();
		}
		this.source.connect(this.node);
		this.running = true;
	}

	async stop() {
		if (!this.context) {
			return;
		}
		if (this.running && this.node) {
			this.node.port.postMessage({ type: 'stop' });
			await withTimeout(
				this.stopped?.promise || Promise.resolve(),
				STOP_TIMEOUT_MS,
				'The microphone capture could not be stopped cleanly.'
			);
		}
		this.running = false;
		try {
			this.source?.disconnect();
		} catch (error) {
		}
		try {
			this.node?.disconnect();
		} catch (error) {
		}
		try {
			this.silentGain?.disconnect();
		} catch (error) {
		}
		this.node && (this.node.port.onmessage = null);
		if (this.context.state !== 'closed') {
			await this.context.close();
		}
		this.context = null;
		this.source = null;
		this.node = null;
		this.silentGain = null;
		this.stopped = null;
	}

	destroy() {
		this.running = false;
		if (this.node) {
			this.node.port.onmessage = null;
		}
		try {
			this.source?.disconnect();
		} catch (error) {
		}
		try {
			this.node?.disconnect();
		} catch (error) {
		}
		try {
			this.silentGain?.disconnect();
		} catch (error) {
		}
		if (this.context && this.context.state !== 'closed') {
			void this.context.close();
		}
		if (this.workletUrl) {
			URL.revokeObjectURL(this.workletUrl);
		}
		this.context = null;
		this.source = null;
		this.node = null;
		this.silentGain = null;
		this.workletUrl = '';
		this.stopped = null;
	}
}

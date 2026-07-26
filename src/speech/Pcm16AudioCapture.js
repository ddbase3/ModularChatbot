function calculateRms(input) {
	if (!input.length) {
		return 0;
	}

	let sum = 0;
	for (const sample of input) {
		sum += sample * sample;
	}

	return Math.sqrt(sum / input.length);
}

function resample(input, sourceRate, targetRate) {
	if (sourceRate === targetRate) {
		return input;
	}

	const ratio = sourceRate / targetRate;
	const length = Math.max(1, Math.round(input.length / ratio));
	const output = new Float32Array(length);

	for (let index = 0; index < length; index += 1) {
		const start = Math.floor(index * ratio);
		const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
		let sum = 0;

		for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
			sum += input[sourceIndex];
		}

		output[index] = sum / Math.max(1, end - start);
	}

	return output;
}

function floatToPcm16(input) {
	const output = new Int16Array(input.length);

	for (let index = 0; index < input.length; index += 1) {
		const sample = Math.max(-1, Math.min(1, input[index]));
		output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
	}

	return output;
}

function createWorkletModuleUrl() {
	const source = `
		class Base3PcmCaptureProcessor extends AudioWorkletProcessor {
			process(inputs) {
				const channel = inputs[0] && inputs[0][0];
				if (channel && channel.length) {
					this.port.postMessage(channel.slice(0));
				}
				return true;
			}
		}
		registerProcessor('base3-pcm-capture', Base3PcmCaptureProcessor);
	`;

	return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}

function concatPcm(left, right) {
	if (!left.length) {
		return right;
	}

	const output = new Int16Array(left.length + right.length);
	output.set(left, 0);
	output.set(right, left.length);
	return output;
}

export function pcm16ToBase64(input) {
	const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	let binary = '';
	const chunkSize = 0x8000;

	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}

	return btoa(binary);
}

export class Pcm16AudioCapture {
	constructor(options = {}) {
		this.options = {
			sampleRate: 16000,
			chunkDurationMs: 160,
			onChunk() {},
			onLevel() {},
			...options
		};
		this.stream = null;
		this.audioContext = null;
		this.sourceNode = null;
		this.workletNode = null;
		this.silentGain = null;
		this.workletModuleUrl = '';
		this.pending = new Int16Array(0);
		this.running = false;
	}

	async start() {
		if (this.running) {
			return;
		}

		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			}
		});
		this.audioContext = new AudioContext();
		if (this.audioContext.state === 'suspended') {
			await this.audioContext.resume();
		}
		this.workletModuleUrl = createWorkletModuleUrl();
		await this.audioContext.audioWorklet.addModule(this.workletModuleUrl);
		this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
		this.workletNode = new AudioWorkletNode(this.audioContext, 'base3-pcm-capture');
		this.silentGain = this.audioContext.createGain();
		this.silentGain.gain.value = 0;
		this.workletNode.port.onmessage = (event) => this.handleAudio(event.data);
		this.sourceNode.connect(this.workletNode);
		this.workletNode.connect(this.silentGain);
		this.silentGain.connect(this.audioContext.destination);
		this.pending = new Int16Array(0);
		this.running = true;
	}

	stop(flush = true) {
		if (flush && this.pending.length) {
			this.options.onChunk(this.pending);
		}
		this.pending = new Int16Array(0);
		this.running = false;

		if (this.workletNode) {
			this.workletNode.port.onmessage = null;
			this.workletNode.disconnect();
		}
		this.sourceNode?.disconnect();
		this.silentGain?.disconnect();
		this.stream?.getTracks().forEach((track) => track.stop());
		this.audioContext?.close();
		this.workletNode = null;
		this.sourceNode = null;
		this.silentGain = null;
		this.stream = null;
		this.audioContext = null;
		if (this.workletModuleUrl) {
			URL.revokeObjectURL(this.workletModuleUrl);
			this.workletModuleUrl = '';
		}
	}

	handleAudio(input) {
		if (!this.running || !(input instanceof Float32Array) || !this.audioContext) {
			return;
		}

		this.options.onLevel(calculateRms(input), Date.now());
		const converted = floatToPcm16(resample(
			input,
			this.audioContext.sampleRate,
			Number(this.options.sampleRate)
		));
		this.pending = concatPcm(this.pending, converted);

		const chunkSamples = Math.max(
			1,
			Math.round(Number(this.options.sampleRate) * Number(this.options.chunkDurationMs) / 1000)
		);
		while (this.pending.length >= chunkSamples) {
			const chunk = this.pending.slice(0, chunkSamples);
			this.pending = this.pending.slice(chunkSamples);
			this.options.onChunk(chunk);
		}
	}
}

function createAbortError() {
	return new DOMException('Text-to-speech playback was aborted.', 'AbortError');
}

function concatBytes(left, right) {
	if (!left.length) {
		return right.slice();
	}
	if (!right.length) {
		return left;
	}

	const output = new Uint8Array(left.length + right.length);
	output.set(left, 0);
	output.set(right, left.length);
	return output;
}

function readAscii(bytes, offset, length) {
	let value = '';
	for (let index = 0; index < length; index += 1) {
		value += String.fromCharCode(bytes[offset + index]);
	}
	return value;
}

function clipSample(value) {
	return Math.max(-1, Math.min(1, value));
}

class WavStreamDecoder {
	constructor(onFrames) {
		this.onFrames = onFrames;
		this.buffer = new Uint8Array(0);
		this.sampleRemainder = new Uint8Array(0);
		this.riffRead = false;
		this.dataStarted = false;
		this.dataRemaining = null;
		this.format = null;
		this.framesDecoded = 0;
	}

	push(chunk) {
		if (!(chunk instanceof Uint8Array) || !chunk.length) {
			return;
		}

		this.buffer = concatBytes(this.buffer, chunk);
		this.parse();
	}

	finish() {
		this.parse();
		if (!this.riffRead || !this.format || !this.dataStarted) {
			throw new Error('Text-to-speech response is not a valid WAV stream.');
		}
		if (!this.framesDecoded) {
			throw new Error('Text-to-speech WAV stream contains no audio frames.');
		}
	}

	parse() {
		if (!this.riffRead) {
			if (this.buffer.length < 12) {
				return;
			}
			if (readAscii(this.buffer, 0, 4) !== 'RIFF' || readAscii(this.buffer, 8, 4) !== 'WAVE') {
				throw new Error('Text-to-speech response is not a RIFF/WAVE stream.');
			}
			this.buffer = this.buffer.slice(12);
			this.riffRead = true;
		}

		while (!this.dataStarted) {
			if (this.buffer.length < 8) {
				return;
			}

			const id = readAscii(this.buffer, 0, 4);
			const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
			const size = view.getUint32(4, true);
			if (id === 'data') {
				if (!this.format) {
					throw new Error('Text-to-speech WAV stream has no format chunk.');
				}
				this.buffer = this.buffer.slice(8);
				this.dataStarted = true;
				this.dataRemaining = size === 0 || size === 0xffffffff ? null : size;
				break;
			}

			const paddedSize = size + (size % 2);
			if (this.buffer.length < 8 + paddedSize) {
				return;
			}
			if (id === 'fmt ') {
				this.readFormat(this.buffer.slice(8, 8 + size));
			}
			this.buffer = this.buffer.slice(8 + paddedSize);
		}

		if (!this.dataStarted || !this.buffer.length) {
			return;
		}

		const available = this.dataRemaining === null
			? this.buffer.length
			: Math.min(this.buffer.length, this.dataRemaining);
		if (!available) {
			return;
		}

		const audio = this.buffer.slice(0, available);
		this.buffer = this.buffer.slice(available);
		if (this.dataRemaining !== null) {
			this.dataRemaining -= available;
		}
		this.decodeAudio(audio);
	}

	readFormat(bytes) {
		if (bytes.length < 16) {
			throw new Error('Text-to-speech WAV format chunk is incomplete.');
		}

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let formatCode = view.getUint16(0, true);
		if (formatCode === 0xfffe && bytes.length >= 40) {
			formatCode = view.getUint16(24, true);
		}

		const channels = view.getUint16(2, true);
		const sampleRate = view.getUint32(4, true);
		const blockAlign = view.getUint16(12, true);
		const bitsPerSample = view.getUint16(14, true);
		if (![1, 3].includes(formatCode)) {
			throw new Error(`Unsupported WAV sample format: ${formatCode}`);
		}
		if (!channels || !sampleRate || !blockAlign || !bitsPerSample) {
			throw new Error('Text-to-speech WAV format is invalid.');
		}
		if (formatCode === 3 && bitsPerSample !== 32) {
			throw new Error(`Unsupported WAV float width: ${bitsPerSample}`);
		}
		if (formatCode === 1 && ![8, 16, 24, 32].includes(bitsPerSample)) {
			throw new Error(`Unsupported WAV PCM width: ${bitsPerSample}`);
		}

		this.format = {
			formatCode,
			channels,
			sampleRate,
			blockAlign,
			bitsPerSample
		};
	}

	decodeAudio(bytes) {
		const input = concatBytes(this.sampleRemainder, bytes);
		const frameCount = Math.floor(input.length / this.format.blockAlign);
		const consumed = frameCount * this.format.blockAlign;
		this.sampleRemainder = input.slice(consumed);
		if (!frameCount) {
			return;
		}

		const channels = Array.from(
			{ length: this.format.channels },
			() => new Float32Array(frameCount)
		);
		const view = new DataView(input.buffer, input.byteOffset, consumed);
		const bytesPerSample = this.format.bitsPerSample / 8;

		for (let frame = 0; frame < frameCount; frame += 1) {
			for (let channel = 0; channel < this.format.channels; channel += 1) {
				const offset = frame * this.format.blockAlign + channel * bytesPerSample;
				channels[channel][frame] = this.readSample(view, offset);
			}
		}

		this.framesDecoded += frameCount;
		this.onFrames(this.format, channels, frameCount);
	}

	readSample(view, offset) {
		if (this.format.formatCode === 3) {
			return clipSample(view.getFloat32(offset, true));
		}

		switch (this.format.bitsPerSample) {
			case 8:
				return (view.getUint8(offset) - 128) / 128;
			case 16:
				return view.getInt16(offset, true) / 32768;
			case 24: {
				let value = view.getUint8(offset)
					| (view.getUint8(offset + 1) << 8)
					| (view.getUint8(offset + 2) << 16);
				if (value & 0x800000) {
					value |= 0xff000000;
				}
				return value / 8388608;
			}
			case 32:
				return view.getInt32(offset, true) / 2147483648;
			default:
				return 0;
		}
	}
}

export class StreamingWavAudioPlayer {
	constructor(response, signal, audioContext) {
		this.response = response;
		this.signal = signal;
		this.audioContext = audioContext;
		this.reader = null;
		this.sources = new Set();
		this.nextStartTime = 0;
		this.lastCompletion = Promise.resolve();
		this.stopped = false;
	}

	async play() {
		const contentType = String(this.response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
		if (!['audio/wav', 'audio/x-wav', 'audio/wave'].includes(contentType)) {
			throw new Error(`Text-to-speech streaming requires WAV audio, received: ${contentType || 'unknown'}`);
		}
		if (!this.response.body) {
			throw new Error('Text-to-speech response has no readable audio stream.');
		}
		if (this.audioContext.state === 'suspended') {
			await this.audioContext.resume();
		}

		const decoder = new WavStreamDecoder((format, channels, frameCount) => {
			this.schedule(format, channels, frameCount);
		});
		this.reader = this.response.body.getReader();

		try {
			while (true) {
				this.throwIfStopped();
				const { done, value } = await this.reader.read();
				if (done) {
					break;
				}
				decoder.push(value);
			}
			decoder.finish();
			this.throwIfStopped();
			await this.lastCompletion;
		} finally {
			this.reader = null;
		}
	}

	stop() {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.reader?.cancel().catch(() => {});
		for (const source of this.sources) {
			try {
				source.stop();
			} catch (error) {
			}
			source.disconnect();
		}
		this.sources.clear();
	}

	schedule(format, channels, frameCount) {
		this.throwIfStopped();
		const buffer = this.audioContext.createBuffer(format.channels, frameCount, format.sampleRate);
		for (let channel = 0; channel < format.channels; channel += 1) {
			buffer.copyToChannel(channels[channel], channel);
		}

		const source = this.audioContext.createBufferSource();
		source.buffer = buffer;
		source.connect(this.audioContext.destination);
		this.sources.add(source);

		let resolveCompletion;
		this.lastCompletion = new Promise((resolve) => {
			resolveCompletion = resolve;
		});
		source.onended = () => {
			this.sources.delete(source);
			source.disconnect();
			resolveCompletion();
		};

		const initialDelay = this.nextStartTime > 0 ? 0.02 : 0.08;
		const startTime = Math.max(this.nextStartTime, this.audioContext.currentTime + initialDelay);
		source.start(startTime);
		this.nextStartTime = startTime + buffer.duration;
	}

	throwIfStopped() {
		if (this.stopped || this.signal.aborted) {
			throw createAbortError();
		}
	}
}

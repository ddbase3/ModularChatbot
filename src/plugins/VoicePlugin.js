import { BackendTextToSpeechProvider } from '../speech/BackendTextToSpeechProvider.js?build=tts-stream-2';
import { BackendRealtimeSpeechToTextProvider } from '../speech/BackendRealtimeSpeechToTextProvider.js';
import { needsDictationSpace } from '../speech/MistralTranscript.js';

const DIALOG_SILENCE_MS = 3000;
const VOICE_RMS_THRESHOLD = 0.012;

function cleanText(value) {
	return String(value || '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/[`*_#]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function resolveLanguage(options) {
	return options.lang === 'auto'
		? document.documentElement.lang || 'en-US'
		: options.lang;
}

function normalizeSttOptions(value) {
	if (value && typeof value === 'object') {
		return {
			enabled: value.enabled !== false,
			provider: String(value.provider || 'browser'),
			sessionUrl: String(value.sessionUrl || '')
		};
	}

	return {
		enabled: Boolean(value),
		provider: 'browser',
		sessionUrl: ''
	};
}

function normalizeTtsOptions(value) {
	if (value && typeof value === 'object') {
		return {
			enabled: value.enabled !== false,
			provider: String(value.provider || 'browser'),
			speechUrl: String(value.speechUrl || '')
		};
	}

	return {
		enabled: Boolean(value),
		provider: 'browser',
		speechUrl: ''
	};
}

function setPressed(button, pressed) {
	button?.setAttribute('aria-pressed', pressed ? 'true' : 'false');
}

function setDisabled(button, disabled) {
	if (button) {
		button.disabled = Boolean(disabled);
	}
}

function requestFrame(callback) {
	const request = globalThis.requestAnimationFrame || globalThis.window?.requestAnimationFrame;
	return request ? request(callback) : globalThis.setTimeout(callback, 16);
}

function cancelFrame(frame) {
	const cancel = globalThis.cancelAnimationFrame || globalThis.window?.cancelAnimationFrame;
	if (cancel) {
		cancel(frame);
		return;
	}
	globalThis.clearTimeout(frame);
}

function animateVoiceLevel(state) {
	const attack = state.levelTarget > state.levelVisual ? 0.52 : 0.16;
	state.levelVisual += (state.levelTarget - state.levelVisual) * attack;
	state.levelTarget *= 0.82;
	state.microphoneButton?.style?.setProperty('--voice-level', state.levelVisual.toFixed(3));
	if (state.listening || state.levelVisual > 0.008 || state.levelTarget > 0.008) {
		state.levelFrame = requestFrame(() => animateVoiceLevel(state));
		return;
	}
	state.levelFrame = 0;
	state.levelVisual = 0;
	state.levelTarget = 0;
	state.microphoneButton?.style?.setProperty('--voice-level', '0');
}

function setVoiceLevel(state, rawRms, rawPeak) {
	if (!state.listening) {
		return;
	}
	const rms = Math.max(0, Math.min(1, Number(rawRms) || 0));
	const peak = Math.max(0, Math.min(1, Number(rawPeak) || 0));
	const signal = Math.max(rms * 5.4, peak * 1.5);
	state.levelTarget = Math.max(0, Math.min(1, signal));
	if (!state.levelFrame) {
		state.levelFrame = requestFrame(() => animateVoiceLevel(state));
	}
}

function resetVoiceLevel(state) {
	state.levelTarget = 0;
	if (!state.levelFrame && state.microphoneButton) {
		state.levelFrame = requestFrame(() => animateVoiceLevel(state));
	}
}

function setStartingState(state, active) {
	const starting = Boolean(active);
	state.starting = starting;
	state.microphoneButton?.classList?.toggle('is-starting', starting);
	state.microphoneButton?.setAttribute('aria-busy', starting ? 'true' : 'false');
	setDisabled(state.microphoneButton, starting || state.dialogEnabled);
}

function setListeningState(state, active) {
	const listening = Boolean(active);
	state.listening = listening;
	state.microphoneButton?.classList?.toggle('is-listening', listening);
	if (!listening) {
		resetVoiceLevel(state);
	}
}

function createDictationTarget(context) {
	const element = context.chatbot.elements.input;
	const originalValue = String(element.value || '');
	const selectionStart = typeof element.selectionStart === 'number'
		? element.selectionStart
		: originalValue.length;
	const selectionEnd = typeof element.selectionEnd === 'number'
		? element.selectionEnd
		: selectionStart;
	const prefix = originalValue.slice(0, selectionStart);
	const suffix = originalValue.slice(selectionEnd);
	let current = '';

	return {
		apply(transcript) {
			current = String(transcript || '');
			const before = needsDictationSpace(prefix, current) ? ' ' : '';
			const after = needsDictationSpace(current, suffix) ? ' ' : '';
			const value = prefix + before + current + after + suffix;
			const caret = prefix.length + before.length + current.length;
			context.setComposerValue(value);
			element.setSelectionRange?.(caret, caret);
		},
		restoreIfEmpty() {
			if (current !== '') {
				return;
			}
			context.setComposerValue(originalValue);
			element.setSelectionRange?.(selectionStart, selectionEnd);
		},
		getValue() {
			return String(element.value || '');
		}
	};
}

function clearDialogStopTimer(state) {
	globalThis.clearTimeout(state.dialogStopTimer);
	state.dialogStopTimer = null;
}

function resetDialogActivity(state) {
	clearDialogStopTimer(state);
	state.dialogSpeechDetected = false;
	state.lastVoiceActivityAt = 0;
	state.dialogStopRequested = false;
}

function scheduleDialogStop(state) {
	clearDialogStopTimer(state);
	if (!state.dialogEnabled
		|| !state.recording
		|| !state.realtimeProvider
		|| !state.dialogSpeechDetected
		|| state.dialogStopRequested) {
		return;
	}
	const remaining = Math.max(0, state.lastVoiceActivityAt + DIALOG_SILENCE_MS - Date.now());
	state.dialogStopTimer = globalThis.setTimeout(() => {
		state.dialogStopTimer = null;
		if (!state.dialogEnabled
			|| !state.recording
			|| !state.realtimeProvider
			|| state.dialogStopRequested) {
			return;
		}
		const quietFor = Date.now() - state.lastVoiceActivityAt;
		if (quietFor < DIALOG_SILENCE_MS) {
			scheduleDialogStop(state);
			return;
		}
		state.dialogStopRequested = true;
		state.realtimeProvider.stop();
	}, remaining);
}

function registerDialogVoiceActivity(state, rms) {
	if (!state.dialogEnabled || !state.recording || !state.realtimeProvider) {
		return;
	}
	if (Number(rms) < VOICE_RMS_THRESHOLD) {
		return;
	}
	state.dialogSpeechDetected = true;
	state.lastVoiceActivityAt = Date.now();
	scheduleDialogStop(state);
}

function registerDialogTranscript(state, text) {
	if (!state.dialogEnabled
		|| !state.recording
		|| !state.realtimeProvider
		|| !String(text || '').trim()
		|| state.dialogSpeechDetected) {
		return;
	}
	state.dialogSpeechDetected = true;
	state.lastVoiceActivityAt = Date.now();
	scheduleDialogStop(state);
}

function cancelSpeech(state) {
	state.speechToken += 1;
	if ('speechSynthesis' in window) {
		window.speechSynthesis.cancel();
	}
	state.backendTtsProvider?.stop();
	state.speaking = false;
	setPressed(state.speakerButton, state.speechEnabled);
}

function disposeRecognition(state) {
	clearDialogStopTimer(state);
	const recognition = state.recognition;
	state.recognition = null;

	if (recognition) {
		recognition.onresult = null;
		recognition.onend = null;
		recognition.onerror = null;
		try {
			recognition.stop();
		} catch (error) {
		}
	}

	if (state.realtimeProvider) {
		state.realtimeProvider.destroy();
		state.realtimeProvider = null;
	}

	state.dictationTarget?.restoreIfEmpty();
	state.dictationTarget = null;
	setStartingState(state, false);
	state.recording = false;
	resetDialogActivity(state);
	setListeningState(state, false);
	setPressed(state.microphoneButton, false);
}

function endDialogMode(context, state) {
	if (!state.dialogEnabled) {
		return;
	}

	state.dialogEnabled = false;
	setPressed(state.dialogButton, false);
	setDisabled(state.microphoneButton, false);
	setDisabled(state.speakerButton, false);
	disposeRecognition(state);
	cancelSpeech(state);
	context.events.emit('voice:dialog-ended', {
		chatbot: context.chatbot
	});
}

function beginSpeech(context, state, text) {
	state.speaking = true;
	setPressed(state.speakerButton, true);
	context.events.emit('voice:tts-started', {
		chatbot: context.chatbot,
		text
	});
}

function finishSpeech(context, state, token, text, onEnd) {
	if (token !== state.speechToken) {
		return;
	}
	state.speaking = false;
	setPressed(state.speakerButton, state.speechEnabled);
	context.events.emit('voice:tts-ended', {
		chatbot: context.chatbot,
		text
	});
	onEnd?.();
}

function speakBrowser(context, options, state, text, token, onEnd) {
	if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
		throw new Error('Browser text-to-speech is not available.');
	}

	window.speechSynthesis.cancel();
	const utterance = new SpeechSynthesisUtterance(text);
	utterance.lang = resolveLanguage(options);
	utterance.onend = () => finishSpeech(context, state, token, text, onEnd);
	utterance.onerror = (event) => {
		if (token !== state.speechToken) {
			return;
		}
		context.events.emit('chatbot:error', event);
		finishSpeech(context, state, token, text);
		if (state.dialogEnabled) {
			endDialogMode(context, state);
		}
	};
	window.speechSynthesis.speak(utterance);
}

function speakBackend(context, options, state, text, token, onEnd) {
	state.backendTtsProvider.speak(text, resolveLanguage(options))
		.then(() => finishSpeech(context, state, token, text, onEnd))
		.catch((error) => {
			if (token !== state.speechToken || error?.name === 'AbortError') {
				return;
			}
			state.speaking = false;
			setPressed(state.speakerButton, state.speechEnabled);
			console.error('Text-to-speech failed.', error);
			context.events.emit('chatbot:error', error);
			if (state.dialogEnabled) {
				endDialogMode(context, state);
			}
		});
}

function speak(context, options, state, text, onEnd) {
	const clean = cleanText(text);
	if (!clean) {
		onEnd?.();
		return;
	}

	cancelSpeech(state);
	const token = ++state.speechToken;
	beginSpeech(context, state, clean);

	try {
		if (options.tts.provider === 'backend') {
			speakBackend(context, options, state, clean, token, onEnd);
			return;
		}
		speakBrowser(context, options, state, clean, token, onEnd);
	} catch (error) {
		if (token !== state.speechToken) {
			return;
		}
		state.speaking = false;
		setPressed(state.speakerButton, state.speechEnabled);
		context.events.emit('chatbot:error', error);
		if (state.dialogEnabled) {
			endDialogMode(context, state);
		}
	}
}

function applyTranscript(context, state, transcript, final) {
	const text = String(transcript || '').trim();
	if (!text) {
		return;
	}

	state.currentTranscript = text;
	state.dictationTarget?.apply(text);
	registerDialogTranscript(state, text);
	context.events.emit(final ? 'voice:transcript' : 'voice:transcript-partial', {
		chatbot: context.chatbot,
		text,
		dialog: state.dialogEnabled
	});

	if (final && !state.dialogEnabled) {
		context.focusComposer();
	}
}

function sendDialogTranscript(context, state) {
	if (!state.dialogEnabled || !state.hadSpeechResult || context.chatbot.sending) {
		return;
	}
	const text = state.dictationTarget?.getValue().trim()
		|| String(context.chatbot.elements.input.value || '').trim();
	if (text) {
		context.send({ text });
	}
}

function startBrowserRecognition(context, options, state) {
	const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!Recognition) {
		throw new Error('Browser speech recognition is not available.');
	}

	const recognition = new Recognition();
	recognition.lang = resolveLanguage(options);
	recognition.continuous = false;
	recognition.interimResults = true;
	state.recognition = recognition;
	state.recording = true;
	state.hadSpeechResult = false;
	state.currentTranscript = '';
	state.dictationTarget = createDictationTarget(context);
	setListeningState(state, true);
	setPressed(state.microphoneButton, true);

	recognition.onresult = (event) => {
		let finalText = '';
		let interimText = '';
		for (let index = 0; index < event.results.length; index += 1) {
			const result = event.results[index];
			const text = String(result?.[0]?.transcript || '');
			if (result.isFinal === false) {
				interimText += text;
			} else {
				finalText += text;
			}
		}

		const combined = `${finalText}${interimText}`.trim();
		if (combined) {
			applyTranscript(context, state, combined, interimText.trim() === '');
		}
		if (finalText.trim()) {
			state.hadSpeechResult = true;
		}
	};

	recognition.onend = () => {
		if (state.recognition !== recognition) {
			return;
		}

		state.recognition = null;
		state.recording = false;
		setListeningState(state, false);
		setPressed(state.microphoneButton, false);
		state.dictationTarget?.restoreIfEmpty();
		context.events.emit('voice:recording-ended', {
			chatbot: context.chatbot,
			hadSpeechResult: state.hadSpeechResult
		});

		if (state.dialogEnabled) {
			if (state.hadSpeechResult) {
				sendDialogTranscript(context, state);
			} else if (!state.speaking && !context.chatbot.sending) {
				endDialogMode(context, state);
			}
		}
	};

	recognition.onerror = (event) => {
		if (event?.error === 'no-speech' && state.dialogEnabled) {
			endDialogMode(context, state);
			return;
		}
		context.events.emit('chatbot:error', event);
	};

	recognition.start();
}

async function startRealtimeRecognition(context, options, state) {
	const input = context.chatbot.elements.input;
	const sourceText = String(input.value || '');
	const selectionStart = typeof input.selectionStart === 'number'
		? input.selectionStart
		: sourceText.length;
	const promptContext = sourceText.slice(Math.max(0, selectionStart - 800), selectionStart);
	state.hadSpeechResult = false;
	state.currentTranscript = '';
	state.recognitionError = null;
	state.dictationTarget = createDictationTarget(context);
	state.recording = false;
	resetDialogActivity(state);
	setListeningState(state, false);
	setPressed(state.microphoneButton, false);
	setStartingState(state, true);

	const provider = new BackendRealtimeSpeechToTextProvider({
		sessionUrl: options.stt.sessionUrl,
		language: resolveLanguage(options),
		context: promptContext,
		onPartial: (text) => applyTranscript(context, state, text, false),
		onFinal: (text) => {
			state.hadSpeechResult = Boolean(String(text || '').trim());
			applyTranscript(context, state, text, true);
		},
		onStart: () => {
			if (state.realtimeProvider !== provider) {
				return;
			}
			setStartingState(state, false);
			state.recording = true;
			setListeningState(state, true);
			setPressed(state.microphoneButton, true);
			context.events.emit('voice:recording-started', {
				chatbot: context.chatbot,
				dialog: state.dialogEnabled,
				provider: 'backend'
			});
		},
		onLevel: (rms, peak) => {
			if (state.realtimeProvider !== provider || !state.recording) {
				return;
			}
			setVoiceLevel(state, rms, peak);
			registerDialogVoiceActivity(state, rms);
		},
		onEnd: ({ error } = {}) => {
			if (state.realtimeProvider !== provider) {
				return;
			}
			state.realtimeProvider = null;
			setStartingState(state, false);
			state.recording = false;
			clearDialogStopTimer(state);
			setListeningState(state, false);
			setPressed(state.microphoneButton, false);
			state.dictationTarget?.restoreIfEmpty();
			context.events.emit('voice:recording-ended', {
				chatbot: context.chatbot,
				hadSpeechResult: state.hadSpeechResult
			});
			if (state.dialogEnabled) {
				if (error || state.recognitionError) {
					endDialogMode(context, state);
				} else if (state.hadSpeechResult) {
					sendDialogTranscript(context, state);
				} else if (!context.chatbot.sending) {
					endDialogMode(context, state);
				}
			} else {
				context.focusComposer();
			}
		},
		onError: (error) => {
			state.recognitionError = error;
			context.events.emit('chatbot:error', error);
		}
	});

	state.realtimeProvider = provider;
	try {
		await provider.start();
	} catch (error) {
		provider.destroy();
		if (state.realtimeProvider === provider) {
			state.realtimeProvider = null;
		}
		setStartingState(state, false);
		state.recording = false;
		clearDialogStopTimer(state);
		setListeningState(state, false);
		setPressed(state.microphoneButton, false);
		state.dictationTarget?.restoreIfEmpty();
		throw error;
	}
}

function startRecognition(context, options, state) {
	if (state.starting || state.recording || state.speaking || (context.chatbot.sending && state.dialogEnabled)) {
		return;
	}

	try {
		if (options.stt.provider === 'backend') {
			startRealtimeRecognition(context, options, state).catch((error) => {
				state.recording = false;
				setListeningState(state, false);
				setPressed(state.microphoneButton, false);
				context.events.emit('chatbot:error', error);
				if (state.dialogEnabled) {
					endDialogMode(context, state);
				}
			});
			return;
		}

		startBrowserRecognition(context, options, state);
		context.events.emit('voice:recording-started', {
			chatbot: context.chatbot,
			dialog: state.dialogEnabled,
			provider: 'browser'
		});
	} catch (error) {
		state.recording = false;
		setListeningState(state, false);
		setPressed(state.microphoneButton, false);
		context.events.emit('chatbot:error', error);
		if (state.dialogEnabled) {
			endDialogMode(context, state);
		}
	}
}

function toggleRecognition(context, options, state) {
	if (state.starting) {
		return;
	}
	if (state.recording) {
		clearDialogStopTimer(state);
		if (state.realtimeProvider) {
			state.realtimeProvider.stop();
		} else {
			state.recognition?.stop();
		}
		return;
	}

	startRecognition(context, options, state);
}

function toggleDialogMode(context, options, state) {
	if (state.dialogEnabled) {
		endDialogMode(context, state);
		return;
	}
	if (context.chatbot.sending) {
		return;
	}

	state.dialogEnabled = true;
	setPressed(state.dialogButton, true);
	setDisabled(state.microphoneButton, true);
	setDisabled(state.speakerButton, true);
	disposeRecognition(state);
	cancelSpeech(state);
	state.backendTtsProvider?.activate().catch((error) => {
		console.error('Text-to-speech activation failed.', error);
		context.events.emit('chatbot:error', error);
		endDialogMode(context, state);
	});
	context.events.emit('voice:dialog-started', {
		chatbot: context.chatbot
	});
	startRecognition(context, options, state);
}

export const VoicePlugin = {
	name: 'voice',

	install(context) {
		const rawOptions = {
			stt: true,
			tts: true,
			dialog: true,
			lang: 'auto',
			...context.getPluginOptions()
		};
		const options = {
			...rawOptions,
			stt: normalizeSttOptions(rawOptions.stt),
			tts: normalizeTtsOptions(rawOptions.tts)
		};
		const state = {
			recognition: null,
			realtimeProvider: null,
			backendTtsProvider: options.tts.provider === 'backend'
				? new BackendTextToSpeechProvider({
					speechUrl: options.tts.speechUrl
				})
				: null,
			starting: false,
			recording: false,
			speechEnabled: false,
			dialogEnabled: false,
			speaking: false,
			speechToken: 0,
			hadSpeechResult: false,
			currentTranscript: '',
			recognitionError: null,
			dictationTarget: null,
			listening: false,
			levelTarget: 0,
			levelVisual: 0,
			levelFrame: 0,
			dialogSpeechDetected: false,
			lastVoiceActivityAt: 0,
			dialogStopTimer: null,
			dialogStopRequested: false,
			microphoneButton: null,
			speakerButton: null,
			dialogButton: null
		};
		this.states ??= new WeakMap();
		this.states.set(context.chatbot, state);

		if (options.stt.enabled) {
			state.microphoneButton = context.ui.addControl('composer-end', {
				id: `${context.chatbot.instanceId}-voice-microphone`,
				label: context.getString('startStopVoiceInput'),
				className: 'base3-chatbot-control base3-chatbot-voice-microphone',
				icon: options.icons?.microphone || '',
				pressed: false,
				order: 10,
				onActivate: () => toggleRecognition(context, options, state)
			});
		}

		if (options.tts.enabled) {
			state.speakerButton = context.ui.addControl('composer-end', {
				id: `${context.chatbot.instanceId}-voice-speaker`,
				label: context.getString('toggleVoiceOutput'),
				icon: options.icons?.speaker || '',
				pressed: false,
				order: 20,
				onActivate: () => {
					state.speechEnabled = !state.speechEnabled;
					setPressed(state.speakerButton, state.speechEnabled);
					if (!state.speechEnabled) {
						cancelSpeech(state);
						return;
					}
					state.backendTtsProvider?.activate().catch((error) => {
						state.speechEnabled = false;
						setPressed(state.speakerButton, false);
						console.error('Text-to-speech activation failed.', error);
						context.events.emit('chatbot:error', error);
					});
				}
			});
		}

		if (options.dialog && options.stt.enabled && options.tts.enabled) {
			state.dialogButton = context.ui.addControl('composer-end', {
				id: `${context.chatbot.instanceId}-voice-dialog`,
				label: context.getString('toggleDialogMode'),
				icon: options.icons?.dialogue || '',
				pressed: false,
				order: 30,
				onActivate: () => toggleDialogMode(context, options, state)
			});
		}

		context.events.on('chatbot:sending-changed', ({ sending }) => {
			if (sending) {
				disposeRecognition(state);
			}
		});

		context.events.on('message:completed', (message) => {
			if (message.interaction || message.error) {
				if (state.dialogEnabled) {
					endDialogMode(context, state);
				}
				return;
			}
			if (!state.speechEnabled && !state.dialogEnabled) {
				return;
			}
			if (state.recording && !state.dialogEnabled) {
				return;
			}

			speak(context, options, state, message.rawText, () => {
				if (state.dialogEnabled) {
					startRecognition(context, options, state);
				}
			});
		});

		context.events.on('message:cancelled', () => {
			if (state.dialogEnabled) {
				endDialogMode(context, state);
			}
		});

		context.events.on('message:error', () => {
			if (state.dialogEnabled) {
				endDialogMode(context, state);
			}
		});

		context.events.on('conversation:changed', () => {
			if (state.dialogEnabled) {
				endDialogMode(context, state);
			}
		});
	},

	destroy(context) {
		const state = this.states?.get(context.chatbot);
		if (state) {
			disposeRecognition(state);
			cancelSpeech(state);
			state.backendTtsProvider?.destroy();
			if (state.levelFrame) {
				cancelFrame(state.levelFrame);
				state.levelFrame = 0;
			}
		}
		this.states?.delete(context.chatbot);
	}
};

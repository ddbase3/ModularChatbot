import { MistralRealtimeSpeechToTextProvider } from '../speech/MistralRealtimeSpeechToTextProvider.js';

function cleanText(value) {
	return String(value || '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/[`*_#]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function resolveLanguage(options) {
	return options.lang === 'auto'
		? document.documentElement.lang || 'de-DE'
		: options.lang;
}

function normalizeSttOptions(value) {
	if (value && typeof value === 'object') {
		return {
			enabled: value.enabled !== false,
			provider: String(value.provider || 'browser'),
			sessionUrl: String(value.sessionUrl || ''),
			speechThreshold: Number(value.speechThreshold || 0.015)
		};
	}

	return {
		enabled: Boolean(value),
		provider: 'browser',
		sessionUrl: '',
		speechThreshold: 0.015
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

function cancelSpeech(state) {
	if ('speechSynthesis' in window) {
		window.speechSynthesis.cancel();
	}
	state.speaking = false;
	setPressed(state.speakerButton, state.speechEnabled);
}

function disposeRecognition(state) {
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

	state.recording = false;
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

function speak(context, options, state, text, onEnd) {
	if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
		const error = new Error('Browser text-to-speech is not available.');
		context.events.emit('chatbot:error', error);
		if (state.dialogEnabled) {
			endDialogMode(context, state);
		}
		return;
	}

	const clean = cleanText(text);
	if (!clean) {
		onEnd?.();
		return;
	}

	window.speechSynthesis.cancel();
	const utterance = new SpeechSynthesisUtterance(clean);
	utterance.lang = resolveLanguage(options);
	state.speaking = true;
	setPressed(state.speakerButton, true);

	const finish = () => {
		state.speaking = false;
		setPressed(state.speakerButton, state.speechEnabled);
		context.events.emit('voice:tts-ended', {
			chatbot: context.chatbot,
			text: clean
		});
		onEnd?.();
	};

	utterance.onend = finish;
	utterance.onerror = (event) => {
		context.events.emit('chatbot:error', event);
		finish();
	};
	context.events.emit('voice:tts-started', {
		chatbot: context.chatbot,
		text: clean
	});
	window.speechSynthesis.speak(utterance);
}

function applyTranscript(context, state, transcript, final) {
	const text = String(transcript || '').trim();
	if (!text) {
		return;
	}

	const composerText = state.composerPrefix
		? `${state.composerPrefix} ${text}`
		: text;
	context.setComposerValue(composerText);

	context.events.emit(final ? 'voice:transcript' : 'voice:transcript-partial', {
		chatbot: context.chatbot,
		text,
		dialog: state.dialogEnabled
	});

	if (final && state.dialogEnabled) {
		context.send({ text });
		return;
	}

	if (final) {
		context.focusComposer();
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
	state.composerPrefix = context.chatbot.elements.input.value.trim();
	setPressed(state.microphoneButton, true);

	recognition.onresult = (event) => {
		let finalText = '';
		let interimText = '';
		for (let index = Number(event.resultIndex || 0); index < event.results.length; index += 1) {
			const result = event.results[index];
			const text = String(result?.[0]?.transcript || '');
			if (result.isFinal === false) {
				interimText += text;
			} else {
				finalText += text;
			}
		}

		if (interimText.trim()) {
			applyTranscript(context, state, interimText, false);
		}
		if (finalText.trim()) {
			state.hadSpeechResult = true;
			applyTranscript(context, state, finalText, true);
		}
	};

	recognition.onend = () => {
		if (state.recognition !== recognition) {
			return;
		}

		state.recognition = null;
		state.recording = false;
		setPressed(state.microphoneButton, false);
		context.events.emit('voice:recording-ended', {
			chatbot: context.chatbot,
			hadSpeechResult: state.hadSpeechResult
		});

		if (state.dialogEnabled && !state.hadSpeechResult && !state.speaking && !context.chatbot.sending) {
			endDialogMode(context, state);
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
	state.composerPrefix = context.chatbot.elements.input.value.trim();
	state.hadSpeechResult = false;
	state.recording = true;
	setPressed(state.microphoneButton, true);

	const provider = new MistralRealtimeSpeechToTextProvider({
		sessionUrl: options.stt.sessionUrl,
		language: resolveLanguage(options),
		speechThreshold: options.stt.speechThreshold,
		onPartial: (text) => applyTranscript(context, state, text, false),
		onFinal: (text) => {
			state.hadSpeechResult = Boolean(String(text || '').trim());
			applyTranscript(context, state, text, true);
		},
		onStart: () => {
			context.events.emit('voice:recording-started', {
				chatbot: context.chatbot,
				dialog: state.dialogEnabled,
				provider: 'mistral-realtime'
			});
		},
		onEnd: () => {
			if (state.realtimeProvider !== provider) {
				return;
			}
			state.realtimeProvider = null;
			state.recording = false;
			setPressed(state.microphoneButton, false);
			context.events.emit('voice:recording-ended', {
				chatbot: context.chatbot,
				hadSpeechResult: state.hadSpeechResult
			});
			if (state.dialogEnabled && !state.hadSpeechResult && !context.chatbot.sending) {
				endDialogMode(context, state);
			}
		},
		onError: (error) => {
			context.events.emit('chatbot:error', error);
			if (state.dialogEnabled) {
				endDialogMode(context, state);
			}
		}
	});

	state.realtimeProvider = provider;
	await provider.start();
}

function startRecognition(context, options, state) {
	if (state.recording || state.speaking || context.chatbot.sending) {
		return;
	}

	try {
		if (options.stt.provider === 'mistral-realtime') {
			startRealtimeRecognition(context, options, state).catch((error) => {
				state.recording = false;
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
		setPressed(state.microphoneButton, false);
		context.events.emit('chatbot:error', error);
		if (state.dialogEnabled) {
			endDialogMode(context, state);
		}
	}
}

function toggleRecognition(context, options, state) {
	if (state.recording) {
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

	state.dialogEnabled = true;
	setPressed(state.dialogButton, true);
	setDisabled(state.microphoneButton, true);
	setDisabled(state.speakerButton, true);
	disposeRecognition(state);
	cancelSpeech(state);
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
			stt: normalizeSttOptions(rawOptions.stt)
		};
		const state = {
			recognition: null,
			realtimeProvider: null,
			recording: false,
			speechEnabled: false,
			dialogEnabled: false,
			speaking: false,
			hadSpeechResult: false,
			composerPrefix: '',
			microphoneButton: null,
			speakerButton: null,
			dialogButton: null
		};
		this.states ??= new WeakMap();
		this.states.set(context.chatbot, state);

		if (options.stt.enabled) {
			state.microphoneButton = context.ui.addControl('composer-end', {
				id: `${context.chatbot.instanceId}-voice-microphone`,
				label: 'Spracheingabe starten oder stoppen',
				icon: options.icons?.microphone || '',
				pressed: false,
				order: 10,
				onActivate: () => toggleRecognition(context, options, state)
			});
		}

		if (options.tts) {
			state.speakerButton = context.ui.addControl('composer-end', {
				id: `${context.chatbot.instanceId}-voice-speaker`,
				label: 'Sprachausgabe ein- oder ausschalten',
				icon: options.icons?.speaker || '',
				pressed: false,
				order: 20,
				onActivate: () => {
					state.speechEnabled = !state.speechEnabled;
					setPressed(state.speakerButton, state.speechEnabled);
					if (!state.speechEnabled) {
						cancelSpeech(state);
					}
				}
			});
		}

		if (options.dialog && options.stt.enabled && options.tts) {
			state.dialogButton = context.ui.addControl('composer-end', {
				id: `${context.chatbot.instanceId}-voice-dialog`,
				label: 'Wechselsprechen ein- oder ausschalten',
				icon: options.icons?.dialogue || '',
				pressed: false,
				order: 30,
				onActivate: () => toggleDialogMode(context, options, state)
			});
		}

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

			speak(context, options, state, message.rawText, () => {
				if (state.dialogEnabled) {
					startRecognition(context, options, state);
				}
			});
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
		}
		this.states?.delete(context.chatbot);
	}
};

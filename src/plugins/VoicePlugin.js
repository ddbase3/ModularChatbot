import { BackendTextToSpeechProvider } from '../speech/BackendTextToSpeechProvider.js?build=tts-stream-2';
import { BackendRealtimeSpeechToTextProvider } from '../speech/BackendRealtimeSpeechToTextProvider.js';

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
			sessionUrl: String(value.sessionUrl || ''),
			speechThreshold: Number(value.speechThreshold || 0.004)
		};
	}

	return {
		enabled: Boolean(value),
		provider: 'browser',
		sessionUrl: '',
		speechThreshold: 0.004
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

function createListeningIndicator(context, state) {
	const indicator = document.createElement('div');
	indicator.className = 'base3-chatbot-voice-listening';
	indicator.hidden = true;
	indicator.setAttribute('role', 'status');
	indicator.setAttribute('aria-live', 'polite');

	const bars = document.createElement('span');
	bars.className = 'base3-chatbot-voice-listening-bars';
	bars.setAttribute('aria-hidden', 'true');
	for (let index = 0; index < 5; index += 1) {
		const bar = document.createElement('span');
		bar.className = 'base3-chatbot-voice-listening-bar';
		bars.appendChild(bar);
	}

	const label = document.createElement('span');
	label.textContent = context.getString('listening');
	indicator.appendChild(bars);
	indicator.appendChild(label);

	state.listeningIndicatorId = `${context.chatbot.instanceId}-voice-listening`;
	state.listeningIndicator = context.ui.addElement(
		'composer-overlay',
		state.listeningIndicatorId,
		indicator,
		10
	);
}

function setListeningState(state, active) {
	const listening = Boolean(active);
	state.listening = listening;
	if (state.listeningIndicator) {
		state.listeningIndicator.hidden = !listening;
	}
	state.composer?.classList.toggle('is-listening', listening);
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
	setListeningState(state, true);
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
		setListeningState(state, false);
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
	setListeningState(state, true);
	setPressed(state.microphoneButton, true);

	const provider = new BackendRealtimeSpeechToTextProvider({
		sessionUrl: options.stt.sessionUrl,
		language: resolveLanguage(options),
		autoStop: state.dialogEnabled,
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
				provider: 'backend'
			});
		},
		onEnd: () => {
			if (state.realtimeProvider !== provider) {
				return;
			}
			state.realtimeProvider = null;
			state.recording = false;
			setListeningState(state, false);
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
			setListeningState(state, false);
			context.events.emit('chatbot:error', error);
			if (state.dialogEnabled) {
				endDialogMode(context, state);
			}
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
		state.recording = false;
		setListeningState(state, false);
		setPressed(state.microphoneButton, false);
		throw error;
	}
}

function startRecognition(context, options, state) {
	if (state.recording || state.speaking || context.chatbot.sending) {
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
			recording: false,
			speechEnabled: false,
			dialogEnabled: false,
			speaking: false,
			speechToken: 0,
			hadSpeechResult: false,
			composerPrefix: '',
			composer: context.chatbot.elements.composer,
			listening: false,
			listeningIndicatorId: '',
			listeningIndicator: null,
			microphoneButton: null,
			speakerButton: null,
			dialogButton: null
		};
		this.states ??= new WeakMap();
		this.states.set(context.chatbot, state);

		if (options.stt.enabled) {
			createListeningIndicator(context, state);
			state.microphoneButton = context.ui.addControl('composer-end', {
				id: `${context.chatbot.instanceId}-voice-microphone`,
				label: context.getString('startStopVoiceInput'),
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
			state.backendTtsProvider?.destroy();
			if (state.listeningIndicatorId) {
				context.ui.remove(state.listeningIndicatorId);
			}
		}
		this.states?.delete(context.chatbot);
	}
};

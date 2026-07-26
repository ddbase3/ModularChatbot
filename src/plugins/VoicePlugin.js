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
	state.recording = false;
	setPressed(state.microphoneButton, false);

	if (!recognition) {
		return;
	}

	recognition.onresult = null;
	recognition.onend = null;
	recognition.onerror = null;
	try {
		recognition.stop();
	} catch (error) {
	}
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

function startRecognition(context, options, state) {
	if (state.recording || state.speaking || context.chatbot.sending) {
		return;
	}

	const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!Recognition) {
		const error = new Error('Browser speech recognition is not available.');
		context.events.emit('chatbot:error', error);
		if (state.dialogEnabled) {
			endDialogMode(context, state);
		}
		return;
	}

	const recognition = new Recognition();
	recognition.lang = resolveLanguage(options);
	recognition.continuous = false;
	recognition.interimResults = false;
	state.recognition = recognition;
	state.recording = true;
	state.hadSpeechResult = false;
	setPressed(state.microphoneButton, true);

	recognition.onresult = (event) => {
		const resultIndex = Math.max(0, Number(event.resultIndex || 0));
		const transcript = String(event.results?.[resultIndex]?.[0]?.transcript || '').trim();
		if (!transcript) {
			return;
		}

		state.hadSpeechResult = true;
		context.events.emit('voice:transcript', {
			chatbot: context.chatbot,
			text: transcript,
			dialog: state.dialogEnabled
		});

		if (state.dialogEnabled) {
			context.send({ text: transcript });
			return;
		}

		const current = context.chatbot.elements.input.value.trim();
		context.setComposerValue(current ? `${current} ${transcript}` : transcript);
		context.focusComposer();
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

	try {
		recognition.start();
		context.events.emit('voice:recording-started', {
			chatbot: context.chatbot,
			dialog: state.dialogEnabled
		});
	} catch (error) {
		state.recognition = null;
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
		state.recognition?.stop();
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
		const options = {
			stt: true,
			tts: true,
			dialog: true,
			lang: 'auto',
			...context.getPluginOptions()
		};
		const state = {
			recognition: null,
			recording: false,
			speechEnabled: false,
			dialogEnabled: false,
			speaking: false,
			hadSpeechResult: false,
			microphoneButton: null,
			speakerButton: null,
			dialogButton: null
		};
		this.states ??= new WeakMap();
		this.states.set(context.chatbot, state);

		if (options.stt) {
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

		if (options.dialog && options.stt && options.tts) {
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

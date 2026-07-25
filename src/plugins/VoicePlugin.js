function cleanText(value) {
	return String(value || '')
		.replace(/<[^>]*>/g, ' ')
		.replace(/[`*_#]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export const VoicePlugin = {
	name: 'voice',

	install(context) {
		const options = {
			stt: true,
			tts: true,
			lang: 'auto',
			...context.getPluginOptions()
		};
		const state = {
			recognition: null,
			recording: false,
			speechEnabled: false
		};
		this.states ??= new WeakMap();
		this.states.set(context.chatbot, state);

		if (options.stt) {
			const microphone = context.ui.addControl('composer-end', {
				id: `${context.chatbot.instanceId}-voice-microphone`,
				label: 'Spracheingabe starten oder stoppen',
				icon: options.icons?.microphone || '',
				pressed: false,
				order: 10,
				onActivate: () => this.toggleRecognition(context, options, state, microphone)
			});
		}

		if (options.tts) {
			const speaker = context.ui.addControl('composer-end', {
				id: `${context.chatbot.instanceId}-voice-speaker`,
				label: 'Sprachausgabe ein- oder ausschalten',
				icon: options.icons?.speaker || '',
				pressed: false,
				order: 20,
				onActivate: () => {
					state.speechEnabled = !state.speechEnabled;
					speaker.setAttribute('aria-pressed', state.speechEnabled ? 'true' : 'false');
					if (!state.speechEnabled && 'speechSynthesis' in window) {
						window.speechSynthesis.cancel();
					}
				}
			});
		}

		context.events.on('message:completed', (message) => {
			if (!state.speechEnabled || message.interaction || message.error || !('speechSynthesis' in window)) {
				return;
			}
			const utterance = new SpeechSynthesisUtterance(cleanText(message.rawText));
			utterance.lang = options.lang === 'auto' ? document.documentElement.lang || 'de-DE' : options.lang;
			window.speechSynthesis.speak(utterance);
		});
	},

	toggleRecognition(context, options, state, button) {
		if (state.recording) {
			state.recognition?.stop();
			return;
		}

		const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!Recognition) {
			context.events.emit('chatbot:error', new Error('Browser speech recognition is not available.'));
			return;
		}

		const recognition = new Recognition();
		recognition.lang = options.lang === 'auto' ? document.documentElement.lang || 'de-DE' : options.lang;
		recognition.onresult = (event) => {
			const transcript = String(event.results?.[0]?.[0]?.transcript || '').trim();
			if (!transcript) {
				return;
			}
			const current = context.chatbot.elements.input.value.trim();
			context.setComposerValue(current ? `${current} ${transcript}` : transcript);
			context.focusComposer();
		};
		recognition.onend = () => {
			state.recording = false;
			button.setAttribute('aria-pressed', 'false');
		};
		recognition.onerror = (event) => {
			context.events.emit('chatbot:error', event);
		};
		state.recognition = recognition;
		state.recording = true;
		button.setAttribute('aria-pressed', 'true');
		recognition.start();
	},

	destroy(context) {
		const state = this.states?.get(context.chatbot);
		state?.recognition?.stop();
		if ('speechSynthesis' in window) {
			window.speechSynthesis.cancel();
		}
		this.states?.delete(context.chatbot);
	}
};

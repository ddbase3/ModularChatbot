import { loadScript } from '../utils/loadScript.js';

function getGlobalTarget() {
	return typeof window !== 'undefined' ? window : globalThis;
}

function configureMathJax() {
	const target = getGlobalTarget();
	const current = target.MathJax && typeof target.MathJax === 'object'
		? target.MathJax
		: {};

	if (typeof current.typesetPromise === 'function') {
		return;
	}

	target.MathJax = {
		...current,
		startup: {
			...(current.startup || {}),
			typeset: false
		},
		tex: {
			...(current.tex || {}),
			inlineMath: [['\\(', '\\)']],
			displayMath: [['\\[', '\\]']]
		},
		output: {
			...(current.output || {}),
			displayOverflow: 'linebreak',
			linebreaks: {
				...(current.output?.linebreaks || {}),
				inline: true,
				width: '100%'
			}
		}
	};
}

function containsMath(value) {
	const text = String(value || '');
	if (!text) {
		return false;
	}

	return /<math(?:\s|>)/i.test(text)
		|| /\\\([\s\S]+?\\\)/.test(text)
		|| /\\\[[\s\S]+?\\\]/.test(text);
}

async function resolveMathJax(context, options) {
	let mathJax = context.resolveGlobal('MathJax');
	if (mathJax && typeof mathJax.typesetPromise === 'function') {
		return mathJax;
	}

	const scriptUrl = String(options.scriptUrl || '').trim();
	if (!scriptUrl) {
		throw new Error('MathJaxPlugin requires pluginOptions.mathjax.scriptUrl.');
	}

	configureMathJax();
	await loadScript(scriptUrl);

	mathJax = context.resolveGlobal('MathJax');
	if (!mathJax || typeof mathJax.typesetPromise !== 'function') {
		throw new Error('MathJax was loaded but did not expose typesetPromise().');
	}

	if (mathJax.startup?.promise) {
		await mathJax.startup.promise;
	}

	return mathJax;
}

function getMessageElement(payload) {
	return payload?.content || payload?.element || null;
}

function clearElement(context, state, element) {
	if (!element || !state.typesetElements.has(element)) {
		return;
	}

	const mathJax = context.resolveGlobal('MathJax');
	if (mathJax && typeof mathJax.typesetClear === 'function') {
		mathJax.typesetClear([element]);
	}
	state.typesetElements.delete(element);
}

function clearAll(context, state) {
	if (state.typesetElements.size === 0) {
		return;
	}

	const elements = [...state.typesetElements];
	const mathJax = context.resolveGlobal('MathJax');
	if (mathJax && typeof mathJax.typesetClear === 'function') {
		mathJax.typesetClear(elements);
	}
	state.typesetElements.clear();
}

async function typesetElement(context, state, element, sourceText) {
	if (state.destroyed || !element || !containsMath(sourceText)) {
		return;
	}

	try {
		const mathJax = await resolveMathJax(context, state.options);
		if (state.destroyed || element.isConnected === false) {
			return;
		}

		clearElement(context, state, element);
		await mathJax.typesetPromise([element]);
		if (state.destroyed || element.isConnected === false) {
			if (typeof mathJax.typesetClear === 'function') {
				mathJax.typesetClear([element]);
			}
			return;
		}
		state.typesetElements.add(element);
	} catch (error) {
		if (!state.destroyed) {
			context.events.emit('chatbot:error', error);
		}
	}
}

export const MathJaxPlugin = {
	name: 'mathjax',

	install(context) {
		this.states ??= new WeakMap();

		const state = {
			destroyed: false,
			options: context.getPluginOptions(),
			typesetElements: new Set(),
			unsubscribe: []
		};
		this.states.set(context.chatbot, state);

		state.unsubscribe.push(
			context.events.on('message:rendering', (payload) => {
				clearElement(context, state, getMessageElement(payload));
			}),
			context.events.on('message:completed', (payload) => {
				if (payload?.interaction || payload?.error) {
					return;
				}
				typesetElement(context, state, getMessageElement(payload), payload?.rawText);
			}),
			context.events.on('baseprompt:loaded', ({ element }) => {
				typesetElement(context, state, element, element?.textContent || '');
			}),
			context.events.on('conversation:changed', () => {
				clearAll(context, state);
			})
		);
	},

	destroy(context) {
		const state = this.states?.get(context.chatbot);
		if (!state) {
			return;
		}

		state.destroyed = true;
		state.unsubscribe.forEach((unsubscribe) => unsubscribe());
		clearAll(context, state);
		this.states.delete(context.chatbot);
	}
};

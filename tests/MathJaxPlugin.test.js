import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatbotEventBus } from '../src/core/ChatbotEventBus.js';
import { MathJaxPlugin } from '../src/plugins/MathJaxPlugin.js';

function flushPromises() {
	return new Promise((resolve) => setImmediate(resolve));
}

function createContext(mathJax) {
	const chatbot = {};
	const events = new ChatbotEventBus();

	return {
		chatbot,
		events,
		getPluginOptions() {
			return {
				scriptUrl: '/assets/mathjax/tex-mml-chtml.js'
			};
		},
		resolveGlobal(path) {
			return path === 'MathJax' ? mathJax : null;
		}
	};
}

function createMathJax() {
	const calls = [];

	return {
		calls,
		startup: {
			promise: Promise.resolve()
		},
		typesetClear(elements) {
			calls.push(['clear', elements]);
		},
		async typesetPromise(elements) {
			calls.push(['typeset', elements]);
		}
	};
}

test('mathjax plugin typesets completed assistant mathematics', async () => {
	const mathJax = createMathJax();
	const context = createContext(mathJax);
	const content = { isConnected: true };

	MathJaxPlugin.install(context);
	context.events.emit('message:completed', {
		content,
		rawText: String.raw`The result is \(x^2 + y^2\).`,
		interaction: false,
		error: false
	});
	await flushPromises();

	assert.deepEqual(mathJax.calls, [
		['typeset', [content]]
	]);

	MathJaxPlugin.destroy(context);
});

test('mathjax plugin ignores completed messages without mathematics', async () => {
	const mathJax = createMathJax();
	const context = createContext(mathJax);

	MathJaxPlugin.install(context);
	context.events.emit('message:completed', {
		content: { isConnected: true },
		rawText: 'This is plain text.',
		interaction: false,
		error: false
	});
	await flushPromises();

	assert.deepEqual(mathJax.calls, []);

	MathJaxPlugin.destroy(context);
});

test('mathjax plugin clears typeset content before a message is rendered again', async () => {
	const mathJax = createMathJax();
	const context = createContext(mathJax);
	const content = { isConnected: true };

	MathJaxPlugin.install(context);
	context.events.emit('message:completed', {
		content,
		rawText: String.raw`\[x = 1\]`,
		interaction: false,
		error: false
	});
	await flushPromises();
	context.events.emit('message:rendering', { content });

	assert.deepEqual(mathJax.calls, [
		['typeset', [content]],
		['clear', [content]]
	]);

	MathJaxPlugin.destroy(context);
});

test('mathjax plugin typesets mathematical opening messages', async () => {
	const mathJax = createMathJax();
	const context = createContext(mathJax);
	const element = {
		isConnected: true,
		textContent: String.raw`Start with \[a^2 + b^2 = c^2\].`
	};

	MathJaxPlugin.install(context);
	context.events.emit('opening-message:loaded', { element });
	await flushPromises();

	assert.deepEqual(mathJax.calls, [
		['typeset', [element]]
	]);

	MathJaxPlugin.destroy(context);
});

test('mathjax plugin clears only its own instance content on destroy', async () => {
	const mathJax = createMathJax();
	const first = createContext(mathJax);
	const second = createContext(mathJax);
	const firstContent = { isConnected: true };
	const secondContent = { isConnected: true };

	MathJaxPlugin.install(first);
	MathJaxPlugin.install(second);
	first.events.emit('message:completed', {
		content: firstContent,
		rawText: String.raw`\(a\)`,
		interaction: false,
		error: false
	});
	second.events.emit('message:completed', {
		content: secondContent,
		rawText: String.raw`\(b\)`,
		interaction: false,
		error: false
	});
	await flushPromises();

	MathJaxPlugin.destroy(first);

	assert.deepEqual(mathJax.calls, [
		['typeset', [firstContent]],
		['typeset', [secondContent]],
		['clear', [firstContent]]
	]);

	MathJaxPlugin.destroy(second);
});

test('mathjax plugin enables responsive line breaking before loading MathJax', async () => {
	const previousMathJax = globalThis.MathJax;
	const previousDocument = globalThis.document;
	const previousCss = globalThis.CSS;
	const events = new ChatbotEventBus();
	const chatbot = {};
	let configuredMathJax = null;
	let scriptListeners = {};

	const context = {
		chatbot,
		events,
		getPluginOptions() {
			return {
				scriptUrl: '/assets/mathjax/tex-mml-chtml-linebreak-test.js'
			};
		},
		resolveGlobal(path) {
			return path === 'MathJax' ? globalThis.MathJax : null;
		}
	};

	try {
		globalThis.MathJax = undefined;
		globalThis.CSS = {
			escape(value) {
				return value;
			}
		};
		globalThis.document = {
			querySelector() {
				return null;
			},
			createElement() {
				scriptListeners = {};
				return {
					dataset: {},
					addEventListener(type, listener) {
						scriptListeners[type] = listener;
					}
				};
			},
			head: {
				appendChild() {
					configuredMathJax = globalThis.MathJax;
					globalThis.MathJax = {
						...configuredMathJax,
						startup: {
							...configuredMathJax.startup,
							promise: Promise.resolve()
						},
						typesetClear() {},
						async typesetPromise() {}
					};
					queueMicrotask(() => scriptListeners.load());
				}
			}
		};

		MathJaxPlugin.install(context);
		context.events.emit('message:completed', {
			content: { isConnected: true },
			rawText: String.raw`\[a = b + c\]`,
			interaction: false,
			error: false
		});
		await flushPromises();
		await flushPromises();

		assert.equal(configuredMathJax.startup.typeset, false);
		assert.equal(configuredMathJax.output.displayOverflow, 'linebreak');
		assert.equal(configuredMathJax.output.linebreaks.inline, true);
		assert.equal(configuredMathJax.output.linebreaks.width, '100%');
	} finally {
		MathJaxPlugin.destroy(context);
		globalThis.MathJax = previousMathJax;
		globalThis.document = previousDocument;
		globalThis.CSS = previousCss;
	}
});

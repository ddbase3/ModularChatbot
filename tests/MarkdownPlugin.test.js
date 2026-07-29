import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { MarkdownPlugin } from '../src/plugins/MarkdownPlugin.js';

const require = createRequire(import.meta.url);
const marked = require('../../../assets/marked/marked.js');

class FakeElement {
	constructor() {
		this.innerHTML = '';
	}

	querySelectorAll() {
		return [];
	}
}

function render(text, preserveMathJax = true) {
	const previousElement = globalThis.Element;
	const element = new FakeElement();
	globalThis.Element = FakeElement;

	try {
		const handled = MarkdownPlugin.renderMessageContent({
			getPluginOptions() {
				return { preserveMathJax };
			},
			resolveGlobal(path) {
				return path === 'marked' ? marked : null;
			}
		}, {
			element,
			text
		});

		assert.equal(handled, true);
		return element.innerHTML;
	} finally {
		globalThis.Element = previousElement;
	}
}

test('markdown plugin preserves standard inline MathJax delimiters', () => {
	const html = render(String.raw`A) The scalar product is \(\mathbf{a} \cdot \mathbf{b} = 1\).`);

	assert.match(html, /\\\(\\mathbf\{a\} \\cdot \\mathbf\{b\} = 1\\\)/);
});

test('markdown plugin preserves display matrices as one MathJax expression', () => {
	const html = render(String.raw`The matrix is:

\[
A =
\begin{bmatrix}
1 & 2 & 3 \\
0 & 1 & 4 \\
5 & 6 & 0
\end{bmatrix}
\]`);

	assert.match(html, /\\\[/);
	assert.match(html, /\\begin\{bmatrix\}/);
	assert.match(html, /1 &amp; 2 &amp; 3 \\\\/);
	assert.match(html, /0 &amp; 1 &amp; 4 \\\\/);
	assert.match(html, /\\end\{bmatrix\}/);
	assert.match(html, /\\\]/);
});

test('markdown plugin preserves formulas inside Markdown table cells', () => {
	const html = render(String.raw`| Method | Accuracy |
| --- | --- |
| Archimedes | \(\mathcal{O}(1/n)\) |`);

	assert.match(html, /<table>/);
	assert.match(html, /\\\(\\mathcal\{O\}\(1\/n\)\\\)/);
});

test('markdown plugin uses normal Markdown escaping when MathJax preservation is disabled', () => {
	const html = render(String.raw`The value is \(x^2\).`, false);

	assert.match(html, /The value is \(x\^2\)\./);
	assert.doesNotMatch(html, /\\\(x\^2\\\)/);
});

test('markdown plugin handles opening-message link markup', () => {
	const originalElement = globalThis.Element;
	class FakeElement {
		querySelectorAll() {
			return [];
		}
	}
	globalThis.Element = FakeElement;
	const listeners = new Map();
	const context = {
		getPluginOptions: () => ({}),
		resolveGlobal: () => null,
		events: {
			on(name, listener) {
				listeners.set(name, listener);
			}
		}
	};

	try {
		MarkdownPlugin.install(context);
		assert.equal(listeners.has('opening-message:loaded'), true);
		assert.equal(listeners.has('baseprompt:loaded'), false);
		listeners.get('opening-message:loaded')({ element: new FakeElement() });
	} finally {
		globalThis.Element = originalElement;
	}
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { MarkdownPlugin } from '../src/plugins/MarkdownPlugin.js';

const require = createRequire(import.meta.url);
const marked = require('../../../assets/marked/marked.js');

class FakeElement {
	constructor() {
		this._innerHTML = '';
		this.jsonCode = null;
	}

	set innerHTML(value) {
		this._innerHTML = String(value);
		const match = this._innerHTML.match(/<code class="language-json">([\s\S]*?)<\/code>/);
		this.jsonCode = match ? { textContent: decodeHtml(match[1]) } : null;
	}

	get innerHTML() {
		return this._innerHTML;
	}

	querySelectorAll(selector) {
		if (selector === 'pre > code.language-json' && this.jsonCode) {
			return [this.jsonCode];
		}
		return [];
	}
}

function decodeHtml(value) {
	return String(value)
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&');
}

class FakeClassList {
	constructor(values = []) {
		this.values = new Set(values);
	}

	add(value) {
		this.values.add(value);
	}

	remove(value) {
		this.values.delete(value);
	}

	contains(value) {
		return this.values.has(value);
	}

	[Symbol.iterator]() {
		return this.values[Symbol.iterator]();
	}
}

class FakeFragmentNode {
	constructor(tagName = 'div', ownerDocument = null) {
		this.tagName = tagName.toUpperCase();
		this.ownerDocument = ownerDocument;
		this.children = [];
		this.parentElement = null;
		this.classList = new FakeClassList();
		this.className = '';
		this.textContent = '';
		this._innerHTML = '';
	}

	set innerHTML(value) {
		this._innerHTML = String(value);
		this.children = [];
		if (this._innerHTML.includes('language-base3-callout')) {
			const pre = new FakeFragmentNode('pre', this.ownerDocument);
			const code = new FakeFragmentNode('code', this.ownerDocument);
			code.classList.add('language-base3-callout');
			code.className = 'language-base3-callout';
			const codeMatch = this._innerHTML.match(/<code class="language-base3-callout">([\s\S]*?)<\/code>/);
			code.textContent = codeMatch ? decodeHtml(codeMatch[1]) : '';
			pre.appendChild(code);
			this.appendChild(pre);
		}
		this.appendChild(new FakeFragmentNode('p', this.ownerDocument));
	}

	get innerHTML() {
		return this._innerHTML;
	}

	get firstChild() {
		return this.children[0] || null;
	}

	setAttribute() {}

	append(...children) {
		children.forEach((child) => this.appendChild(child));
	}

	appendChild(child) {
		if (child.parentElement) {
			child.parentElement.children = child.parentElement.children.filter((candidate) => candidate !== child);
		}
		this.children.push(child);
		child.parentElement = this;
		return child;
	}

	get childNodes() {
		return this.children;
	}

	replaceChildren(...children) {
		for (const child of this.children) {
			child.parentElement = null;
		}
		this.children = [];
		this.append(...children);
	}

	replaceWith(replacement) {
		if (!this.parentElement) {
			return;
		}
		const parent = this.parentElement;
		const index = parent.children.indexOf(this);
		if (index < 0) {
			return;
		}
		if (replacement.parentElement) {
			replacement.parentElement.children = replacement.parentElement.children.filter((candidate) => candidate !== replacement);
		}
		parent.children[index] = replacement;
		replacement.parentElement = parent;
		this.parentElement = null;
	}

	querySelector(selector) {
		if (selector === 'code') {
			return this.children.find((child) => child.tagName === 'CODE') || null;
		}
		if (selector === '.base3-chatbot-extension-pending-text') {
			return this.children.find((child) => child.className === 'base3-chatbot-extension-pending-text') || null;
		}
		return null;
	}

	querySelectorAll(selector) {
		if (selector === 'a[href]') {
			return [];
		}
		if (selector === '.base3-chatbot-extension-pending') {
			return this.children.filter((child) => child.classList.contains('base3-chatbot-extension-pending'));
		}
		if (selector !== 'pre > code' && selector !== 'pre > code.language-json') {
			return [];
		}

		return this.children.flatMap((child) => {
			if (child.tagName !== 'PRE') {
				return [];
			}
			return child.children.filter((candidate) => {
				if (candidate.tagName !== 'CODE') {
					return false;
				}
				return selector === 'pre > code' || candidate.classList.contains('language-json');
			});
		});
	}
}

class FakeDocument {
	createElement(tagName) {
		return new FakeFragmentNode(tagName, this);
	}

	createDocumentFragment() {
		return new FakeFragmentNode('#document-fragment', this);
	}
}

function render(text, assistant = null) {
	const previousElement = globalThis.Element;
	const element = new FakeElement();
	globalThis.Element = FakeElement;

	try {
		const handled = MarkdownPlugin.renderMessageContent({
			getString: (key) => key,
			resolveGlobal(path) {
				return path === 'marked' ? marked : null;
			}
		}, {
			element,
			text,
			assistant
		});

		assert.equal(handled, true);
		return element.innerHTML;
	}
	finally {
		globalThis.Element = previousElement;
	}
}

test('markdown plugin renders ordinary markdown without extension-specific branches', () => {
	const html = render('## Result\n\n- First\n- Second');

	assert.match(html, /<h2>Result<\/h2>/);
	assert.match(html, /<li>First<\/li>/);
	assert.match(html, /<li>Second<\/li>/);
});

test('markdown plugin renders line breaks in the initial assistant message', () => {
	const html = render('First line\nSecond line', {
		element: {
			classList: new FakeClassList(['base3-chatbot-initial-message'])
		}
	});

	assert.match(html, /First line<br>Second line/);
});

test('markdown plugin pretty prints json code blocks after rendering', () => {
	const previousElement = globalThis.Element;
	const element = new FakeElement();
	globalThis.Element = FakeElement;

	try {
		const handled = MarkdownPlugin.renderMessageContent({
			getString: (key) => key,
			resolveGlobal(path) {
				return path === 'marked' ? marked : null;
			}
		}, {
			element,
			text: '```json\n{"name":"example","items":[1,2]}\n```'
		});

		assert.equal(handled, true);
		assert.equal(element.jsonCode.textContent, '{\n  "name": "example",\n  "items": [\n    1,\n    2\n  ]\n}');
	}
	finally {
		globalThis.Element = previousElement;
	}
});

test('markdown plugin handles opening-message link markup', () => {
	const originalElement = globalThis.Element;
	class OpeningMessageElement {
		querySelectorAll() {
			return [];
		}
	}
	globalThis.Element = OpeningMessageElement;
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
		listeners.get('opening-message:loaded')({ element: new OpeningMessageElement() });
	}
	finally {
		globalThis.Element = originalElement;
	}
});

test('markdown fragment command returns a fragment and neutralizes nested extension blocks', () => {
	const previousElement = globalThis.Element;
	globalThis.Element = FakeFragmentNode;
	const document = new FakeDocument();
	const context = {
		root: { ownerDocument: document },
		resolveGlobal(path) {
			return path === 'marked'
				? { parse: () => '<pre><code class="language-base3-callout">payload</code></pre><p>Text</p>' }
				: null;
		}
	};

	try {
		const fragment = MarkdownPlugin.commands['markdown:render-fragment'](context, {
			markdown: '**Text**',
			document,
			allowExtensionBlocks: false
		});
		const code = fragment.querySelectorAll('pre > code')[0];

		assert.equal(fragment.children.length, 2);
		assert.equal(code.classList.contains('language-base3-callout'), false);
		assert.equal(code.classList.contains('language-text'), true);
	}
	finally {
		globalThis.Element = previousElement;
	}
});


test('markdown fragment keeps base3 payload hidden behind the extension pending box', () => {
	const previousElement = globalThis.Element;
	globalThis.Element = FakeFragmentNode;
	const document = new FakeDocument();
	const context = {
		root: { ownerDocument: document },
		resolveGlobal(path) {
			return path === 'marked'
				? { parse: () => '<pre><code class="language-base3-callout">payload</code></pre><p>Text</p>' }
				: null;
		}
	};

	try {
		const fragment = MarkdownPlugin.commands['markdown:render-fragment'](context, {
			markdown: 'extension',
			document,
			allowExtensionBlocks: true
		});
		const pre = fragment.children[0];
		const code = pre.children[0];

		assert.equal(pre.classList.contains('base3-chatbot-extension-pending'), true);
		assert.equal(code.classList.contains('language-base3-callout'), true);
		assert.equal(pre.children.length, 2);
		assert.equal(pre.children[1].className, 'base3-chatbot-extension-pending-text');
	}
	finally {
		globalThis.Element = previousElement;
	}
});


test('markdown plugin preserves the pending extension element while streamed code grows', () => {
	const previousElement = globalThis.Element;
	globalThis.Element = FakeFragmentNode;
	const document = new FakeDocument();
	const element = new FakeFragmentNode('div', document);
	const context = {
		root: { ownerDocument: document },
		getPluginOptions: () => ({ strings: { extensionLoading: 'Loading' } }),
		resolveGlobal(path) {
			return path === 'marked' ? marked : null;
		}
	};

	try {
		MarkdownPlugin.renderMessageContent(context, {
			element,
			text: '```base3-callout\nfirst\n```'
		});
		const pending = element.querySelectorAll('.base3-chatbot-extension-pending')[0];
		assert.ok(pending);

		MarkdownPlugin.renderMessageContent(context, {
			element,
			text: '```base3-callout\nfirst second\n```'
		});
		const updated = element.querySelectorAll('.base3-chatbot-extension-pending')[0];

		assert.equal(updated, pending);
		assert.match(updated.querySelector('code').textContent, /first second/);
	}
	finally {
		globalThis.Element = previousElement;
	}
});

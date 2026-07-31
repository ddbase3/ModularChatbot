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
	constructor(tagName = 'div') {
		this.tagName = tagName.toUpperCase();
		this.children = [];
		this.parentElement = null;
		this.classList = new FakeClassList();
		this._innerHTML = '';
	}

	set innerHTML(value) {
		this._innerHTML = String(value);
		this.children = [];
		if (this._innerHTML.includes('language-base3-callout')) {
			const pre = new FakeFragmentNode('pre');
			const code = new FakeFragmentNode('code');
			code.classList.add('language-base3-callout');
			pre.appendChild(code);
			this.appendChild(pre);
		}
		this.appendChild(new FakeFragmentNode('p'));
	}

	get innerHTML() {
		return this._innerHTML;
	}

	get firstChild() {
		return this.children[0] || null;
	}

	appendChild(child) {
		if (child.parentElement) {
			child.parentElement.children = child.parentElement.children.filter((candidate) => candidate !== child);
		}
		this.children.push(child);
		child.parentElement = this;
		return child;
	}

	querySelectorAll(selector) {
		if (selector === 'a[href]') {
			return [];
		}
		if (selector !== 'pre > code') {
			return [];
		}

		return this.children.flatMap((child) => {
			if (child.tagName === 'PRE') {
				return child.children.filter((candidate) => candidate.tagName === 'CODE');
			}
			return [];
		});
	}
}

class FakeDocument {
	createElement(tagName) {
		return new FakeFragmentNode(tagName);
	}

	createDocumentFragment() {
		return new FakeFragmentNode('#document-fragment');
	}
}

function render(text) {
	const previousElement = globalThis.Element;
	const element = new FakeElement();
	globalThis.Element = FakeElement;

	try {
		const handled = MarkdownPlugin.renderMessageContent({
			resolveGlobal(path) {
				return path === 'marked' ? marked : null;
			}
		}, {
			element,
			text
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

import { loadScript } from '../utils/loadScript.js?build=conversation-draft-1';
import { patchExternalLinks } from '../utils/dom.js?build=conversation-draft-1';

const EXTENSION_LANGUAGE_PREFIX = 'language-base3-';
const STYLE_ATTRIBUTE = 'data-base3-chatbot-extension-pending-styles';

function getMarked(context) {
	const marked = context.resolveGlobal('marked');
	if (!marked || typeof marked.parse !== 'function') {
		throw new Error('Markdown renderer is not available.');
	}
	return marked;
}

function getDocument(context, payload) {
	const document = payload?.document || context.root?.ownerDocument || globalThis.document;
	if (!document || typeof document.createElement !== 'function' || typeof document.createDocumentFragment !== 'function') {
		throw new Error('Markdown fragment rendering requires a document.');
	}
	return document;
}

function ensureStyles(root) {
	if (!root || typeof root.querySelector !== 'function' || root.querySelector(`style[${STYLE_ATTRIBUTE}]`)) {
		return;
	}
	const document = root.ownerDocument || globalThis.document;
	if (!document || typeof document.createElement !== 'function') {
		return;
	}
	const style = document.createElement('style');
	style.setAttribute(STYLE_ATTRIBUTE, '');
	style.textContent = `
.base3-chatbot-extension-pending { display: flex; align-items: center; min-height: 3.25rem; margin: 0.75rem 0; padding: 0.8rem 0.95rem; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 0.5rem; background: color-mix(in srgb, currentColor 3%, transparent); }
.base3-chatbot-extension-pending > code { display: none !important; }
.base3-chatbot-extension-pending-text { opacity: 0.72; }
`;
	root.appendChild(style);
}

function formatJsonCodeBlocks(container) {
	container.querySelectorAll('pre > code.language-json').forEach((code) => {
		try {
			code.textContent = JSON.stringify(JSON.parse(code.textContent), null, 2);
		}
		catch (error) {
			// Keep invalid or incomplete JSON unchanged.
		}
	});
}

function neutralizeExtensionBlocks(container) {
	container.querySelectorAll('pre > code').forEach((code) => {
		const extensionClasses = [...code.classList].filter((className) => className.startsWith(EXTENSION_LANGUAGE_PREFIX));
		if (extensionClasses.length === 0) {
			return;
		}
		extensionClasses.forEach((className) => code.classList.remove(className));
		code.classList.add('language-text');
	});
}

function markExtensionBlocksPending(container, text = 'Inhalt wird erstellt …') {
	container.querySelectorAll('pre > code').forEach((code) => {
		if (![...code.classList].some((className) => className.startsWith(EXTENSION_LANGUAGE_PREFIX))) {
			return;
		}
		const pre = code.parentElement;
		if (!pre || pre.classList.contains('base3-chatbot-extension-pending')) {
			return;
		}
		pre.classList.add('base3-chatbot-extension-pending');
		const document = code.ownerDocument || globalThis.document;
		const label = document.createElement('span');
		label.className = 'base3-chatbot-extension-pending-text';
		label.textContent = text;
		pre.append(label);
	});
}

function getPendingExtensionBlocks(container) {
	if (!container || typeof container.querySelectorAll !== 'function') {
		return [];
	}
	return Array.from(container.querySelectorAll('.base3-chatbot-extension-pending'));
}

function preservePendingExtensionBlocks(currentContainer, nextContainer) {
	const currentBlocks = getPendingExtensionBlocks(currentContainer);
	const nextBlocks = getPendingExtensionBlocks(nextContainer);

	nextBlocks.forEach((nextBlock, index) => {
		const currentBlock = currentBlocks[index];
		if (!currentBlock || typeof nextBlock.replaceWith !== 'function') {
			return;
		}

		const currentCode = currentBlock.querySelector?.('code') || null;
		const nextCode = nextBlock.querySelector?.('code') || null;
		if (currentCode && nextCode) {
			currentCode.textContent = nextCode.textContent;
			currentCode.className = nextCode.className;
		}

		const currentLabel = currentBlock.querySelector?.('.base3-chatbot-extension-pending-text') || null;
		const nextLabel = nextBlock.querySelector?.('.base3-chatbot-extension-pending-text') || null;
		if (currentLabel && nextLabel) {
			currentLabel.textContent = nextLabel.textContent;
		}

		nextBlock.replaceWith(currentBlock);
	});
}

function renderStreamingMarkdown(context, renderContext, marked, loadingText) {
	const currentPending = getPendingExtensionBlocks(renderContext.element);
	if (currentPending.length === 0) {
		renderContext.element.innerHTML = marked.parse(renderContext.text);
		markExtensionBlocksPending(renderContext.element, loadingText);
		return;
	}

	const document = renderContext.element.ownerDocument || context.root?.ownerDocument || globalThis.document;
	if (!document || typeof document.createElement !== 'function' || typeof renderContext.element.replaceChildren !== 'function') {
		renderContext.element.innerHTML = marked.parse(renderContext.text);
		markExtensionBlocksPending(renderContext.element, loadingText);
		return;
	}

	const nextContainer = document.createElement('div');
	nextContainer.innerHTML = marked.parse(renderContext.text);
	markExtensionBlocksPending(nextContainer, loadingText);
	preservePendingExtensionBlocks(renderContext.element, nextContainer);
	renderContext.element.replaceChildren(...Array.from(nextContainer.childNodes));
}

function renderMarkdownFragment(context, payload = {}) {
	const markdown = String(payload.markdown || '');
	const marked = getMarked(context);
	const document = getDocument(context, payload);
	const container = document.createElement('div');
	container.innerHTML = marked.parse(markdown);
	if (payload.allowExtensionBlocks !== true) {
		neutralizeExtensionBlocks(container);
	} else {
		markExtensionBlocksPending(container);
	}
	formatJsonCodeBlocks(container);
	patchExternalLinks(container);
	const fragment = document.createDocumentFragment();
	while (container.firstChild) {
		fragment.appendChild(container.firstChild);
	}
	return fragment;
}

export const MarkdownPlugin = {
	name: 'markdown',

	commands: {
		'markdown:render-fragment': renderMarkdownFragment
	},

	install(context) {
		const options = context.getPluginOptions();
		ensureStyles(context.root);
		if (options.scriptUrl && !context.resolveGlobal('marked')) {
			loadScript(options.scriptUrl).catch((error) => {
				context.events.emit('chatbot:error', error);
			});
		}
		context.events.on('opening-message:loaded', ({ element }) => {
			formatJsonCodeBlocks(element);
			patchExternalLinks(element);
		});
	},

	renderMessageContent(context, renderContext) {
		const marked = context.resolveGlobal('marked');
		if (!marked || typeof marked.parse !== 'function') {
			return false;
		}
		const options = typeof context.getPluginOptions === 'function' ? context.getPluginOptions() : {};
		renderStreamingMarkdown(
			context,
			renderContext,
			marked,
			options?.strings?.extensionLoading || context.getString('extensionLoading')
		);
		formatJsonCodeBlocks(renderContext.element);
		patchExternalLinks(renderContext.element);
		return true;
	}
};

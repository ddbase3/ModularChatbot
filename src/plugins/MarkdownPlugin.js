import { loadScript } from '../utils/loadScript.js?build=conversation-draft-1';
import { patchExternalLinks } from '../utils/dom.js?build=conversation-draft-1';

const EXTENSION_LANGUAGE_PREFIX = 'language-base3-';

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

function renderMarkdownFragment(context, payload = {}) {
	const markdown = String(payload.markdown || '');
	const marked = getMarked(context);
	const document = getDocument(context, payload);
	const container = document.createElement('div');
	container.innerHTML = marked.parse(markdown);

	if (payload.allowExtensionBlocks !== true) {
		neutralizeExtensionBlocks(container);
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

		renderContext.element.innerHTML = marked.parse(renderContext.text);
		formatJsonCodeBlocks(renderContext.element);
		patchExternalLinks(renderContext.element);
		return true;
	}
};

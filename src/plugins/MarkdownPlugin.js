import { loadScript } from '../utils/loadScript.js?build=conversation-draft-1';
import { patchExternalLinks } from '../utils/dom.js?build=conversation-draft-1';

const MATHJAX_EXPRESSION_PATTERN = /\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g;

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function protectMathJaxExpressions(value) {
	const source = String(value || '');
	const expressions = [];
	let prefix = 'BASE3MATHJAXEXPRESSION';
	while (source.includes(prefix)) {
		prefix += 'X';
	}

	const text = source.replace(MATHJAX_EXPRESSION_PATTERN, (expression) => {
		const token = `${prefix}${expressions.length}END`;
		expressions.push({ token, expression });
		return token;
	});

	return {
		text,
		restore(html) {
			return expressions.reduce(
				(output, item) => output.split(item.token).join(escapeHtml(item.expression)),
				String(html || '')
			);
		}
	};
}

export const MarkdownPlugin = {
	name: 'markdown',

	install(context) {
		const options = context.getPluginOptions();
		if (options.scriptUrl && !context.resolveGlobal('marked')) {
			loadScript(options.scriptUrl).catch((error) => {
				context.events.emit('chatbot:error', error);
			});
		}

		context.events.on('opening-message:loaded', ({ element }) => {
			patchExternalLinks(element);
		});
	},

	renderMessageContent(context, renderContext) {
		const marked = context.resolveGlobal('marked');
		if (!marked || typeof marked.parse !== 'function') {
			return false;
		}

		const options = context.getPluginOptions();
		if (options.preserveMathJax === true) {
			const protectedContent = protectMathJaxExpressions(renderContext.text);
			renderContext.element.innerHTML = protectedContent.restore(marked.parse(protectedContent.text));
		}
		else {
			renderContext.element.innerHTML = marked.parse(renderContext.text);
		}

		patchExternalLinks(renderContext.element);
		return true;
	}
};

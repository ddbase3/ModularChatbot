import { loadScript } from '../utils/loadScript.js';
import { patchExternalLinks } from '../utils/dom.js';

export const MarkdownPlugin = {
	name: 'markdown',

	install(context) {
		const options = context.getPluginOptions();
		if (options.scriptUrl && !context.resolveGlobal('marked')) {
			loadScript(options.scriptUrl).catch((error) => {
				context.events.emit('chatbot:error', error);
			});
		}

		context.events.on('baseprompt:loaded', ({ element }) => {
			patchExternalLinks(element);
		});
	},

	renderMessageContent(context, renderContext) {
		const marked = context.resolveGlobal('marked');
		if (!marked || typeof marked.parse !== 'function') {
			return false;
		}

		renderContext.element.innerHTML = marked.parse(renderContext.text);
		patchExternalLinks(renderContext.element);
		return true;
	}
};

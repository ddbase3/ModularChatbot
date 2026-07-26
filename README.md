# ModularChatbot

ModularChatbot is the native ES module chatbot client for BASE3.

The project is intentionally independent from the preserved ClassicChatbot client. It provides:

- no jQuery dependency
- multiple independent chatbot instances per page
- a complete `init()` / `destroy()` lifecycle
- REST and SSE transport adapters
- a plugin manager with explicit plugin options
- instance-local UI slots
- accessible native controls
- Markdown, MathJax, suggestions, feedback, reference, activity, interaction, canvas, thread and browser voice plugins
- browser voice dialog mode with automatic listen, send, speak and listen switching
- provider-backed realtime speech transcription with live composer updates

## Source and deployment

The repository source lives in:

```text
ClientStack/dev/ModularChatbot/src/
```

ClientStack deploys the source unchanged to:

```text
ClientStack/assets/modularchatbot/
```

Run:

```bash
./deploy-modular-chatbot.sh
```

## Browser entry point

```javascript
import {
	mountChatbot,
	MarkdownPlugin,
	ReferencePlugin
} from './index.js';

await mountChatbot(root, {
	serviceUrl: '/chatbot',
	plugins: [ReferencePlugin, MarkdownPlugin]
});
```

The module keeps mounted instances in a `WeakMap`. It does not expose global constructors or instance properties on DOM elements.

## MathJax

`MathJaxPlugin` typesets completed assistant messages and base prompts after the normal content renderer has finished. It uses the self-hosted MathJax 4 component supplied through `pluginOptions.mathjax.scriptUrl` and loads it lazily only when mathematical delimiters or MathML are present.

```javascript
import {
	mountChatbot,
	MarkdownPlugin,
	MathJaxPlugin
} from './index.js';

await mountChatbot(root, {
	serviceUrl: '/chatbot',
	plugins: [MarkdownPlugin, MathJaxPlugin],
	pluginOptions: {
		markdown: {
			preserveMathJax: true
		},
		mathjax: {
			scriptUrl: '/assets/mathjax/tex-mml-chtml.js'
		}
	}
});
```

The canonical delimiters are `\(...\)` for inline mathematics and `\[...\]` for display mathematics. When Markdown and MathJax are enabled together, set `pluginOptions.markdown.preserveMathJax` to `true`. `MarkdownPlugin` then protects complete MathJax expressions before calling Marked and restores them afterwards, so models can emit ordinary MathJax TeX without doubled delimiter backslashes.

MathJax processing starts only after the message is complete. REST and SSE therefore share exactly the same final typesetting path, and an incomplete streaming expression is never handed to MathJax.

## Current integration status

`ClientStack\\Display\\ModularChatbotDisplay` renders this module under the technical name `modularchatbotdisplay`.

The ClientStack default binding remains `ClassicChatbotDisplay`. Projects can explicitly bind `UiFoundation\\Api\\IChatbotDisplay` to `ModularChatbotDisplay` when they want to test or activate the new client.

Mistral realtime STT is available when Chatbot supplies a configured short-lived session URL. Browser speech recognition remains available without backend configuration. Provider-backed TTS and conversation-history hydration remain separate later steps.

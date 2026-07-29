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
- Markdown, MathJax, suggestions, feedback, reference, activity, interaction, canvas, conversation and browser voice plugins
- server-backed conversation lists with activation, creation, renaming and deletion
- hydration of stored messages through the same render path as live messages
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

The deployment is verified by:

```bash
php tests/verify-deployment.php
```

Files under `assets/modularchatbot/` are generated deployment output. Change the source under `dev/ModularChatbot/src/` and deploy it instead of editing both trees independently.

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

## Conversation plugin

`ConversationPlugin` is the only owner of the browser-side conversation selection. It registers the chat-list and new-chat controls immediately, then loads the active conversation from the configured server endpoints. The controls remain disabled until the server state is available. Failure of the optional history endpoint leaves only these controls disabled; the chatbot core, its other controls and the configured main heading remain usable.

It does not:

- generate conversation ids
- persist the active chat in `localStorage`
- keep an independent browser history
- render stored messages through a separate HTML path

The server-side conversation memory remains the source of truth. The plugin receives structured messages and asks the chatbot core to hydrate them through the normal render pipeline. Markdown, MathJax, message actions and feedback therefore behave the same for stored and newly generated assistant messages.

Install `ConversationPlugin` after content-rendering and message-action plugins so the initial hydration can use their registered handlers.

When multiple conversations are disabled, the plugin still manages the one server-side active conversation but does not render list controls.

## MathJax

`MathJaxPlugin` typesets completed and hydrated assistant messages as well as the prominent main heading after the normal content renderer has finished. It uses the self-hosted MathJax 4 component supplied through `pluginOptions.mathjax.scriptUrl` and loads it lazily only when mathematical delimiters or MathML are present.

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

MathJax processing starts only after the message is complete. REST, SSE and hydrated history therefore share exactly the same final typesetting path, and an incomplete streaming expression is never handed to MathJax.

## Current integration status

`ClientStack\\Display\\ModularChatbotDisplay` renders this module under the technical name `modularchatbotdisplay`.

The ClientStack default binding remains `ClassicChatbotDisplay`. Projects can explicitly bind `UiFoundation\\Api\\IChatbotDisplay` to `ModularChatbotDisplay` when they want to activate the modular client.

The modular display supports the server-backed Conversation API supplied by Chatbot. ClassicChatbot remains a non-multi-chat fallback and is not extended by `ConversationPlugin`.

Mistral realtime STT is available when Chatbot supplies a configured short-lived session URL. Browser speech recognition remains available without backend configuration.

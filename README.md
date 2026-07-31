# ModularChatbot

ModularChatbot is the native ES module chatbot client for BASE3.

The project is the active native ES module chatbot client. It provides:

- no jQuery dependency
- multiple independent chatbot instances per page
- a complete `init()` / `destroy()` lifecycle
- REST and SSE transport adapters
- a plugin manager with explicit plugin options
- instance-local UI slots
- accessible native controls
- Markdown, suggestions, feedback, reference, activity, interaction, canvas, conversation and browser voice plugins
- host-loaded response extensions supplied by optional plugins
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

The server-side conversation memory remains the source of truth. The plugin receives structured messages and asks the chatbot core to hydrate them through the normal render pipeline. Markdown, message actions, feedback and host-loaded post-render extensions therefore behave the same for stored and newly generated assistant messages.

Install `ConversationPlugin` after content-rendering and message-action plugins so the initial hydration can use their registered handlers.

When multiple conversations are disabled, the plugin still manages the one server-side active conversation but does not render list controls.

## Post-render extensions

The modular client keeps Markdown as its synchronous content renderer during streaming. More expensive decorators are loaded by the host as normal Chatbot plugins and react to the stable message lifecycle after rendering.

Optional plugins own their browser modules, content preparation, finalization and post-render processing. The modular client provides only the neutral lifecycle and does not contain capability-specific connector code. Incomplete streaming output is not handed to expensive post-render decorators.

External modules must export one plugin object with a unique `name`. They are installed by the existing `ChatbotPluginManager`; ClientStack does not maintain a second extension registry.

## Current integration status

`ClientStack\\Display\\ModularChatbotDisplay` renders this module under the technical name `modularchatbotdisplay`.

ClientStack binds `UiFoundation\Api\IChatbotDisplay` to `ModularChatbotDisplay`. The display supports the server-backed Conversation API supplied by Chatbot.

Mistral realtime STT is available when Chatbot supplies a configured short-lived session URL. Browser speech recognition remains available without backend configuration.

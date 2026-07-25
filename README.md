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
- Markdown, suggestions, feedback, reference, activity, interaction, canvas, thread and browser voice plugins

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

## Current integration status

`ClientStack\\Display\\ModularChatbotDisplay` renders this module under the technical name `modularchatbotdisplay`.

The ClientStack default binding remains `ClassicChatbotDisplay`. Projects can explicitly bind `UiFoundation\\Api\\IChatbotDisplay` to `ModularChatbotDisplay` when they want to test or activate the new client.

Conversation history hydration and provider-backed STT/TTS are intentionally not part of this initial module step because the required backend contracts are not present yet.

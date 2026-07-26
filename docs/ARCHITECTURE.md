# ModularChatbot architecture

## Core

The core owns only instance lifecycle, composer behavior, current conversation identity, message containers, request dispatch and the normalized transport event flow.

## Transport

`RestChatTransport` and `SseChatTransport` emit the same internal events:

- `msgid`
- `token`
- `done`
- `error`

Plugins contribute additional SSE event names without changing the transports.

## Plugins

Plugins are objects with a unique `name`. Optional capabilities include:

- `install(context)`
- `destroy(context)`
- `commands`
- `transportEvents`
- `transformRequest(context, payload)`
- `renderMessageContent(context, renderContext)`
- `onTransportEvent(context, eventName, payload, eventContext)`

Plugins must use the provided context and instance-local UI slots. They must not search the complete document for chatbot controls.

Content renderers such as `MarkdownPlugin` implement `renderMessageContent()`. Post-render decorators such as `MathJaxPlugin` react to message lifecycle events instead of competing for the content-renderer slot. The relevant lifecycle is:

```text
message:rendering
  -> content renderer
  -> message:rendered
  -> message:completed
```

`message:rendering` allows decorators to release state tied to the current DOM before the core replaces the message content. `MathJaxPlugin` typesets only after `message:completed`, so REST and SSE use the same stable final DOM and incomplete TeX from a running stream is not processed.

When MathJax is enabled with Markdown, `MarkdownPlugin` protects complete `\(...\)` and `\[...\]` expressions before Marked parses the message and restores them in the generated HTML. This keeps standard MathJax delimiters intact without requiring model-specific doubled backslashes.

## UI slots

The initial display provides:

- `composer-start`
- `composer-end`

Additional slots can be added by displays without changing plugin APIs.

## Multiple instances

Every `Chatbot` receives one root element. All queries and listeners are scoped to that root and its lifecycle. Conversation identity is separate from widget identity, so multiple widgets can intentionally use the same conversation without sharing DOM state.

## Voice dialog mode

`VoicePlugin` owns the browser speech lifecycle. Dialog mode alternates between one recognition turn and one assistant speech turn:

```text
listen -> send transcript -> wait for assistant -> speak response -> listen
```

The chatbot core only emits normal message lifecycle events. It does not contain speech-specific state.

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

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
- `prepareMessageContent(context, renderContext)`
- `renderMessageContent(context, renderContext)`
- `finalizeMessageContent(context, renderContext, handled)`
- `onTransportEvent(context, eventName, payload, eventContext)`

Plugins must use the provided context and instance-local UI slots. They must not search the complete document for chatbot controls.

Content renderers such as `MarkdownPlugin` implement `renderMessageContent()`. Host extensions may use the neutral preparation and finalization hooks around the selected renderer, and expensive decorators react to message lifecycle events instead of competing for the content-renderer slot. The relevant lifecycle is:

```text
message:rendering
  -> content renderer
  -> message:rendered
  -> message:completed
```

`message:rendering` allows decorators to release state tied to the current DOM before the core replaces the message content. Expensive decorators should process only `message:completed` and `message:hydrated`, so REST, SSE and restored history use the same stable final DOM.

The host may dynamically import additional plugin objects and pass their options through the existing `pluginOptions` map. Capability-specific parsing and connector logic remains in those external plugins.

## UI slots

The initial display provides:

- `composer-start`
- `composer-end`

Additional slots can be added by displays without changing plugin APIs.

## DOM class targets

Project-specific styling is configured through the core `domClasses` option. It uses semantic target names instead of arbitrary CSS selectors, so host styling depends on the public chatbot DOM contract rather than private markup details.

The current targets are:

| Target | Contract element |
| --- | --- |
| `root` | chatbot root passed to `mountChatbot()` |
| `conversation_panel` | `[data-chatbot-conversation-panel]` |
| `opening` | `[data-chatbot-opening-message]` |
| `main` | `[data-chatbot-main]` |
| `messages` | `[data-chatbot-messages]` |
| `suggestions` | `[data-chatbot-suggestions]` |
| `canvas` | `[data-chatbot-canvas]` |
| `composer` | `[data-chatbot-composer]` |
| `input` | `[data-chatbot-input]` |
| `actions` | `[data-chatbot-actions]` |
| `ai_notice` | `[data-chatbot-ai-notice]` |

The client validates the target names once during construction, applies the configured classes before plugin installation, and tracks only classes it actually added. `destroy()` removes those tracked classes while preserving classes that were already present on the host markup.

New stable styling regions should be exposed by adding one semantic target and one corresponding `data-chatbot-*` contract marker. Plugins should continue to use their provided context and UI slots instead of depending on these styling targets for behavior.

## Multiple instances

Every `Chatbot` receives one root element. All queries and listeners are scoped to that root and its lifecycle. Conversation identity is separate from widget identity, so multiple widgets can intentionally use the same conversation without sharing DOM state.

## Voice dialog mode

`VoicePlugin` owns the browser speech lifecycle. Dialog mode alternates between one recognition turn and one assistant speech turn:

```text
listen -> send transcript -> wait for assistant -> speak response -> listen
```

The chatbot core only emits normal message lifecycle events. It does not contain speech-specific state.

## Agent activity rendering

`AgentActivityPlugin` owns the normalized orchestration event flow. It converts stage and tool transport events into one renderer-neutral activity model and delegates presentation to an activity renderer.

The built-in renderers are:

- `ShimmerAgentActivityRenderer`: compact one-line progress with non-technical status text. This is the default through `AgentActivityPlugin`.
- `DetailedAgentActivityRenderer`: persistent technical activity history with turn id, stage/tool state and expandable tool parameters.

Both full plugin variants are exported as `ShimmerAgentActivityPlugin` and `DetailedAgentActivityPlugin`. A host developer can temporarily switch the installed plugin without changing transport or orchestration behavior. Only one activity plugin should be installed for a chatbot instance.

An activity renderer implements these methods:

```text
createState(assistant)
setTurnId(state, turnId)
update(state, activity)
onToken(state)
complete(state, result)
```

The renderer receives only the normalized state. It must not subscribe to transport events itself.

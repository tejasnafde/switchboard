# Provider Adapter Architecture

Switchboard abstracts agent backends behind `ProviderAdapter`. Today there
are two implementations — Claude Code (via the Anthropic Agent SDK) and
Codex (via `codex app-server` JSON-RPC). The renderer never sees
provider-specific types: both adapters emit normalized `RuntimeEvent`s.

## Wire format (what flows between main ↔ renderer)

Everything is defined in `src/shared/provider-events.ts`. Importing from
`shared/` (not main-only types) is what lets preload + renderer type
`window.api.provider.onEvent(callback: (event: RuntimeEvent) => void)`
against a single discriminated union.

```ts
type RuntimeEvent =
  | { type: 'content', threadId, messageId, text, streamKind }
  | { type: 'tool.started', threadId, toolId, toolName, input }
  | { type: 'tool.completed', threadId, toolId, output? }
  | { type: 'tool.denied', threadId, toolName, reason, mode }   // 2026-04-20
  | { type: 'request.opened', threadId, requestId, requestType, toolName, detail }
  | { type: 'request.closed', threadId, requestId, decision }
  | { type: 'turn.completed', threadId, costUsd?, usedTokens?, maxTokens? }
  | { type: 'status', threadId, status }
  | { type: 'session', threadId, sessionId }
  | { type: 'context_window', threadId, usedTokens, maxTokens }
  | { type: 'plan.proposed', threadId, planId, planMarkdown }
  | { type: 'question.asked', threadId, requestId, questions }
  | { type: 'question.answered', threadId, requestId, answers }
  | { type: 'error', threadId, message }
```

Wire events are emitted by the adapter via the `onEvent` callback it was
given in `startSession(...)`. `ProviderRegistry` forwards them to the
renderer as `ipcRenderer.send(ProviderChannels.EVENT, event)`.

## ProviderAdapter interface

```ts
interface ProviderAdapter {
  readonly provider: 'claude' | 'codex'
  startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession>
  sendTurn(threadId, message, runtimeMode?, images?): Promise<void>
  interruptTurn(threadId): Promise<void>
  respondToRequest(threadId, requestId, decision): Promise<void>
  stopSession(threadId): Promise<void>
  setRuntimeMode(threadId, mode): Promise<void>
  answerQuestion?(threadId, requestId, answers): Promise<void>
  isAvailable(): Promise<boolean>
}
```

`answerQuestion` is optional because only Claude currently supports
AskUserQuestion. Codex will add it in Phase B.

## Claude Adapter (`src/main/provider/adapters/claude-adapter.ts`)

Uses `@anthropic-ai/claude-agent-sdk` in streaming-input mode.

### Prompt queue + long-running query

```
sendTurn(threadId, msg)
  └─ PromptQueue.push(userMsg)   // AsyncIterable<SDKUserMessage>
        └─ if !draining: startDraining()
             └─ sdk.query({ prompt: queue, canUseTool, permissionMode, ... })
                  .onMessage → normalize to RuntimeEvent → onEvent(ev)
```

`PromptQueue` implements `AsyncIterable`. The SDK pulls the next prompt
when the current turn completes. New user messages sent via `sendTurn`
are just pushed to the queue — the SDK picks them up automatically.

### canUseTool pipeline (the most important code path)

Every tool call fires `canUseTool(toolName, toolInput)` before execution.
Our implementation has four branches in order:

1. **`ExitPlanMode`** — extract `toolInput.plan` markdown, emit
   `plan.proposed` event, **deny** (stops the agent so user can review).
   The agent's next turn (if user clicks "Implement") includes a new user
   message that tells it to proceed.
2. **`AskUserQuestion`** — parse `toolInput.questions[]`, emit
   `question.asked`, **block on a Promise** until the user answers via
   `answerQuestion(threadId, requestId, answers)`. Return the answers as
   tool output in `updatedInput.__user_answers`.
3. **Policy via `decidePermission(mode, toolName)`**:
   - `full-access` → allow
   - `accept-edits` → allow Edit/Write/MultiEdit/NotebookEdit, prompt else
   - `plan` → allow if in `PLAN_READ_ONLY_TOOLS`, **deny** else (emit
     `tool.denied`)
   - `sandbox` → prompt
4. **Prompt flow** (`sandbox` / unhandled `accept-edits`):
   emit `request.opened` → block on Promise → user's decision via
   `respondToRequest` → emit `request.closed` → return allow/deny.

### Hard-denials emit `tool.denied`

When policy denies (not user-level prompt), we emit a `tool.denied` event
so the renderer can show a denial pill in the chat. Before this, the
only signal was the agent's prose reaction, which was easy to miss.

### Suppressed tool.started for custom-UI tools

`CUSTOM_UI_TOOLS = {'AskUserQuestion', 'ExitPlanMode'}`. When a `tool_use`
block for these arrives, we **skip** emitting `tool.started` — otherwise
the raw JSON tool block renders alongside the QuestionCard / PlanCard.

### Image content blocks

`sendTurn(..., images)` builds a Claude `MessageParam` with mixed content:

```ts
content: [
  { type: 'image', source: { type: 'base64', media_type, data } },
  ...more images,
  { type: 'text', text: message },
]
```

The data URL's `data:image/png;base64,` prefix is stripped to get raw
base64. Claude SDK passes this directly to the Anthropic API.

## Codex Adapter (`src/main/provider/adapters/codex-adapter.ts`)

Spawns `codex app-server` per session and communicates via JSON-RPC 2.0
over stdio. T3 Code is the reference implementation
(`/tmp/t3code/apps/server/src/codexAppServerManager.ts`).

### What's implemented today

- `startSession` / `sendTurn` / `interruptTurn` / `respondToRequest` /
  `setRuntimeMode` / `stopSession`
- Approval notifications from Codex are stored in `pendingApprovals`
  and emitted as `request.opened`

### What's missing (Phase B)

- **Images**: `sendTurn` ignores the `images` param
- **Plan mode enforcement**: uses `decidePermission` like Claude, but the
  Codex side doesn't have an equivalent of `canUseTool` interception —
  needs to set Codex's approval policy appropriately (`untrusted` for
  plan, `on-request` for sandbox, `never` for full-access) and reject
  non-read tools client-side when mode is plan
- **AskUserQuestion equivalent**: Codex sends `item/userInput/request`
  RPCs for interactive questions — need to wire these to the same
  `question.asked` event so QuestionCard works across providers
- **ExitPlanMode equivalent**: TBD whether Codex exposes this
- **Context window metrics**: Codex may emit usage in `event_msg`
  responses; needs exploration

## Session loading from disk (`JsonlParser`)

When the user clicks a historical session in the sidebar, we don't
re-start an agent — we stream the existing JSONL file from disk and
parse it into `ChatMessage[]`. The parser is source-aware:

- `source: 'claude-code'` (default): handles `{type: 'assistant'|'user'|'result'}`
  events; extracts text + tool-use + image content blocks
- `source: 'codex'`: handles `{type: 'response_item', payload: {type: 'message',
  role, content}}` events; skips `developer` and `system` roles (those
  are injected context, not real conversation turns)

Images in historical Claude sessions are reconstructed from `image`
content blocks back into `MessageImage[]` with data URLs — otherwise
attached images would vanish on reload.

## Reusing the policy across adapters

`decidePermission`, `PLAN_READ_ONLY_TOOLS`, and `CUSTOM_UI_TOOLS` are
exported from `claude-adapter.ts`. Phase B will lift them into a shared
`src/main/provider/policy.ts` module so Codex can use them without
importing from another adapter. Tests in `claude-adapter-plan-mode.test.ts`
and `provider-adapter-tool-filter.test.ts` lock down the policy semantics.

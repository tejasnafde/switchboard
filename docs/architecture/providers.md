# Provider Adapter Architecture

Switchboard abstracts agent backends behind `ProviderAdapter`. There are
three implementations - Claude Code (via the Anthropic Agent SDK), Codex
(via `codex app-server` JSON-RPC), and OpenCode (via `opencode acp` over
the Agent Client Protocol). The renderer never sees provider-specific
types: every adapter emits normalized `RuntimeEvent`s.

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
  | { type: 'turn.completed', threadId, costUsd?, usedTokens?, maxTokens?, numTurns?, durationMs? }
  | { type: 'status', threadId, status }
  | { type: 'session', threadId, sessionId }
  | { type: 'context_window', threadId, usedTokens, maxTokens, costUsd? }
  | { type: 'model.variants', threadId, modelId, availableVariants, currentVariant }
  | { type: 'plan.proposed', threadId, planId, planMarkdown }
  | { type: 'question.asked', threadId, requestId, questions }
  | { type: 'question.answered', threadId, requestId, answers }
  | { type: 'file.edited', threadId, turnId, fileEditId, repoRoot, relPath, changeKind, oldContent, newContent, hunks }  // 2026-06-02
  | { type: 'error', threadId, message }
```

`durationMs` on `turn.completed` is what powers the "Worked for X.Xs" badge
in `MessageBubble`. `numTurns` is the cumulative agent turn count from the
SDK. `file.edited` is emitted once per changed file per turn (sourced from a
git checkpoint diff - provider-agnostic); drives the Cursor-style in-chat
diff card with per-hunk accept/reject. `model.variants` carries available
thinking-budget tiers (`low`/`medium`/`high`/`max`) for models that support
them (emitted by the OpenCode ACP adapter from `_meta.opencode.availableVariants`).

Wire events are emitted by the adapter via the `onEvent` callback it was
given in `startSession(...)`. `ProviderRegistry` forwards them to the
renderer as `ipcRenderer.send(ProviderChannels.EVENT, event)`.

## ProviderAdapter interface

```ts
type ProviderKind = 'claude' | 'codex' | 'opencode'

interface ProviderAdapter {
  readonly provider: ProviderKind
  startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession>
  sendTurn(threadId, message, runtimeMode?, images?): Promise<void>
  interruptTurn(threadId): Promise<void>
  respondToRequest(threadId, requestId, decision): Promise<void>
  stopSession(threadId): Promise<void>
  setRuntimeMode(threadId, mode): Promise<void>
  isAvailable(): Promise<boolean>
  // optional
  setModel?(threadId, model): Promise<void>
  answerQuestion?(threadId, requestId, answers): Promise<void>
  listSkills?(threadId): Promise<ProviderSkill[]>
}
```

`answerQuestion` / `setModel` / `listSkills` are optional capabilities.
Claude and Codex both implement `answerQuestion` (AskUserQuestion);
OpenCode does not yet.

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
are just pushed to the queue - the SDK picks them up automatically.

### canUseTool pipeline (the most important code path)

Every tool call fires `canUseTool(toolName, toolInput)` before execution.
Our implementation has four branches in order:

1. **`ExitPlanMode`** - extract `toolInput.plan` markdown, emit
   `plan.proposed` event, **deny** (stops the agent so user can review).
   The agent's next turn (if user clicks "Implement") includes a new user
   message that tells it to proceed.
2. **`AskUserQuestion`** - parse `toolInput.questions[]`, emit
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
block for these arrives, we **skip** emitting `tool.started` - otherwise
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

### What's implemented today (Phase B complete)

- `startSession` / `sendTurn` / `interruptTurn` / `respondToRequest` /
  `setRuntimeMode` / `stopSession`
- Approval notifications from Codex are stored in `pendingApprovals`
  and emitted as `request.opened`
- **Images**: `sendTurn` encodes images into JSON-RPC content blocks
- **Plan mode enforcement**: uses the shared `decidePermission`; plan mode
  maps to a `read-only` sandbox and non-read tools are rejected
  client-side
- **AskUserQuestion**: Codex `item/userInput/request` / `askUserQuestion`
  surface as `question.asked` events (multi-select supported);
  `answerQuestion` responds back - QuestionCard works across providers
- **Plan proposals**: `item/plan/delta` / `turn/plan/updated`
  notifications surface as `plan.proposed`

### OpenCode Adapter (`opencode-acp-adapter.ts`)

The only OpenCode adapter (the legacy `opencode run --format json`
shell-out was retired 2026-05-02). Speaks the Agent Client Protocol over
a long-lived `opencode acp` child. Shares env-probing via
`adapters/opencode/env.ts`.

- **Skill discovery**: implements `listSkills` - the adapter caches the
  skill list kept fresh by `available_commands_update` ACP push events
  (replaced the earlier `opencode debug skill` shell-out). Slash command
  menu shows OpenCode skills alongside Switchboard built-ins.
- **No `answerQuestion`**: OpenCode does not yet support
  `AskUserQuestion`-style blocking prompts.

## Session loading from disk (`JsonlParser`)

When the user clicks a historical session in the sidebar, we don't
re-start an agent - we stream the existing JSONL file from disk and
parse it into `ChatMessage[]`. The parser is source-aware:

- `source: 'claude-code'` (default): handles `{type: 'assistant'|'user'|'result'}`
  events; extracts text + tool-use + image content blocks
- `source: 'codex'`: handles `{type: 'response_item', payload: {type: 'message',
  role, content}}` events; skips `developer` and `system` roles (those
  are injected context, not real conversation turns)

Images in historical Claude sessions are reconstructed from `image`
content blocks back into `MessageImage[]` with data URLs - otherwise
attached images would vanish on reload.

## Shared policy across adapters

`decidePermission`, `denialMessage`, `PLAN_READ_ONLY_TOOLS`, and
`CUSTOM_UI_TOOLS` now live in the shared `src/main/provider/policy.ts`
module (lifted out of `claude-adapter.ts`). All three adapters import
from it, so plan-mode semantics are identical across providers. The
read-only and custom-UI sets include both the Claude tool names and the
Codex equivalents (`read_file`/`list_files`/`search_files`/`fetch`,
`ask_user_question`/`exit_plan_mode`). Tests in
`provider-policy.test.ts`, `claude-adapter-plan-mode.test.ts`, and
`provider-adapter-tool-filter.test.ts` lock down the semantics.

## Multi-instance credentials

`provider_instances` (settings DB) holds named credential sets per agent
type - `(id, agent_type, display_name, accent_color, auth_mode,
env_encrypted, oauth_dir, config_json, enabled, …)`. `auth_mode` is
`'env'` (safeStorage-encrypted env overlay) or `'oauth_dir'` (per-instance
`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). `provider-registry` resolves the
instance at `startSession` (requested → default → any enabled), applies
the env overlay (`env-overlay.ts`), and migrates Claude session JSONL
across `oauth_dir` rotation (`claude-session-migrate.ts`). IPC lives in
`ipc/providerInstances.ts`; UI in `UnifiedProviderPicker` +
Settings → Providers.

# Provider bridge

Detail for this part of the code. The root `AGENTS.md` holds the rules that apply everywhere (shipping checklist, cross-surface policy, logging, writing style); they apply here too.

## Provider bridge (`src/main/provider/`)

- `types.ts` re-exports from `src/shared/provider-events.ts` so renderer can type the IPC boundary
- `ProviderKind = 'claude' | 'codex' | 'opencode'`
- `ProviderAdapter` interface - required: `startSession(opts, onEvent)`, `sendTurn(threadId, message, runtimeMode?, images?)`, `interruptTurn`, `respondToRequest`, `stopSession`, `setRuntimeMode`, `isAvailable`. Optional: `setModel?`, `answerQuestion?`, `listSkills?`, `cancelQueuedTurn?`, `promoteQueuedTurn?`
- **`policy.ts` is the shared policy module** (2026-04/05 - was previously inlined in claude-adapter). All three adapters import from it:
  - `decidePermission(mode, toolName) → 'allow' | 'deny' | 'prompt'` - pure, unit-tested
  - `denialMessage(mode, toolName)` - human-readable denial reason
  - `PLAN_READ_ONLY_TOOLS` - Read/Glob/Grep/NotebookRead/WebFetch/WebSearch/TodoWrite (+ Codex equivalents `read_file`/`list_files`/`search_files`/`fetch`) allowed in plan mode, everything else denied
  - `CUSTOM_UI_TOOLS` - AskUserQuestion + ExitPlanMode (+ Codex `ask_user_question`/`exit_plan_mode`) skip `tool.started` emission so the custom cards render instead of raw JSON
- `event-bus.ts` - `RuntimeEventBus` (EventEmitter) decouples adapter event emission from the renderer, so N subscribers (renderer, future telemetry) can listen instead of 1:1 `webContents` coupling
- `env-overlay.ts` - merges a provider-instance env overlay into the spawn env (skips empty strings so partial configs don't blank defaults)
- `claude-session-migrate.ts` - copies Claude SDK session JSONL across `oauth_dir` when rotating provider instances mid-flight, so resume survives a credential switch

## Runtime events (wire format)

Defined in `src/shared/provider-events.ts`. Discriminated union:

- `content` · streaming text, `streamKind: 'assistant' | 'reasoning' | 'plan'`
- `tool.started` · tool call begun (skipped for custom-UI tools)
- `tool.completed` · tool finished
- `tool.denied` · **2026-04-20**: `canUseTool` hard-denied (e.g. Plan mode blocked Write) - UI renders denial pill
- `request.opened` / `request.closed` · approval prompt flow (`requestType: 'command' | 'file' | 'tool'`)
- `turn.completed` · turn ended, with `costUsd? / usedTokens? / maxTokens? / numTurns? / durationMs?`
- `turn.queued` / `turn.dequeued` · a `delivery: 'queue'` message is held until the running turn ends / left the queue (`started | promoted | cancelled | dropped | failed`), keyed by its chat row id (`echoMessageId(origin)`). The registry's `QueuedTurnLedger` fills in the text and serves list / promote / cancel (`turn_queue_controls_v1`); outstanding-turn accounting for a queued message is settled on `turn.dequeued` only, never in the IPC handlers
- `turn.queue-held` · after Stop (all three adapters, reason `Stopped.`), a failed or usage-limited turn, or a queued message that could not start (`turn.dequeued` `failed`, which stays listed as Not sent until Cancel), the adapter starts nothing more until the user resumes (`provider:resume-queued-turns`) or cancels. Claude takes held messages back out of the CLI queue (`cancelAsyncMessage`) and pushes them again, with a fresh uuid, on Resume. Clients keep queued rows on `status: error`; only `stopped` clears them
  - **Claude turn boundaries.** A queued message started at a `result` makes the status `running`, not `idle`. A steer sent mid-turn carries a uuid; when one was sent and a queued message waits, the next turn is undecided (`awaitingNextTurn`) until its first `message_start`, whose `user_message_uuid(s)` stamp names the queued message (it starts, with its mode) or the steer (a turn of its own). No stamp (an older CLI) means the queue head, as before. A turn nobody started (that late steer, or the agent's own follow-up) is announced as `status: running` with `newTurn: true`, which the registry counts until its `turn.completed`. A query that dies mid-turn ends the running turn itself (`endTurnWithoutResult`)
  - **Codex stale ends.** A `turn/completed` for another turn than the running one (the turn Stop interrupted, arriving after the next send started a turn) is ignored: no `turn.completed`, no idle status, no queue start
  - **Codex native queue: tried and rejected (spike 2026-09-29, Codex 0.158).** Its `thread/queue/*` methods are experimental, and they cannot carry our semantics: `queue/start` refuses while a turn runs, so Send now (promote into the running turn) has no equivalent; queue items carry no settings, so a queued message's own runtime mode cannot apply when it starts; and the server starts the next item itself, so a failed start cannot be reported back. Decision: Codex keeps going through our `QueuedTurnLedger`. Re-check only once the queue leaves experimental, can merge an item into a running turn, and stores per-item settings.
- `status` · session status change · `session` · sessionId recorded
- `context_window` · live token count (polled after each turn)
- `model.variants` · available model variants + current selection
- `plan.proposed` · ExitPlanMode intercept → PlanCard
- `question.asked` / `question.answered` · AskUserQuestion intercept → QuestionCard
- `file.edited` · **2026-06-02**: one event per changed file per turn, sourced from a git checkpoint diff (provider-agnostic) - drives the Cursor-style in-chat diff card with per-hunk accept/reject
- `request.expired` · the provider can no longer take an answer for an open approval or question (its session errored, stopped or restarted). Clients replace the card with a notice naming the reason, recovery closes cards the backend no longer lists, and `RESPOND_TO_REQUEST` / `ANSWER_QUESTION` refuse a request the registry no longer holds (`REQUEST_EXPIRED`) instead of returning silently
- `error` · adapter-level error surfaced to chat

## Image pipeline (2026-04-20)

1. User pastes/drags image in `ChatInput` → `ImageAttachment[]`
2. `ChatPanel.handleSend` shrinks each `File` to a data URL with `fitImageToBudget` (canvas). Every client resizes the same way, by `src/shared/image-resize.ts` (Android port `domain/composer/ImageResizePlan.kt`): at most 2048 px on the long side, JPEG 0.85 (a PNG stays PNG while under 1 MiB), stepping down to 1600 px and then 1280 px at 0.75 until the image fits what is left of the 3 MiB message limit, which is unchanged and still enforced by `validateUserMessageImages`. A GIF is sent as is or refused (re-encoding would drop its animation). The decoder applies EXIF orientation and the output carries no EXIF. Each refusal names the image (`imageRefusalMessage`). The Expo app does it with `expo-image-manipulator` (a native module: added 2026-10-03, so it needed a new binary, not an OTA); Android with `BitmapFactory` and `inSampleSize` (`BitmapImageShrinker`) on the composer worker, when the image is staged into the draft
3. `providerApi.sendTurn(..., messageImages)` passes through preload → `provider-registry` IPC → adapter
4. Claude adapter strips the `data:image/png;base64,` prefix and builds `{type:'image', source:{type:'base64', media_type, data}}` content blocks alongside text
5. Codex adapter encodes images into JSON-RPC content blocks (Phase B done - see `codex-adapter.ts` `sendTurn`)
6. On JSONL reload, `JsonlParser.extractImages` reconstructs data URLs from image blocks - historical images survive restart

## Question / Plan flow

1. Agent calls `AskUserQuestion` or `ExitPlanMode` (both in `CUSTOM_UI_TOOLS`) - raw `tool.started` is suppressed
2. SDK fires `canUseTool` → our handler intercepts, emits `question.asked` / `plan.proposed`
3. ChatPanel appends a message with `question` or `plan` attachment
4. `MessageBubble` routes to `QuestionCard` (T3-style, numbered shortcuts 1-9, auto-advance) or `PlanCard` (markdown + Implement/Iterate buttons)
5. User answers → `provider.answerQuestion(threadId, requestId, answers)` resolves the blocked Promise
6. `canUseTool` returns allow + `updatedInput` with the answer payload

## Cross-session messaging (`/send-to` + agent-initiated sends)

One session hands a self-contained summary to another on the SAME backend. Two entry points, ONE delivery method - `ProviderRegistry.deliverPeerMessage(input)`:

- **User-typed**: `/send-to <session>: <message>` (parsing + fuzzy target resolution in `renderer/components/chat/send-to-command.ts`) → `ProviderChannels.DELIVER_PEER_MESSAGE` → the registry with `initiator: 'user'`. The handler FORCES the initiator; a client claiming `'agent'` would take the agent path's budget while skipping the approval that path relies on.
- **Linked sessions**: `/link <session> [messages] [time]` / `/unlink [session]` (`renderer/components/chat/link-command.ts`, targets resolved like `/send-to`, and `/link` gets the same chat picker) let two sessions' agents message back and forth under the link's own budget (see the guard table). A trailing number is the budget and a trailing `Nm` / `Nh` the time (10 minutes to 24 hours; a unit is required, since a bare number is the budget), unless the text with them is exactly a chat's title ("Issue 172", "Sprint 2h"): options are peeled off only until an exact title matches. No time means the backend setting `chat.peerLinkDuration` (Settings > Chat & agents > Link duration, `30m` by default, stored in the `/link` form and read by the registry at link time; `peerLinkDurationChoice` turns anything that is not one of the row's choices into `30m`, for the row and the registry alike).
- **Agent-initiated (all three agents)**: `list_agent_sessions` and `send_agent_message` on the Switchboard MCP server (see `src/main/mcp/AGENTS.md`), so Claude sees `mcp__switchboard__*`, OpenCode `switchboard_*`. Names, descriptions and handler behaviour live in `provider/peer-tools.ts`; `mcp/peer-mcp-tools.ts` binds them to the server and applies the gate.

Delivery is an ordinary `sendTurn`, which is what makes a peer message structurally unable to answer an approval: nothing on the path reaches `respondToRequest`. The receiving body is `wrapPeerMessage`, which tells the peer the message is not from the user and carries no authority.

Guards, all pure in `shared/peer-messaging.ts` and held by the BACKEND so every client shares one budget:

| Guard | Value | Why |
|---|---|---|
| Body cap | 16 KiB | A peer message is a summary, not a transcript |
| Per-pair rate | 5 / 60s | Both initiators |
| Dedupe | identical (from, target, text) inside 10 min | Content-addressed id `pm_<16 hex>` |
| **Hop depth** | `PEER_MESSAGE_MAX_HOP_DEPTH = 1` | Agent sends only. Depth counts consecutive AGENT hops since the last human message, so a session acting on a peer message cannot pass one on: that is the A -> B -> A guard, and rate limits do not substitute for it |
| **Per-sender budget** | 6 / 10 min per SENDING session | Agent sends only. The per-pair limit is multiplied by fan-out otherwise (5 siblings = 25/min) |
| **Session link** (`shared/peer-links.ts`) | Per EDGE (both directions): the messages the user chose (`/link <session> [messages] [time]`, default 20, 1 to 200) or the edge's own window (the time given, else the Link duration setting, 30 min by default; 10 min to 24 h), whichever first. The edge stores its window: a message the user types in either session, or sends along the edge, renews both with it; Extend adds 20 (never past 200) and restarts that window, not the default | Agent sends along a link the USER made skip hop depth and the per-sender budget, so two agents can hold a back-and-forth and a hub can fan out to any number of linked workers (no cap on links per session). Only along that edge: the same session sending to an unlinked one meets both limits. Body cap, dedupe and per-pair rate still apply. 200 is ten default budgets. The window bounds time and the budget bounds volume: at the per-pair rate a busy pair spends 200 in about 20 minutes, so a long window keeps a sparse exchange alive but a chatty one still stops for the user. Kept at 200 when windows grew to 24 h for that reason |

Traps:

- **The gate is the server's, not the adapter's.** `peer-mcp-tools.ts` runs `decidePermission` on `mcp__switchboard__send_agent_message`: denied in plan (with a `tool.denied` pill), sent in full access, one ordinary approval card otherwise. The adapters let every `switchboard` tool through without a prompt of their own. `list_agent_sessions` runs unasked: it reads only titles the sidebar already shows, and prompting for a harmless read trains the user to click through the send that follows.
- **Hop depth is NOT cleared at turn end**, only by a user turn (set to 0 in `SEND_TURN`) or `STOP_SESSION`. Clearing it per turn would let an unattended chain continue by waiting. A Switchboard result turn (an approval card's answer, see `src/main/mcp/AGENTS.md`) does not clear it either, and does not renew a link.
- **Refusals go back to the model as tool output with `isError`, never as a throw** - a thrown MCP error reaches it as an unreadable transport failure and it retries the same call.
- The per-pair limit (5) is LOWER than the per-sender budget (6), so any test of the budget must fan out over two targets or the pair limit fires first.
- **Links are edges, user-made, in memory.** `/link A`, `/link B` from a hub makes two edges; A and B are not linked with each other. Only `ProviderChannels.LINK_PEER` creates one (`PeerLinkBook.link` refuses an `'agent'` initiator, and no MCP tool reaches it). Keyed by `resolveRootThreadId`. Removed by `/unlink`, by `STOP_SESSION` on either side (not by a profile switch, which restarts the session) and by archiving either chat (`notifyConversationArchived`). Not persisted: a restart stops every session, which would remove them anyway. `list_agent_sessions` reports `linked`, and `provider:peer-links-changed` (`{ threadIds }`, root ids) drives the desktop banner (`PeerLinkBanner`).
- **A link skips the hop limit, it does not reset it.** The receiving turn's depth still grows with each linked hop, so a session deep in a linked exchange cannot send to an UNLINKED session until the user speaks to it, and unlinking mid-exchange can leave both ends unable to send. That is deliberate: the link is consent for that edge only.
- **A spent link never loses the message.** The refusal tells the model the message was NOT delivered, to keep working, and to put it in its final reply. The registry also stores it in the SENDER's chat as a `[[sb:peer-undelivered]] <json>` system row (`PEER_UNDELIVERED_MARKER_PREFIX`, `PeerUndeliveredRow`) with a Send button, which delivers it as a user send (renewing the edge) and rewrites the row as sent (`rewriteSystemMarker`, carried by `undeliveredId`). The first refusal after a run-out publishes `peer.undelivered` with `notify: true`, which the push notifier (`kind: 'link'`) and the desktop (`notifyPeerLinkSpent`) turn into one notification naming both sessions; later refusals are rows only, until the edge is renewed.
- **Every client renders every `[[sb:` system row, and an unknown kind never shows raw.** The phones read stored rows through `shared/system-markers.ts` (`systemRowView`; Android `SystemMarkers.kt`, both run `tests/fixtures/system-marker-cases.json`): Not delivered gets its own row with Send (`provider:deliver-peer-message` is open to a phone's `chat` scope), the other markers a notice in the desktop's words, an `Error:` row an error, and a kind they do not know a neutral "Switchboard notice" (the desktop's `MessageBubble` falls back the same way). Android stores both from history and from the live `peer.undelivered` / `approval.result` events as `RawNotice` rows of type `history.system` with id `h-<messageId>`, so a reload and a live event land on one row and a sent update replaces it. A NEW marker kind needs a case in that fixture and a row in both ports, or it shows as the neutral notice.
- **Each edge keeps its own window.** `PeerLinkBook` stores `windowMs` per edge, so renewals and Extend restart that edge's length, never the current Settings default; changing Link duration affects only links made after. `/link` on an already linked pair replaces its budget and window (no time means the setting's), and the expired refusal names the edge's own length ("This link's time (4 hours) is up."). The banner shows the time left per link (`Worker A · 7 of 20 · 3h 12m left`).
- **Phones may unlink, never link or extend.** `provider:link-peer` and `provider:extend-peer-link` are admin-scoped in `device-auth.ts`: a link is consent to card-less agent traffic in auto mode, like approving a host write. `provider:unlink-peer` and the list stay open, since they only take power away or read.
- **Card along a link**: auto mode sends without one (the user lets the agent settle routine calls there, and a card per message would undo the link); sandbox and accept-edits keep the card, plan still denies, full access already sends. A card-less send carries `requireLink`, so an unlink while it is in flight refuses it instead of delivering it uncarded.
- **The link is checked again after the checkpoint await**, the one await between the charge and `sendTurn` (`peerDeliveryProblem`). The edge is compared by id (`PeerLinkBook.edgeId`), so an unlink there, or an unlink and relink, withdraws the send: the per-pair slot and the link charge are given back (`release` only refunds the edge that was charged), a checkpoint taken for a turn that will not happen is dropped, and the message is kept as a `link-removed` Not delivered row. A target that stopped or switched profile meanwhile is refused the same way.
- Sender-side provenance is a marker prefix, not a field: `[[sb:peer-sent]]` vs `[[sb:peer-sent-agent]]` (`parseRotationMarker` kinds `peer` / `peer-agent`), because a reload reads the stored string and has nothing else to tell the two apart.

## Provider instances (multi-account credentials)

- `provider_instances` table: `(id, agent_type, display_name, accent_color, auth_mode, env_encrypted BLOB, oauth_dir, config_json, enabled, created_at, updated_at)`. Multiple named instances per agent type (e.g. `codex-work` / `codex-personal`).
- `auth_mode`: `'env'` (safeStorage-encrypted env vars in `env_encrypted`) or `'oauth_dir'` (per-instance config dir set as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`).
- IPC (`ProviderInstanceChannels`): `LIST` (secrets stripped), `UPSERT` (plaintext env in, encrypted at rest), `DELETE` (refuses last-of-kind), `TEST` (probes creds via `claude auth status` / `codex login status` / `opencode models`), `CREATE_OAUTH_DIR`.
- Registry resolves the instance at `startSession` (`resolveProviderInstance(agentType, instanceId)`), falling back requested → default → any enabled; applies the env overlay + oauth_dir at spawn.
- UI: `UnifiedProviderPicker` (drop-up: agent tabs → instance rail → model search) in the chat composer; `ProvidersTab` in Settings. Renderer cache in `provider-instance-store`.
- **Usage limits** (`ProviderInstanceChannels.USAGE` → `src/main/provider/usage/`): a per-row "Usage" button reads that instance's subscription quota. Claude via `GET /api/oauth/usage` with the instance's own keychain token; Codex via a short-lived `codex app-server` speaking `account/rateLimits/read`; OpenCode is not-applicable (own API keys). Normalised to `ProviderUsage` (`shared/provider-usage.ts`): `usedPercent` 0-100, `resetsAtMs` epoch ms. Traps:
  - Claude's per-model weekly limit is in `limits[]` as `kind: "weekly_scoped"`, **not** `seven_day_opus`/`seven_day_sonnet` (legacy, null). `is_active` marks which limit is *binding*, not whether it exists - never filter on it.
  - Codex's app-server wire is camelCase and `resetsAt` is unix **seconds**; the snake_case form belongs to `codex exec --json`. `account/read` needs an explicit `params`.
  - Keychain service = `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0..8]>`, derived from the **effective env value**, which is what makes lookup per-instance.
  - Never reuse `runProbe` to read credentials: `security ... -w` prints the token on stdout, and `runProbe`'s callers surface stdout to the UI.
  - Tokens are never refreshed here - the CLI rotates and writes back, and racing it can log the user out. Expiry is checked locally.
  - Every `security` read of an item it has no lasting access to is a macOS password prompt, and Claude Code resets that access whenever it rewrites the item on a token refresh. So reads are shared per SERVICE, not per instance (`usage/keychain-read-cache.ts`: 45s window, concurrent reads joined, an item without a `claudeAiOauth` payload remembered for the process and never retried under the next account), only the user's Usage refresh or an instance edit reads past that, and nothing reads usage unasked: Settings prewarms the account list only, and Accounts reads once per visit.

## Skill exposure (shipped 2026-04-26)

`ProviderAdapter.listSkills?(threadId)` is the seam:
- **Claude adapter** captures `system/init.{slash_commands|commands}` and prefers live `query.supportedCommands()`. Cached on the active session.
- **Codex adapter** sends JSON-RPC `skills/list`, caches result. Older builds get a graceful empty cache (logged, not retried).
- **OpenCode** receives skills via `available_commands_update` ACP push events; the adapter caches the list and `listSkills()` returns it directly. (The earlier `opencode debug skill` shell-out was replaced when the ACP adapter was finalised.)
- IPC: `ProviderChannels.LIST_SKILLS` → `provider:list-skills` (preload `window.api.provider.listSkills(threadId)`).
- UI: `ChatInput` fetches on session start with retry-while-empty (handles late `system/init`); `mergeWithAgentSkills` keeps built-ins first, name-collisions resolve in favor of built-ins so `/clear` always means "clear chat" not whatever a skill named `clear` does. `SlashCommandMenu` renders source-grouped sections + argument-hint suffix. Agent-source selections insert `/<name> ` into the textarea (no special wire path) - the SDK / CLI parses leading slash from the prompt itself.

Pure parsers exported and unit-tested: `parseClaudeSlashCommands` (claude-adapter), `parseCodexSkills` (codex-adapter), `mergeWithAgentSkills` + `skillsToSlashCommands` (slash-commands.ts).

## OpenCode adapter

OpenCode ACP adapter (2026-04-28, only OpenCode adapter - legacy `opencode run --format json` shell-out retired 2026-05-02): speaks the Agent Client Protocol over a long-lived `opencode acp` child. Dynamic model list, shell-env probing for API keys, settings-DB key injection, placeholder + heartbeat + 3-min timeout (free-tier-aware error message) for cold-boot UX. Skill discovery via `available_commands_update` ACP push events. Helper: `adapters/opencode/env.ts` for shared env-probing.

- **OpenCode 1.x only, for now** (2026-09-29). OpenCode 2.x is the same `opencode` binary (curl installs it to `~/.opencode/bin/opencode`, v1's path too; npm `@opencode/cli`; brew `opencode-v2`, which conflicts with `opencode`) and it breaks us: `acp` takes no options, so our `acp --cwd <dir>` is rejected before ACP starts; `session/set_model` is gone (the model is a `session/set_config_option` with `configId: "model"`, `"effort"` for the variant) and `session/new` returns `configOptions` instead of `models`; and `opencode models` attaches to a shared background service spawned with its first caller's env, so an instance's API keys may not apply. `adapters/opencode/version.ts` reads `opencode --version` once per binary (keyed by path, mtime and size) and `assertSupportedOpencode` throws `OpencodeUnsupportedVersionError` for major >= 2 before the adapter start, the native-fork runner, the catalog probe and the Settings Test spawn anything. `--version` runs in the spawn's cwd, and the cache is keyed by cwd and by `opencodeEnvFingerprint` (a hash of PATH, HOME, `OPENCODE_*`, `XDG_*` and version-manager keys, never logged), for shims and wrappers that pick an install per directory or env. A native fork that is refused falls back to the handoff with the refusal as its warning (`native-fork-unsupported-version`). When it fails or is unparseable, `opencodeV2InstallSignal` judges the files without running anything: an `opencode2` shim beside the binary (v2's curl installer and `@opencode/cli`'s second npm bin; v1 has neither) or a real path in `@opencode/cli` or brew's `opencode-v2` Cellar means 2.x. With no version and no signal the binary is let through (a 1.x must not be locked out), and that is the known hole: a renamed or hand-copied 2.x that cannot print its version would run and could migrate `opencode.db` one way. Unparseable output is logged as a byte count only. A v2 path needs, behind a flag: no `--cwd` (spawn `cwd` covers it), model and effort changes through `setSessionConfigOption` whenever `configOptions` comes back (that response shape can pick the branch, so one adapter serves both), `--standalone` on `opencode models`, and a live re-check of the permission injection, the question tool and the `switchboard_*` tool names. Also note v2 migrates `opencode.db` forward in place and moves `auth.json` credentials into it, so a downgrade is not guaranteed clean. Research, from the v2.0.19 source: `docs/notes/opencode-v2-research.md`.

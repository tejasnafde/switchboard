# Task: cross-session messaging phase 2 (AGENT-initiated peer sends, Claude only)

Phase 1 (`/send-to`, user-typed) already shipped on main - see the "Design
decided" section at the bottom, which is still authoritative. This phase adds
two SDK MCP tools so the CLAUDE model can hand context to a sibling session
itself, plus the guards that make that safe unattended.

## Plan
- [x] 1. Pure guards in `src/shared/peer-messaging.ts` + tests
      (`nextHopDepth`, `PeerAgentSendGuard`, initiator type)
- [x] 2. `src/main/provider/peer-tools.ts`: tool names, descriptions,
      `PeerToolHost`, `createPeerToolHandlers` + tests
- [x] 3. Registry: extract `deliverPeerMessage(input)` as a public method,
      add `listPeerSessions`, `turnDepth`, agent guard; `types.ts` gains
      `setPeerToolHost?`
- [x] 4. Claude adapter: `createSdkMcpServer` wired into queryOptions,
      list-tool auto-allow in canUseTool
- [x] 5. UI: agent-initiated sender marker + `initiator` on `peer.message`
- [x] 6. Docs: CLAUDE.md feature note + /help line
- [x] 7. Gate: typecheck + full `npm test`, then FINAL commit WITHOUT
      `--no-verify`

## Current step: DONE

## Next concrete action
None. Typecheck clean, 221 files / 2311 tests green (was 202 files / 2091
before the mobile install, 2181 at the end of phase 1).

Deliberately deferred, not forgotten:
- Codex and OpenCode cannot SEND. They are valid targets. `setPeerToolHost?` is
  the seam; an equivalent is adapter work only.
- The mobile app does not render `peer.message` at all (pre-existing gap from
  phase 1), so an agent send is invisible on the phone until reload.
- The canUseTool approval for `send_agent_message` was confirmed by reading
  `sdk.mjs`, not against a live Claude session. If an agent send ever runs in
  sandbox with no approval card, check that first.

## Files touched so far
- CHECKPOINT.md
- src/shared/peer-messaging.ts (hop depth, agent guard, initiator, marker)
- tests/unit/peer-messaging-guards.test.ts (16 -> 30 green)
- src/main/provider/peer-tools.ts (new: names, descriptions, handlers)
- tests/unit/peer-tools.test.ts (new, 12 green)
- src/main/provider/provider-registry.ts (public deliverPeerMessage,
  listPeerSessions, turnDepth, peerAgentGuard, setPeerToolHost fan-out)
- src/main/provider/types.ts (setPeerToolHost? on ProviderAdapter)
- src/shared/provider-events.ts (initiator on peer.message)
- tests/unit/peer-agent-tools-ws.test.ts (new, 14 green)
- src/main/provider/adapters/claude-peer-tools.ts (new: SDK MCP binding)
- src/main/provider/adapters/claude-adapter.ts (mcpServers + list-tool allow)
- package.json (zod as a direct dependency)
- tests/unit/claude-peer-tools.test.ts (new, 4 green)
- src/renderer/components/chat/rotationMarker.ts (kind 'peer-agent')
- src/renderer/components/chat/sendToCommand.ts (prefix from initiator)
- src/renderer/components/chat/MessageBubble.tsx (agent-send pill copy)
- tests/unit/rotation-marker.test.ts (+2), tests/unit/send-to-command.test.ts
  (+1, fixture gained `initiator`)
- src/renderer/components/chat/slashCommands.ts + tests/unit/slash-commands.test.ts
  (/send-to description now says Claude can send one itself, +1 test)
- CLAUDE.md (Cross-session messaging section, what's-working bullet, file tree)

## Design decided for THIS phase (do not re-litigate)
- Tool names, as the model sees them: `mcp__switchboard__list_agent_sessions`
  and `mcp__switchboard__send_agent_message`. SDK MCP server name
  `switchboard`, registered per Claude session in `startDraining`.
- **The approval gate is the EXISTING one.** SDK MCP tools route through the
  CLI's permission system, so `canUseTool` fires for them (verified in
  `sdk.mjs`: `can_use_tool` is generic on `tool_name`). `decidePermission`
  therefore already gives exactly the required behaviour: prompt in
  sandbox/accept-edits, allow in full-access, deny in plan. No parallel prompt.
  `list_agent_sessions` gets an early auto-allow in `canUseTool` next to the
  ExitPlanMode / AskUserQuestion branches: it reads only titles the sidebar
  already shows, and prompting for it would train the user to click through.
- **Hop depth** counts consecutive AGENT-initiated hops since the last human
  message. `PEER_MESSAGE_MAX_HOP_DEPTH = 1`: a delivery creates depth
  senderDepth+1 and is refused when that exceeds 1, so only a turn the user
  started may originate an agent send. That kills A -> B -> A outright rather
  than allowing one round trip.
  - A USER-initiated `/send-to` sets the target's depth to 0, not +1: the human
    authored that text, so the recipient is not "one hop from a human".
  - Depth is NOT cleared on `turn.completed`, only on a user turn (set 0) or
    `STOP_SESSION` (deleted). A session that acted on a peer message therefore
    cannot originate one until the user speaks to it again, which is the whole
    point of the guard.
- **Per-sender budget** `PEER_AGENT_SEND_BUDGET = 6` per
  `PEER_AGENT_SEND_WINDOW_MS = 600_000` (10 min), keyed on the SENDING thread
  only. The existing per-pair limit is 5/60s, so five siblings would otherwise
  allow 25/min. 6 per 10 min is deliberately below 5x the pair limit, and still
  covers handing a finding to each of a handful of siblings once.
- Both guards refuse BEFORE recording, and both are released when `sendTurn`
  throws, exactly like the existing `PeerMessageGuard`.
- Refusals reach the MODEL as tool output with `isError: true`, never as a
  thrown MCP error, so it can adapt instead of retrying blindly.
- `PeerMessageInput.fromLabel` becomes optional: the adapter cannot know the
  sending conversation's title, so `deliverPeerMessage` falls back to
  `getConversationTitle(fromThreadId) ?? fromThreadId`.
- ONE delivery path. `ProviderRegistry.deliverPeerMessage` is public and both
  the IPC handler (`initiator: 'user'`) and the tool handler
  (`initiator: 'agent'`) call it. A test spies the method and drives both.
- Sender marker gains a second prefix `[[sb:peer-sent-agent]]` ->
  `parseRotationMarker` kind `'peer-agent'`. `[[sb:peer-sent]]` is not a string
  prefix of it (`-` follows, not `]]`), so the existing startsWith dispatch
  stays unambiguous.
- Codex and OpenCode stay valid TARGETS and cannot SEND: the tools are Claude
  SDK MCP tools. Nothing about the registry path is Claude-specific, so a
  Codex/OpenCode equivalent is adapter work only.
- `zod` moves into `dependencies` (was transitive via the agent SDK, deduped
  at 4.3.6): `sdk.tool()` needs a Zod raw shape for `inputSchema`.

## Gotchas learned
- `npm install` is required in a fresh worktree (done).
- `tests/unit/provider-switch-ws.test.ts` and the peer WS tests mock
  `src/main/db/database`; any new DB function the registry calls must be added
  to those mocks or the test throws.
- The per-pair rate limit (5) is LOWER than the per-sender budget (6), so a
  budget test must fan out over two targets or the pair limit fires first.
- MCP `CallToolResult` declares an index signature, so `PeerToolResult` needs
  `[key: string]: unknown` or the handler will not typecheck at the SDK edge.
- Tests are NOT typechecked (`tsconfig.*.json` include only `src/**`), so a
  stale event fixture in a test compiles even when the type gained a field.

## Design decided in PHASE 1 (still authoritative)
- Guard constants: 16 KiB body cap, 5 sends per (from,target) per 60_000 ms,
  identical content-addressed id dropped within 10 min. `now` is injected on
  every call; no clock inside the module.
- Content-addressed id: `pm_<16 hex>` = pure-TS FNV-1a 64. No node:crypto -
  `src/shared/*` has zero node imports and is consumed by the RN app.
- Delivery goes through the SAME code path as `ProviderChannels.SEND_TURN`.
  `respondToRequest` is never called, so a peer message structurally cannot
  resolve a pending approval.
- Target resolved through `resolveRootThreadId` before the adapter lookup
  (CLAUDE.md gotcha: sidebar surfaces the rotated Claude session UUID).
- `getSystemMarkerMessages` already matches `content LIKE '[[sb:%'`, so a
  sender marker survives a JSONL reload with no DB change.

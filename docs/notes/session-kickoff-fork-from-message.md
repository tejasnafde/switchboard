# Session kickoff — `fork-from-message` (#4)

Drop this doc into a fresh Claude session as the first turn. It's
self-contained: nothing here assumes prior conversation context.

---

## What we're building

A **"Fork from here"** action on any message in a chat panel. Forking
spawns a new conversation that:

1. Opens in a new chat tab (sidebar entry, fresh `AgentSession`).
2. Has a copy of every message **up to and including** the selected one
   from the source conversation.
3. Is wired to the agent's resume mechanism so the new session keeps
   real context — not just visual continuity. For Claude, that means
   passing `--resume <new-uuid>` against a JSONL we wrote ourselves;
   for Codex, that means seeding the app-server session with the same
   history the user sees.
4. Records its parent in the DB so the sidebar can render fork lineage
   (e.g. an arrow / indent marker; UI scope is up to you).

Why: lets the user explore alternative paths without nuking the working
conversation. Same primitive Cursor and Claude Desktop ship; ours has
to also work across all three adapters (Claude / Codex / OpenCode).

---

## Repo orientation (Switchboard)

Electron 33 + React 19 + TypeScript 5.7. Read `CLAUDE.md` at the repo
root for full stack notes. Test runner is vitest (~520 tests). Always
run `npm run typecheck && npm test` before declaring done.

Key files for this work:

- **Schema**: `src/main/db/database.ts:44-64` — `conversations` table
  (no `parent_conversation_id` yet — you'll add one) and `messages`
  table at lines ~80-110. There's also a `thread_sessions` table at
  ~447 mapping a threadId to the child Claude session UUIDs we've seen
  for it; relevant for resume behaviour but separate from forks.
- **Claude JSONL**: Claude Code stores sessions at
  `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. Encoder is in
  `src/main/projects/session-scanner.ts` (`encodeClaudeProjectPath` —
  exported). Each line is a JSON event with a `uuid` field per message
  and `parentUuid` for the parent. Truncating means: copy the file up
  to the matching `uuid` line, fix up the `parentUuid` chain at the
  cut point, write to a new `<new-uuid>.jsonl`.
- **JSONL parser**: `src/main/agent/jsonl-parser.ts:82-100, 199-201`
  for the read path. Use it as a reference but don't try to invert it
  — you only need to copy lines up to a marker, not re-emit them.
- **Provider registry**: `src/main/provider/provider-registry.ts:89-100`
  is `START_SESSION`. `SessionStartOpts` (`src/main/provider/types.ts:47-56`)
  already accepts `resumeSessionId` — the Claude adapter wires it to
  the SDK at `claude-adapter.ts:280-282`. No new IPC plumbing needed
  for the resume side; you just need to give the right UUID.
- **Codex resume**: app-server JSON-RPC takes a `sessionId` on the
  initial `session/start` call. Codex stores its sessions under
  `~/.codex/sessions/<uuid>.jsonl`. Same truncation strategy: copy
  lines up to the chosen message, fix any back-pointers, point the
  new session at the new file. Codex JSONL events also have ids,
  see `jsonl-parser.ts` Codex branch.
- **OpenCode (ACP)**: `src/main/provider/adapters/opencode-acp-adapter.ts`.
  ACP doesn't have a public "load N events then continue" endpoint
  yet. Treat OpenCode forks as **best-effort summary-only** for v1
  (concat the prior turns into a system prompt and start a fresh
  session). Document this clearly in code comments.
- **MessageBubble**: `src/renderer/components/chat/MessageBubble.tsx`.
  No message-level context menu yet — the only `onContextMenu` is on
  the image preview overlay (line 425-442). Add a right-click handler
  on the bubble root that opens a small popover (mirror
  `SlashCommandMenu` styling — `sb-floating-surface` class + the
  `popoverStyle` constant).
- **Sidebar**: `src/renderer/components/sidebar/Sidebar.tsx`. After
  the new conversation lands in the DB and a new `AgentSession` is
  added to the store, the sidebar will pick it up automatically.
  Forklineage indicator is bonus, not required for v1.
- **Agent store**: `src/renderer/stores/agent-store.ts:24-69`. The
  `AgentSession` shape has `conversationId`, `projectPath`,
  `resumeSessionId`, `messages`, `runtimeMode`. After fork, `addSession`
  with the new ids + the copied `messages` then call `setActiveSession`.

---

## Implementation plan

### 1. Schema migration

Add `parent_conversation_id TEXT` and `forked_at_message_id TEXT` to
`conversations`. Both nullable. Migration goes in `database.ts` — copy
the pattern of an earlier `ALTER TABLE` block (search for
`ALTER TABLE conversations`).

### 2. IPC: `conversations.fork`

Main-side handler in `src/main/ipc/app.ts`. Signature:

```ts
fork(args: {
  sourceConversationId: string
  upToMessageId: string
}): Promise<{ conversation: Conversation; resumeHint: string | null }>
```

Logic:

1. Look up the source conversation; resolve its `agent_type`.
2. Generate a new conversation row with a fresh id, `parent_conversation_id`
   = source, `forked_at_message_id` = upToMessageId, copy `project_path`,
   `agent_type`, `title` (suffix " · fork"), `created_at = now`.
3. Copy rows from `messages` where `conversation_id = source` AND
   `position <= upToMessage.position` (or whatever ordering you have)
   into the new conversation — assign new message ids but preserve
   role/content/tool_calls/timestamp.
4. **Adapter-specific resume prep**:
   - **Claude**: read the source JSONL (path derives from
     `encodeClaudeProjectPath(project_path)` + the source's stored
     Claude UUID), copy lines up to the matching `uuid`, generate a
     new UUID for the fork, write the file. Return `resumeHint =`
     new UUID. Note: when truncating, the last copied line's `uuid`
     becomes the resume anchor; the SDK will pick up from there.
   - **Codex**: same idea against `~/.codex/sessions/`. Return new
     session UUID as `resumeHint`.
   - **OpenCode**: return `resumeHint = null` (renderer will treat
     this as "summary-only" mode and prepend a synthetic
     `<previously-discussed>` system message on first turn).
5. Return the new conversation + hint.

### 3. Renderer: context menu

`MessageBubble.tsx`:

- Add `onContextMenu` to the bubble root. Open a popover positioned at
  the click coordinates with two entries (more later): "Fork from here"
  and "Cancel".
- On select, call `window.api.conversations.fork({ sourceConversationId,
  upToMessageId: message.id })`.
- On success: `addSession(...)` to agent-store with the fork's id +
  messages + `resumeSessionId = resumeHint ?? undefined`. Then
  `setActiveSession(newId)`.

Reuse `SlashCommandMenu` as a styling reference — same floating
surface, same accent on the active row.

### 4. Resume verification

Smoke test by hand: fork mid-conversation in Claude, send a follow-up
in the new chat, verify the agent's response references prior turns
("As we discussed earlier..." kind of thing). If it doesn't, the JSONL
truncation is wrong — most likely culprit is `parentUuid` of the cut-
point line not matching anything in the new file.

For Codex: same flow. Use `cat ~/.codex/sessions/<uuid>.jsonl | wc -l`
before/after to sanity check.

### 5. Tests

Pure functions worth unit-testing (place in `tests/unit/`):

- `truncateClaudeJsonl(content, upToUuid) -> { newContent, anchorUuid }`
  — copy lines up to and including the line whose `uuid` matches.
  Bail if not found. Don't rewrite `parentUuid` of unrelated lines.
- `truncateCodexJsonl(content, upToEventId)` — same shape.
- DB-level: in-memory sqlite, insert source conversation + 5 messages,
  call `fork` for message #3, assert new conversation has 3 messages
  and `parent_conversation_id` is set.

---

## Pitfalls / gotchas

- **JSONL line ordering**: Claude's events aren't strictly chronological
  if subagents write back in parallel. Use `parentUuid` chains, not line
  position, to determine "up to and including".
- **Image messages**: `messages.images` is a separate JSON column (or
  blob refs — read the schema). Make sure the copy pulls them through.
- **Tool call IDs**: don't strip `tool_calls` from copied messages —
  the agent's resume needs them to understand what tools have been
  called already.
- **Concurrency**: don't fork while the source session has a turn in
  flight. Either block in the UI or check `session.status === 'idle'`.
- **`thread_sessions` table**: this is unrelated to forks. It maps the
  *threadId* (Switchboard's stable id for an open chat) to the *child
  Claude session UUIDs* that the SDK has produced for that thread over
  successive `--resume` calls. Don't conflate with fork lineage —
  forks happen at the conversation level and produce a new threadId.
- **OpenCode best-effort note**: leave a TODO in the adapter pointing
  to the future ACP `session/load` extension when one exists. Don't
  ship a half-broken truncation; explicit summary-only is fine for v1.

---

## Definition of done

- `parent_conversation_id` + `forked_at_message_id` columns exist with
  a forward-only migration.
- `conversations.fork` IPC handler ships with adapter-aware JSONL
  truncation for Claude + Codex.
- "Fork from here" right-click menu on `MessageBubble`.
- Forked Claude session demonstrably resumes (manual smoke).
- Forked Codex session demonstrably resumes (manual smoke).
- OpenCode falls back to summary-only with a clear TODO comment.
- Unit tests cover the JSONL truncation pure functions + the DB row
  copy.
- `npm run typecheck && npm test` clean.
- One CHANGELOG.md line.

---

## Out of scope (do these later)

- Worktree on fork (that's #5 — see `session-kickoff-fork-to-worktree.md`).
- Sidebar lineage UI (arrow/indent showing parent → fork).
- Forking inside a forked session (works structurally — DB column is
  set — but visual hierarchy depth is a follow-up).
- Bulk fork (fork from this message + open N parallel forks at once).

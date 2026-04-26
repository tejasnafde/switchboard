# Switchboard

### The unified workspace for developers who run agents, terminals, and chats — not in separate apps, but as one coherent view per project.

---

## The Problem

Modern AI-assisted development has fractured the developer's attention across at least four disconnected surfaces:

**The IDE** (Cursor, VS Code) — where you read and write code, but whose terminal is an afterthought and whose chat history is locked in a workspace-scoped SQLite DB (`state.vscdb`) with no interop.

**The Agent TUI** (Claude Code, Codex CLI) — powerful coding agents that run in a terminal, maintain rich conversation histories (JSONL in `~/.claude/projects/` and `~/.codex/sessions/`), but have zero awareness of your other running processes. You can't say "look at this error in my frontend terminal" — you have to copy-paste it.

**The Terminal Multiplexer** (tmux, cmux) — where your actual services run: frontend dev server, backend, DB tunnels, log tails. tmux is battle-tested but blind to agents. cmux (Fdds agent-aware notifications, vertical tabs, and a socket API, but it's still *just* a terminal — no chat UI, no conversation persistence across sessions, no declarative project layouts.

**The Launch Config** (Warp YAML) — the only tool that lets you declaratively define "for this project, open these tabs with these commands." But it's Warp-only, has no agent/chat integration, and the configs don't travel with the repo.

The result: you `⌘-Tab` between 3-4 apps constantly. Your agent can't see your terminal output. Your terminal can't see your agent's reasoning. Your conversation history is scattered across `~/.claude/`, `~/.codex/`, and Cursor's SQLite. When you switch repos, you start from scratch. When you resume tomorrow, you reconstruct the layout manually.

**Nobody has built the switchboard** — the single surface that multiplexes terminals *and* agent chats, persists the layout per-project, and lets information flow between panes and the AI.

---

## The Gap: Where dpcode, cmux, and t3code rt

| Capability | cmux | t3code / dpcode | Warp | **Switchboard** |
|---|---|---|---|---|
| Terminal multiplexing | ✅ Split panes, vertical tabs | ❌ No terminals | ✅ Tabs + splits | ✅ |
| Agent chat UI | ❌ Raw TUI only | ✅ Web GUI for Codex/Claude | ❌ | ✅ |
| Multiple concurrent agents | ✅ Via panes | ❌ Single thread | ❌ | ✅ |
| Import existing conversations | ❌ | ❌ | ❌ | ✅ Claude + Codex + Cursor |
| Terminal → Agent context | ❌ Copy-paste | ❌ | ❌ | ✅ Select text, ⌘+L |
| Declarative project layouts | ❌ (via `.vscode/terminals.json` hack) | ❌ | ✅ YAML launch configs | ✅ YAML, lives in repo |
| Per-project workspace persistence | ❌ | Partial (thread per project) | ❌ (session restore) | ✅ |
| Conversation history browsing | ❌ | Partial | ❌ | ✅ Unified across agents |

**dpcode specifically**: It's a T3 Code fork with 1,129 commits, ~130 stars, single contributor. It adds Claude Code support alongside Codex. But its TODO reveals where it actuallre no terminals, no split panes, no layout persistence, no conversation import. It's a chat GUI wrapper, not a workspace. The delta from dpcode to what we want is enormous — it would need a ground-up rearchitecture to become a multiplexed workspace rather than a chat app.

**cmux specifically**: Closest to the terminal side of the vision. Native macOS (Swift/AppKit + libghostty), socket API for automation, agent notification rings, embedded browser. But it has no chat UI — you see agent TUI output in a terminal pane, not rendered markdown. No conversation import. Layout persistence is manual or via the community `terminals.json` hack, not a first-class feature. It's an *agent-aware terminal*, not an *agent workspace*.

---

## The Vision: Switchboard

One window. One project. Everything connected.

```
┌─────────────────────────────────────────────────────────────┐
│  Switchboa                                            │
│ Projects │              CHAT (primary surface)              │
│          │   ┌──────────────────────────────────────────┐   │
│ geoiq-   │   │ Claude Code — Session: pipeline-fixes    │   │
│ analytics│   │ ─────────────────────────────────────────│   │
│ ●        │   │ You: The staging promotion failed, here's│   │
│          │   │ the error from the backend terminal ↗     │   │
│ ssg-     │   │                                          │   │
│ saathi   │   │ Claude: Looking at the dbt test output   │   │
│          │   │ you attached from pane [backend]...       │   │
│ celliq   │   │                                          │   │
│          │   └──────────────running   │ │ ▶ running   │ │ ▶ conn.   │ │
│ ●        │  │             │ │             │ │            │ │
│ schema   │  │ localhost:  │ │ ERROR:      │ │ SELECT ... │ │
│  migra.  │  │ 3000 ready  │ │ dbt test   │ │            │ │
│          │  │             │ │ failed...   │ │            │ │
│ prev.    │  └─────────────┘ └──────⬆──────┘ └───────────┘ │
│ sessions │            select text → ⌘+L → chat             │
│ (import) │                                                  │
└──────────┴───âhitecture: Building Blocks to Glue Together

### Layer 1 — Terminal Engine
**libghostty** (or xterm.js for cross-platform). cmux proved libghostty works beautifully for this. The terminal panes are real PTY sessions — they run your dev server, your DB tunnel, your log tail. Each pane has a label, a status indicator, and the ability to capture selected text as structured context.

### Layer 2 — Agent Runtime Bridge
Don't rebuild Claude Code or Codex. Spawn them as subses in terminal panes, but intercept their I/O via the existing protocols:
- **Claude Code**: Spawn `claude` CLI. Read conversation state from `~/.claude/projects/{project}/` JSONL files. Use `claude --resume <session-id>` to continue threads. Hook into Claude Code's hook system for status updates.
- **Codex CLI**: Spawn `codex` CLI. Read from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Use `codex resume --session <id>`. Same hook pattern.
- **Future agents**: Any CLI agent that writes JSONL transcripts — this is becing the de facto standard.

The chat UI is a **rendered view** on top of the agent's TUI — parse the JSONL, render markdown, show tool callas collapsible blocks. The raw TUI still exists in the background pane for power users.

### Layer 3 — Conversation Import & Unified History

This is the killer differentiator. On first launch for a project, Switchboard scans:

| Source | Location | Format |
|---|---|---|
| Claude Code | `~/.claude/projects/{encoded-path}/` | JSONL per session + `sessions-index.json` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL with CWD metadata |
| Cursor | `~/Library/Application Support/Cursor/User/workspaceStorage/*/state.vscdb` | SQLite → `composer.composerData` key |

All three get normalized into a unified conversation format and shown in the sidebar as "Previous Sessions." You can browse, search, and *fork* any past conversation into a new active agent thread. Your history follows you into the new tool.

### Layer 4 — Project Layout Config (the "Switchboard File")

 file that lives **in the repo** at `.switchboard/workspace.yaml`:

```yaml
name: geoiq-analytics
agent: claude-code  # or codex, or auto-detect

terminals:
  - name: frontend
    cmd: npm run dev
    cwd: ./frontend
    
  - name: backend
    cmd: python -m uvicorn main:app --reload
    cwd: ./backend
    
  - name: db-tunnel
    cmd: gcloud compute ssh db-proxy -- -L 5432:10.0.0.3:5432
    
  - name: db-shell
    cmd: psql -h localhost -p 5432 -U analytics
    
  - name: logs
    cmd: tail -f /var/log/app/*.log

layout:
  chat: 65%          # chat takes 65% of width
  terminals: 35%     # terminal strip takes 35%
  terminal_rows: 2   # arrange terminals in 2 rows

on_start:
  - wait: frontend   # wait for "ready" in frontend before starting backend
    pattern: "compiled successfully"
  - then: backend
```

This is the Warp Launch Config concept, but project-portable and agent-aware. Check it into git. New team member clones, runs `switchboard`, gets the full workspace.

### Layer 5 — Context Bridge (the ⌘+L interaction)

The core UX innovation. When you select text in a terminal pane:
- `⌘+L` — append to the current chat as context (like Cursor's behavior)
- `⌘+K` inline quick-prompt with that context
- The context carries metadata: which pane, what command was running, timestamp

This means the agent can reason about: "The error in your backend pane at 14:32 shows a dbt test failure on `stg_store_metrics`. Looking at your `models/staging/` directory..."

### Layer 6 — Electron/Tauri Shell

Package as a desktop app. Electron is the pragmatic choice (dpcode/t3code already use it, xterm.js is native). Tauri is lighter but would need a Rust terminal implementation. Given the goal is shipping fast, Electron + xterm.js + React is the path — fork from dpcode's shell but gut the internals.

---

## Build vs. Fork Decision

**Don't fork dpcode.** It's too far from the target. dpcode is a chat GUI that wraps agent CLIs. Switchboard is a workspace multiplexer that happens ave a chat as its primary surface. The architecture is inverted.

**Do steal from cmux's design language** — vertical tabs, notification rings, status indicators. But implement in Electron, not native Swift, for cross-platform reach and faster iteration.

**Do study t3code's agent spawning** — it solved the "wrap Claude Code / Codex as a subprocess and render their output" problem. Extract that pattern.

**Build on these exng libraries:**
- `xterm.js` — terminal rendering
- `node-pty` — PTY management  
- `better-sqlite3` — reading Cursor's `state.vscdb`
- JSONL parsing — for Claude Code + Codex history
- `marked` / `shiki` — markdown + code rendering in chat
- Electron IPC — for contetween terminal panes and chat

---

## Name

**Switchboard** — a switchboard operator connects any line to any other. That's exactly the metaphor: connecting terminals, agents, and conversations through a single surface. It also evokes "switching context" — which is the pain it enates.

---

## Phase 0: What to Build First (2-week proof of concept)

1. Electron shell with split layout: chat panel (65%) + terminal strip (35%)
2. Spawn Claude Code in a managed PTY, render its JSONL output as markdown in the chat panel
3. 2-3 additional terminal panes with configurable commands
4. `⌘+L` to capture selected terminal text into the chat input
5. Read `~/.claude/projects/` to s sessions in the sidebar
6. Basic `.switchboard/workspace.yaml` parser for layout + commands

That's enough to replace the daily `tmux + Claude Code + ⌘-Tab` loop. Everything else — Codex support, Cursor import, workspace persistence, team configs — layers on top.

# Data Scientist Mode - design (2026-07-18)

Adopt CellIQ's notebook-mirror concept into Switchboard as an SSH-first "data scientist mode":
the embedded code-server workbench (with notebooks) becomes the center pane, agent chat moves to
the right pane, and agents edit an LLM-friendly `.py` mirror instead of raw `.ipynb` JSON.

Source project: `~/Desktop/projects/celliq` (Electron notebook editor with a `.ipynb <-> .py`
bidirectional sync engine). Its PRD's core insight holds: don't fix the agent, fix the interface.

## Who this is for (SSH-first)

Primary persona: data scientists who SSH into client-specific servers via VS Code Remote-SSH,
run the Claude Code extension there, and live in a remote file explorer full of
`analysis_final_v2.ipynb`, `.xlsx` and `.csv` dumps.

Switchboard's remote architecture is already this shape: headless server (`src/server`, `WsHost`)
on the VM, desktop app over an `ssh -L` tunnel, agents/PTYs/git/fs spawning remotely. Data
scientist mode extends that with two more remote services (code-server + jupyter server) tunneled
over the same SSH connection. **Remote is the primary deployment; local is the degenerate case.**
`TransportRouter` already drives multiple machines in one window, so one Switchboard window can
multiplex several client servers - a real upgrade over one VS Code window per client.

Note: only Claude is allowed remote today (`remote-gate.ts`), which matches the office's stack
(Claude Code extension). Codex/OpenCode stay local-only for now.

## Decisions (locked 2026-07-18)

1. **Notebook surface: embedded code-server + seeded Jupyter extension.** VS Code web has the
   notebook editor built in; rendering + execution needs `ms-toolsai.jupyter` (published on
   Open VSX). Seed it the way `sb-bridge` is seeded (`code-server-manager.ts` `seedBridgeExtension`).
   No custom notebook renderer - users expect the VS Code notebook UX from the IDE pane anyway,
   and rich mime rendering (plots, dataframes, widgets) comes for free.
2. **Kernel: shared jupyter server.** Switchboard spawns a real `jupyter server` per project
   (on the machine where the code/data live). The code-server Jupyter extension connects to it as
   a remote kernel, AND the agent gets MCP tools (`run_cell`, `read_variable`, `list_variables`,
   `kernel_status`) against the same live kernel. One kernel, two clients - the agent verifies
   edits in the user's actual session state. This is the differentiator.
3. **Mirror home: hidden + gitignored.** `<repo>/.switchboard/notebooks/<name>.py`, consistent
   with the worktrees convention. Regenerable, zero repo noise. A committed jupytext-style pair
   (git-friendly notebook diffs in PRs) is a possible later opt-in, not v1.
4. **Activation: per-session toggle + sticky per-project preference.** A keybinding (proposed
   cmd+shift+J) + composer chip flips the session layout. Mirror sync + `.ipynb` guardrails are
   ALWAYS on for any project containing notebooks, regardless of layout mode.
5. **Sticky mode preference - for ALL modes, not just DS.** Treat the top-level surfaces as
   peer "modes": dev (chats), PM (kanban), data science. Track mode usage per project (settings
   DB, e.g. `layout.modeUsage.<projectPath>` counters or last-N-sessions). On opening a project,
   launch into its most-used mode - a PM-heavy project reopens on the kanban board, a dev repo in
   chats, a client server in DS mode. Global fallback for new projects; explicit per-project
   override in Settings. Same persistence pattern as `layout.appView`, which becomes derived
   rather than a single global toggle.

## What ports from CellIQ vs what gets rebuilt

Port nearly verbatim (~380 lines, into `src/main/notebooks/`):
- `mirror-format.ts` (132 lines, fully pure). Marker format:
  `# %% [cellbridge_id=<uuid>] [type=code|markdown|raw] [lang=python|markdown]`.
  Code cells raw; markdown cells `# `-prefixed per line; outputs stripped from the mirror.
  Header says "EDIT THIS FILE" (an earlier "DO NOT EDIT MANUALLY" header made Claude bypass the
  mirror and reach for NotebookEdit - keep the regression tests that pin this).
- `sync-engine.ts` (248 lines). chokidar watchers both directions, `pendingSelfWrites` counter as
  echo-loop guard, 150ms debounce. Only Electron coupling is its logger import - swap for
  `createMainLogger('notebooks:sync')`. Runs in the backend process, so it works behind BOTH
  `ElectronIpcHost` and `WsHost` (remote sync for free - the files are on the VM, so is the engine).
- The system-prompt spec from `claude-protocol.ts` (mirror rules, id preservation, markdown
  prefixing) - feeds our `appendSystemPrompt` and the deny-redirect copy.
- Kernel env discovery (venv/.venv in project -> system pythons -> `conda env list --json` ->
  pyenv). Genuinely good; reuse for the jupyter-server env picker (run via the backend so it
  probes the right machine).
- MCP kernel-tool concept (`run_cell` / `read_variable` / `list_variables` / `kernel_status`),
  re-pointed at the jupyter server's REST/WS API instead of CellIQ's stdio toy.

Fix during the port (real CellIQ bugs, confirmed by code audit):
- **Write-before-review**: CellIQ writes the `.ipynb` inside `watchMirror` BEFORE showing the diff
  UI, violating its own "write only on accept" spec. In Switchboard the mirror edit is reviewed
  via the diff card first; the `.ipynb` write-back happens on accept/resolve.
- **Stale output re-attachment**: `syncFromMirror` re-attaches outputs/execution_count from the
  notebook snapshot captured at open time. Re-read the live `.ipynb` at sync time so outputs
  computed after open survive agent edits to other cells.
- **Metadata loss**: CellIQ's save keeps only `cellbridge_id` per cell, dropping tags/collapsed/
  slideshow metadata. Preserve full cell metadata on write-back.
- **Cell identity**: prefer nbformat 4.5's native cell `id` over custom metadata where present
  (fall back to injecting one). Less invasive, same guarantee.
- CellIQ's per-cell accept/reject buttons are cosmetic (only accept-all is wired) - ours rides
  the already-working per-hunk FileDiffCard flow instead.

Do NOT port: CellIQ's kernel bridge (custom JSON-over-stdio, text-only outputs, no plots, no
interrupt, 30s hard timeout, single namespace). Toy. The jupyter server replaces it.
Do NOT port: CellIQ's notebook renderer (CodeMirror cells, text-only outputs) - code-server is
the surface.

## Architecture

### Guardrails (always on, all providers, local + remote)

Two layers at existing seams:

1. **Hard deny + redirect in `policy.ts`** (shared by all adapters). If the tool is an edit tool
   (incl. `NotebookEdit`, Codex `write_file`/`apply_patch`) and the write path ends in `.ipynb`
   (reuse `worktree-drift.ts` `extractWritePaths` - it already knows `file_path`/`notebook_path`/
   `path`), deny with: "Notebooks are edited via their .py mirror. Edit `<mirror path>` instead."
   The denial message TEACHES the agent the mirror path - self-healing, provider-agnostic, renders
   as the existing `tool.denied` pill. (Optional later: allow-with-rewrite via `updatedInput`,
   which the SDK honors - the AskUserQuestion path proves it. Start with deny; it's legible.)
   Reads of `.ipynb` stay allowed (agents may need outputs/errors context); only writes redirect.
2. **`appendSystemPrompt` on the Claude adapter** carrying the mirror-format spec + active mirror
   paths. The SDK `Options` supports it; `claude-adapter.ts` `queryOptions` (~line 699) just
   doesn't set it yet - this is the one clean per-session prompt seam. Codex/OpenCode have no
   prompt seam today; layer 1 carries the load there.

Mirror lifecycle: when a session's project (or worktree) contains `.ipynb` files, the backend
registers sync pairs lazily - generate mirror on first agent touch or notebook open, TTL-clean
orphans, ensure `.switchboard/` is gitignored (worktree flow already establishes this convention).

### Diff review (reuses the existing pipeline unmodified)

Agents edit the mirror -> the per-turn git checkpoint diff (`checkpoint.ts` temp-index tree diff)
picks up `.switchboard/notebooks/<name>.py`... **caveat: gitignored files don't appear in
`git add -A` tree diffs.** Resolution options, pick during implementation:
  a. Exempt `.switchboard/notebooks/` from gitignore (ignore only worktrees), or
  b. Emit a synthetic `file.edited` event from the sync engine when an agent write lands (the
     sync engine already knows old/new mirror content - no git needed).
Option (b) is cleaner and also works for non-git projects; it feeds the same
`file.edited -> ChatPanel attachment -> FileDiffCard -> files:write-file` skeleton.

Because `# %%` markers delimit cells, line hunks in the mirror already correspond ~1:1 to cells,
so per-hunk keep/revert IS per-cell accept/reject. On resolve: write resolved mirror ->
sync engine propagates to `.ipynb` (preserving outputs on untouched cells).
Suppress raw diff cards for `.ipynb` files that have a live mirror pair (otherwise every accepted
edit produces a useless JSON-wall card next to the clean mirror card).
Later polish: `NotebookDiffCard` that groups hunks under cell headers + CellIQ's AST badges
(`+ import`, `sig changed`, complexity) via its `ast_diff.py`.

### Layout: chat right, workbench center

Approach: swap within the chats view (NOT a new AppView).
- `layout-store`: add `dataScienceMode` (per-session map or active-session flag) + the sticky
  per-project preference described above.
- `App.tsx` center `flex:1` slot (where ChatPanel renders): when active, host the IDE surface.
- ChatPanel becomes a THIRD display-toggled absolute overlay in the existing right pane
  (`terminalRef` div) alongside TerminalStrip/IdePane - the overlay-mount pattern already
  preserves state across toggles. `RightPaneMode` widens accordingly; cmd+shift+E cycling gains
  a mode or DS mode pins the right pane to chat and cycles center content instead.
- `IdePane` is reused for the center slot (same webview, `visible` keyed off the new mode).
  Copy `ChatSplitHandle` for the center/right divider.
- Terminal access in DS mode: terminals remain reachable (right-pane cycle or the workbench's own
  terminal, which sb-bridge already routes to Switchboard's terminal intent).

### SSH-first: remote code-server + remote jupyter

Today code-server is local-only (spawned in the Electron main process; no IDE handlers on
`WsHost`). For remote machines:
- **Spawn on the VM**: move/mirror `code-server-manager` behind the backend seam so the headless
  server (`src/server`) can spawn code-server on the remote (`--bind-addr 127.0.0.1:<port>`,
  `--auth none` - same same-user trust boundary as PTYs, unreachable except via the tunnel).
  Binary download targets the remote's OS/arch; extend `provisioner.ts` to install it alongside
  the headless server, and seed sb-bridge + Jupyter extension there.
- **Tunnel**: extend `sshTunnel.ts` to forward multiple ports on the one ssh process
  (`-L wsPort -L codeServerPort -L jupyterPort`). Ports negotiated at connect via the existing
  connection manager handshake.
- **Webview**: `IdePane` loads `http://127.0.0.1:<localForwardedPort>/?folder=<remote path>`.
  From the workbench's perspective nothing changed; open-at-line keeps flowing through the
  bridge-server (which must also listen VM-side; route its WS over the tunnel or via WsHost).
- **jupyter server**: spawned by the backend on whichever machine owns the project (local host or
  VM). The code-server Jupyter extension connects to `http://127.0.0.1:<port>` with the generated
  token (seed via workbench settings). Agent MCP kernel tools run in the backend process, so they
  hit the jupyter server locally on the VM - no extra tunneling for the agent path.
- Already remote-safe with zero work: mirror sync (backend-side chokidar), guardrails (policy runs
  in the adapter on the VM), checkpoint diffing (runs where the provider registry runs),
  `files:*` write-back (routes by `repoRoot` through `TransportRouter`).

### Kernel sharing detail (phase 4)

`jupyter server` (not bare ipykernel) gives: kernel lifecycle REST API, WS execute channel with
full mime bundles (plots/HTML), interrupt/restart, multiple kernels. The MCP server is a thin
stdio process (like CellIQ's bundled `mcp-kernel-server`) that the Claude session gets via
mcp-config, talking to the jupyter REST/WS API. Tool set: `run_cell(code)` (returns text +
truncated rich-output summaries), `read_variable(name)`, `list_variables()`, `kernel_status()`.
Env picker: port CellIQ's discovery, executed via the backend so it probes the correct machine;
selected env persists per project. Kernel must have `ipykernel` + `jupyter_server` installed -
detect and offer `pip install` into the selected env (data scientists' client servers won't
always have it).

## Conflict + echo nuances

- Sync engine's `pendingSelfWrites` counter assumes 1:1 write-to-event; add coverage for chokidar
  event coalescing (untested in CellIQ - its sync-engine tests never import the real class).
- code-server as a third writer: user edits in the workbench -> autosave (already seeded on)
  writes `.ipynb` -> chokidar sees a normal user edit -> mirror regenerates. Fine.
- Write-back echo into the workbench: when the sync engine writes the `.ipynb` after an accepted
  agent edit, VS Code auto-reverts the open editor if it isn't dirty. The real conflict window is
  user-dirty-editor + concurrent agent mirror edit: v1 policy = pause mirror->ipynb write-back
  while the diff card is unresolved, and let the diff card be the merge UI. Detect user `.ipynb`
  changes during a pending review and re-baseline the card (CellIQ's "Flow 3" was never built;
  this is our answer).
- A code line literally starting with `# %% [cellbridge_id=` inside a cell would be misparsed
  (no escaping in the format) - keep CellIQ's guard test, accept the edge case.
- `.xlsx`/`.csv` dumps: no special handling needed - the workbench file explorer + extensions
  cover viewing; agents already read them via Bash/Read on the remote.

## Phase 0 spike results (2026-07-18) - PASSED

Automated with Playwright against Switchboard's pinned code-server 4.127.0
(harness preserved at `e2e/notebook-ide.spike.cjs`; run instructions in its header):

- `ms-toolsai.jupyter` 2025.9.1 installs from Open VSX via `--install-extension`, with the full
  dependency chain auto-resolved (jupyter-renderers, keymap, cell-tags, slideshow, ms-python.python,
  debugpy, python-envs). No vsix wrangling.
- Notebook renders as real cells (not raw JSON), project `.venv` offered as Recommended by the
  kernel picker (extension has its own conda/pyenv/venv discovery - CellIQ's discovery port is
  only needed for OUR jupyter-server spawn, not the workbench picker).
- Run All against the `.venv` kernel: pandas dataframe renders as an HTML table, matplotlib plot
  renders as an image, shared kernel state across cells confirmed. Rich outputs confirmed free.

Gotchas captured for the real integration:
- **Extension-host readiness race**: opening an `.ipynb` before the extension host finishes
  registering providers opens it as raw JSON text. The IdePane prewarm likely absorbs this, but
  open-at-notebook routing should wait for extension-host readiness (or use a Reopen-With
  fallback, see the spike harness).
- **Workspace trust**: `security.workspace.trust.enabled: false` must be seeded (already in
  `ide/settings.ts` SEEDED_DEFAULTS - the spike initially missed it and got Restricted Mode,
  which blocks extensions).
- **Kernel-pick footgun**: selecting a global interpreter without ipykernel produces a red error
  (the extension offers an auto-install). Our jupyter-server phase sidesteps this by pointing the
  workbench at Switchboard's own server, but v1 UX should nudge toward the project venv.
- The extension surfaces "Existing Jupyter Server..." as a kernel source - exactly the seam
  phase 4 plugs the shared jupyter server into.

**VM-side tunnel test (2026-07-18) - PASSED.** Ran the same Playwright harness against
code-server 4.127.0 (linux-amd64) provisioned on `geoiq-ssg-bot-stg-in` (a Switchboard-registered
staging VM, reached through a gcloud IAP `ProxyCommand`), tunneled via
`ssh -N -L 8378:127.0.0.1:8378`. All 6 checks passed, including reading a seeded `.csv` +
`.xlsx` from the remote filesystem (the target persona's data-dump scenario). Cell execution
round-trips were 0.3-0.5s through the tunnel. Findings:
- `ssh -L` composes fine with IAP ProxyCommand - no changes needed to the tunnel approach,
  just an extra `-L` flag per service on the existing connection.
- Open VSX extension install works identically on linux-amd64.
- The hostile-env risk is real on the very first box tried: `python3-venv` was missing and
  needed `sudo apt-get install python3.12-venv`. Provisioner must handle this (the machines
  table already models a sudo user), and kernel features must degrade gracefully without it.
- Full provision (code-server download + extract + 8 extensions + venv with
  ipykernel/pandas/matplotlib/openpyxl) took ~2 minutes on the staging VM.

Phase 0 is COMPLETE - both gates passed, surface decision final.

## Mode UX continuity (decided 2026-07-18)

DS mode reuses the SAME code-server + seeded extensions as the existing IDE pane, so:
- **Theme sync**: the sb-bridge extension's Switchboard Charcoal theme + live config apply carry
  over unchanged. Seed the Jupyter extension alongside sb-bridge in `seedBridgeExtension`'s dir.
- **cmd+l / cmd+k**: bridge selection-capture and quick-edit keep working by construction (same
  webview, same bridge). Verify cmd+l inside a notebook cell editor (cells are text editors, so
  `activeTextEditor` selection should capture) - and the resulting pill should reference the
  mirror path + cell, not the raw `.ipynb`, so the agent receives an editable target.
- Testing pattern: workbench-level assertions via Playwright against the local code-server URL
  (the spike harness is the template); pure sync/mirror logic stays vitest.

## Phase 1 implementation notes (2026-07-18, shipped)

Landed in src/main/notebooks/ (mirror-format, notebook-doc, sync-engine, discover, manager,
file-edit-filter, system-prompt) + policy.notebookWriteRedirect + registry/adapter wiring.
Verified by unit tests and a live-agent e2e (e2e/notebook-live.e2e.mjs, SB_LIVE_AGENT=1):
the agent edited the mirror on the first try with zero denials - the system prompt alone steered it.

Decisions made during review-fix that refine the design above:
- Mirrors are rooted at the GIT TOPLEVEL (not session cwd) because checkpoint diff relPaths
  are always toplevel-relative; the session cwd is kept as an alias for event lookups.
- Echo guard is content-based only (no write counter) - immune to coalesced watcher events.
- ensureMirror never clobbers a foreign mirror edit: mtime arbitration (mirror newer -> apply
  through validation; notebook newer -> regenerate).
- .ipynb/.py writes are atomic (temp + rename), same pattern as files/writing.ts.
- Diff-card filtering is explain-based: only engine-performed .ipynb writes are suppressed, so
  a DIRECT notebook edit (provider without the redirect) always stays visible as a raw card.
- Synthetic mirror cards live per REPO and are claimed by the draining thread - concurrent
  turns on one repo cannot double-card.
- Invalid mirror edits publish an error event to chat (the agent's Edit succeeded, so without
  this the failure would be invisible).
- Rejecting an added-notebook card cascades: mirror unlink deletes the materialized .ipynb,
  but only if the engine created it and the user never touched it.

Known deferred items:
- Codex/OpenCode do not get the deny-redirect yet (their approval wire shapes need their own
  path extraction); their direct .ipynb edits are visible as raw diff cards and the notebook
  watcher keeps the mirror in sync afterward. Wire when Codex/OpenCode notebook usage matters.
- A code line that literally starts with '# %% [cellbridge_id=' inside a cell body is parsed
  as a marker (no escaping) - accepted edge, same as CellIQ.
- notebookManager is a module singleton while index.ts can construct a second ProviderRegistry
  on macOS reactivate (pre-existing pattern shared with other module state).
- Agent-facing feedback for invalid mirror edits is chat-only; injecting a tool-visible signal
  needs a hook the SDK does not expose today.

## Phasing

Remote acceptance is part of every phase's definition of done, not a final phase.

- **Phase 0 - spike (1-2 days)**: seed `ms-toolsai.jupyter` from Open VSX into local code-server;
  verify `.ipynb` open/render/execute + extension license/telemetry behavior. Manually tunnel a
  code-server running on a test VM and point the webview at it. Kill criteria: if the extension
  won't install/run under code-server, fall back to guardrails-only scope while evaluating
  alternatives (e.g. the built-in notebook renderer + our jupyter server as the only kernel).
- **Phase 1 - guardrails + mirror sync**: port mirror-format + sync-engine into
  `src/main/notebooks/` (+ IPC in `ipc/notebooks.ts`, channels in shared), `.ipynb` deny+redirect
  in `policy.ts`, `appendSystemPrompt` for Claude, synthetic `file.edited` from the sync engine,
  `.ipynb` diff-card suppression. Ships value into EVERY existing session (local and remote)
  with no new UI. This alone solves the stated problem.
- **Phase 2 - the mode (core SHIPPED 2026-07-18)**: `dataScienceMode` layout flip via a pure
  CSS order/size swap (workbench takes the wide slot, chat docks right, every pane stays
  mounted), cmd+shift+J toggle, persisted globally via `layout.dataScienceMode`, Jupyter +
  Python extension stack auto-seeded from Open VSX on IDE boot (`seedJupyterExtensions`,
  offline-tolerant). Verified by e2e/ds-mode.e2e.mjs. Shipped alongside: STABLE workbench
  port (`ide.port` setting + `preferredPort`) - extension globalState/secrets live in
  origin-scoped IndexedDB, so the old random-port-per-launch orphaned all extension state
  (Atlassian re-onboarding, lost auth, forgotten kernel picks) every restart.
  Still open from phase 2: composer chip affordance, per-PROJECT usage-weighted sticky
  preference generalized across dev/PM/DS modes (current persistence is global).
- **Phase 3 - SSH-first IDE (core SHIPPED 2026-07-18)**: the provisioner installs code-server
  (+ Jupyter/Python extensions) on the remote idempotently on every connect; the tunnel bootstrap
  starts it (pidfile + stale-kill, loopback :8766); the ssh tunnel gained extraForwards and
  carries a second -L to a per-machine STABLE persisted local port (`machines.idePort.<id>` -
  origin-scoped IndexedDB again); status/getStatuses carry idePort into machine-store; IdePane
  loads the forwarded remote workbench for machine-bound sessions (no local server involvement).
  Verified live against geoiq-ssg-bot-stg-in via gcloud IAP (e2e/remote-ide.e2e.mjs).
  Still open: sb-bridge extension on the remote (open-at-line/cmd+L from remote workbench),
  remote bridge routing, per-machine workbench theme sync.
- **Phase 4 - shared kernel**: per-project jupyter server (local or VM-side), workbench connects
  to it, MCP kernel tools for the agent, env picker with CellIQ's discovery.
- **Phase 5 - polish**: `NotebookDiffCard` (cell grouping + AST badges), conflict re-baselining
  UX, kernel status in StatusBar, committed jupytext pairing as opt-in.

## Risks

- Open VSX `ms-toolsai.jupyter` compatibility/licensing under code-server - the phase 0 spike is
  the gate for the whole surface decision.
- Cell identity drift (agent deletes/reorders markers): `validateMirror` blocks total rewrites
  and duplicate/missing ids; new-cell-among-survivors passes. Keep those semantics.
- Client servers are hostile environments (no conda, old Python, no pip access): every kernel
  feature needs a graceful "guardrails still work without a kernel" degradation.
- Tunnel port sprawl: keep it to one ssh process, additive `-L` flags, ports owned by
  `connectionManager`.

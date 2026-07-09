# Embedded IDE (code-server) - design

Date: 2026-07-10
Status: validated (4 probe agents + live binary probes), approved direction: real IDE inside Switchboard, delete the CodeMirror stack.

## Decision

Replace the hand-rolled Files pane (file tree + CodeMirror editor + LSP manager + Quick Open, ~4k lines + 13 test files) with the real VS Code workbench, served by code-server (Coder, MIT, `macos-arm64` builds) and rendered in an Electron `<webview>`. openvscode-server was rejected for local use: it ships Linux-only binaries. It remains the natural server for the remote-machines feature later, same webview + bridge.

## Verified facts (live probes, not docs)

- code-server 4.127.0 `macos-arm64` boots in ~0.35s to `/healthz` 200.
- One server process serves multiple folders concurrently via `?folder=` per client. One server per app, not per project.
- The workbench renders inside an Electron `<webview>` (probed with Switchboard's own Electron 33 binary). No blocking CSP / frame headers, and webview guests ignore frame-ancestors anyway.
- A folder-dropped extension in `--extensions-dir` activates and inherits spawn env. Gotcha: a stale `extensions.json` in that dir marks unknown folders as removed - the seeder must handle it.
- The extension host runs Node 24: global `WebSocket` client exists, so the bridge extension has zero dependencies.
- Each connected webview gets its own extension host process. Folder identity must come from `vscode.workspace.workspaceFolders[0]` at runtime, never from env (env is static across all ext hosts).
- `ws@8.21.0` is already a direct dependency; `src/main/backend/ws-host.ts` is the in-repo precedent for a main-process WebSocketServer.

## Components

### 1. `src/main/ide/code-server-manager.ts`

- Binary: downloaded on first IDE-pane open to `userData/code-server/<version>/` from GitHub releases (platform/arch lookup table), extracted with `fetch` + system `tar` (zero new npm deps). `PATH` fallback (`code-server` on PATH) for devs. Not bundled in the dmg.
- Spawn (one per app, lazy, killed on quit):
  `code-server --auth none --bind-addr 127.0.0.1:<port> --extensions-dir <userData>/code-server/extensions --user-data-dir <userData>/code-server/data`
  Port pre-picked with the existing `allocatePort()` (`src/main/machines/connectDeps.ts`). On EADDRINUSE (code-server exits 1 cleanly), pick again and retry once.
- Env at spawn: `SB_BRIDGE_PORT`, `SB_BRIDGE_TOKEN` for the bridge extension.
- Extension seeding: copy bundled `resources/sb-bridge/` into the extensions dir; delete or rewrite `extensions.json` so the seeded extension is not "marked as removed". Idempotent.
- TCC pre-flight: run `assertCwdReadable` (existing `src/main/path-access.ts`) against the target folder before serving it, including when reusing the running server for a new project.
- Crash: respawn on next pane open; webview reloads.

### 2. Bridge (`src/main/ide/bridge-server.ts` + `resources/sb-bridge/`)

Main process hosts a `WebSocketServer` (existing `ws` dep) on `127.0.0.1:<ephemeral>` with a random token. The bundled extension connects out using `SB_BRIDGE_PORT`/`SB_BRIDGE_TOKEN` from its env, token sent in the connect URL query and validated server-side.

Messages (JSON, one object per frame):

- ext -> main `{type:'hello', folder}` - folder from `vscode.workspace.workspaceFolders[0].uri.fsPath`. Main keeps a folder -> socket map for routing.
- main -> ext `{type:'open', path, line?, endLine?}` - handler runs `workspace.openTextDocument` + `window.showTextDocument` with selection + reveal.
- ext -> main `{type:'selection', path, startLine, endLine, text}` - fired by an extension-contributed `cmd+l` keybinding (`when: editorTextFocus`) reading `window.activeTextEditor`.

Extension is plain JS, two files: `protocol.js` (pure: message build/parse/validate, reconnect backoff schedule - unit-testable without a vscode mock) and `extension.js` (thin vscode glue).

Keybinding note: `cmd+l` overrides VS Code's default "Expand Line Selection". Deliberate, precedented (Cursor does the same), and user-remappable via keybindings.json.

### 3. `src/renderer/components/ide/IdePane.tsx`

- Replaces `FilesPane` under the existing `rightPaneMode === 'files'` (mode key unchanged, persisted layout values keep working). Stays mounted like the terminal strip so workbench state survives toggles.
- `<webview src="http://127.0.0.1:<port>/?folder=<encoded projectPath>" partition="persist:ide">` - persistent partition so workbench layout/state survives restarts.
- Requires `webviewTag: true` in the main window `webPreferences` (one line in `src/main/index.ts`).
- Loading state: manager IPC exposes status (`downloading | starting | ready | error`); pane shows progress for the one-time binary download.

### 4. Renderer integration (existing seams, verified call sites)

- Pill click -> open at line: `FileChip.tsx` / `MessageBubble.tsx` keep calling `layout-store.openInViewer(path, range)`. `openInViewer` is repurposed: flip `rightPaneMode` to `'files'`, then send `IdeChannels.OPEN` -> main -> bridge `open` routed by the session's project folder. `viewerLineRange`/`viewerFilePath`/editor-store nav plumbing dies.
- `cmd+l` in the IDE -> chat: bridge `selection` -> main -> renderer event -> same path as the old file-viewer branch of `captureSelection()`: `formatFileViewerContext` -> `useDraftStore.addPill` -> `sb-pill-added` CustomEvent. The DOM-scraping file-viewer branch of `contextBridge.ts` is deleted; the formatter stays.
- `cmd+shift+E` keeps toggling the right pane. `cmd+P` global handler dies (VS Code has its own when focused). Nav-history keybindings die with the editor.
- IPC: `IdeChannels = { STATUS: 'ide:status', OPEN: 'ide:open', SELECTION: 'ide:selection' }` following the existing `<Domain>Channels` pattern.

## Security ADR: --auth none on 127.0.0.1

code-server 4.x has only `password | none` auth; no token mode. With `none`, any same-user local process can use the server's HTTP API (verified: unrestricted file read via `/vscode-remote-resource`). Accepted: the attacker in that model already runs as the user and already has the filesystem; it is the same trust boundary node-pty PTYs and the embedded agent SDK already assume. Mitigations kept: strict `127.0.0.1` bind, ephemeral port. Bespoke proxy auth rejected as complexity without a real boundary change.

## Deletion list (verified by import graph)

DELETE: `src/renderer/components/files/` (all panes + `editor/` tree), `src/main/lsp/` + `src/main/ipc/lsp.ts`, renderer `lspClient` / `definitionProvider` / `grepSource` / `lspSource` / `referencesSource` / `symbolIndex`, `editor-store` + `editor_tabs` table + `EDITOR_TABS_*` IPC, `src/main/git/diffHunks.ts` + `git:file-diff`, `src/main/files/gitignore.ts` + `grep.ts`, files IPC handlers `LIST_DIR` / `READ_FILE` / `READ_BATCH` / `GREP_SYMBOL`, the file-viewer branch of `contextBridge.ts`, App.tsx nav-history + `cmd+P` blocks. 13 test files die with them; 2 more get pruned (`files-edge-cases`, `viewer-state-by-session`).

KEEP (surviving consumers verified): `fuzzyScore.ts` MOVED to `src/renderer/services/` (atMention imports it), `listAllFiles` + `LIST_ALL` (ChatInput @-mentions), `writing.ts` + `WRITE_FILE` / `DELETE_FILE` (FileDiffCard accept/reject), `RESOLVE` (MessageBubble pill existence), `resolveWithinRepo`, `fileDiffResolve.ts` + `checkpoint.ts` (FileDiffCard is independent of diffHunks), layout-store `rightPaneMode` + repurposed `openInViewer`.

## Testing

Unit (vitest, no binary, no network - CI runs ubuntu/macos/windows):
- `code-server-manager-spawn-args` - pure argv construction
- `code-server-manager-download-url` - platform/arch -> asset table, unsupported throws
- `code-server-manager-extensions-seed` - real mkdtemp fixture, stale `extensions.json` handled, idempotent
- `code-server-manager-respawn` - injected spawn stub + fake timers
- `ide-bridge-server` - token reject, malformed JSON, open/selection/hello routing with fake sockets
- `sb-bridge-protocol` - pure protocol.js: message shapes, backoff schedule

Opt-in probe: `e2e/code-server.e2e.mjs` (sibling of the existing `e2e/*.e2e.mjs` family, never in CI): spawn real binary, `/healthz`, extension activation, kill. Gated on `SB_IDE_PROBE=1`.

Port/token logic reuses `allocatePort()`; no new port test needed beyond token shape.

## Performance budget (RAM is P0, CPU next, bundle P1)

RAM policy - as conservative as possible:

- ONE code-server process per app, ever (validated: serves any folder). Never per-project.
- ONE `<webview>` total, reused across projects: switching projects navigates the same webview to the new `?folder=` instead of keeping N workbench renderer processes alive. Each workbench webview is a full renderer process (hundreds of MB); this is the single biggest RAM decision. Cost: a workbench reload (~1-2s) on project switch; layout persists via the `persist:ide` partition + code-server workspace state.
- Single webview implies a single extension host process (they are per-connection).
- Idle shutdown: if the IDE pane has been hidden for 15 minutes, kill the code-server process and blank the webview (`about:blank` releases the renderer). Cold respawn is ~0.35s (measured), so reclaiming the memory is nearly free.
- Nothing spawns at app launch. First IDE-pane open pays the (one-time) download and the spawn.
- Offset: deleting the in-house LSP manager removes per-(workspace, language) `typescript-language-server` and `pyright` children - pyright alone routinely exceeds 200MB. code-server's TS server replaces, not adds to, that footprint, and only while the IDE is open.

CPU policy:

- Event-driven everywhere: no polling loops in manager or bridge. `/healthz` is only polled during boot, capped retries.
- Webview `backgroundThrottling` stays on (default) so a hidden workbench drops to background cadence.
- The bridge WS is idle unless a message flows.

Bundle (P1): binary downloaded on demand to userData, never in the dmg. sb-bridge is two small JS files. Net bundle change from this feature is negative once CodeMirror/LSP deps are dropped from the renderer build.

Audit (required, post-implementation): measure per-process RSS via `app.getAppMetrics()` (covers webview renderer) + `ps` on the code-server child tree, in three states - baseline (no IDE), IDE open, after idle shutdown - plus idle CPU% over 60s in each. Numbers get appended to this doc. Regressions against baseline outside the IDE-open state are bugs.

## Out of scope (deliberate)

- Remote machines: same webview can later point at a server on the remote host. Not v1.
- Open VSX marketplace curation, settings sync: YAGNI until felt. (Idle server shutdown moved IN scope by the performance budget.)

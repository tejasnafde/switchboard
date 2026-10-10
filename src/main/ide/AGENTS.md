# Embedded IDE

Detail for this part of the code. The root `AGENTS.md` holds the rules that apply everywhere (shipping checklist, cross-surface policy, logging, writing style); they apply here too.

## Embedded IDE (code-server) + file IPC

- **Right pane has two modes** (⌘⇧E toggles): the terminal strip, or the IDE pane. Both stay mounted (positioned overlay) so xterm/pty and workbench state survive toggling.
- `IdePane.tsx` renders the real VS Code workbench served by a per-app `code-server` process in ONE persistent `<webview partition="persist:ide">` - switching projects navigates the same webview to the new `?folder=` (RAM policy: never N workbench renderer processes). Prewarmed in the background once a session is active (server + hidden workbench; never downloads the binary uninvited), so the first ⌘⇧E is instant. Hidden 15 min → server killed + webview blanked; cold respawn ~0.35s.
- `src/main/ide/`: `code-server-manager.ts` (spawn args, release-asset table, extension seeding, lifecycle: EADDRINUSE retry-once, capped health poll, respawn after crash), `binary.ts` (download to `userData/code-server/<version>/`, PATH fallback for devs), `bridge-server.ts` (ws + token; routes open/selection by workspace folder).
- `resources/sb-bridge/`: zero-dependency extension seeded into code-server's extensions dir. `protocol.js` is pure (message build/parse/validate + reconnect backoff, unit-tested); `extension.js` is thin vscode glue (open-at-line, cmd+l selection capture, cmd+k quick edit, live config apply, the Switchboard Charcoal color theme (app palette), terminal-intent keybindings (ctrl+backtick / cmd+j / cmd+shift+e route to Switchboard's terminal pane; task/debug terminals untouched)). Ships via electron-builder `extraResources`.
- IPC (`IdeChannels`): `ENSURE` (boot + serve folder, TCC pre-flight per call) / `STATUS` (push: stopped | starting | downloading | ready | error) / `OPEN` (pill click → open-at-line in workbench) / `SELECTION` (cmd+l in workbench → chat draft pill) / `STOP` (idle shutdown).
- Security ADR: `--auth none` on `127.0.0.1` - same-user trust boundary as PTYs and the embedded SDK. Design doc: `docs/plans/archive/2026-07-10-embedded-ide-design.md`.
- Surviving file IPC (`FilesChannels`): `list-dir` (lean name/isDir - remote add-project autocomplete), `list-all` (@-mentions, 10k cap), `write-file`/`delete-file` (FileDiffCard accept/reject - atomic temp-then-rename, mtime conflict detection, 8 MB cap), `resolve` (inline file pill existence). `resolveWithinRepo` rejects `..`-escapes.

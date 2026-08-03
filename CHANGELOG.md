# Changelog

All notable changes across Switchboard development sessions. Reverse-chronological.

## 0.8.1 - Models the picker actually has

### Fixed
- **Model lists were stale on both agents.** Claude offered Haiku 4.5, Sonnet
  4.5, Opus 4.5 and Opus 4.7, missing Opus 5, Opus 4.8, Sonnet 5, Sonnet 4.6
  and Fable 5. Codex was worse: four of its eight entries (the `-codex` slugs)
  are not in the catalog the codex binary ships, and the whole 5.6 generation
  was absent - Sol, Terra and Luna, three models rather than one. Both lists
  now come from the ids in the binaries the adapters spawn.
- **The default Claude model was positional.** `defaultModelFor` indexed
  `CLAUDE_MODELS[1]`, so reordering the list moved the default from Sonnet to
  Opus 5. It names the model now.

Codex matters more than Claude here: that adapter never emits `model.variants`,
so its static list is the only one the picker ever shows.

### Mobile (ships over the air, no new APK)
- Chats started on the phone are titled from their first message. Without it
  they stayed "New conversation" and were unfindable in a long sidebar.
- Long-press a chat to rename it. The backend has always had the handler; the
  phone had no way to call it.
- Markdown tables render. They used to show as raw pipes and dashes.

## 0.8.0 - The phone

A Switchboard client for Android, and the backend work it needed. The desktop
changes stand on their own and are the reason this is a minor rather than a
mobile-only release.

### Added
- **Mobile client** (`apps/mobile/`, Expo SDK 57). Pairs with a desktop or a
  headless server, sees the same projects, chats and sessions, and can send
  turns, answer approvals and questions, and review diffs. Reaches an
  IAP-tunnelled VM directly where there is no inbound port.
- **Per-device pairing.** The QR carries a one-time code, good for five
  minutes, which a device redeems once for a session of its own. Sessions are
  stored hashed, listed in Settings with a last-seen time, and revocable
  individually - revoking cuts the live socket, not just the record. A paired
  phone gets `chat` scope: it cannot spawn a terminal or administer pairings.
- **The mobile endpoint has an explicit on/off switch** and is off by default.
- **Push notifications** for approvals, questions, turn end and errors, sent by
  the backend because the phone is asleep when it matters. Suppressed entirely
  while you are at the machine, measured from OS idle time rather than window
  focus, so running three agents does not buzz your pocket about the two you
  are not watching.

### Changed
- **Streamed content is incremental.** Adapters emitted the whole accumulated
  message on every token, so a reply cost O(n^2) bytes. Free over local IPC,
  ruinous over a radio. All three adapters now emit deltas, folded by one
  shared rule.
- **Turn-finished notifications say how long, not how much.** The cost was the
  one number that cannot tell you whether to walk back to your desk.
- The reconnect ladder is shared by the transport, the ssh tunnel manager and
  the phone's send queue, and the transport gained the jitter it lacked.

### Fixed
- **Events emitted while a client was disconnected are no longer lost.** `evt`
  frames carry a sequence, the host keeps a bounded replay buffer, and a
  reconnecting client is replayed exactly what it missed. When that is not
  possible the server says so and the client re-seeds, rather than showing a
  transcript with a silent hole in it.
- **Half-open sockets are detected.** The host pings; a client that stops
  answering is dropped, and a client that hears nothing re-dials. Both sides
  require proof the peer speaks the heartbeat first, so an older phone against
  a newer desktop stays connected.
- **A viewing claim expires.** A phone force-quit with a thread open used to
  silence its own notifications for that thread until the backend restarted,
  and a desktop in the same state silenced every phone.
- **Dead push tokens are pruned.** The cleanup read the ticket, but Expo
  reports `DeviceNotRegistered` on the receipt, so it was mostly dead code.
- Concurrent `startSession` for one thread could spawn two adapters over the
  same JSONL. The guard checked a map written after an await.
- `user.message` is published after the adapter accepts it, so a failed send
  that the client retries no longer renders a duplicate on every client.
- The pairing token moved to the OS keystore, and off the WebSocket URL.
- `decodeFrame` validates frame shape rather than casting on one field.

### Notes
- **The mobile app is a first release and has had far less real use than the
  desktop.** The desktop side of this was daily-driven for a full day before
  shipping; the phone was used briefly, on a development build, before most of
  this landed. Expect to find things.
- One additive migration: `conversations.last_read_at`. Rollback-safe.
- A paired phone can do what a second desktop window can do - create
  conversations, send turns, write files, run git. That is the point of a
  remote control. It can no longer open a shell.
- Code-signing is still absent, so macOS and Windows builds remain unsigned.

## 2026-08-01 - Chats that switched profiles showed every old message N times

### Fixed
- **A chat that had rotated provider profiles rendered its older messages once per profile.** Rotating instance copies the session JSONL into the new `oauth_dir` so resume survives the credential switch, and `load-by-id` therefore unions that session id from EVERY profile dir, deduping by message id. The id came from `msg_${Date.now()}_${++counter}`, so the same line read out of two directories produced two different ids and nothing ever collapsed. The dedupe was inert from the day it was written: across every log on this machine, all 232 loads reported "0 dupes removed" and not one reported more. Ids now come from the JSONL line's own `uuid`.
- Measured on a real four-profile chat before the fix: 236 messages concatenated against 120 unique, a 1.97x inflation. 27 messages appeared four times, 16 three times and 3 twice, which accounts for the 116 duplicates the same load now removes. Older messages duplicated the most, because each rotation copied them into one more directory.

### Notes
- The dedupe moved out of the `load-by-id` handler into `src/main/agent/dedupe-messages.ts` and is now tested. The defect lived in the seam between the parser's id and this filter's key, and inline in the handler that seam could not be reached by a test: the loader could have been re-keyed to `content` with every test still green. Both wrong fixes are now killed by mutation, and so is the `message.id` key.
- It also returns a conflict count, and the loader warns when it is non-zero. Profile copies are byte-prefixes of one another, so two copies of one id should always agree; if that ever stops being true, "first wins" would silently discard a differing version, and the old log line reported only a count. `listOauthDirsForAgent` has no `ORDER BY`, so which copy survives is not specified.
- **The key is `uuid` and deliberately not `message.id`.** One assistant `message.id` spans a separate JSONL line per content block, measured up to 7 lines on a real file, so keying on it would have merged a turn's text, thinking and `tool_use` into a single message and silently dropped content. `uuid` is per line and was unique 252 of 252 times on that file. A fix that looked more natural would have traded visible duplication for invisible data loss.
- The parser reads a top-level `id` that Claude Code JSONL does not have, which is why the fallback fired for every message including assistant turns. That field is kept as a secondary fallback because it costs nothing, but `uuid` is checked first.
- Codex is unaffected and was left alone. `claude-session-migrate.ts` only copies Claude sessions, and every Codex rollout file on disk exists exactly once, so its synthesized ids have no union to break.
- **Locale-dependent tests from 0.7.30 are fixed here too.** Two assertions hardcoded "Aug 1", but `fmtResetsAt` renders through `toLocaleString([])`, i.e. the host locale, which produces "1 Aug" elsewhere. They passed on the US-locale CI runner and would have failed on any other. They now assert the message embeds `fmtResetsAt`'s own output and that it differs from a time-only render, which is the behaviour that actually matters, and they pass under `LANG=en_GB.UTF-8`.
- Not addressed: a session copied into 13 profile directories is still parsed 13 times on open, and the largest such file here is 7.7 MB. Deduping candidate paths by size and mtime would risk dropping a genuinely divergent copy for a speed win, so correctness was left in front.
- Also seen on disk and left alone: one project directory encoded with the dot intact (`-.claude-worktrees-`) beside the correct `--claude-worktrees-`. That is the stale `encodeClaudeProjectPath` artifact already described in CLAUDE.md. The loader joins one exact encoded name, so it is unreachable data rather than a second duplication source.

## 2026-08-01 - A rate-limit error that sent you the wrong way, and the model it never named

### Fixed
- **The rate-limit error blamed the profile when the cause was the model.** A rejection printed "Switch to another provider or instance", which for an `org_level_disabled_*` reason cannot work: the spend cap is org-wide, so every profile in that org is refused identically. A user rotated Default to Akshaya and hit the same wall, which is exactly what the copy told them to do. The message now branches on scope. Org-wide says rotation will not help and to change the model; account-scoped still offers another profile, because there it genuinely helps.
- **The reset time dropped the date.** `toLocaleTimeString` alone rendered "Resets 05:30 AM" for a reset 6.2 hours away on the NEXT day, and an extra-usage cap resets monthly, so the same line could present a reset weeks out as "later today". Reset times reuse `fmtResetsIn` + `fmtResetsAt` and always carry the absolute date.
- **The model behind the failure was unnameable in the UI.** The picker rendered "Default" whenever nothing was pinned, while the session had resolved to `claude-fable-5`. `context_window` now carries the resolved model and the picker labels it, so the model is visible before a send rather than inferred after a failure. It is stored separately from the user's pin and never written back to it.
- **Nothing warned before a send that was certain to fail.** A new `spend.blocked` event records the refused (profile, model) pair, persisted, and the composer warns on that pair before the next send with the covered models named. Keyed per pair, not per profile: opus, sonnet and haiku all worked on the same seat at the moment Fable was refused, so a per-profile block would push users back into the profile rotation this exists to prevent.

### Notes
- **Root cause, and it was not an exhausted plan.** The plan windows read 0% session and 4% weekly while every turn was refused, which is what made it look random. Fable had no `weekly_scoped` allowance on two of four seats, so its usage billed to org credits, and those were over cap and org-disabled. Running the CLI per profile with `--model claude-fable-5` reproduced it exactly: two profiles refused, two fine, while opus/sonnet/haiku succeeded on all four. Do not diagnose this with a bare `claude -p`, which defaults to Sonnet and passes everywhere.
- **`overageDisabledReason` is a closed enum in `sdk.d.ts` and guessing it was wrong.** The first cut matched `user_*` and `spend_limit_*`, neither of which exists on that wire, while five real values fell through to "no reason reported" and were told to retry a permanent admin toggle. Those two names do exist, but on `extra_usage` in the usage endpoint, which is a different payload.
- **Review caught the guard being dead on arrival, twice.** `lastKnownModel` was only assigned in the post-turn poll, and a rejection produces no `result`, so in the reported case the model was never known and the event never fired. The init and post-compaction polls now seed it. Separately the adapter recorded the RESOLVED instance id while the composer looked up the un-resolved one, so `claude-code-default` never matched `null` and the banner could not appear on a default-profile session.
- The Usage panel still cannot show this. The usage endpoint reports `disabled_reason: null` and `spend_limit_reached: false` while the API rejects with `org_level_disabled_until`, so only the rejection payload carries the reason. Surfacing the last rejection in the panel is open.
- The guard is learned, not predicted. The first failure per (profile, model) is what teaches it. Predicting from a missing `weekly_scoped` row was deliberately not done: that link is a four-account correlation, not proven causation, and a false "this will fail" is worse than a warning one turn late.

## 2026-07-30 - Quit stops crashing, and slow buttons admit they are working

### Fixed
- **"Restart and install" had no idempotency guard of any kind.** No disabled state, no spinner, no label change, and `app:quit-and-install` is a fire-and-forget `send` with no return value, so every click re-fired it. The button now latches on a ref (StrictMode cannot double-send), disables, shows a spinner and reads "Restarting…". Main drops repeat fires independently and broadcasts a new `installing` status, so closing and reopening Settings mid-install still shows the pending state instead of offering a button whose clicks are dropped.
- **The app aborted with SIGABRT on quit, again.** `before-quit` killed the PTYs synchronously, but `pty.kill()` returns before node-pty delivers its exit callback through a napi ThreadSafeFunction, and a callback that lands once `node::FreeEnvironment` is under way throws into a dying environment and `abort()`s the process. This is the 0.7.19 crash restored by a fix that only looked synchronous. Quit now prevents itself once, awaits an exit drain capped at 1.5s, then re-requests the quit.
- **The install path must not have its quit prevented.** `autoUpdater.quitAndInstall()` triggers its own quit to run the install, so the drain runs ahead of it via `prepare()` and that quit passes straight through. Draining inside `before-quit` instead would cancel the install. If the process is somehow still alive 15s later the install never started, so the latch releases with an actionable message rather than a dead button.
- **A turn that went silent showed the user nothing.** No `turn.completed`, no `error`, just a spinner that never resolved, with the only evidence in the `claude` subprocess's stderr in the dev log. Unexplained silence longer than three minutes now posts to the chat and quotes the recent stderr tail, which is buffered on the session instead of only logged. Tool runs and prompts awaiting an answer are bracketed, so silence that is legitimate stays quiet.
- **Double-fire guards across every control that mutates something.** A new thread ran a real `git worktree add` with no guard, so a second click during those seconds produced two worktrees and two conversation rows; a kanban card launch minted a second session id and overwrote `card.conversationId`, orphaning the first provider process; `⌘Enter` in the card modal bypassed the button's own `disabled` because the keydown closure captured a stale flag; approve/deny, question submit, plan implement and the file-diff actions all stayed live until their event round-tripped.
- **Failures that were previously silent now surface.** `respondToRequest` had no `.catch` at all and `answerQuestion` had `.catch(() => {})`; both now report in chat and re-enable their card. File-diff write failures show inline on the card, which stays actionable. A worktree fallback raises a toast, and a kanban launch failure raises a dismissible banner.

### Notes
- **A turn killed mid-tool leaves an unmatched suspension, which would disable the stall watchdog permanently and silently.** Any interrupt or error between `tool_use` and `tool_result` leaks one suspend, and the counter never returned to zero, so a watchdog built to catch silent hangs would itself go quiet for the rest of the session. A new turn resets it: no tool from a finished turn can still be running.
- **Adding `installing` to `UpdateStatus` left the status-line switch non-exhaustive, and TypeScript allowed it.** The label was an un-annotated IIFE, so the inferred return became `string | undefined` and the missing case rendered a blank line on exactly the remount the status was added for. The label is now a pure function annotated `: string`, so the next status kind fails typecheck instead of shipping an empty line.
- The stall threshold is deliberately generous. Builds and test suites are quiet for minutes, and a false alarm costs a line of text while a spinner with no explanation costs the user their confidence in the app.
- Button-state rules and the status copy live in a pure module with unit tests, because the renderer has no jsdom and components cannot be rendered in this suite. Anything with a rule worth trusting was moved out of the component.
- Verification limit worth stating plainly: the crash-on-quit fix and the install path can only be fully proven in a packaged build. `npm run dev` exercises the PTY drain, but `quitAndInstall` is a no-op when `app.isPackaged` is false.

## 2026-07-29 - Remote workbench: keybindings inside it reach Switchboard again

### Fixed
- **`cmd+shift+E` inside a remote workbench toggled the IDE pane on but never back off.** On an SSH-backed machine the VM's code-server had no sb-bridge extension at all: the provisioner only ever seeded it for the LOCAL workbench, and the remote code-server was started by a raw `nohup` line in the ssh bootstrap with no `SB_BRIDGE_PORT`/`SB_BRIDGE_TOKEN` and no bridge listening on the VM. `extension.js` stays idle without those, so every key pressed inside the remote workbench died in the guest. Toggling *on* worked only because focus was still in Switchboard's own document, where the app's document listener sees the chord. `cmd+l`, `cmd+k`, `cmd+shift+J` and the Charcoal theme were dead on remote for the same reason.
- The extension is now provisioned onto the VM, the ssh bootstrap mints one `SB_BRIDGE_TOKEN` in the single shell that starts both remote processes (so they agree without the token ever reaching this machine's logs), and the headless backend runs the bridge. Intents ride `WsHost.emit` over the backend socket the desktop already holds - no extra tunnel, no extra forward.
- **`ide:open` and `ide:set-theme` now carry `machineId`.** `folder` is not a routing key, so a pill click in a remote session was resolving to the local backend and silently queueing there.
- **An interrupted update download is retried once.** `~/Library/Caches` is purgeable, and electron-updater only retries `EBUSY` on its temp-to-final rename - so a single purge mid-download lost the download and surfaced a raw `ENOENT ... rename '.../temp-Switchboard-X.Y.Z-arm64-mac.zip'` in the UI.

### Notes
- **The `extensions.json` clear must run on every connect, not just when seeding.** code-server's `--install-extension` (the Jupyter step) rewrites that manifest, and a manifest that omits sb-bridge marks it *removed* - the extension sits on disk and never activates. Confirmed on a live VM whose manifest listed 8 extensions without it. The clear therefore lives in `codeServerEnsureScript`, which runs unconditionally, rather than in the gated seed.
- **Any ssh upload to an IAP-tunneled host costs ~2 minutes regardless of size.** Measured: 2.0s for a tiny argv vs 2m01s for 27KB, and the same ~2m for the 1.1MB server bundle - a per-upload stall, not bandwidth. Shipping the ~20KB extension payload on every connect added ~2 minutes to every connect and reconnect, so the seed is gated on a payload marker the ssh probe now reports alongside the server version. Steady-state connect is back to ~30s. `ControlMaster`/`ControlPersist` in `SSH_COMMON_OPTS` would collapse all six provisioning connections onto one and is the larger win, left as follow-up.
- **The seed marker is a hash of the payload, not the app version.** `seedBridgeExtension` re-copies on every local boot, so keying the remote on `appVersion` would leave a VM running a stale extension, with no signal, until the next release.
- The bridge's wire behaviour (the callback set, one-pending-open-per-folder, theme write precedence) is shared by both hosts in `ide/bridge-channels.ts`; only the lifecycle differs, since a remote has no binary to download or idle-shutdown to run.
- Verified end to end against a live VM by `e2e/remote-bridge.e2e.mjs` (`npm run test:e2e:remote-bridge`), including real `cmd+shift+E` / `cmd+shift+J` / `ctrl+\`` keystrokes in a real remote workbench. Chords are pressed in a retry loop: the first press can land before the workbench's keybinding service is listening, which reads as a routing failure and is not one.

## 2026-07-29 - Usage limits: say why the request failed

### Fixed
- **A failed usage request now names its cause.** undici reports every transport failure as the bare string `fetch failed` and puts the real reason on `.cause`, which was discarded - so a DNS or socket problem rendered as "Could not reach the usage endpoint: fetch failed" with nothing to act on. The cause code is now included, happy-eyeballs `AggregateError`s are unwrapped to their per-address codes, and a resolution failure additionally names the macOS DNS flush.
- **One retry on a transient transport failure.** undici keeps a process-lifetime connection pool, so after the machine sleeps the first request through a stale keep-alive socket fails even though the network is fine. Switchboard's main process runs for days, which makes that the common case. Timeouts are not retried - they already consumed the full budget.

## 2026-07-28 - Per-instance subscription usage limits in Settings → Providers

### Added
- **A "Usage" button on every provider instance row** (Settings → Providers) showing that instance's subscription limits: for Claude the 5-hour session window, the weekly all-models window, and the per-model weekly window; for Codex its rolling window(s), plan type and credits. Limits are read per credential, so two profiles pointing at different logins report different numbers.
- Rendered as aligned bars in a full-width disclosure panel, with relative reset times ("in 4h 12m") and the absolute timestamp on hover. Severity colours reuse the `ContextWindowMeter` thresholds so a filling bar means the same thing in Settings as in the chat header.
- Results are cached for 45s, deduped per instance, and Codex probes are serialised so fan-clicking a list of instances cannot spawn several 260MB `app-server` children at once.

### Notes
- **Claude's per-model weekly limit is not `seven_day_opus`/`seven_day_sonnet`.** Those are legacy and null on current accounts; the live value comes from `limits[]` as `kind: "weekly_scoped"`, labelled from `scope.model.display_name`. Reading the Agent SDK's `rateLimitType` enum instead would silently show nothing for that row.
- **Overage is a separate row and never folded into a window meter.** An account can sit at 100% `extra_usage` with `org_spend_cap_reached` while both real windows are still `allowed`; merging them would render a healthy account as cut off.
- **No OAuth token is ever refreshed.** The Claude CLI rotates the token and writes it back, and clears a dead refresh token, so refreshing here would race it and could log the user out. An expired credential is reported as `expired` with the login command instead. The keychain service name is derived per instance as `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0..8]>`, with candidates covering trailing separators, unexpanded tildes and NFD.
- Nothing in the adapters' turn-handling path changed. Codex's `account/rateLimits/updated` push is still discarded in `codex-adapter.ts`; caching it there is a follow-up.
- `--danger` is not defined in `global.css`, so the existing `var(--danger, #d04848)` uses in `ProvidersTab.tsx` all run on their fallback. The new panel uses the real `--error` token rather than propagating that.

## 2026-07-17 - Embedded IDE: open on the file explorer, not a Bitbucket sign-in

### Fixed
- **Missing project folder no longer masquerades as a broken Claude install.** Starting or resuming a session whose cwd was deleted (e.g. a cleaned-up worktree) made node's spawn fail with ENOENT on the command, which the agent SDK surfaced as "Claude Code native binary not found at /opt/homebrew/bin/claude". The `assertCwdReadable` pre-flight now checks every cwd (not just TCC-protected ones) and throws `MissingCwdError` with a message that names the real cause and the fix.
- **⌘⇧E now lands on the file explorer** instead of whatever viewlet a third-party extension grabbed. Extensions like Atlassian/Bitbucket auto-focus their own view (and pop a "Get started" walkthrough) on activation, and VS Code then restores that as the last-active viewlet. Two fixes: `workbench.welcomePage.walkthroughs.openOnInstall: false` in the seeded settings suppresses the walkthrough popup, and the bridge now sends a `focusExplorer` frame on each fresh workbench `hello` (no queued file), revealing the Explorer via `workbench.view.explorer`.

## 2026-07-15 - Embedded IDE: extension OAuth login + reliable folder switching

### Fixed
- **Extension OAuth logins (Bitbucket / Atlassian atlascode, etc.) now work.** code-server's opener calls `window.open`, which Electron silently blocks in a `<webview>` unless `allowpopups` is honored - and React 19 was setting `allowpopups` as a property, not the attribute Electron reads, so the login never opened. Two fixes: `IdePane` sets `allowpopups` as a real DOM attribute via a callback ref, and the main process overrides `window.open` inside the guest and routes the URL to the system browser. The token exchange completes via the extension's own `127.0.0.1` loopback server.
- **Switching chats now re-points the embedded IDE to the new project.** The `<webview>` only navigated via its React `src` attribute, which Electron ignores for same-origin `?folder=` changes after first load, so the workbench stayed pinned to the first folder. Navigation is now driven by `webview.loadURL()` on a `dom-ready`-guarded effect. (Shipped in 0.7.15.)

### Added
- **`code-oss://` deep-link handler.** Registers the app for the scheme code-server emits, so an extension's post-OAuth "return to editor" link focuses Switchboard instead of dead-ending in the browser. (Effective in packaged builds.)
- **`SB_USER_DATA` env override** relocates `userData` before the single-instance lock, so a dev build can run alongside the installed app for testing.

## 2026-07-14 - Embedded IDE: TTL kill, server recycle, extension popups

### Added
- **Configurable idle TTL** (Settings → General → Embedded IDE). The IDE server is killed after it sits hidden this long (default lowered 15min → **5min**); reopening relaunches in ~2s. IdePane re-reads the setting live on save.
- **Server recycle after N distinct folders** (default 5): once the single code-server has served that many folders in a session, the next switch restarts it, reclaiming the per-folder extension hosts it had accumulated. Bounds the CPU/RAM growth from actively hopping many worktrees.
- **`<webview>` popups now open in the system browser** (`app.on('web-contents-created')` → `setWindowOpenHandler` → `shell.openExternal`). A bare webview no-ops `window.open`, so extension "Open in browser" / OAuth "Authorize" buttons inside code-server previously did nothing; they now launch the real browser.

### Notes
- Extension OAuth (e.g. Bitbucket) that failed to "take" was most likely a stale extension host - left over from a previous folder/workbench - squatting the extension's localhost callback port, so the callback updated an invisible host. The TTL + recycle above clear those, so doing the sign-in in a freshly-opened IDE within a single chat now completes.

### Fixed
- **Keeping the IDE pane (⌘⇧E) open while hopping across chats no longer thrashes CPU/RAM.** The webview's `?folder=` was re-pointed on every `activeSessionId` change, and each change fully reloads the workbench (a fresh extension host per folder). `IdePane` now debounces the navigated folder (500ms) and only advances it while the pane is visible, so fast chat-hopping collapses into a single navigation and hopping with the IDE hidden doesn't churn at all. (Deliberately visiting many distinct worktrees over a session can still accumulate extension hosts inside code-server - that reaping is code-server-side.)

## 2026-07-14 - Worktree drift detects the EnterWorktree tool

### Fixed
- **The "Agent is working in <branch> - Follow?" banner now fires when an agent calls Claude Code's `EnterWorktree` tool**, instead of only noticing a few commands later once the agent happened to *write* into the new worktree. `worktree-drift.ts` recognizes `EnterWorktree`, stashes its `name`, and resolves it against `git worktree list` (by branch or directory basename) on the next event. The detection is still deferred one event (Claude emits no `tool.completed`, and the worktree may have just been created), so a long agent pause can still delay the banner by the think time between tools - but reads now trigger it too, not just writes.

## 2026-07-14 - Unbounded pane resize + stuck-divider fix

### Changed
- **Removed the max-width cap on the sidebar and right (terminal/IDE) panes.** The old hard caps (500px sidebar, 800px terminal) are gone. A pane can now be stretched as far as you like - the only bound is viewport-relative (`window.innerWidth - the other pane - a 240px chat minimum`) so the chat and the opposite pane's own resize handle always stay on screen. ⌘B / ⌘J still hide the panes entirely. `layout-store` exports `paneMaxWidth()` as the single source of truth; App.tsx recomputes it on window resize.

### Fixed
- **Resize dividers could get stuck in "resize mode."** If the pointer crossed into the code-server `<webview>` (the embedded IDE) or the xterm canvas mid-drag, pointer capture was lost, the terminating `pointerup` never arrived, and the `col-resize` cursor + `user-select: none` + `pointerEvents` overrides stayed frozen until reload. Fixes, applied to all three handles (main `ResizeHandle`, terminal `PaneResizeHandle`, dual-chat `ChatSplitHandle`):
  - A full-viewport shield overlay (`src/renderer/services/dragOverlay.ts`) is raised for the duration of a drag, so the pointer can't reach a child frame and capture is never lost in the first place.
  - A `lostpointercapture` listener ends the drag cleanly as a fallback if capture is yanked anyway.
  - `ChatSplitHandle` (previously `pointerup`-only) gained `pointercancel` + `lostpointercapture` + a window-`blur` fallback and a single idempotent teardown.

### Tests
- `drag-overlay.test.ts` (overlay create/idempotent/cleanup), expanded `layout-store.test.ts` (viewport-relative max, old caps lifted, opposite-pane accounting), guardrails in `resize-handle-wiring.test.ts`, and a real Playwright/Electron e2e (`e2e/resize.e2e.mjs`, `SB_RESIZE_E2E=1`) that drags the sidebar past 500px and asserts the cursor/overlay never stick after a normal release or an interrupted (blur) drag.

### Changed
- **The terminal-template feature is now called "launch configs"** everywhere, freeing the word "workspace" to mean only the sidebar project grouping (`project_workspaces`). The feature previously carried two names - "workspace" (the config file/types/store/IPC) and "template" (picker, planner, reducer, DB column) - now unified under "launch config".
  - **On-disk file:** `.switchboard/workspace.yaml` → `.switchboard/launch-config.yaml`. The old filename is still read as a fallback, and the legacy top-level `templates:` key is still parsed as an alias for the new `configs:` map, so existing projects keep working until their next save (which writes the new name/shape). Existing local `workspace.yaml` files were migrated in place.
  - **DB:** `session_layouts.template_name` → `launch_config_name`, renamed in place via `ALTER TABLE ... RENAME COLUMN` so pinned per-chat selections survive the upgrade.
  - **Code:** types (`LaunchConfigFile`/`LaunchConfig`/…), shared parser (`src/shared/launch-config.ts`), main store (`src/main/launch-config/launch-config-store.ts`), IPC channels (`GET_LAUNCH_CONFIG`/`SAVE_LAUNCH_CONFIG`/`app:launch-config-changed`), preload bridge, renderer component (`LaunchConfigPicker`), services, and Settings tab ("Launch Configs") all renamed. The sidebar workspace-grouping concept was deliberately left untouched.
  - Back-compat parsing is covered by a new test; full suite green (1217 tests).

## 2026-07-14 - Fix rename flows dead in Electron (window.prompt)

### Fixed
- **Rename project now works.** It was built on `window.prompt`, which Electron renderers don't implement (it returns `null` and opens no dialog), so the rename silently did nothing. Replaced with the same inline edit the session rename uses. The same dead-`prompt` bug is fixed in three more places: **rename workspace** (Manage workspaces modal, now inline), **new workspace from a project** (now defaults the name to the project's folder name), and **rename remote chat** (now a small in-app prompt modal).
- Guard test (`no-window-prompt.test.ts`) fails the build if `window.prompt` reappears in the renderer.

## 2026-07-14 - Remove and rename projects

### Added
- **Remove and rename projects from the sidebar.** Right-click a project header for "Rename project…" (updates the display name; path stays the primary key so conversations and kanban cards keep their link) and "Remove project" (confirm-gated; the FK cascade drops the project's conversations and kanban cards, the folder on disk is untouched). Removing a project also tears down any open sessions rooted in it so the active chat can't write against a deleted conversation.

## 2026-07-11 - Remote chats survive reconnects; auth preflight; day-2 SSH batch (v0.6.3)

### Fixed
- **Remote chat history no longer vanishes.** Two independent causes: (1) the remote server scanned only `~/.claude` for JSONLs while sessions run under forwarded per-instance dirs like `~/.claude-tech-team`, so history loads returned empty and reconnect re-syncs overwrote snapshots without those chats; (2) a disconnect wiped session-id routing bindings and reconnect never restored them, silently routing open chats to the local backend. Scans now cover every config dir on the VM (by `.claude*` name or the `projects/` marker, so free-text oauth_dir names work too), and reconnect re-binds every open session.
- **WsTransport double-execute:** a queued invoke that timed out during a tunnel blip was still flushed after the re-dial, running non-idempotent calls remotely after the caller saw them fail. Timed-out frames are purged from the outbox.
- **Permanent transport wedge:** the transport self-closed after a 60s reconnect budget even when the connection manager still (correctly) reported connected - nothing ever replaced it. It now re-dials indefinitely at the capped interval; only the manager closes it.
- **Editing an ssh-config machine's connection now takes effect** - the stale alias shadowed host/user/port; it is cleared when connection fields change.
- **Model picker no longer shows a stale or cross-instance list.** Dynamic model lists are cached per (agent, instance) and hydrate new chats instantly; the live Claude fetch re-arms when the session becomes active instead of exhausting a mount-time retry loop.
- **QuestionCard:** a typed free-text answer on a single single-select question now has a Submit button, and Enter submits (Shift+Enter for newline) - previously the only way out was interrupting the agent.
- Sidebar titles for remote chats track renames/auto-title; remote rows have a right-click menu (Rename / Export as Markdown / Archive) with machine-routed actions.
- Rate-limit errors no longer render twice; error cards survive restart; cross-profile session migration falls back to a projects-wide scan (merged from fix/chat-layer-bugs).

### Added
- **Remote auth preflight:** opening a chat on a VM that isn't logged in to Claude shows a banner above the composer with a copyable interactive login command (`CLAUDE_CONFIG_DIR=... claude` + `/login` - the headless `claude auth login` URL flow breaks on VMs) and a Re-check button. The first-send error remains as backstop.
- **Provisioning symlinks the bundled `claude` CLI onto PATH** (`~/.local/bin/claude`, glibc-first) so login instructions work as written on every VM.
- Machine edit UI (pencil on remote rows) - name/host/user/port/run-as editable in place.

### Changed
- Reconciled with PR #60's parallel remote-UX overhaul (shipped in 0.6.2): its connect-lifecycle implementation (progress detail, reconnecting pip, cancel, ssh timeouts, tunnel stderr reasons, stable ports, hydrate resync, modal polish) is kept as-is; this release layers the unique day-2 work on top and removes the dead states left by the reconciliation.

## 2026-07-05 - Remote session fixes (v0.5.5)

### Fixed
- **Chat stuck on "Working..." when a session failed to start.** ChatPanel set an optimistic `running` status before `startSession`, but the failure path (e.g. the remote per-device-login guard refusing an unauthenticated VM) never cleared it, and Stop was a no-op because the registry silently ignores interrupts for threads with no live adapter session. Status now resets to idle on start/send failure, and Stop clears the local status directly when no provider session exists.

### Changed
- **Remote machines default to running as the `ubuntu` user.** The Add-machine form pre-fills "Run as user" with `ubuntu` (clearable), and every remote script now starts from the target user's `$HOME` - `sudo -H` swaps HOME but keeps the ssh login user's cwd, so scripts previously ran from a directory the target user might not read. Matches the manual `sudo su ubuntu; cd` workflow.

## 2026-07-05 - v0.5.3 startup OOM fix

### Fixed
- **v0.5.3 crashed on startup with a JS heap OOM** for anyone with a sizeable Codex history. The previous "Performance audit" entry parallelized `GET_PROJECTS` to scan every project concurrently, but `scanCodexDir`'s Codex-rollout-head cache only de-duplicated *sequential* reads (`Map.get`/`Map.set` with an `await` in between) - it did nothing to stop N concurrent scans from all cold-missing the same file and reading it in parallel. With 35 projects racing over the same `~/.codex/sessions` tree, a handful of large rollout files (10-20MB+) got fully read into memory up to 35 times simultaneously, blowing the heap. Fixed by caching the in-flight `Promise` itself (single-flight), so concurrent scans share one read instead of stampeding.
- **Sidebar/kanban/settings project refresh was slow.** Root cause of the above bug's severity: `scanCodexDir` used `readFile(path, 'utf-8')` to load each *entire* rollout file into memory just to check the first 2000 characters for a path match. Rollout files can run into the tens of MB; a Codex history of ~160MB across ~60 files meant every refresh re-read all of it from disk. Switched to a bounded partial read (`open` + `read` for the first 2000 bytes) so only the bytes actually needed are read.

## 2026-07-05 - Performance audit

### Fixed
- **App tree re-rendered on every streamed token.** `App`, `ChatPanel`, `FileTreePane`, and the sidebar unread badge subscribed to the whole agent store, so each streamed token re-rendered large subtrees (and in dual-chat, each panel re-rendered on the other's tokens). Switched to per-action / primitive Zustand selectors; the forward-menu now subscribes to `sessions` only while open, and the context-usage estimate is memoized.
- **`GET_PROJECTS` re-scanned the whole session filesystem serially per project.** Now scans projects concurrently, mtime-caches Codex rollout heads, and targets the exact Claude project dir instead of listing the whole folder - removing the repeated full-tree walk on every sidebar/settings/kanban refresh.
- **Memory: LSP servers, Codex accumulators, and in-flight RPCs leaked.** Language servers are now disposed on quit; the Codex adapter clears per-turn maps on `turn/completed` and rejects pending RPCs when the process exits.

## 2026-07-04 - Provisioning upload OOM fix

### Fixed
- **Remote provisioning OOM'd (heap grew to ~2GB) during "upload server bundle"** for a ~985KB bundle. `execProc` accumulated child stdout/stderr into unbounded strings and wrote the whole bundle to stdin as one buffered string. Captured output is now capped at 1MB, and the bundle is streamed from disk into stdin via `createReadStream().pipe()`. A read error kills the child so a truncated upload fails loudly instead of falsely reporting success.

## 2026-06-26 — Editor focus sweep

### Fixed
- **`⌘W` could kill a terminal (and its SSH session) from ambiguous focus.** Modals focus their input on open but never restore focus on close, so focus fell to `<body>` and `⌘W` closed a terminal. `⌘W` now closes a terminal only when one is genuinely focused; ambiguous focus is a no-op.
- **Opening a file (`⌘P` / file tree / chat pill) now focuses the editor**, so `⌘W` closes the editor tab and `F12` works without an extra click.
- **Back-nav after Go to Definition/References returns to the exact spot you invoked it** (records the source location before jumping, VS Code-style) instead of a stale history entry.

## 2026-06-25 — Docs + dead-code cleanup

### Changed
- Added an MIT `LICENSE`; aligned README tour copy with the softened in-app tour captions (PR #9).
- Removed verified dead code (ponytail audit): the unused Shiki highlighter path and the turn-duration stamping module, with their tests.

## 2026-06-24 — Go to References + search-snippet fix

### Added
- **Go to References (`⇧F12`)** — finds all call sites of the symbol under the cursor via the LSP references IPC. 0 → no-op; 1 → auto-jump; 2+ → an inline, VS Code-style block-widget peek under the cursor line (`path:line` + one-line preview; `↑↓` select, `Enter`/click open, `Esc` close).

### Fixed
- **Search result snippets never closed their `<mark>` tags** — the highlighter turned every `**` delimiter into an opening tag and the follow-up replace was a no-op, so the accent styling bled to the end of each snippet. Now emits balanced `<mark>…</mark>` and HTML-escapes the snippet (it's rendered via `dangerouslySetInnerHTML`).

## 2026-06-24 — Focus-scoped keybindings + editor shortcuts

### Fixed
- **`⌘W` no longer kills a terminal (or its SSH session) from the editor.** It was a single global handler that always closed a terminal pane. It's now routed by focus: editor → close the active editor tab and stop; chat panel (dual) → close that panel; else terminal tab → app window.
- **Back/forward navigation (`Ctrl±`) was flaky** — the focus guard failed after a jump. The editor now takes focus after navigating, so editor-scoped keys keep working without an extra click.
- **Diff-card color cutoff** — the +/- row background now spans the full horizontal scroll (`width:max-content; min-width:100%`) instead of clipping at the visible width.

### Added
- **`F12`** → go to definition at the cursor (reuses the LSP → `git grep` resolver).
- **`Ctrl+G`** → go to line (VS Code's macOS binding; `⌘G` stays find-next).
- **`docs/keybindings.md`** — full reference. Documents that comment-toggle `⌘/`, move/copy line `⌥↑↓`/`⇧⌥↑↓`, and multi-cursor `⌘D` already ship via CodeMirror's bundled keymaps.

### Internal
- Shortcuts are now **scoped by focus** (editor / terminal / global) — editor-concept keys live in the CM6 keymap, only app-concept keys touch the global layer. Shared `closeEditorTab()`; pure, unit-tested `classifyCloseFocus()`. Suite: 887 → 892.

---

## 2026-06-24 — File-editor bug sweep, jump-to-definition UX, SSH plan

### Fixed
- **Symlink path-traversal in the files IPC** — `resolveWithinRepo` was lexical only; a symlink inside the repo could read/write/delete outside it. Now resolves the realpath of the nearest existing ancestor and re-checks containment.
- **UTF-8 read boundary** — `readFileCapped` sliced mid-codepoint at the 2 MB cap, emitting `U+FFFD`. Uses `StringDecoder` to drop the partial trailing codepoint instead.
- **gitignore annotation** — added `**` cross-segment matching and case-insensitive matching (mirrors `core.ignorecase` on macOS/Windows).
- **EOL preservation on save** — majority-vote CRLF/LF detection (a leading bare `\n` no longer flips a CRLF file to LF); lone `\r` normalized.
- **Tab-switch lost undo history** — editor now swaps whole `EditorState`s (`setState`) instead of replacing the doc, so undo no longer bleeds across buffers.
- **Jump-to-line was dead** — cmd-click / file-pill / ⌘P-line navigation wrote to the store but never moved the editor; `EditorHost` now dispatches the scroll into the live view (fixes cmd-click go-to-definition visibly doing nothing, including cross-file jumps).
- **Git gutter stayed stale after save** — added `lineMarkerChange` so the bars repaint on the post-save hunks refresh.
- **Save-conflict silently dropped** — ⌘S on a file changed on disk now prompts overwrite / reload instead of swallowing the write.
- **Nav history** — `openInViewer` is the single push point (no more double-push from `navigateTo`); back/forward replays pass `recordHistory:false` so the forward stack isn't truncated.
- **LSP crash recovery + didClose** — the client nulls its dead child and the manager evicts the entry on exit so the next call respawns; `textDocument/didClose` is now sent on tab close (was never sent — leaked docs / stale results).
- **Worktree-mode file browsing** — file tree + quick-open now use `worktreePath ?? projectPath` like the viewer (kanban-card / fork-to-worktree sessions browsed the parent repo before).
- **Monotonic diff turn id** — `CheckpointTracker` used `Date.now()`, so two turns in the same millisecond collided and dropped diff cards; switched to a counter.
- **Markdown-preview XSS** — README preview is sanitized with DOMPurify before `dangerouslySetInnerHTML`.

### Added / improved
- **⌘/Ctrl-hover underline** on the symbol under the cursor (VS Code-style affordance for cmd-click).
- **`git grep` go-to-definition fallback** — when LSP can't resolve (cold server or non-LSP language), grep the repo for the declaration. The previously-advertised tree-sitter fallback was a never-populated stub. New `files:grep-symbol` IPC.
- **Quick-open ranking** — `fuzzyScore` leading-gap penalty so basename-prefix matches outrank buried ones.
- **`$/cancelRequest`** — superseded same-method LSP requests are cancelled so the server stops computing discarded results.
- **SSH "Connect to Remote" implementation plan** (`docs/notes/ssh-remote-plan.md`).

### Tests
- +24 unit tests across 4 new files (file edge-cases, nav history, fuzzy score, git-grep) plus diff/checkpoint/editor/definition-provider additions. Suite: ~790 → 887.

---

## 2026-06-10 — Fix leaked `claude` subprocesses on session stop

### Fixed
- **Claude sessions leaked a live `claude` CLI subprocess every time they were stopped.** Each `sdk.query()` spawns a child `claude` process; `stopSession` closed the prompt queue and aborted the `AbortController` but never called `query.close()`, so the SDK kept its spawned child alive. Closing a tab, archiving a chat, or rotating a provider instance abandoned the subprocess instead of reaping it — they accumulated as children of the Switchboard app (observed: ~15 orphaned `claude` processes parented to one multi-day app session). `stopSession` now calls `active.query.close()` (the SDK's documented "terminate the underlying process … including the CLI subprocess") inside a try/catch with `log.warn`, before clearing session state. `stopAll` (app quit) inherits the fix since it loops `stopSession`.
- **Downstream symptom:** the abandoned subprocesses could each grab `~/.claude/.update.lock` during a background version check and then never release it, wedging `claude update` behind a stale lock.
- **In practice the leak fired on archive.** Switchboard has no "close tab" flow — `stopSession` runs on archive, auth/agent rotation, and app quit. Archiving a conversation reaped its UI state but left the subprocess alive, so archived chats accumulated live processes.
- **Guarded the `startDraining` retry path:** force-closing the subprocess surfaces as "process exited with code N", which matched the resume-failed retry branch and could respawn a fresh query (with an unclosed prompt queue) *after* the session was stopped — re-leaking a process. The catch now bails when the session is no longer the active one for its thread.
- 6 new unit tests (`claude-adapter-stop-session.test.ts`): asserts `query.close()` is called, abort + prompt-queue close still happen, the session is removed from the registry, `close()` throwing is tolerated, and `query === null` / unknown-thread are safe no-ops.

---

## 2026-06-02 — In-chat diff review (Cursor-style accept/reject) + editor/file-tree fixes

### Added
- **Per-file diff cards in chat, with per-hunk accept/reject** — when an agent edits files during a turn, each changed file renders as its own inline card showing the unified diff with **Keep all / Reject all**, per-hunk **Revert**, and **Apply**. Works identically across **all three providers** (Claude Code, Codex, OpenCode) because the diff is derived from **git checkpoints**, not provider-specific tool payloads: a temp-index snapshot (`git add -A` → `write-tree`, never touching the user's index/HEAD) is taken before each turn and diffed against the working tree after `turn.completed`. Provider-agnostic, deterministic, modeled on the open-source `t3code` approach. New modules: `src/main/git/checkpoint.ts`, `src/main/provider/checkpoint-tracker.ts`, `src/renderer/components/chat/FileDiffCard.tsx` + `fileDiffResolve.ts`; new `file.edited` runtime event.
- Diff rendering + accept/reject math is powered by **`@pierre/diffs`** (Apache-2.0). Reject reverts a hunk to its baseline; partial accept writes the resolved subset back via the existing atomic `files:write-file`. **Rejecting an agent-*added* file deletes it** (new `files:delete-file` IPC) rather than leaving an empty file — matching Cursor's revert semantics.
- 30 new unit tests (checkpoint primitives incl. a real-git integration test, the turn tracker, the resolve/row helpers, the message keeper-list, and `deleteFileSafe`).

### Fixed
- **File viewer loaded the first-opened file blank**, then re-selecting its tab did nothing and showed a phantom unsaved dot. Two compounding `EditorHost` lifecycle bugs: the view-recreate cleanup didn't reset the mounted-buffer marker (so a remount skipped loading the buffer into the fresh empty view), and the buffer-swap set that marker *after* dispatching — so the view's round-trip wrote the new file's content back over the *previous* buffer, corrupting it and flagging it dirty. Marker is now cleared on teardown and set before the swap dispatch.
- **CodeMirror search panel (⌘F) was unstyled** under the translucent/light/dark themes — raw browser buttons, checkboxes, and an orange focus ring. Now themed via CSS variables, laid out with flex (stable two-row layout that doesn't reflow awkwardly on pane resize, pinned close button, checkbox-label spacing), and Escape reliably closes it.
- **gitignore annotation** mishandled patterns containing a mid-slash (`foo/bar` matched at any depth instead of anchoring to root).
- **Silent error swallowing** removed across `EditorHost`, `FileTreePane` (now shows a "couldn't read folder" state), `FileViewerPane`, `cmdClickJump`, and the LSP frame parser — each now logs via the scoped logger per the repo's logging rules. Also fixed a ⌘-click jump-to-definition race that could navigate the wrong session.

### Notes
- Diff cards are **session-ephemeral** (v1): they live in the live session and aren't restored on reload; disk already reflects the user's decisions. Files ignored by `.gitignore` (including a file ignored by a same-turn `.gitignore` edit) don't produce a card — intentional, to avoid cards for build output / `node_modules`.

---

## 2026-05-04 — Sidebar archive button: anchor instead of overlap-with-time

### Fixed
- **Clicking the sidebar archive icon did nothing**, though right-click → "Archive" from the context menu worked. The icon was inserted into the row's flex flow with `margin-left: -18px` so it overlapped the adjacent `.sidebar-thread-time` element; on hover the time element collapsed via `width: 0` while the icon's margin snapped to 0. Because `.sidebar-thread-time` kept `overflow: visible` (so its text could keep painting during the opacity fade) the click target flickered across the layout transition and a click on the visible icon often landed on residual time-text rendering before the button's hit area resolved. Right-click bubbled to the row's `onContextMenu` regardless and was unaffected. Fix: anchor the archive button with `position: absolute; right: 8px` so it has a single, stable hit area; add `pointer-events: none` to `.sidebar-thread-time` on hover (it's just text — never a click target — and `none` while collapsed keeps it from intercepting clicks meant for the button); add `pointer-events: none` to the SVG so clicks on the icon's hollow centre don't fall through `pointer-events: visiblePainted`. `z-index: 1` on the button is belt-and-braces.

---

## 2026-05-04 — Fork to worktree

### Added
- **"Fork to worktree"** in the chat message right-click menu — same flow as "Fork from here", plus a `git worktree add -b fork/<slug> <repo>/.switchboard/worktrees/<slug> HEAD` runs first so the new conversation is rooted at an isolated working tree on its own branch. Slug derives from the picked message body via `makeBranchSlug` (lower-case, alnum-or-dash, capped at 40 chars, prefixed `fork/`). On a successful fork the chat surfaces a "Forked to fork/<slug>" toast, the sidebar title becomes `<parent> · fork/<slug>`, and the Claude SDK's resume / terminal panes / file pane all pick up the worktree as cwd via the existing `projectPath` plumbing (no extra wiring needed downstream).
- **Collision handling**: branch / dir collisions retry with `-2`, `-3`, … suffixes (capped at 20 attempts) so two forks of the same message coexist; non-collision errors (unknown ref, shallow repo) bail immediately with the verbatim git stderr.
- **DB**: nullable `worktree_path` + `worktree_branch` columns on `conversations`; persisted iff the fork opted into a worktree. Existing rows stay valid without a backfill.
- **Test seam**: `forkConversation` accepts an optional `gitRunner` so the fork→worktree path can be unit-tested without shelling out to real git. 6 new tests in `tests/unit/worktree.test.ts` cover the happy path, collision retry, non-collision fail-fast, relative-path / empty-slug rejection. 12 tests in `tests/unit/branch-slug.test.ts` cover the slug rules (case, dash collapsing, mid-cut trim, empty fallback).
- The Claude fork path now writes the truncated `<newId>.jsonl` to `~/.claude/projects/<encoded-effective-path>/` (the worktree's encoded dir for worktree forks; same as before for plain forks) — without this, a worktree-rooted fork would resume from the wrong project dir and lose context.

### Notes
- v1 derives the branch slug deterministically from the picked message body, not via an LLM summary call. The kickoff doc named `summarizeForBranchName` as a follow-up; deferred until we want the branch names to read more naturally (e.g. "fix-redis-timeout" vs. "fix-the-redis-timeout-i-was-seein"). The deterministic path has zero added latency and no API key dependency.
- Cleanup ("Delete worktree" UI when a forked conversation is archived) deferred — `git worktree list` + `git worktree remove` still work from a terminal.

---

## 2026-05-04 — Fork from here

### Added
- **Right-click any chat message → "Fork from here"** to spawn a new chat tab containing every message up to and including the one you clicked. The new conversation is wired to the agent's resume primitive: for Claude Code we truncate the source `~/.claude/projects/<encoded>/<uuid>.jsonl`, write a fresh `<new-uuid>.jsonl` next to it (with each line's `sessionId` rewritten to the new UUID), and pass the new id as `resumeSessionId` so the SDK picks up real context — not just visual continuity. Codex falls back to "best-effort" (writes a truncated rollout file as an audit record but starts the daemon cold; TODO to pipe through Codex's `session/start` JSON-RPC). OpenCode is summary-only with a TODO for ACP `session/load`.
- **Lineage in DB**: new nullable `parent_conversation_id` + `forked_at_message_id` columns on `conversations`. Sidebar arrow/indent UI is deferred (out of scope for v1) but the data is there for future audit + bulk-fork flows.
- **Pure JSONL truncation functions** in `src/main/agent/jsonl-truncate.ts` (`truncateClaudeJsonl` / `truncateCodexJsonl` / `assembleClaudeFork`) — visibility-aware, replicate JsonlParser's predicate so non-visible meta lines (Claude `summary`, Codex `session_meta` / developer prompts) ride along verbatim and the truncated file still loads cleanly. `assembleClaudeFork` walks all chronological fragments so threads spanning multiple JSONL files (Claude SDK rotates `session_id` during compaction) are forked correctly. 11 unit tests covering anchor capture, sessionId rewrite, malformed-line skip, over-/under-cap, and multi-fragment cuts.
- **Position-based fork contract**: the IPC takes `upToIndex` (renderer's array position) instead of a message id — JsonlParser regenerates ids on every reload, so id-based lookup never matched. The renderer's message order matches the parser's emission order for both Claude and Codex (same visibility predicates), so position survives a re-parse. The original id rides along as `forkedAtMessageId` for audit / lineage only.
- **Dual-chat correctness**: `MessageBubble` accepts a `sessionId` prop wired from `MessageList`, so right-clicking the right panel forks the right session instead of whichever pane holds focus.
- **Non-resumable fork notice**: Codex / OpenCode forks (which can't yet resume real context) get a synthetic system message prepended in the new tab so users aren't misled into thinking the agent has the prior turns.
- IPC: `app:fork-conversation` handler in `src/main/ipc/app.ts`, orchestration in `src/main/conversations/fork.ts`, renderer service in `src/renderer/services/forkSession.ts`, popover UI in `MessageBubble.tsx`. Concurrency guard: refuses to fork while the source session has a turn in flight.

---

## 2026-05-02 — Kanban promoted to top-level view

### Changed
- **Kanban is no longer a right-pane mode**. It's now a top-level alternate view that swaps the chat + right-pane area for a workspace-scoped board, with the sidebar still mounted (and ⌘B still hiding it). The card *is* the unit of work; making the user "be in a chat" to see the board was backwards.
- **⌘⇧K** now toggles `appView: 'chats' | 'kanban'` instead of jumping the right pane to a per-session kanban. Persisted under `layout.appView`.
- **⌘⇧E** is back to a 2-mode toggle (`terminal ↔ files`). Legacy persisted `'kanban'` value migrates to `'terminal'`.
- **Workspace + project filters** in the toolbar drive scope. Default is "All workspaces"; selecting a workspace narrows to its projects, and a further project filter drills down to one. Filters are persisted under `layout.kanbanWorkspaceFilter` / `layout.kanbanProjectFilter`. Changing the workspace filter clears any stale project filter under the previous workspace.
- **Cross-project board** unions cards from every in-scope project; tiles show the project basename so the wide view stays legible. Card hydration runs per-project via the existing IPC — N round-trips on first paint, but kanban-store dedupes so toggling scopes doesn't re-fetch.
- **Sidebar session click** drops back to chats view automatically (and so does `+ New Chat`), so the user lands in the conversation they just clicked instead of staring at the unchanged board.
- `KanbanPane.tsx` deleted; replaced by `KanbanView.tsx` mounted as a top-level sibling of the chat + terminal stack (see follow-up below).

### Fixed (later same day)
- **No more overlay bleed-through.** First cut mounted the kanban as an absolute-positioned overlay with `background: var(--bg)`, which is *transparent* in the translucent theme — the chat UI showed through. Restructured to a true view swap: chat + terminal stack and `<KanbanView />` are siblings, and we toggle `display: none` on whichever isn't active. Same pattern as the right-pane terminal↔files toggle, so PTY + xterm + Shiki state still survives. (User feedback: "shouldnt the uis be swapped... it looks like we are overlaying the board on top of the chat".)
- **Visible "Chats / Board" toggle in the title bar** (right of the Switchboard wordmark, left of the gear). Mirrors ⌘⇧K — discoverability for users who don't know the shortcut. The kanban is a top-level mode of the app, not a side pane: PM view ↔ engineering view.

### Added (later same day)
- **Tour clip for the two-mode swap.** New `kanban-view` step in `FEATURE_TOUR_STEPS`, slotted right after `welcome` so the app's two top-level modes are introduced before any chat-specific feature. `TOUR_VERSION` bumped to `2026-05-02` so existing users auto-see it on next launch. HyperFrames scene at `videos/scenes/kanban-view/index.html`, rendered MP4 at `videos/dist/kanban-view.mp4`.
- **Drag-and-drop column moves** (`@dnd-kit/core`). Tiles are draggable across columns; the destination column highlights with an accent border, and the dropped card lands in the new column on the same frame the overlay disappears. `kanban-store.move()` is now optimistic (cache patched synchronously, IPC follows) so drag feels instant — backed by 2 unit tests covering the synchronous patch + the no-such-card no-op. PointerSensor activation distance of 5px keeps clicks (open the edit modal) distinct from drags.
- **AskUserQuestion auto-promotes a card to `needs_input`.** When an agent calls AskUserQuestion (Claude or Codex), the runtime's `question.asked` event handler in ChatPanel looks up the linked card via `kanbanStore.findByConversationId(threadId)` and flips status `in_progress → needs_input`. `question.answered` flips it back. The `needs_input` column finally has a population mechanism — previously it was a manual label nothing in the runtime ever set. Symmetric, idempotent; we deliberately don't auto-flip cards that aren't currently in_progress (backlog/done were placed there intentionally).
- **Live tile state** — the per-card session pip now subscribes to `agent-store` and renders a green pulse for `running` / `thinking`, a static dot for `idle`, and red for `error`. An accent "N new" unread badge surfaces `session.unreadCount`. Pulse animation lives in `global.css` as `@keyframes sb-kanban-pulse` (distinct from the typing-indicator pulse so we can tune the ring color independently).

### Fixed (later same day, follow-ups)
- **CardModal now shows the project association** as a chip at the top of the body, or as a picker when create-mode scope spans multiple projects. Edit mode locks the project — moving a card across projects would invalidate worktrees and conversation links.
- **Filter dropdowns are no longer empty on toggle.** `KanbanView` was being unmounted every time the user flipped to chats view; remount re-fired `getProjects` + `workspaces.list` and the dropdowns rendered empty until IPC returned. Both views are now always-mounted (display:none on the inactive one), matching the right-pane terminal↔files pattern.

---

## 2026-05-02 — Kanban v1 + worktrees + main-process hardening

### Added
- **Kanban board** (right pane, ⌘⇧K). Per-project task cards with title / description / comma-tags / status / cost ceiling. Four columns: Backlog, In progress, Needs input, Done. Cards persist in SQLite (`kanban_cards` table) and round-trip through IPC — no optimistic updates, since human-paced mutations don't need them and the failure modes are easier to reason about with a single source of truth in main.
- **Per-card git worktrees**. Opt-in checkbox at create time spawns `git worktree add -b kanban/<slug>-<shortId> .switchboard/worktrees/<slug>-<shortId> HEAD`. Cards expose Attach / Detach buttons in the edit modal. Branch deletion on remove is namespace-guarded (only `kanban/*` branches get pruned — user-created branches are left alone).
- **Card → session start**. Click a card's ▶ button to spawn a chat whose `projectPath` is the card's worktree (or the project root if no worktree). Terminal panes spawned inside that session and the file tree / viewer all root themselves at the worktree automatically — no extra plumbing in the lifecycle hook. Card → conversation linkage is patched on first start so subsequent clicks jump (↗) instead of duplicating.
- **Worktree manager modal** (⎇ Worktrees button on the kanban toolbar). Lists every worktree git knows about, tags each as linked / orphaned / prunable / stale, and offers per-row remove + a "Clean up N stale" footer action. Stale = git-prunable, missing on disk, or orphaned (no kanban card).
- **Right-pane mode `'kanban'`**. `layout-store.toggleRightPaneMode` now cycles `terminal → files → kanban → terminal`. Persisted in settings.
- **`RuntimeEventBus`** in `src/main/event-bus.ts` — EventEmitter-backed pub/sub for adapter → renderer event flow. Decouples adapters from `provider-registry` and gives tests a clean injection seam (6 unit tests).
- **`stopSession` on tab close** — `agent-store.removeSession` now fires `provider.stopSession(id)` before dropping renderer state. Prevents leaked Codex app-server / OpenCode ACP / Claude SDK loops that previously held cwd / file handles / sockets until app exit.
- **Unhandled-rejection logger** in `src/main/index.ts` and **rejection logging** across Claude / Codex / OpenCode adapters and `provider-registry`. Replaces `.catch(() => {})` swallow points that hid real errors.

### Changed
- `removeWorktree` falls through to `git worktree prune` when the directory was manually deleted, so the metadata cleans up either way.
- New IPC: `kanban:list / create / update / delete / create-worktree / remove-worktree / list-worktrees / list-stale-worktrees / remove-stale-worktree`. The path-based stale removal refuses to operate outside `<projectPath>/.switchboard/worktrees/` to neutralise a malformed renderer call.

### Why
Cards-with-worktrees gives parallel agentic work without the test/checkout collision that branches-in-place suffer. Cleanup UI matters because every iteration leaves a worktree behind, and a stale-worktree avalanche is a hostile first run for a returning user. Event-bus + rejection logging are the same lesson learned twice: silent failures eat days of debugging time, the fix is cheap, ship it before it bites.

---

## 2026-05-02 — Deslop ESLint pre-commit

### Added
- **`eslint.config.mjs`** (flat ESLint 9 config, deslop-focused). Four rules: `@typescript-eslint/no-explicit-any`, `no-useless-catch`, `no-else-return`, `no-useless-rename`. Deliberately tight scope — every additional rule is a tax that invites `--no-verify`.
- **lint-staged + pre-commit hook**: `npx lint-staged` runs eslint with `--max-warnings=0` on staged `src/**/*.{ts,tsx}` only. New `as any` casts and other tells fail the commit; pre-existing slop in unmodified files is untouched.
- **`scripts/pre-commit.sh`** (checked into the repo) and **`scripts/install-hooks.mjs`** (runs as `prepare` lifecycle on `npm install` to copy the hook into `.git/hooks/`). Future clones get the hook automatically.
- **`npm run lint:deslop`** for ad-hoc full-tree audits — exposes deslop debt to drive toward zero.

### Known debt
- **64 pre-existing `no-explicit-any` violations** across 27 files (top offenders: codex-adapter 10, opencode-acp-adapter 9, claude-adapter 8, sidebar 7). Will be cleaned up in a follow-up commit. Until then, edits to those files will block on commit — fix the local violations or add `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`.

### Why
Mechanical AI-noise (defensive `as any`, useless try/catches, `else return`) accumulates faster than reviewers can catch it. ESLint can't tell good code from bad, but it CAN tell mechanical noise from non-noise. Use it for what it's good at; leave the judgement calls to `/review` and `/simplify`.

---

## 2026-05-02 — OpenCode legacy adapter retired

### Removed
- **`opencode-adapter.ts`** (911 lines, the `opencode run --format json` shell-out variant) deleted. The ACP-based adapter has been default since 2026-04-28 and is now the only path.
- **`opencode.useAcpAdapter` setting** removed (was: gate flag, default `true`). Existing values in the settings DB are inert and harmless.
- **Settings → OpenCode → Adapter** toggle removed from `SettingsModal.tsx`.

### Changed
- `provider-registry.ts` simplified: dropped `resolveOpencodeAdapter()` indirection; the OpenCode entry in the adapter map points directly at the ACP instance. `OPENCODE_LIST_MODELS` IPC handler now calls the ACP adapter directly.
- `opencode-acp-adapter.ts` header comment updated to reflect retirement (no longer "replaces" — it replaced, past tense).
- `CLAUDE.md` "What's currently working" + file structure updated.

### Why
The ACP adapter has been default for a release with no fallback complaints. Live-streaming tool progress, real plan mode, permission RPCs, image input, and inline model catalog made the legacy CLI fallback obsolete. Carrying 911 lines of dead code (plus its toggle UI and IPC indirection) was pure tax on every refactor.

---

## 2026-04-20 — Phase A (docs, UX polish, slash commands)

### Added
- **Slash command menu**: type `/` at start of a line in chat to open an inline popover. v1 commands: `/plan`, `/sandbox`, `/edits`, `/full`, `/clear`, `/archive`, `/image`, `/stop`, `/help`. Keyboard-only: ↑↓/Enter/Esc in the menu, typing filters the list live. Trigger detector is a pure function with 11 regression tests to lock down mid-line vs line-start semantics.
- **Plan-mode denial pill**: when `canUseTool` hard-denies a tool (e.g. Plan mode blocked Write), a red-bordered pill appears in the chat stream with the tool name + reason. Previously only the agent's prose reaction surfaced the block.
- **ApprovalCard collapsible detail**: tool-input JSON wraps in `<details>` with a smart one-line summary (command / file_path / first key). Long JSON no longer hides inside a 160px scrolling box.
- **Historical images reconstruct from JSONL**: `JsonlParser.extractImages` rebuilds `MessageImage[]` from Claude's `image` content blocks. Previously, images attached via Switchboard would disappear after app restart because the parser dropped non-text blocks.
- **Source-aware JSONL parser**: `JsonlParser` takes a `source: 'claude-code' | 'codex'` arg. Codex sessions (with `response_item`/`event_msg` events instead of Claude's `assistant`/`user`) now load their messages. Imported Codex chats previously showed titles in the sidebar but zero messages.
- **Typed wire events**: `RuntimeEvent` union moved to `src/shared/provider-events.ts` so preload + renderer share the same discriminated union. `window.api.provider.onEvent` is now typed — no more `as any` casts in ChatPanel/App.

### Changed
- `src/preload/index.ts` — `provider` methods typed against `RuntimeMode`, `ApprovalDecision`, `StartSessionOpts`. Removed unused `any` boundaries.
- `src/renderer/components/chat/ChatPanel.tsx` — dropped legacy `--print` agent fallback; all traffic goes through the provider bridge.

### Fixed
- Multiple real bugs surfaced by enabling the gated build (typecheck + test + build):
  - `CommandPalette.tsx` was calling `addPane` / `addRow` — both removed in the terminal refactor. Palette items "New Terminal Pane" and "New Terminal Row" had been silently broken since. Now wired to `addPaneToActiveWindow` + `addWindow`/`splitActiveWindow` with `cwd`.
  - `claude-adapter.ts` could call `CUSTOM_UI_TOOLS.has(undefined)` when `block.name` was absent. Added null guard.
  - `provider-registry.ts` Map literal was inferring as a union rather than `Map<ProviderKind, ProviderAdapter>` — added explicit generic.
  - `SearchModal.tsx` `useRef<Timeout>()` without initial value; added null initializer + guard on `clearTimeout`.
  - `App.tsx` + `ThemeSwitcher.tsx` had `WebkitAppRegion: 'no-drag' as any` — added global CSSProperties augmentation in `env.d.ts`, removed casts.

### Infrastructure
- **Build gate**: `npm run build` now chains `prebuild → typecheck → test → build`. Build fails if typecheck or tests fail. Escape hatch: `npm run build:fast`.
- **+60 tests** (~130 → ~190):
  - `tests/unit/slash-commands.test.ts` (18) — trigger detection + registry
  - `tests/unit/jsonl-parser.test.ts` (+11) — Codex source + historical images
  - `tests/unit/message-list.test.ts` (+1) — denial message keeper
  - `tests/unit/session-scanner.test.ts` (+6) — exact-match cases
- **Docs rewrite**: this file (`CHANGELOG.md`), `CLAUDE.md` rewritten to match reality, docs/plan.md status updated.

---

## Earlier sessions (pre-CHANGELOG)

### 2026-04-20 AM — Plan mode + tests expansion

- Extracted `decidePermission` / `PLAN_READ_ONLY_TOOLS` / `CUSTOM_UI_TOOLS` as pure exported functions from `claude-adapter.ts`
- Added `tests/unit/claude-adapter-plan-mode.test.ts` (12) and `tests/unit/provider-adapter-tool-filter.test.ts` (5) — locking down plan-mode policy and the custom-UI tool allowlist
- Fixed **plan mode writing to disk** — previously fell through to the generic approval prompt; now hard-denies all non-read-only tools
- `MessageList.groupIntoTurns` now exported + tested; fixed regression that dropped messages with only `question` / `plan` / `image` attachments
- `session-scanner.ts` exports `encodeClaudeProjectPath` + `isClaudeDirForProject` for testing; scanner uses exact dir equality (was substring match, caused parent/child session bleed)
- `getArchivedConversationIds()` returns a global set — archive filter now robust against same session appearing under multiple project paths

### 2026-04-20 — Image pipeline (end-to-end fix)

Images in chat were captured in the UI and saved to DB but **never sent to the agent**. Traced the gap and wired all four layers:
- `ChatPanel.tsx:384` passes `messageImages` to `sendTurn`
- `preload/index.ts` `sendTurn` signature now accepts images
- `provider-registry.ts` IPC handler forwards images to the adapter
- `claude-adapter.ts` strips `data:…;base64,` prefix and constructs SDK `image` content blocks alongside text

### 2026-04-20 — QuestionCard rewrite + tool filter

- Rewrote `QuestionCard.tsx` in T3-Code style: one question at a time with `i/N` pagination, number shortcuts 1-9, single-select auto-advance 200ms, multi-select waits for Next
- Suppressed `tool.started` emission for `AskUserQuestion` and `ExitPlanMode` (raw JSON tool block was rendering alongside the custom card)

### 2026-04-20 — Archive bug (two root causes)

- Scanner was using `dir.includes(encoded)` — substring match caused parent project `/Users/foo/ssg` to pick up sessions from child `/Users/foo/ssg/sub`
- Archive filter was per-project (`getConversationsForProject(path)`) — archiving from one view didn't hide the session from the other
- Fixed scanner to exact match + archive filter now queries a global set of archived IDs

### 2026-04-20 — Terminal cwd defaults

Panes created via `⌘T`, `⌘⇧T`, `⌘\`, and the "+" buttons defaulted to electron's cwd (the switchboard dir) instead of the active session's project path. Fixed across `App.tsx` keybindings, `TerminalStrip.tsx` toolbar, `TerminalWindow.tsx` per-tab +, and `CommandPalette.tsx`.

### Earlier — Major infrastructure (pre-April)

- Tmux-style terminal panes: rows of windows holding stacked pane tabs; keyboard nav, splits, resize handles
- Claude SDK streaming-input integration via `AsyncIterable<SDKUserMessage>` prompt queue
- `canUseTool` callback + `setPermissionMode` for live runtime-mode updates
- File-based logger with 7-day retention
- Single-instance lock
- Translucent theme with macOS vibrancy
- Archive/unarchive conversations
- FTS5 full-text search over message bodies
- Drag-to-reorder projects via `@dnd-kit`
- Context window meter from live SDK polling
- Session resume via `--resume <session-id>`
- Pre-commit hook runs tests
- GitHub Actions CI (typecheck + test + build on push/PR)

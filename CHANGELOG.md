# Changelog

All notable changes across Switchboard development sessions. Reverse-chronological.

## 0.8.53 - Repair remote reconnects, refresh managed tools, and stop dropping live models

### Fixed
- **A wedged remote server can no longer hold its port forever.** The pidfile that the remote bootstrap kills before relaunching is now claimed only once the backend is actually listening and released only while it still owns the file, closing the race that let a relaunch overwrite the real owner's pid, kill a corpse on retry, and leave the true holder running unbounded (one instance was observed surviving 41 hours at 99% CPU this way). Shutdown now terminates every open WebSocket and raw TCP client before closing the listeners, is bounded by a force-exit watchdog, and no longer double-runs on a repeated SIGTERM.
- **A missing or outdated managed CLI on an already-provisioned ("ready") remote is now repaired instead of left alone.** Managed Claude/Codex tool health is decided from the probed executables and their installed versions, independent of the connect plan's ready/install verdict, so a dangling `claude` symlink or a Codex install stuck at an old pinned version gets relinked or reinstalled on the next connect rather than persisting indefinitely.
- **The managed CLI bin directory now wins PATH resolution everywhere it matters** (spawn, `which`, and `PATH` construction agree), a dangling managed symlink falls through to a real binary instead of failing at spawn time, and the resolved binary is revalidated rather than cached forever - a CLI a remote repairs or upgrades after the backend has been running for days becomes visible without a process restart. This also fixes a Codex-specific bug where "CLI not found" latched permanently, so installing Codex after the backend started still required a restart.
- **Persisted or default Claude/Codex model selections no longer disappear just because they don't literally match a live catalog row.** `reconcileSelectedModel()` now knows a live row can be an alias (`sonnet`, `opus[1m]`) rather than the exact id the CLI accepts, and keeps a selection when the row names it directly, when the CLI's own `resolvedModel` maps to it, when they differ only by a `[1m]`-style capability suffix, or when a bare family alias covers one of this build's shipped ids - instead of clearing it on any id mismatch. The Codex adapter now reconciles the active model against the live catalog on every turn, not only at session start.
- **Claude and Codex model catalogs can no longer get stuck empty or stale for a whole session.** A `supportedModels()`/`model/list` response that races provider startup is no longer cached as the final answer, and the cache is keyed to the resolved CLI's identity so a remote whose CLI was just repaired or upgraded is re-queried instead of serving the previous binary's list indefinitely.
- **Queued-send and status text now render as `…` instead of the six literal characters `\u2026`.** Several JSX locations - bare text nodes and plain (non-`{}`) attribute strings - never interpret `\uXXXX` escapes; `Sending…`, `thinking…`, `Approving…`/`Denying…`, and tooltips across ChatInput, TerminalStrip, SettingsModal, and Sidebar are now literal Unicode glyphs.
- **The terminal toolbar's third button now shows its actual shortcut.** It read "New tab in active window (⌘C)"; the button performs the same action as the app's global `⌘\` handler, and the tooltip now says `⌘\`.

### Changed
- **`@anthropic-ai/claude-agent-sdk` upgraded from ^0.2.141 to ^0.3.260** (bundled CLI 2.1.141 → 2.1.260), which supplies the `resolvedModel` field the alias-aware catalog reconciliation above relies on and adds support for newer model ids.
- **The remote-managed `@openai/codex` pin moved from 0.144.1 to 0.153.2.**

### Notes
- This is a Desktop/Electron and shared remote-backend release; no mobile code, wire contract, or mobile release version changed. React Native/iOS and native Android are thin remote clients that already request `provider:list-models` over the unchanged contract, so they inherit the corrected catalog behavior without any client-side change.
- See `docs/feature-parity/remote-backend-lifecycle-and-managed-tools.json` and `docs/feature-parity/ui-unicode-labels.json` for full verification detail, including what was and was not exercised against a live remote VM.

## 0.8.52 - Stop Claude resume from losing or clobbering its session id

### Fixed
- **Resuming a forked or aliased thread no longer misses its own history.** A thread id that is actually a rotated Claude UUID handed back by the renderer is now resolved to its root before looking up the typed resume segment and session family, so a sibling transcript recorded under the true root is found instead of silently ignored.
- **`ProviderRegistry.startSession` no longer overwrites Claude's resolved resume id with the client's raw hint.** The resume id it retains is now seeded only by a synchronous session event fired during that call (Codex resume/fresh-thread confirmation); previously it started from the unvalidated `resumeSessionId` hint, which clobbered the adapter's DB-resolved id on every Claude session start.
- **A missing transcript now tries a sibling session before giving up.** When the held resume id's transcript can't be found, Switchboard looks up a sibling id and retries placement through the existing cross-profile transcript migration; a sibling I/O error (a momentarily full disk, a lock) is retried for a few turns instead of being treated as a permanent loss, without ever adopting an unverified sibling id.

### Notes
- This is a shared backend/Desktop fix. React Native/iOS and native Android are thin remote clients that only send `resumeSessionId` as a hint and hold no local resume-placement logic, so they are unaffected and keep their existing versions.
- No schema or migration change: the fix reads existing `thread_sessions` rows through helpers already added by the prior conversation-fork-reliability migration.
- Automated verification: the new `claude-resume-placement`, `claude-resume-root-resolution`, and `provider-registry-claude-resume-clobber` unit suites (16 cases, run and passing) and the full feature-parity validator pass. The standalone server's own resume path and a live resume-after-long-idle run against a real Claude CLI session with an actual OAuth profile switch were not exercised.

## Native Android 0.5.10 - Harden the WS coordinator and event feed

### Fixed
- **A loading state can no longer deadlock the connection.** `AuthenticatedWsCoordinator`'s `connect`/`setNetworkAvailable`/`probe`/`invoke`/`disconnect`/`destroy` entry points now run their locked state transition and then drain queued listener/callback deliveries unlocked, so app code invoked from a callback can no longer re-enter the coordinator while it still holds its own lock.
- **A destroyed connection can no longer deliver events to a stale listener.** `destroy()` now clears channel event listeners in addition to runtime event listeners, and both listener lists are read under lock at delivery time rather than at registration time.
- **Duplicate or dropped feed rows from unsequenced events are fixed.** Denial, error, and raw-notice feed items now carry a per-arrival id when the transport gives no sequence number, so repeated identical events (e.g. repeated plan-mode denials) land as distinct rows instead of colliding; sequenced transport events continue to upsert by sequence, and the runtime event's sequence number now actually reaches the thread reducer instead of being dropped as `null`.
- **Large file diffs can no longer blow up alignment cost on one lopsided side.** A new 3,000-line per-side cap complements the existing 90,000-cell product cap, so a diff with one very large and one very small side falls back to the bounded presentation instead of allocating a huge one-sided table.
- **CI gained a scoped, non-blocking instrumented UI check.** A new `instrumented` job runs `ThreadScreenRegressionTest` on an emulator (API 30, KVM) and always uploads its test reports; it is marked `continue-on-error: true` for this first rollout and is not required to pass.

### Notes
- This is a native-Android-only patch. No Desktop, React Native/iOS, or shared backend/wire-format file changed; the server already emitted the per-frame sequence number this client was previously discarding.
- Automated verification: the new `ThreadStoreReducerTest`, `WsCoordinatorTest`, and `FileDiffPresentationTest` Kotlin unit tests, and the `android-native-ci` workflow-YAML test (14 cases, run and passing) that asserts the new instrumented job's structure. The Gradle/Kotlin unit and lint suites and the new emulator-based instrumented job itself were not executed in this environment (no Gradle/emulator available here); no physical or emulated Android hardware was used. `BrowseScreenVisualTest`, `DeepLinkNavigationTest`, `NewSessionWorktreeScreenTest`, and `SwitchboardDatabaseTest` remain unexercised by any CI run — only `ThreadScreenRegressionTest` is wired into the new job.

## 0.8.51 - Make optimistic sends feel immediate

### Fixed
- **Sending no longer leaves the same message in two places.** Desktop clears the composer as soon as an idle or active send begins while retaining the optimistic transcript bubble and working feedback.
- **Failed sends roll back into the composer instead of becoming transcript debris.** Text, pills, images, and retry identity restore together with the concrete delivery error; the failed optimistic bubble is removed.
- **Retries remain duplicate-safe.** An unchanged ambiguous message exposes `Retry safely` and reuses its original delivery ID. Editing it creates one new ID after a single warning and resolves the older uncertain delivery before submission.
- **New drafts and late acknowledgements cannot race recovery.** A newer draft is never overwritten, detached failures expose an explicit Restore action, and canonical acceptance clears matching recovery even while its chat is hidden.

### Notes
- This patch changes Desktop composer presentation only. The shared atomic API and stored data are unchanged; React Native/iOS and native Android retain their existing durable outbox implementations and versions.
- Direct upgrades use the existing migration path. Verification uses disposable profiles and never opens or mutates the running v0.8.35 profile.
- macOS releases remain unsigned until production signing credentials are configured. macOS 12 or later is required.

## 0.8.50 - Repair rich chats and acknowledge idle sends

### Fixed
- **Rich remote chats keep their rows separated as content changes.** Same-key turns now remeasure during the React commit, cache resets are separated from DOM measurement, and hidden tabs rebuild their row sizes when revealed. The bottom-follow guard no longer mistakes TanStack's own height corrections for a user scroll, which was the immediate cause of later messages rendering at stale 120px offsets and overlapping.
- **Cold idle-chat sends acknowledge the click immediately.** Desktop shows a transient `Sending…` bubble before provider startup, reconciles it in place with the canonical accepted turn, removes it on definite rejection, retains `Delivery unconfirmed` while recovery is required, and marks an explicitly abandoned attempt `Delivery unresolved · not resent`. These rows remain renderer-only: SQLite persistence, title/activity updates, handoff cleanup, and provider admission still require the existing atomic backend acceptance.

### Notes
- This patch changes Desktop behavior only. React Native/iOS and native Android already use durable pending outboxes and keep their existing release versions; the shared atomic API, stored data, package identity, deep links, and provider credentials are unchanged.
- Direct upgrades from Desktop v0.8.35 and v0.8.49 use the existing migration path and are rehearsed in isolated temporary profiles. The running v0.8.35 profile is never opened, copied, stopped, or mutated.
- macOS releases remain unsigned until production signing credentials are configured. macOS 12 or later is required.

## 0.8.49 - Stabilize Desktop quit and chat rendering

### Fixed
- **Quitting on macOS is now one-way.** Once terminal, provider, mobile, and database teardown begins, Dock reopen events, deep links, and second launches can no longer recreate a window against closed services. The final quit retry is deferred to a fresh event-loop turn and scheduled only once, including when teardown rejects.
- **The blue chat focus border now means two panes are actually visible.** A single chat no longer receives the dual-pane focus outline, while side-by-side chats retain it and tabbed narrow layouts use their existing selected-tab treatment.
- **Tall remote-chat turns no longer render on top of each other.** Bottom-follow scrolling now keeps dynamic row measurement active while histories load and cards or streamed turns change height; scroll lock still leaves the transcript alone when you read older messages.

### Notes
- This is a Desktop-only patch. React Native/iOS, native Android, shared backend/API contracts, stored data, package identity, deep links, provider credentials, and mobile release versions are unchanged.
- Direct upgrades from Desktop v0.8.35 and v0.8.47 retain the existing database migration path. Verification uses isolated temporary user data and never opens or mutates the running user's profile.
- The failed v0.8.48 tag was never published. v0.8.49 carries those fixes, adds the transcript-layout repair, and widens the comprehensive Windows migration rehearsal's CI timeout after two healthy-but-slow runs exceeded Vitest's generic five-second default.
- macOS releases remain unsigned until production signing credentials are configured. macOS 12 or later is required.

## 0.8.47 - Certify the v0.8.35 upgrade

### Fixed
- **A live v0.8.35 profile can upgrade without an intermediate install.** The published v0.8.35 SQLite shape now has a repeatable migration fixture covering projects, conversations, messages, images, display bodies, settings, integrity, foreign keys, and idempotent relaunch.
- **Desktop updates cannot be hidden by a mobile release.** Native Android releases no longer become GitHub Latest, and a missing desktop update manifest is surfaced as a repairable error instead of “up to date.”
- **Unconfirmed turns no longer disappear or wedge a thread forever.** The v0.8.35 positional client retains ambiguous responses; current Desktop, iOS, and Android clients can explicitly continue without resending, durably resolving the blocker while preserving the original origin as abandoned. Resolution is scoped to the authenticated client and cannot race an active provider dispatch.
- **The macOS update feed cannot install an incompatible runtime.** Electron 43 raises the app floor to macOS 12, and release metadata carries the Darwin 21 floor understood by the updater already shipped in v0.8.35. macOS 11 users stay on their compatible release instead of receiving an app that cannot launch.
- **The Electron 43 smoke gate boots as an app on every platform.** Its child environment now removes `ELECTRON_RUN_AS_NODE` instead of preserving an empty value that Windows interprets as Node mode and aborts before loading the main bundle.
- **Remote chat scope can no longer cross file or event boundaries.** Canonical-path checks protect launch configuration from alternate roots and symlinks, and TCP event delivery applies the same scope filter as WebSocket delivery.
- **Rendered agent Markdown no longer trusts raw HTML or executable URL schemes.** Raw tags are escaped and unsafe links/images are omitted while normal Markdown, code-copy controls, relative links, HTTP(S), and mail links remain intact.
- **Worktree cleanup preserves user work.** Explicit removal never force-deletes an advanced branch, and restart recovery recognizes rollback intent instead of rematerializing a worktree already removed during compensation.
- **Feature-parity evidence is now real evidence.** Validation rejects missing files, repository escapes, and cross-surface evidence that does not belong to the declared product slice.
- **Runtime dependencies are clean.** Electron, better-sqlite3, electron-updater, electron-builder, Claude Agent SDK, js-yaml, Vite, Vitest, and affected transitive packages were moved to patched compatible releases; the unused DOM sanitizer dependency was removed.

### Notes
- Desktop/backend 0.8.47, the React Native/iOS production OTA, and native Android 0.5.9 carry the same ambiguous-turn recovery contract. Package identity, deep links, provider credentials, and existing stored data remain unchanged.
- macOS 12 or later is required for Desktop 0.8.47. The update feed prevents older macOS installations from accepting this release.
- The Desktop/runtime dependency audit is clean. Expo 57's development toolchain still reports upstream Metro/CLI advisories; npm offers only an incompatible Expo 46 downgrade for the remaining chain, so the existing iOS native fingerprint is preserved for OTA compatibility.
- The upgrade rehearsal uses isolated temporary user data and never opens, copies, stops, or mutates a running v0.8.35 profile.

## Native Android 0.5.9 - Resolve uncertain delivery safely

### Fixed
- **An ambiguous queued turn has an explicit exit.** Retry preserves the exact origin as before; Abandon asks the backend to durably resolve the uncertainty before deleting the local outbox record, so later messages can proceed without risking a duplicate provider call.
- **Mobile releases cannot replace Desktop Latest.** The signed APK workflow publishes `mobile-v*` as a non-latest GitHub release while retaining package, signer, checksum, and monotonic version checks.

## 0.8.46 - Make conversation forks durable

### Added
- **Forks now use a stable, backend-validated message anchor.** Every client sends an idempotent request with a durable message ID and full structured-content digest; the backend resolves one canonical history snapshot, rejects stale or ambiguous anchors, and returns the exact persisted conversation and newly identified rich messages.
- **Fork lineage is durable and navigable.** Desktop, React Native/iOS, and native Android show the parent, anchor preview, native-resume versus transcript-handoff mode, and Git base/branch when present. Opening the parent returns to the exact canonical anchor.
- **Fork retries and recovery are first-class.** SQLite journals each request, worktree creation delegates to the shared transaction, provider artifacts publish behind a compensation seam, and retrying the same request returns the original result instead of creating another branch, transcript, or conversation.

### Fixed
- **Worktree forks preserve project identity.** `projectPath` remains the owning project while `worktreePath` is the execution checkout; renderer state now preserves worktree, machine, provider profile, runtime mode, model, reasoning effort, and launch configuration across success, restart, search, and remote routing.
- **Fork persistence is atomic and lossless.** Conversation lineage, resolved provenance, handoff state, and full structured messages—including image-only turns, tools, pills, display bodies, plans, questions, todos, and diffs—commit in one SQLite transaction, and returned message IDs match the stored rows.
- **Provider resume claims now match reality.** Compatible Claude lineage resumes natively in the source conversation's committed profile. Codex and OpenCode use a durable exactly-once transcript handoff and no longer create fake rollout files in provider discovery directories.
- **Git side effects are honest and recoverable.** Worktrees use the source checkout's frozen HEAD but a canonical non-nested managed root, dirty tracked and untracked state requires confirmation, clean pre-command failures compensate branch/worktree artifacts, and potentially modified trees are retained with an explicit cleanup receipt.
- **Remote forks stay remote.** Routing recognizes the source conversation, binds the authoritative returned conversation to the same machine before activation, and preserves that machine for provider, terminal, IDE, file, archive, and later-fork calls.

### Notes
- The old positional `upToIndex` contract now fails with an explicit upgrade-required error instead of silently choosing the wrong boundary. Legacy fork diagnostics classify project-path drift, missing/orphaned worktrees, ambiguous anchors, and unusable Codex artifacts without deleting or rewriting uncertain data at startup.
- The provider matrix is Claude native resume only for compatible committed lineage; Claude degrades explicitly when lineage/profile data is missing, while Codex and OpenCode use exactly-once transcript handoff.
- Automated gates passed 3,103 desktop tests across 321 files, React Native TypeScript plus 18 tests, Android's 797 unit tests plus lint/APK/android-test compilation, production builds and smoke boot, and feature-parity validation. Live native resume passed with both named Claude OAuth profiles. Physical mobile hardware and a separately hosted remote-machine disconnect/retry remain unexercised.

## Native Android 0.5.8 - Make conversation forks durable

### Added
- **Conversation messages can be forked directly from the native thread.** Long-press a canonical user or assistant turn to fork in the shared checkout or create a new worktree from current HEAD, with dirty-source confirmation and typed failure recovery.
- **Returned fork identity is authoritative.** Navigation and process recreation preserve parent project grouping, execution worktree, branch, machine routing, provider profile, model, mode, reasoning effort, retry identity, and durable lineage/resume presentation.

### Notes
- Native Android 0.5.8 keeps package identity, signing key, Room data, connection state, and the production-signed APK update channel. It requires a backend advertising `conversation_fork_v1`; older backends remain usable without exposing the action.
- Unit, lint, debug APK, and instrumentation-source compilation gates pass. No attached emulator or physical Android device was available for the fork interaction matrix.

## 0.8.45 - Make two chats work as one focused workspace

### Added
- **Dual chat is now discoverable without memorizing a shortcut.** Chat headers and sidebar actions expose Open beside with a session picker that identifies provider, project, worktree, branch, machine, and status. The documented shortcut is consistently shown as `⌘⇧\\` with `⌘|` as its keyboard-layout alias.
- **The workspace has an explicit primary, secondary, and focused chat model.** A restrained focus treatment shows which chat owns session-scoped commands, while narrow windows and data-science mode preserve both bindings as usable identity tabs instead of squeezing two composers into the chat dock.
- **Prompts can be copied between chats without coupling their sends.** Text, pills, and attachments are cloned into an independent receiving draft, with confirmation when the destination crosses a machine or provider credential boundary.

### Fixed
- **Right-panel actions no longer route through the left chat.** IDE and terminal binding, status, quick prompt, interrupt, composer focus, chat/terminal/IDE context capture, and explicit file, fork, forward, approval, plan, question, and diff actions resolve an authoritative owning session.
- **Visible secondary chats no longer behave like hidden background work.** Both displayed chats avoid local unread badges and redundant native notifications while the window is visible; notification clicks focus an existing slot, and backend read/viewing state follows the documented visible-versus-focused policy.
- **Forwarding can no longer duplicate or misidentify sessions.** Send to other panel uses the message's source session, preserves the source slot, excludes self-targets, populates rather than sends the receiving draft, and focuses the registered receiving composer.
- **Slot state now reconciles deterministically.** Duplicate sessions, removal/archive, provider ID rotation, restored stale IDs, close/promotion, sidebar selection, and terminal-only sessions flow through one pure reconciliation seam. Concurrent provider streams share one event reducer and remain isolated between panels.

### Notes
- This is a Desktop Electron renderer/workspace release. React Native/iOS and native Android remain single-thread presentations and do not share the dual-pane layout; the backend wire contract, stored conversations, migrations, package identities, and mobile release channels are unchanged.
- The full local gate passed 3,101 tests across 326 files, both TypeScript projects, production renderer/server builds, packaged-main smoke boot, feature-parity validation, and an isolated Electron Playwright dual-chat workflow. Claude's adversarial design and implementation reviews identified shortcut drift and terminal ownership gaps; both were fixed with regression coverage. Real provider credentials, code-server download/navigation, remote machines, and physical mobile hardware were not exercised in this release verification.

## Native Android 0.5.7 - Discover work VMs from connected Macs

### Added
- **The Google IAP add flow now discovers SSH-config VMs through every connected Switchboard backend.** Available targets appear above the existing manual form; selecting one fills its name, project, zone, and instance while preserving the required backend-token and Google-account checks.

### Fixed
- **Already-saved IAP targets no longer clutter discovery.** Results are normalized across backends, merged once, and filtered against connections already stored on the phone. Partial backend failures leave successful results usable, and the empty state distinguishes “all added” from “nothing discovered.”

### Notes
- Native Android 0.5.7 keeps the existing package identity, signing key, connection storage, and manual signed-APK update channel. No Room migration or backend wire-format change is required.

## 0.8.44 - Keep machine discovery fresh

### Fixed
- **Desktop rereads `~/.ssh/config` every time Add machine opens.** Newly added aliases appear without restarting Switchboard; the primary list now contains only actionable hosts, while saved hosts remain available in a separate collapsed “Already added” disclosure.
- **React Native/iOS refreshes IAP discovery whenever its add flow opens.** Results from ready backends are merged by normalized VM identity and filtered against machines already saved on the phone, with distinct all-added and no-discovery states.

### Notes
- Desktop/backend 0.8.44 and the automatic React Native/iOS production OTA ship together. Native Android 0.5.7 ships separately through the production-signed APK workflow.
- Discovery reuses the existing SSH and IAP contracts. Stored connections, credentials, package identities, deep links, and database schemas remain unchanged.

## Native Android 0.5.6 - Compact agent activity

### Fixed
- **Agent tool calls no longer consume the thread as a stack of oversized cards.** Each call now uses a compact accessible activity row with a stable status slot, a humanized provider-agnostic label, and the useful bounded command, path, query, URL, or task summary visible immediately.
- **Output disclosure now reflects whether output actually exists.** Completed tools with nonblank output expand in place, while running and blank-output tools expose no false action. Large output is rendered in bounded newline-aware lazy pages and retains a one-tap full-copy action.
- **Tool accessibility now exposes coherent state and actions.** Rows merge decorative descendants, reserve the 48 dp minimum target, announce running/completed and expanded/collapsed state, and provide explicit Expand/Collapse semantics only when actionable.

### Notes
- Native Android 0.5.6 also includes the capability-gated transactional worktree creation source shipped with desktop/backend 0.8.43.
- Automated Android unit, lint, assembly, and Android-test compilation gates pass. The production-signed 0.5.5-to-0.5.6 in-app upgrade passed on CPH2487 with package-private storage and paired-machine state preserved; focused worktree creation, TalkBack traversal, and compact-tool screenshots remain recorded separately as unexercised.

## 0.8.43 - Make worktree creation one recoverable operation

### Added
- **New-chat, Kanban, and fork worktrees now share one backend-owned creation transaction.** A client-generated `creationId` identifies a durable saga from pending through Git materialization, sparse checkout, atomic owner linkage, configured setup, terminal startup, provider launch, and an exactly-once initial prompt. Renderers submit intent and observe correlated phase progress instead of coordinating those resources themselves.
- **Managed worktrees now have canonical identity, ownership, provenance, and product lineage.** SQLite journals interrupted creations and stores immutable worktree records while retaining the existing conversation/card path and branch columns as compatible projections. Legacy session, fork, and Kanban worktrees are conservatively catalogued without inventing lineage.
- **Repositories can define an explicit worktree setup hook.** `.switchboard/launch-config.yaml` supports an additive worktree setup command, default setup policy, and startup ordering. Switchboard never guesses a package-manager command, and optional sparse checkout is restricted to validated cone-mode repository-relative directories.

### Fixed
- **An explicit worktree request can no longer silently start in the parent checkout.** Desktop, React Native/iOS, and native Android retain the same creation identity across reconnects and process restarts, show recoverable backend state, and require a separate explicit parent-checkout action.
- **Partial Git, database, terminal, and provider failures no longer leave unowned or duplicate resources.** Pre-command failures reconcile branch-only and worktree-only states before compensation; once setup or startup may have mutated the tree it is retained for explicit recovery. Git/link mutations serialize per repository while unrelated repositories and long-running setup continue concurrently.
- **Stale cleanup can no longer mistake a live session or fork worktree for an orphaned Kanban tree.** Cleanup consults the canonical catalog, active creation reservations, and every compatibility projection, and refuses path-only deletion when immutable ownership cannot be proven.
- **Remote worktree creation now follows authenticated device scopes.** Chat-only phones may request provider-backed conversations, but cannot mutate repository setup/launch configuration, run startup commands, or spawn terminal layouts. Capability negotiation hides creation on older backends while preserving active recovery state through version skew.

### Notes
- Desktop/backend v0.8.43 and the automatic React Native/iOS OTA ship together. Native Android 0.5.6 is capability-gated by `worktree_creation_v1` and releases separately through the manual production-signed APK lane; v0.5.5 remains compatible.
- The additive database migration preserves old clients' `worktree_path` and `worktree_branch` projections. Existing paths are imported with legacy provenance; missing or reused paths are tolerated and never deleted automatically during migration.
- Automated gates cover the real Electron preload-to-IPC-to-SQLite-to-Git path, 3,029 root tests across 312 files, both root TypeScript projects, the production bundles and smoke boot, 17 React Native tests plus shared mobile contracts, and the complete Android JVM suite with Android test-source compilation. Hardware and separately hosted remote-machine scenarios remain recorded as unexercised in the parity manifest.

## 0.8.42 - Ship the stable code-copy release

### Fixed
- **A remote-provisioning process-runner test used Unix commands on the Windows release gate.** The same real child-process behavior is now exercised with the current Node executable on every runner, covering captured output, non-zero exit codes, timeouts, and normal completion without relying on `sh` or `sleep`.

### Notes
- This patch carries the stable Markdown code-copy controls and the Bash 3.2-compatible macOS packaging fix forward from the incomplete v0.8.39-v0.8.41 release attempts.

## 0.8.41 - Publish stable code-copy controls on every desktop

### Fixed
- **The unsigned macOS release lane could pass every application gate and then fail before packaging.** Release packaging now branches explicitly between signed and unsigned electron-builder commands instead of expanding an empty Bash array, which is invalid under the macOS runner's Bash 3.2 with `set -u`.

### Notes
- This patch supersedes the incomplete artifact sets for v0.8.39 and v0.8.40. It contains the same stable Markdown code-copy implementation and its regression coverage; no renderer behavior changed after Claude's final no-issues review.

## 0.8.40 - Keep Cursor recovery portable

### Fixed
- **The Cursor workspace regression suite still contained one macOS-only URI.** Every file URI fixture now comes from a native path, so Windows exercises the same exact-match and percent-decoding behavior without an expected decode warning.

### Notes
- This is a test-portability follow-up; runtime Cursor import behavior is unchanged.

## 0.8.39 - Keep code copy controls steady while agents stream

### Fixed
- **Markdown code-block Copy buttons could flash, disappear, or differ by provider timing.** Each code block now renders its complete `<pre>/<code>/button` structure atomically, while transient mutability is tracked per assistant message. Coalesced content flushes before completion, error, interruption, or shutdown settles the touched message, so late status and tool events cannot race the control out of the DOM.
- **A finished block could become unstable while later prose or another turn streamed.** Closed earlier fences remain settled, historical and remounted messages start settled, and every tagged or untagged block receives exactly one React-owned delegated control. Plan cards use the same renderer instead of maintaining a second imperative decorator.
- **The hover-only affordance looked missing and was incomplete for keyboard and touch users.** Settled controls now have a quiet visible resting state, `:focus-visible` treatment, coarse-pointer visibility, exact-code clipboard extraction, stable copied feedback, and handled/logged clipboard failures. Focus on a settled control survives later content commits without being stolen after the user moves elsewhere.

### Notes
- This is a renderer-only Desktop Electron fix. React Native/iOS and native Android use separate rich-text renderers and do not share the affected DOM ownership path; backend events, stored messages, migrations, wire contracts, and rollout flags are unchanged.
- Regression coverage includes cumulative snapshots, appended deltas, flush-before-completion ordering, completion followed by unrelated events, error/interruption settlement, multiple fence styles, historical messages, file pills, plan cards, clipboard denial, keyboard focus, coarse pointers, and an isolated Electron Playwright flow that never opens the live Switchboard database or provider credentials.

## 0.8.38 - Bring Cursor history into the switchboard

### Added
- **Cursor conversations now appear in the recovery inventory.** Switchboard discovers both legacy workspace-local and current global Cursor SQLite layouts through exact folder or multi-root workspace membership, reads them without write access, and imports only the transcript the user selects.
- **Imported Cursor history can continue as a real agent chat.** The snapshot keeps durable Cursor provenance across Desktop, React Native/iOS, native Android, and the shared wire row while Claude Code remains the runnable provider. Its first accepted turn receives the existing bounded handoff exactly once; later turns resume the native provider segment normally.
- **Desktop release signing is production-ready.** Complete platform credentials select forced signing, hardened runtime and notarization on macOS or Authenticode on Windows. Missing credentials retain the documented unsigned path; partial credential sets fail before packaging, and signed output is verified in the builder hook.

### Fixed
- **The roadmap still reported shipped behavior as missing.** Launch-config hot reload and `wait_for` startup orchestration, cross-provider bounded handoffs, and same-provider OAuth transcript migration are now recorded against their implementations and regression suites.
- **Re-importing Cursor could have risked replacing continued work.** Snapshots refresh idempotently only before a provider continuation exists; once a native segment is recorded, the managed history is left untouched.

### Notes
- Cursor JSON records are size-bounded, malformed records are isolated, and Cursor's own databases are never changed.
- The repository currently has no macOS or Windows signing secrets, so this release uses the supported unsigned packaging path. Adding the documented complete credential sets will activate signed artifacts without another code change.
- Android provenance code is covered by source tests but could not be run locally because this machine has no Android SDK; the release CI remains the automated authority for that lane.
- Claude's adversarial review found and drove fixes for legacy header-only bubbles, destructive empty refreshes, literal composer-ID matching, boundary logging, and tool-only history classification; its final focused pass reported no issues.
- The final local gate passed 2,728 tests across 274 files, both Desktop typechecks, React Native typecheck, lint, production builds, packaged-main smoke boot, feature-parity validation, and an unsigned arm64 ZIP whose stable identifier-only designated requirement passed strict codesign verification.

## 0.8.37 - Never show a turn the provider never received

### Fixed
- **A Desktop turn with several images could appear in the transcript and survive a restart without ever reaching the provider.** The backend now owns one typed, atomic submission envelope containing the provider text, visible body, pills, validated images, runtime mode, stable origin, and handoff metadata. The user row, title, activity, and handoff state commit only after that exact payload crosses the provider acceptance boundary.
- **Retrying an uncertain send could either duplicate provider work or let a later message skip ahead.** Exact origins and payload hashes now reconcile against durable reserved, dispatching, ambiguous, and completed states. Completed duplicates replay the canonical user event without a second dispatch; changed payloads conflict; true post-boundary uncertainty blocks later origins until durable state proves the outcome.
- **Definite rejection could leave a sent-looking bubble while discarding editable input.** Startup and pre-dispatch failures release their reservation, restore idle state, keep text, pills, and attachments recoverable, and suppress title/activity changes. React Native/iOS and native Android outboxes preserve their stable origins and attachment files under the same classification.

### Notes
- There is still no four-image or seven-image count cap. Admission validates PNG/JPEG/WebP/GIF data URLs against the existing 3 MiB aggregate synchronization budget.
- Older paired mobile clients retain an explicit compatibility path during Desktop/backend rollout. Native Android remains at 0.5.5 for this release; its existing origin-bearing outbox is compatible with the new backend, while the paired Android source changes await a separately verified signed APK release.
- The release gate passed 2,698 Desktop tests across 269 files, both TypeScript projects, 17 React Native tests, and 739 Android tests. A built-Electron live Codex turn sent seven genuine screenshots below 3 MiB and produced exactly one provider dispatch, one completed durable acceptance, one seven-image database row, and one canonical user event; Codex independently counted all seven attachments.

## 0.8.36 - Switch accounts without losing the thread

### Added
- **Claude and Codex conversations can now continue across OAuth profiles of the same provider.** Switchboard drains the active adapter, verifies the exact source and target JSONL histories, copies only compatible transcripts through a temporary file and atomic rename, then resumes with the selected credentials.
- **Transcript conflicts have an explicit recovery path.** Equal and prefix-related copies reconcile automatically; divergent, ambiguous, changing, or unreadable histories leave the source profile active and offer a deliberate start-fresh continuation instead of guessing which file wins.

### Fixed
- **A partial profile switch could leave the database, visible picker, and live provider process disagreeing.** Target events remain fenced until provider startup and the database transition commit together; failed preparation, startup, or persistence rolls back to the source profile.
- **Mobile retries could redispatch an already accepted turn or lose a degraded context handoff.** Provider acceptance and cleanup are now classified separately, handoff metadata commits with the profile transition, and the outbox injects the bounded history preamble at delivery time.

### Notes
- The migration keeps the source transcript intact, validates every JSONL record while hashing it, detects concurrent file changes, and records provider-session lineage in the same SQLite transaction as the selected profile.
- The implementation passed adversarial Claude review after extending repository-review calls to a ten-minute window. The final local gate passed 2,628 standard-runtime tests and 16 Electron-native tests; mobile typecheck and 17 mobile tests also passed.

## 0.8.35 - Put saved messages where they belong

### Added
- **Saved messages now have a dedicated sidebar view.** A bookmark action beside New Thread opens the full-width list, keeps the view open while jumping to a message, and returns to Recents, machines, workspaces, and projects through a clear Back action. The empty view remains reachable before the first bookmark.

### Fixed
- **Machine disclosure reset on every launch.** Expanded and collapsed top-level machines are now persisted by machine ID, restored after a full quit, and pruned when a machine no longer exists. Newly added machines still begin expanded.

### Notes
- The Saved view uses the existing surface and theme tokens, with no opaque card or translucent-theme override. The Electron Playwright flow seeds a real bookmark, verifies Saved navigation, collapses This Mac, fully relaunches the app, and confirms the disclosure state survives.
- The full local gate passed 2,479 tests across 244 files, both TypeScript projects, all production bundles, the remote server, packaged-main smoke boot, lint, and the final Electron visual/relaunch flow.

## 0.8.34 - Page through Recents without flooding the sidebar

### Fixed
- **Show more could render hundreds of conversations at once.** Recents now reveals five additional rows per click, labels the final partial page accurately, and keeps Show less available after the first expansion so the configured 4/6/8/12-row baseline is always one click away.

### Notes
- Approval, Input, Working, Failed, Done, and ordinary-recency ordering is unchanged. This release adds no pinned, settled, snoozed, archived, or database behavior.
- The Electron Playwright flow verifies 6 → 11 → 16 → 18 rows, the final **Show 2 more** label, and collapse back to six. The full local gate passed 2,475 tests across 244 files, both typechecks, all production bundles, the remote server, and packaged-main smoke test.

## 0.8.33 - Unstick Codex turns and keep conversation identity intact

### Fixed
- **Codex could wait forever after an MCP server requested structured input.** Standard MCP form elicitations now render through Switchboard's question UI and return schema-shaped values; unsupported elicitation modes are cancelled instead of leaving the app-server blocked.
- **Stop sent an invalid Codex request and left the composer on Working.** Interrupts now include the required native turn ID, have a bounded deadline, restore idle state immediately, and terminate the wedged provider session if interruption fails.
- **A stale Codex turn ID could create a second concurrent turn.** Switchboard now adopts the live turn ID reported by app-server and retries steering once instead of falling through to `turn/start`.
- **A recent named `branding` could open under `New conversation`.** Live-session summaries now carry the persisted database title, and selecting an already-adopted session reconciles its header with the sidebar title.
- **The recovery import action lacked the modal's button treatment.** Its primary action now uses the established recovery-modal styling and focus states.

### Notes
- The reported `branding` session was `agent_1786814211280`. Its packaged log showed an unanswered `mcpServer/elicitation/request`, followed by `turn/interrupt` failing with `missing field turnId`; these exact protocol paths now have regressions.
- The Electron Playwright fixture now seeds managed conversations on the current schema, waits for hydration, and asserts a recent title survives into the chat header. The final local gate passed 2,474 tests across 244 files, lint, both typechecks, all production bundles, the remote server, packaged-main smoke test, and the full Electron visual flow.

## 0.8.32 - Make conversation recovery usable and complete

### Fixed
- **The recovery inventory rendered as an unscrollable sidebar section.** It is now a bounded application modal with an independently scrollable list, title/provider/role/ID search, result counts, backdrop/Escape/close dismissal, and trapped/restored keyboard focus.
- **The reported `v0` transcript was hidden under its first prompt and sorted last.** Recovery candidates prefer Switchboard's durable conversation title, so the archived mixed-provider chat appears as `v0` and is directly searchable.
- **Duplicate Claude profiles could select a stale, truncated transcript copy.** Recovery now compares copies by completeness and freshness, choosing the full transcript regardless of provider-profile order while statting indexed candidates concurrently.
- **Reviving an archived mixed-provider root could overwrite its active Codex provider metadata.** Existing roots now change only recovery-owned visibility and title state; provider, instance, model, runtime mode, and resume cursor remain intact.
- **A repeated import could report success without restoring or refreshing the chat.** Known segments are unarchived and re-mirrored from the current native transcript, while cross-project or dangling lineage fails before any segment or message write.

### Notes
- The `v0` recovery fixture resolves native Claude session `b58253b1-d3c4-42a3-aea2-917b7831168b` to canonical root `agent_1786000350667` without mutating its Codex/Lenskart/model selection.
- Claude's backend profile review was diagnosed as a non-converging tool-exploration loop. A bounded exploration followed by tools-disabled synthesis completed successfully and found the final data-integrity and accessibility issues fixed in this release.
- The final local gate passed 2,467 tests across 244 files, both typechecks, all production bundles, and the packaged-main smoke test.

## 0.8.31 - Never mistake a migration failure for corruption

### Fixed
- **The 0.8.30 sidebar-role migration reset healthy databases at startup.** Its JavaScript template literal collapsed a SQLite `ESCAPE` clause into an empty string, so the migration failed with `ESCAPE expression must be a single character`. The prefix match now uses `GLOB`, which needs no escaping.
- **Any database initialization error could trigger destructive recovery.** Switchboard now moves a database aside only for SQLite's explicit `SQLITE_CORRUPT` and `SQLITE_NOTADB` codes. Migration, permission, I/O, and configuration failures leave every database file untouched and surface the real error.

### Notes
- Databases reset by 0.8.30 remain recoverable from their timestamped `.corrupt-*` files; the failure did not corrupt their contents.
- Regression coverage proves ordinary migration errors cannot move a database and verifies the sidebar-role SQL no longer contains the broken escape expression.

## 0.8.30 - Keep provider workers out of the conversation list

### Added
- **Native Claude and Codex transcripts now have an explicit Import/Recovery surface.** Provider files no longer manufacture sidebar chats just because they share a project path. Foreground transcripts can be imported, while delegated and utility runs can be deliberately promoted to independent conversations without mutating their parent lineage.

### Fixed
- **Codex subagents could split one logical chat into dozens of sidebar rows.** The normal sidebar, remote client list, archive list, and search navigation now project only app-owned managed roots from SQLite; raw provider sessions remain intact as recovery inventory.
- **A Codex child thread could replace its parent's resume cursor or stream worker output into the parent chat.** Foreground identity now comes only from correlated start/resume responses, and notifications carrying another native thread ID are isolated from the parent.
- **Legacy scanner rows could survive merely because they had been clicked once.** The additive migration uses durable ownership evidence and treats pane-layout state as non-authoritative, preserving ambiguous rows and all messages without showing them as conversations.
- **Pruned or rotated provider JSONL could make an app-owned chat disappear.** Sidebar identity no longer depends on provider files; typed foreground segments and the SQLite transcript remain the durable logical conversation.

### Notes
- The migration was rehearsed on a consistent copy of the 487 MB production database. It preserved all 174,844 messages and moved the reported evidence-free `Codex 38`, `Codex 40`, and `Codex 45` rows to recovery instead of deleting them.
- The implementation passed 2,452 tests across 242 files, both TypeScript projects, all production bundles, and the packaged-main smoke test. Claude's backend profile authenticated successfully, but its repository review process produced no result before the required timeout; the release proceeds on the green gate, fixture rehearsal, and Codex review.

## 0.8.29 - Long conversations survive provider and transcript rotation

### Fixed
- **A Claude conversation continued in Codex could reopen at the end of its Claude history.** Switchboard now records typed provider segments and assembles one chronological history from every Claude and Codex transcript copy plus the SQLite mirror.
- **Rotated, pruned, truncated, or relocated JSONL files could hide messages.** History loading unions all known native session IDs across configured provider homes and worktree CWDs, retains SQLite-only prefixes and completions, and uses stable Codex message identities.
- **Legacy mixed-provider conversations could resume the wrong native UUID.** Untyped Claude and Codex candidates are now verified against the corresponding provider's on-disk transcript, while the legacy `conversations.session_id` bridge recovers chats created before typed segments existed.
- **Forking a mixed-provider conversation applied a unified message index to one provider's JSONL.** Native forks now map the selected visible message back to its provider-owned index or deliberately degrade to a context handoff when an exact native cut is impossible.
- **Very long legacy histories reconciled quadratically.** Semantic reconciliation now uses indexed timestamp queues; the 20,000-message regression case dropped from roughly 2.8 seconds to about 60 milliseconds locally.

### Notes
- The reported `v0` RetailIQ/panel-agent conversation was backed up before repair. Its legacy Codex continuation was verified under the Lenskart Codex home and is now reachable through the provider-validated legacy hint path.
- The implementation was developed test-first and passed repeated adversarial review. The final gate passed 2,440 tests across 240 files, both typechecks, all production bundles, and the packaged-main smoke test.

## 0.8.28 - Organize workspaces without losing their order

### Added
- **Workspaces now have a dedicated organizer.** A compact two-pane view supports creating, renaming, recoloring, deleting, and reordering workspaces, plus moving and reordering projects with drag-and-drop or Option+Arrow keyboard controls.
- **The sidebar creation flow is unified.** One restrained Create menu replaces the separate project, workspace, and machine actions, while workspace rows expose contextual organization controls only on hover or focus.

### Fixed
- **Projects could shuffle within their workspaces after launch.** Project position now lives in the database beside workspace position, with a one-time migration from the legacy setting and deterministic ordering across desktop, remote machines, mobile, and full app relaunches.
- **Workspace edits could refresh through a second, differently sorted project path.** All organizer mutations now return through the canonical project loader, so the sidebar cannot briefly or permanently disagree with the persisted order.

### Notes
- The organizer reuses the existing theme tokens and native translucent surfaces; it adds no opaque theme layer, gradients, or hard-coded card palette. Packaged Electron Playwright checks Dark, Light, and Translucent modes, tour dismissal, keyboard reordering, transparent-root composition, and order persistence after a full quit and relaunch.
- The final local gate passed 2,414 tests across 236 files, both typechecks, mobile typecheck, lint, all production bundles, the packaged-main smoke test, and Playwright against the packaged macOS app.

## 0.8.27 - Make remote sends wait for their session

### Fixed
- **A message with an image could race remote provider startup and fail with `No session: agent_*`.** Concurrent starts and sends now share the same in-flight startup promise, so a quick attachment send waits for the adapter to exist instead of leaving the composer stuck in Working.
- **Finder-launched builds could not find `gcloud` even though it worked in the terminal.** Provisioning and long-lived tunnels now inherit the login shell's PATH while preserving the packaged app's remaining environment, so Homebrew and Google Cloud SDK installations resolve normally.

### Notes
- TDD reproduced both failures through the real WebSocket provider boundary and real child processes running with Finder's minimal PATH. Review also caught and fixed stale status reporting when a second renderer reattached during startup.
- The final gate passed 2,405 tests across 233 files, both typechecks, lint, all production bundles, the packaged-main smoke test, and packaged Electron Playwright. macOS, Windows, and Ubuntu CI passed before tagging.

## 0.8.26 - Make translucent mode actual crystal glass

### Added
- **Recents can match larger working sets.** Settings → General now lets the collapsed section show 4, 6, 8, or 12 conversations, while an inline Show more / Show less control exposes the full list without adding another sidebar scrollbar.
- **Recents now carries useful activity.** Approval, Input, Working, Failed, and unread Done states use restrained semantic icons and labels instead of generic blinking dots; ordinary conversations retain their relative timestamp.

### Fixed
- **Translucent mode could still render over an opaque black native window.** Every macOS window is now created transparency-capable, so switching from Dark or Light can activate native vibrancy without a relaunch. Dark and Light continue to paint solid renderer surfaces.
- **The translucent palette buried native glass under charcoal layers.** The workspace, sidebar, and titlebar now expose the macOS material directly, while headers, the composer, terminals, and controls use only restrained local tints.
- **The fullscreen fallback targeted a descendant theme class that does not exist.** Solid fallback variables and panel backgrounds now match the theme class on `<html>` when macOS disables transparency in fullscreen.
- **Tool summaries expanded and collapsed on every tool event.** “Used N tools” now stays collapsed and stationary while Claude or Codex works; only the user controls its disclosure state.
- **The documented native rebuild command skipped the database module.** `npm run rebuild` now rebuilds both `node-pty` and `better-sqlite3` for Electron, preventing locally packaged apps from failing before their first window opens with an ABI mismatch.

### Notes
- The packaged Playwright test now places a controlled magenta/cyan native window behind Switchboard and verifies the colors through an OS-level screen capture. It compares identical app pixels with native vibrancy enabled and disabled, reloads while fullscreen, checks Recents configuration and relaunch persistence, dismisses the tour, and verifies tool-summary and updater-help geometry.
- Review caught fullscreen reload synchronization, a failed-launch process leak, a platform-specific fixture command, a weak native-material comparison, a late-settings race, and Approval/Input ordering. All were fixed before the deslop and full release gates.
- The final local gate passed 2,401 tests across 233 files, both typechecks, lint, all production bundles, the packaged-main smoke test, and Playwright against a locally packaged macOS app.

## 0.8.25 - Restore translucency and finish updater recovery

### Fixed
- **The 0.8.24 translucent theme was effectively opaque.** The renderer root is transparent again so native macOS vibrancy remains visible, while restrained local tints keep the sidebar, header, composer, input, terminal, and diff surfaces readable.
- **Dark-theme metadata was too dim, and Full Access glowed amber.** Meaningful muted text now clears a 4.5:1 contrast floor, and the runtime-mode selector uses the same neutral surface as every other mode.
- **A completed update could stay stuck on “downloading.”** Updater state is now process-owned, broadcasts to every live window, and can be queried when Settings mounts after the terminal event.
- **The unsigned-build help tooltip was unreliable and clipped.** It is now a keyboard-accessible disclosure with a 40px effective hit target, stays inside the Settings layout without covering controls, closes independently on Escape, and supports outside-click dismissal.

### Notes
- TDD captured each released failure before implementation, including packaged-app assertions for transparent root composition, neutral Full Access styling, tour dismissal, tool-summary geometry, help-panel clipping/overlap, and Escape behavior.
- The final local gate passed 2,383 tests across 230 files, both typechecks, lint, all production bundles, the packaged-main smoke test, and Playwright against a locally packaged macOS app.

## 0.8.24 - Codex retries and diffs render like first-class UI

### Fixed
- **Recoverable Codex reconnects filled the transcript with permanent red errors even when the turn ultimately succeeded.** Retry notifications now update one temporary status card in place, disappear when the turn succeeds or stops, and persist only a final failure.
- **Codex file edits rendered as raw JSON instead of the same readable diff cards used by Claude.** File-change hunks now become structured Edit cards, live patch updates refresh the existing card, rename-only changes remain visible, and the aggregate raw turn diff is suppressed instead of appearing as a duplicate.
- **The translucent theme lost contrast against bright wallpaper.** The renderer now applies one charcoal material tint rather than stacking translucent backgrounds across the document, with stable panel, composer, terminal, and border contrast.
- **Tool summaries were double-indented and their disclosure marker, tree rule, icon, and label did not align.** The summary and nested tool rows now share one optical grid with explicit disclosure and button styling.
- **Full Access drew a yellow line across the entire composer.** The warning accent is confined to the runtime-mode selector.

### Notes
- A new Electron Playwright visual test exercises the real renderer with isolated user data, checks the translucent material and tool-summary geometry, and compares a macOS pixel baseline. The backend-host E2E and visual harness both clean temporary data and forcibly terminate Electron if graceful shutdown stalls.
- Review caught evolving Codex patches, rename-only changes, compounded translucent opacity, ineffective screenshot coverage, and E2E process leaks before release. The final gate passed 2,378 tests across 228 files, both typechecks, lint, all production bundles, the packaged-main smoke test, and both Electron E2E flows.

## 0.8.23 - Codex recovers when its native thread disappears

### Fixed
- **A Codex send could fail with `thread not found` and leave the composer stuck on “Working”.** Missing native threads now trigger one safe retry on a fresh Codex thread. Any final start failure rejects normally and restores the session to idle, so registry turn state and the composer cannot remain active forever.

### Notes
- The reported screenshot came from a Switchboard 0.8.20 process that had remained open through the 0.8.22 release. That older adapter sent `turn/start` directly against the prior Claude UUID. Version 0.8.22 already added `thread/resume` with a fresh-thread fallback; this release also makes the turn path self-healing if app-server loses a thread after startup.
- The fix was developed test-first. Review added a regression proving that an unrelated `model not loaded` error is not mistaken for a missing thread, and the deslop pass found no unnecessary casts, defensive branches, or comments to remove.

## 0.8.22 - Codex works on the remote machine too

### Added
- **Remote Codex sessions.** The remote backend now provisions a pinned Codex CLI, keeps authentication isolated per provider profile under `CODEX_HOME`, surfaces a device-auth banner when the VM is not logged in, and supports Codex anywhere a remote Claude session can run. OpenCode remains local-only.
- **Current Codex app-server parity.** Codex now loads its live model catalog, switches models between turns, resumes persisted threads with `thread/resume`, uses current approval and question response shapes, and sends selected skills as typed `$skill` input blocks.
- **GCP IAP as a first-class machine transport.** A saved machine whose SSH alias contains a gcloud IAP `ProxyCommand` is upgraded automatically and connected through `gcloud compute ssh --tunnel-through-iap`. Gcloud owns OS Login identity and key resolution; Switchboard still runs the backend, terminals, and agents as the configured runtime user through `sudo -H`.

### Fixed
- **The production VM failed with `Permission denied (publickey)` even though the shell alias worked.** Switchboard bypassed the alias's gcloud/IAP launcher and called plain `ssh` with a stale user/key tuple. Probe, provisioning, uploads, and the long-lived tunnel now share the resolved transport.
- **Switching providers could reopen a Claude chat with a Codex model, or vice versa.** Provider kind, credential profile, model pin, and native resume id are now changed in one database statement, and the picker rolls back if that write fails.
- **Codex's live models existed behind an adapter method the renderer never called.** The active-session model fetch now covers both Claude and Codex.

### Notes
- Review caught the model-fetch gate and a compatibility regression where older Codex question requests would have received the new keyed-answer response. Both paths have focused regressions.
- The gcloud command was checked against the production alias with `--dry-run`; the release gate covered 2,368 tests plus the main, preload, renderer, remote-server, and packaged-main smoke builds. A live VM connection remains the post-release manual test.
- `v0.8.21` did not publish: Windows CI exposed two path/newline assumptions in source-inspection tests before any packaging job ran. Those tests are platform-neutral in this release.

## 0.8.20 - A Codex checklist is a checklist, not a plan to approve

### Fixed
- **Codex's own todo list rendered as an approval-gated plan.** `update_plan` is the model's progress checklist and arrives repeatedly through a turn, but both handling sites emitted `plan.proposed`, so the UI drew a PROPOSED PLAN card with Implement and Iterate buttons under a list that asks nothing, and redrew it on every update. A genuine Codex plan proposal is the `exit_plan_mode` tool, intercepted separately, so neither site was ever one. Checklists now render as a plain list with per-step state and a done count, replaced in place so updates fold onto one bubble.

### Notes
- Review of this fix caught a regression inside it: the two Codex sites carry the checklist in different shapes, an array of steps and a markdown block, and the first version parsed only the array. The markdown site would have silently rendered nothing. Both shapes are parsed and tested now.
- Neither site had any test before this, which is why the mismapping shipped unnoticed.
- The replace-in-place behaviour lives in `ChatPanel`, which has no component tests, so that part is verified by reading rather than by a test.

## 0.8.19 - A session can now message a sibling on its own

`/send-to` shipped in 0.8.15 as a command you typed, which made it copy-paste
with extra steps: if you are writing the message yourself, you could paste it.
The value is the agent deciding to hand context over, so that is what this adds.

### Added
- **Two tools a Claude session can call itself.** `list_agent_sessions` returns the other open chats (id, title, project, provider, whether each is mid-turn) so the model has real ids instead of invented ones. `send_agent_message` delivers through the same path `/send-to` uses - one delivery function, with a test proving both entry points call it.
- **Guards for unattended sending**, on top of the existing 16 KiB cap, 5-per-pair-per-minute limit and duplicate drop:
  - **Approval** through the existing permission gate: an agent send prompts in sandbox and accept-edits, is denied in plan, and runs unattended only in full access. `list_agent_sessions` is auto-allowed, because putting a card in front of reading titles you can already see trains you to click through the send that follows.
  - **Hop depth 1**: only a turn a human started may originate a send, so A to B to A cannot run away. Depth counts consecutive agent hops since the last human message and is cleared by a user turn, not by the turn ending, so waiting does not reset it. Rate limits alone do not stop this, since two-session ping-pong sits inside every per-pair budget.
  - **6 agent sends per sending session per 10 minutes**, because the per-pair limit alone would allow 25 a minute across five open siblings.
  - Every refusal reaches the model as tool output with its reason, so it adapts instead of retrying.
- Agent-initiated sends read "The agent messaged X" in the sender's transcript, distinct from a send you made.

### Fixed
- **The target picker was unreadable.** It reused the at-mention menu wholesale, so it was headed FILES and listed bare titles: two chats called "Issue 172", two called "v0", nothing to tell them apart. Rows are now `<title> · <project>` under a Chats heading, with a short id suffix when both collide, and picking inserts an id rather than a title.
- **A received peer message showed its own plumbing.** `MessageBubble` only honoured `displayBody` when `pillsMeta` was also set, so the bubble rendered the whole wire body including the "cannot approve or deny anything" paragraph.

### Notes
- Sending is Claude-only: Codex and OpenCode have no tool seam, though both remain valid targets and receive peer messages as ordinary turns. `ProviderAdapter.setPeerToolHost` is the seam for adding them.
- The approval path for `send_agent_message` was verified by reading the SDK's control-request handling, not against a live session. If an agent send ever runs in sandbox with no card, check that first.
- The mobile app still does not render `peer.message`, so an agent send is invisible on the phone until reload.

## 0.8.18 - /send-to tells you who you can send to

### Fixed
- **`/send-to` was unusable without knowing a chat's exact title.** Typing `/send-to ` now lists the open chats and arrow keys plus Enter commit one with its colon, reusing the at-mention menu's keyboard model. Nothing showed the titles before, so the command asked for something the user had no way to recall.
- **Its failure message blamed the name.** With only one chat open, any target answered `No open session matches "..."`, which reads like a typo when the real problem is that there is no second chat. Empty-candidate cases now say what to do: open another chat, or that the others run on a different backend.
- **The delivery handler was silent.** It logged nothing on success or refusal, so a failed attempt left no trace to diagnose. Both paths log now.

## 0.8.17 - A slow update check was reported as a failed one

### Fixed
- **"Couldn't check: Update check timed out" on a healthy connection.** The check was not failing, it was finishing late: on a network whose connect to `release-assets.githubusercontent.com` stalls (measured 30s to 45s, on BOTH address families, so it is a middlebox rather than the usual IPv6 fallback), a successful check completes at ~77s. The 30s deadline turned that into a red error, and the retry it invited inherited the same in-flight request through electron-updater's dedupe. The deadline is now a 120s backstop against a check that never returns, and a slow one reports itself as still running.
- **The status row contradicted itself.** A timed-out check rendered as `Couldn't check: Still checking...` in the error colour. Slow checks now have their own status: message verbatim, ordinary colour, check button kept busy while the request is in flight.

### Changed
- The update toast is frosted glass: translucent fill over a 22px backdrop blur with `saturate(180%)`, a hairline lit top edge, softer corners and a deeper shadow.

## 0.8.16 - Five bugs the phone found

### Fixed
- **The first message you sent from the phone rendered twice.** `NewSessionScreen` appended the optimistic bubble with no id and called `sendTurn` with no `origin`, so the backend's `user.message` echo could not collapse onto it. It was also the only send in the app bypassing the outbox, contradicting that module's own docblock. All three send sites now build their turn through one helper, so origin and bubble id cannot be minted apart. Two adjacent bugs fell out: `implementPlan` appended its bubble twice unconditionally, and a history seed landing mid-send wiped the in-flight bubble and let the echo put a fresh one back.
- **The keyboard covered the composer while typing the first message.** The screen in question had no keyboard avoidance at all, and the rest of the app had three different policies. There is now one tested policy across four screens. The Android half was wrong wherever it existed: `keyboardVerticalOffset={headerHeight}` double-counts a header the measured frame already excludes, and `behavior: undefined` waits for a window resize that unconditional edge-to-edge never performs. `SafeAreaProvider` was a dependency that was never imported, so the composer now pads for the gesture bar instead of a hardcoded 12dp.
- **A chat started on the phone looked idle on the desktop while it streamed.** The backend does broadcast every event to every client, but the desktop's reducers are `sessions.map(...)` over a list with no row for a thread that window did not start, so the events were dropped silently. `provider:list-sessions` plus adoption on boot. Re-attaching to a live session also reported a hardcoded `idle` regardless of a turn in flight.

### Added
- **Google sign-in for work VMs no longer needs the repo.** The sign-in screen told users to run `node scripts/google-mint-token.mjs`, which needs a checkout plus a `personal`-configured gcloud with Secret Manager access - almost nobody running a released build has either. Minting moved into the desktop app under Settings > Mobile: it runs consent in a browser and renders the credential blob as a QR. The blob shape is single-sourced in `shared/`, so the desktop writer and the phone parser cannot drift.
- **Sessions inherit the machine's defaults.** `START_SESSION` fell straight from the request to a hardcoded `'sandbox'`, never reading the conversation row or any setting, so a chat opened from the phone ignored however the desktop was configured. Three tiers now, resolved per field: request, then the conversation's stored value, then the machine default.

### Security
- **A paired phone could raise the machine-wide permission default.** Routing session defaults through the settings table made `chat.defaultRuntimeMode` permission-bearing, while `settings:set` is deliberately ungated so the phone can write `projectOrder`. A stolen phone credential could have written `full-access` and then opened any chat. Writes to permission-bearing keys are now gated per key, enforced beside the channel check.
- The loopback mint server sets an explicit content type and never reflects the query string, so a sniffed body cannot execute on a loopback origin that can reach code-server (`--auth none`). State is compared before the error branch, so a forged `?error=` from any open tab cannot abort a sign-in in flight. Keep-alive sockets are closed and a second attempt cancels the first, rather than the port staying bound and the retry blaming a foreign process.

### Notes
- The default model setting moved from one global key to `chat.defaultModel.<agentType>`. A model id almost never means anything to another provider, and nothing clears a stored model on an agent switch, so a single key would have pinned a Codex model onto a later Claude session. Any value under the old key is ignored rather than migrated; it self-heals the next time a model is picked.
- Sub-agent messages now reach the desktop live, but reloading an old thread still will not show them: they exist only in the event stream and the history reader has no format to recover them from. No transcript on this machine contains a `Task` call or `isSidechain: true`, so the backfill was left unbuilt rather than guessed at.
- The keyboard fix is unit-tested at the policy level only. Layout was not verified on a device before release.

## 0.8.15 - Sessions can message each other

### Added
- **`/send-to <session>: <message>`.** Hand context from one chat to another without re-explaining it. The target is fuzzy-matched against open sessions, the receiving agent picks the message up as a turn, and both transcripts record the delivery. Guards: 16 KiB body cap, 5 sends per pair per minute, identical message dropped within 10 minutes, and a session cannot message itself. Delivery goes through the ordinary turn path, so a peer message cannot answer a pending approval prompt - it is not a policy, it is the absence of a code path.

### Notes
- Phase 1 is user-directed and same-backend. An agent cannot message a sibling on its own initiative, and a session on another machine is excluded from matching rather than resolving and then failing.
- Review caught six real defects before release, all fixed and covered: a rotated live chat reported as "not running" because the adapter map is keyed by the id the session started under; an OpenCode target mid-turn silently dropping the message while both transcripts claimed delivery; a failed send spending its rate-limit slot so the retry was refused as a duplicate; the peer turn skipping checkpoint bookkeeping so its edits produced no diff cards; the provenance label being live-only so a reload showed the raw wrapper; and `/send-to` silently discarding attached images.
- Also fixed pre-release: the backend persisted both sides of a delivery but no renderer consumed the events, so messages appeared only after a reload. Same failure shape as the twin-session bug in 0.8.13.

## 0.8.14 - Context survives a provider switch; dictation learns your codebase

### Added
- **Cross-provider context handoff.** Switching agent mid-chat (or forking a Codex/OpenCode conversation) used to start the new adapter with zero context. The next send now prefixes the wire message with a capped transcript replay ("Conversation so far: ..."), exactly once, marked by a `[[sb:context-handoff]]` pill. Your bubble shows only your own text (displayBody convention). The pending flag survives session-id rotation (`resolveRootThreadId`) and is cleared before the send fires, so no retry or reload can double-inject. Pattern borrowed from Databricks' omnigent project.
- **Backend-corrected voice notes.** The phone keeps native STT as the instant draft, persists the raw 16 kHz WAV while recognizing, and ships it to the backend over the existing transport. The backend downloads whisper-server plus a ggml model to userData on first use (same lifecycle as code-server), spawns it on loopback, and biases transcription with an initial prompt built from the project's file list - which is exactly where native STT failed (file paths, identifiers). The draft is replaced only when untouched since recording stopped. JS-only on mobile: ships over the OTA lane. macOS backends without a prebuilt server binary fall back to PATH (`brew install whisper-cpp`).

### Fixed
- **Composer footer overflowed on a narrow pane.** The provider/model/branch/mode row now measures itself, wraps, drops the decorative hint below 560px, shortens the runtime-mode labels, and never squeezes the context meter under the pane edge.
- **Updates section blasted every OS's first-run instructions at everyone.** Now one line plus a platform-specific tooltip (Gatekeeper/xattr on macOS, SmartScreen on Windows, nothing on Linux).

### Notes
- First transcription on a fresh backend downloads a 574 MB model, so it times out client-side by design and later dictations succeed; there is no pre-warm UI yet.
- A phone-originated first turn after a provider switch sends without the handoff preamble (no backend injection seam yet).

## 0.8.13 - A live reply rendered into a session with no sidebar entry

A chat can answer to two ids: the synthetic `agent_<ts>` thread it starts
under, and the session UUID Claude assigns after its first turn. The sidebar
lists only the second. Selecting it built a *second* store session, so every
token of the running turn streamed into a session nothing on screen showed.
The reply looked like it was never sent. It was in the transcript the whole
time, and only reappeared after a restart.

### Fixed
- **Replies could vanish from a running chat.** `handleSessionSelect` matched sidebar clicks to store sessions by exact id, so clicking a chat under its rotated UUID created a twin holding a snapshot instead of attaching to the live thread. `load-session-by-id` now returns `rootThreadId` and the renderer resolves through it (`resolveSessionSelectTarget`). The same twin was reachable from search hits; `SearchModal` resolves too.
- **Live assistant text never reached SQLite.** It existed only in the provider's own transcript, which Claude Code prunes and rotates, so a lost reply had no second home. The provider registry now folds `content` deltas per turn and mirrors them on `turn.completed`, and on a mid-turn stop where no `turn.completed` is coming. It lives in the registry, not `ChatPanel`, so a phone on a headless server with no window attached is covered.
- **Archiving a rotated chat left it listed.** `archiveConversation`/`unarchiveConversation` wrote one row, so the chat stayed visible under its other id. Both now cover every id of the thread via a new `threadFamilyIds` helper.
- **Unread badges could not be cleared.** `setConversationLastRead` stamped one row for the same reason; it now stamps the whole family. Its getter and `isConversationArchived` resolve through `resolveRootThreadId`.
- **Update downloads paid for a differential attempt that never worked.** On 2026-08-07 it spent ~12s on range requests, failed a sha512 checksum, then full-downloaded anyway. `disableDifferentialDownload` is on.

### Notes
- The rule from 0.8.11 needed a second half. Per-conversation *reads* resolve to the root; per-conversation *writes* must cover every id, because a rotated chat owns one `conversations` row per id. `threadFamilyIds` is the write-side counterpart to `resolveRootThreadId`.
- A slow "Check for updates" is a stalled GitHub request, not app code: healthy checks take ~2s, three observed stalls each ran ~77s, which is a TCP connect black-holing until the OS gives up. Manual checks now log their duration so this is measurable rather than guessed at.
- Not done: the twin rows already in the database are left alone. The fix stops new ones and routes around existing ones.

## 0.8.12 - One stalled request wedged the updater until restart

### Fixed
- **"Check for updates" could stick on "Checking..." forever.** `autoUpdater.checkForUpdates()` runs an HTTP request with no deadline, and electron-updater dedups concurrent checks by returning the same cached in-flight promise - so one stalled request (seen 2026-08-07: a check that never resolved, then "already in progress" on every retry click) pinned the Settings row until app restart. All three check call sites (manual button, launch-time, stale-download retry) are now bounded by a 30s timeout; a timeout surfaces as an error naming the restart escape hatch instead of silence. Healthy checks resolve in ~2s.
- **A hung launch-time check also left the row stuck** - its failure path only logged. It now broadcasts the error status too.

### Notes
- `withTimeout` was extracted to `src/shared/promise-timeout.ts` from codex-adapter's private copy (verbatim), which now imports it - one implementation, not two.
- The timeout unsticks the UI but cannot cancel electron-updater's cached in-flight request; a genuinely hung request stays hung until restart, which is why the error message names restarting. A late-resolving check firing its events afterwards is harmless - it overwrites the error with a correct, current status.

## 0.8.11 - A setting saved under one id, read back under another

Two per-conversation settings - provider instance and runtime mode - reset to
their defaults the first time a chat was reopened after Claude assigned it a
session id. A third, the pinned model, had no persistence at all and reset
every time, not just some of the time.

### Fixed
- **Provider instance and runtime mode reset to default after a chat's first turn.** Claude assigns a chat its own session UUID once it produces a turn, and the sidebar then surfaces that UUID as the chat's id instead of the synthetic `agent_<ts>` id it was created under. `getConversationProviderInstanceId`/`getConversationRuntimeMode` queried `conversations WHERE id = ?` with that UUID directly, found no row, and fell back to the default - even though `thread_sessions` already mapped the rotated id back to the original for title/worktree inheritance. Both getters and setters now resolve through the existing `resolveRootThreadId` first.
- **The model picker's pin was never persisted at all.** Unlike runtime mode and provider instance, the chosen model lived only on the in-memory session object, so it reset on every sidebar or kanban reopen after a chat's first turn. Added a `conversations.model` column and a matching getter/setter (with the `resolveRootThreadId` fix built in from the start), wired into the chat header's model picker and restored on reopen from both the sidebar and kanban card launch.

### Notes
- Review caught the sidebar restore losing its per-field failure isolation when the three reads (runtime mode, provider instance, model) were parallelized with `Promise.allSettled`: a bare call that throws synchronously is no longer caught by its own try/catch, so it would throw while the array was still being built, before `Promise.allSettled` exists to catch anything, taking the rest of session-open down with it. Each read is now wrapped in its own async IIFE.
- Review also caught the kanban "reuse existing session" path doing its two reads (runtime mode, model) sequentially right after the sidebar path was parallelized for that exact reason. Parallelized there too.
- Deferred: runtime mode, provider instance, and now model are three near-identical column + getter + setter pairs, each one a place to forget `resolveRootThreadId` again. A generic per-conversation key-value table would remove that risk structurally, but it is a schema migration touching two existing columns and out of scope for this fix.

## 0.8.10 - The backend writes history now, not the window

Every `saveMessage` call site was in `src/renderer`. `apps/mobile/src` had none, and neither did the registry. So the durable record of a conversation existed only if a desktop window happened to be attached.

### Fixed
- **A turn sent from the phone persisted nothing.** Two of three `mob-*` chats here have zero rows in `messages`, one of them against a 189-line transcript. That turn could never be found by `⌘⇧F`, and if Claude pruned the JSONL the DB-recovery fallback rendered the chat empty. `SEND_TURN` persists the user's turn now, whichever client sent it.
- **A phone-driven chat never rose in the phone's own list.** `updated_at` is only touched by `saveMessage`, and the phone sorts on it, so an hour of phone work left the thread buried. Persisting the turn moves it.
- **An error card survived a reload only on the desktop.** `ChatPanel` was the sole writer, so a headless `npm run server` driving a paired phone showed a 529 once and lost it - the JSONL parser deliberately drops API-error records. `publish()` persists error events now, and the renderer's duplicate write is gone.

### Notes
- **Review caught this destroying pill metadata on every desktop send.** The first cut used `saveMessage`, which is `INSERT OR REPLACE` and therefore whole-row. `ChatPanel` writes its copy BEFORE calling `sendTurn` and the registry writes after, so the backend row landed second and nulled `display_body` and `pills_meta` - a chat message with file chips would have reloaded as its expanded body, up to the 50k-char cap. There is a `saveMessageIfAbsent` now: fill-only, so the renderer's richer row always wins and the backend is a backstop.
- That also removed a second defect the reviewer found: `INSERT OR REPLACE` does not fire the FTS delete trigger (`recursive_triggers` is off), so each desktop turn left an orphaned index row. Searches stayed correct because the rowid join drops orphans, but the `ftsCount < msgCount` self-heal could never fire again, and a later deletion reusing that rowid would fail a constraint and silently lose the message.
- The phone's opening message sends no `origin`, so an `if (origin)` guard skipped exactly the first turn of every phone-created chat. Ids fall back to a minted one.
- The registry test's DB mock had no `saveMessage`, so a missing write showed up only as a `log.warn` and the suite passed. The mock records writes now and two tests assert them.

## 0.8.9 - The phone and the Mac were reading different lists

The phone did not have a sync bug so much as its own idea of which chats exist. Event fan-out was always correct: one `ProviderRegistry`, one bus behind a `MultiHost`, and `WsHost.emit` broadcasting to every authed socket. What diverged was identity.

### Fixed
- **The phone listed chats the Mac had archived.** `GET_CONVERSATIONS` was a raw `SELECT * FROM conversations WHERE project_path = ?` - no archive filter, no rotation dedupe. `grep -rn archived apps/mobile/src` returns nothing; the phone has no concept of archiving. On this install it listed 169 chats for one project where the desktop showed 32, 120 of them archived. Its own project screen used the filtered count, so it printed "32 sessions" and then listed 169.
- **The two clients addressed the same chat by different ids, which is why messages did not appear.** A chat routinely exists as two rows: an `agent_<ms>` row and a Claude UUID row sharing one `session_id` (83 such pairs live here). The desktop list picks the UUID and suppresses the twin; the phone showed both. Runtime events are keyed on `threadId` and `appendMessage` drops anything whose id does not match the open session, so a phone driving `agent_1785917479430` while the Mac had `a3717923-…` open had every `content` and `user.message` event discarded. Not a missing broadcast - a mismatched key. The phone's list is now built from the same `visibleSessionsForProject` the sidebar renders, so the id it opens is the id the desktop uses.
- **A chat archived on the Mac could still be listed on the phone.** Archiving flags only one of the twin rows: "Add skills" was `agent_1781436825014` (archived=0) beside `146a4711-…` (archived=1). Both are hidden now, on both clients.
- **The phone ran worktree-backed chats in the parent repo.** It sent `cwd: projectPath` where the desktop sends `worktreePath ?? projectPath`, and whichever client starts first fixes the cwd for both - so a phone-first open had the agent editing the wrong tree. 33 unarchived conversations here carry a worktree. Fixed for both the initial start and profile rotation, which stops the session first and so could not rely on the registry's idempotent re-attach.
- **A phone-driven chat never rose in its own list.** The phone sorts on `updated_at`, which only the desktop renderer's `saveMessage` ever moved. It now comes from the session's real last activity.
- **Renaming from the phone could report success and change nothing.** A scanned transcript need not have a `conversations` row (6 of 28 in this project), and `updateConversationTitle` updated zero rows. The phone ensures the row first, as the sidebar does.

### Notes
- **Review caught the first attempt deleting 98 chats from the phone.** It filtered conversation rows by the visible-id set, which compares two different id spaces: a desktop Claude chat is a row keyed `agent_<ms>` whose visible id is the transcript UUID, so the intersection is empty. Simulated over the live DB: 174 unarchived rows dropped, 98 reachable under no other id, including a chat with a 6.6 MB transcript. The list has to be built FROM the summaries, which is also what makes the ids line up.
- Per-thread state the phone remembers (model, mode, draft) is keyed on the thread id, so for a twin chat it resets once.
- Not addressed: the phone has no equivalent of the desktop's orphaned-worktree healing, so if a worktree directory is deleted the phone reports the failed start rather than falling back to the clone. 11 unarchived rows point at a missing directory today, though none of them currently survive the visible-session filter.
- Still open, and the reason phone-driven history is thin: nothing but the desktop renderer writes to `messages`. Two of three `mob-*` chats here have zero rows, so `⌘⇧F` cannot find a phone turn.

## 0.8.8 - A 529 looked exactly like nothing happening

### Fixed
- **API errors other than rate limits were dropped in silence.** The CLI writes an API error as a synthetic assistant message, and the live handler discarded any assistant message carrying `error` (`claude-adapter.ts`, 2026-07-10). The rationale was that `rate_limit_event` already emits a card, so rendering both duplicates it - true for a rate limit, false for everything else. Live capture: "yo" ran 3.4 minutes, the CLI wrote `API Error: 529 Overloaded`, and the user got a spinner, no reply and no error. `load-by-id` reported 1 message for a thread that had 2. That machine logged 6 rate limits and 4 overloads the same day. Non-rate-limit API errors now surface with the CLI's own text.
- **Sidechain API errors stay out of the main chat.** A subagent's transient 529 is not the parent turn's failure and the parent usually recovers from it, so a message with `parent_tool_use_id` is not surfaced.

### Notes
- **Review caught the first fix double-reporting 85% of API errors.** It gated on a per-turn "did we already emit a rate-limit card" flag. The synthetic message arrives BEFORE the matching `rate_limit_event` - measured across 12 production log/transcript pairs, 1 to 78 ms - so the flag reads false every time. Of 948 API-error records in 1496 local transcripts, 807 are `rate_limit`, so almost every one would have produced two cards that disagreed about the cause ("hit your org's monthly spend limit" beside "rate limit reached (five-hour window)"). The dedupe is keyed on the error code instead, which is order-independent, and the flag is gone.
- Not fixed, and it needs backend-side persistence rather than a patch here: on reload the message survives only because `ChatPanel` persists `error` events to sqlite, and `ChatPanel` is the only writer in the codebase. A headless `npm run server` driving a paired phone shows the red line once and loses it on reopen, because `jsonl-parser.ts` still drops `isApiErrorMessage` records. Same root cause as the desktop/mobile history divergence: nothing but the desktop renderer writes to `messages`.
- The Codex and OpenCode adapters have no equivalent surfacing path.

## 0.8.7 - Changing the model did nothing until you switched profile

### Fixed
- **The model picker never reached a live Claude session.** `ProviderAdapter.setModel` is optional and the Claude adapter never implemented it, so `provider-registry`'s `if (adapter.setModel)` was always false. The picker updated the UI and nothing else. Live capture: a turn was rejected on Fable (org spend block), the user picked Opus and resent, and the log shows the retry still running as `model=claude-fable-5`. Only switching provider profile fixed it, because that is a `stopSession` + `startSession` and the new session re-reads the model. The adapter now implements `setModel`: it records the model for the next query and applies it to the running one.
- **A rejection right after a model switch blamed the wrong model.** `lastKnownModel` was only written by the post-turn context poll, so the rate-limit message and the `spend.blocked` guard both named the model the user had just moved away from - and the composer then warned about the wrong one. `setModel` retargets it.
- **The phone could silently retarget the desktop's model.** `ThreadScreen` pushes its remembered per-thread model on OPEN. That was inert for Claude while `setModel` did nothing; with it implemented, opening a thread on the phone would change the model of a session the desktop is driving, mid-conversation. The restore is now local to the phone's picker, and the live model still arrives on `context_window`.

### Notes
- **A wrong diagnosis got as far as a written fix, and review killed it.** The first read of the capture was "the drain loop parks after a rejection, so later sends queue into a void", based on the resend having no `starting query` line after it. That line is only logged for the FIRST query of a session - streaming-input mode reuses one query for every later turn - so its absence proves nothing. The raw log shows the resend WAS processed, on Fable. The discarded fix retired the query on every rejection, which would have killed the CLI's own retry (three rejections 1.2s apart inside one query appear in an earlier log), orphaned a subprocess per retire, and let a retired loop clobber its successor's state.
- Not addressed: an `import()` failure in `startDraining` still leaves `draining` true forever with no `finally` to clear it. Pre-existing.

## 0.8.6 - Every reader that guessed where a transcript lives

An audit of one bug's family. A transcript's path is a function of `(profile, cwd)` at WRITE time - `<CLAUDE_CONFIG_DIR>/projects/<encode(cwd)>/<id>.jsonl` - and every reader was reconstructing it from `(~/.claude, project_path)` at READ time. Both halves drift: the profile changes when you switch instance, the cwd changes when a chat enters a worktree. 0.8.2 fixed resume. These are the rest.

### Fixed
- **Re-entering a chat replaced live history with a frozen snapshot.** `LOAD_SESSION_BY_ID` scanned every profile but only the `encode(project_path)` directory, so a chat running in a worktree loaded whatever stale copy sat under the project dir. Measured on a real thread: it returned the same 540 messages for 17 hours while the live transcript grew past 1599 lines, and every reload overwrote the in-memory history with it. Every log line said `across 1 fragment(s)`, which was the tell. Now unions every copy under every project dir of every profile, then dedupes by uuid as before. On the affected chat the handler went from reading 5.19 MB to 13.64 MB.
- **Fork could not find 98% of transcripts.** `fork.ts` hardcoded `homedir()/.claude` in three places. That is not even the default profile's directory here - `claude-code-default` resolves to `~/.claude-tech-team` - so it missed 355 of 361 locatable transcripts. It then fell back to the sqlite mirror, which holds only the handful of messages Switchboard streamed itself, and the range guard threw `upToIndex out of range` into the UI. Forking "29 Jul Bugfixes" past message 12 of its 401 was impossible. Fragments now resolve by session id across all profiles and project dirs, newest copy wins. On this database, forkable conversations go from **6 to 327**.
- **Fork wrote to the wrong profile.** The truncated JSONL landed in `~/.claude` while the new session ran under the resolved default instance. It only worked because 0.8.2's per-query pre-flight found it there and re-filed it. Now written where the new session will read it.
- **"Fork to worktree" from a worktree chat branched off the wrong ref.** It passed `project_path` as the repo root, so the fork started at the repo's HEAD instead of the branch you were looking at.
- **Worktree chats sorted to the bottom of the sidebar.** They can only render through `synthesizeDbOnlySessions`, which stamped `startedAt` from `created_at`. One real row was 2 days 5 hours behind its transcript. `sessionActivity.ts` already documented this field as last-activity from `updated_at`; the synthesizer was the one place that disagreed. `SCAN_SESSIONS` also concatenated db-only rows instead of sorting, the exact bug `GET_PROJECTS` carries a comment about having fixed.
- **Exporting a worktree chat wrote an empty file.** The export path keys off `filePath`, which db-only rows leave as `''`, so it serialized zero messages with the transcript sitting on disk. Falls back to `loadSessionById`.

### Notes
- `claudeCandidateDirs` moved from `ipc/app` to `claude-session-migrate` so fork can use it without an import cycle.
- Widening by session id, not by directory name, is what keeps this safe. A prefix or substring rule would reinstate the parent/child bleed fixed in 2026-04: `encode('~/Desktop/projects')` is a prefix of both `-Users-tejas-Desktop-projects-switchboard` and its worktree dirs, and this install has 25 child projects registered under one parent. Session ids already belong to a known conversation row, so they cannot bleed.
- Fork's orchestration layer had zero tests, which is why none of this was caught. `listClaudeFragmentPaths` is exported and covered now.
- **Latent, left alone:** OpenCode writes session summaries under `encode(session.cwd)` and scans under `encode(project_path)` - the same asymmetry, but `~/.opencode` does not exist and there are 0 OpenCode conversations. Codex matches rollouts by cwd substring, which survives an in-repo worktree but not one in `/tmp`; no Codex rollout references a worktree today. `findCodexRollout` hardcodes `~/.codex/sessions` and breaks the moment a second Codex profile exists.
- **Sqlite is not the backup it looks like.** For the chat above: 46 rows in `messages`, ~800 real. The DB fallback only fires when JSONL yields zero.

## 0.8.5 - A git process per frame

### Fixed
- **BranchPicker spawned `git` on every render while a turn streamed.** Its refresh effect depended on the `onCwdMissing` callback, which depended on a `{ path, branch }` object rebuilt on every agent-store commit. Streaming commits at up to 30fps, so the effect re-ran that often, each pass spawning `git rev-parse` and re-registering the HEAD watcher. The memo returns strings now, so the callback is stable while the worktree is.
- **"Worktree X no longer exists" appeared twice.** `refresh()` calls `onCwdMissing` after an await, so both of StrictMode's mount-effect invocations were in flight before either healed. `appendMessage` already dedupes by id and its comment names this exact class of duplicate; only `wt_orphan_${Date.now()}` defeated it. The id is derived from the worktree path now, which also covers the same session shown in two panes.

### Notes
- A first attempt used a per-mount ref to count invocations. Review killed it: `ChatPanel` has no key, so ChatInput is not remounted when you switch chats, and a path-keyed ref would then have skipped the store write for a second session pointing at the same deleted worktree. Making the operation idempotent, which is what the other StrictMode call sites here do, has no such edge.
- The duplicate was visual only. That path appends to the store without calling `saveMessage`, so a reload never showed it twice.

## 0.8.4 - A chat could exist in the database and render nowhere

### Fixed
- **A chat started on the phone was in SQLite, unarchived, and in neither list the sidebar renders.** Its transcript was written under a non-default Claude profile dir, and `claudeCandidateDirs()` scans every profile - so the scanner found it, `thread_sessions` had it as a rotation child, and `childSet` dropped the scanned entry. `synthesizeDbOnlySessions` was then handed every scanned id and dropped the database row as a duplicate of the entry that had just been dropped. Both halves cancelled and the chat vanished. The two reasons a transcript can be hidden are now distinguished: hidden as a rotation child keeps the row, hidden by archiving suppresses it.
- The same defect existed a second time in `SCAN_SESSIONS`.

### Changed
- The Settings > Mobile command now sets `TCP_PORT=8766` as well. Without it the ndjson listener never starts and an IAP-tunnelled phone silently never connects. The hint alongside it says which machine the command is for, that it runs in the foreground, and that the server prints its own pairing QR.

## 0.8.3 - A chat started on the phone showed up on the desktop

### Fixed
- **A conversation created on the mobile app was invisible on the desktop until the window was reloaded.** The sidebar learned about new chats from `onSessionCreated`, a renderer-local bus fired by the desktop's own ChatPanel, so nothing told a running window that another client had written to the database. The backend now emits `app:conversations-changed` on create and rename, and the sidebar refetches on it.
- **A new chat appeared at the bottom of its project.** `GET_PROJECTS` returned `[...scanned, ...dbOnly]`, and a chat with no transcript yet is db-only, so it sorted below sessions from months ago. The merged list is sorted newest-first.
- **A sidebar refresh undid a project drag.** `projectOrder` was applied only in the mount effect, so any later refetch reinstated the database's `added_at` order - and the next drag persisted that reset order.
- **Most broadcasts described nothing.** `createConversation` is `INSERT OR IGNORE` and runs on every chat open; it now reports whether it inserted, and a rename reports whether the title actually changed. Without this, each no-op write cost a full-workspace filesystem rescan.

## 0.8.2 - Resume blamed the profile when the directory had moved

### Fixed
- **A chat that changed directory lost its Claude context, and the error blamed the wrong thing.** The SDK resumes from exactly `<CLAUDE_CONFIG_DIR>/projects/<encode(cwd)>/<sessionId>.jsonl`, so the cwd keys that path as much as the profile does. Only the profile half was handled. Live capture: a 214-message chat resumed with cwd set to a worktree while its transcript stayed filed under the repo, under the correct profile, and was told "This conversation was started under a different profile - switch back". There was nothing to switch back to.
- **The pre-flight check could not see the case it existed for.** `claudeSessionExistsIn` scans every project subdirectory, so it answered "already present" for a transcript filed under any cwd and skipped the copy. Existence and resumability are separate functions now, and only the exact-path one gates the copy.
- **Rotating profiles A to B and back resumed a transcript frozen at the first switch.** The copy is one-directional, so B's file kept growing while A's did not. Placement ranks by mtime, takes the newest, and never overwrites a newer destination.
- **Directory order picked the wrong copy.** A repo's encoded name is a prefix of its worktrees', so `readdirSync` returned the pre-worktree copy first. On real data that re-filed a 1-turn transcript over a 21-turn conversation.
- **A failed copy claimed nothing was found, and cost the conversation.** A destination-side `io-error` (TCC denial, no space) fell through a per-candidate retry loop that discarded it and reported `source-missing`. One copy attempt now, and its error surfaces. The resume id is dropped only when the transcript is genuinely gone: on a transient fault it is kept, because clearing it is permanent - the SDK's replacement UUID gets recorded and becomes the resume target from then on.
- **The failure message says where the transcript is:** at the resume path, in this profile under another cwd, in a named other profile, or nowhere known. Only one of those mentions profiles.

### Notes
- Placement moved from `startSession` to `runQuery`. Resume is a per-query argument, and `ChatPanel` guards `startSession` behind `providerStartedRef`, so the resend the message asks for never re-ran the old check. In practice the drain loop spans the session, so this fires at session start and after each query terminates rather than on every send.
- Two bugs found by writing the tests: `readdirSync` on an unreadable profile dir threw out of the scan, and `statSync`'s `throwIfNoEntry` covers ENOENT but not EACCES. Either would have killed the turn with a raw errno instead of the notice.
- The `<sessionId>/` sidecar (`subagents/`, `tool-results/`) is still not copied and does not need to be: tool results are referenced by absolute path with an inline preview, and sources are copied rather than moved, so those paths keep resolving. Deleting a profile would degrade an oversized result to its preview.
- Not addressed: the "other profile" message names the directory (`.claude-tejas`), not the Settings display name. Two profiles at `~/work/.claude` and `~/personal/.claude` both render as `.claude`.

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

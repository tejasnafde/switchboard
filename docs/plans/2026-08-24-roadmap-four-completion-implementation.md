# Roadmap Four Completion Implementation Plan

## 1. Cursor format model and project discovery

Files:

- Add `src/main/cursor/types.ts`.
- Add `src/main/cursor/workspace.ts`.
- Add `tests/unit/cursor-workspace.test.ts`.

Steps:

1. Write failing tests for decoding file URIs, exact folder matching, and
   multi-root `.code-workspace` membership.
2. Implement normalized workspace matching without reading outside the Cursor
   storage root or the referenced workspace file.
3. Cover missing, malformed, percent-encoded, and case-normalized platform
   paths.

## 2. Cursor storage adapters

Files:

- Add `src/main/cursor/legacy-store.ts`.
- Add `src/main/cursor/global-store.ts`.
- Add `src/main/cursor/normalize.ts`.
- Add `tests/unit/cursor-legacy-store.test.ts`.
- Add `tests/unit/cursor-global-store.test.ts`.
- Add `tests/unit/cursor-normalize.test.ts`.

Steps:

1. Seed temporary SQLite fixtures and write failing tests for the legacy
   `composer.composerData` layout.
2. Implement read-only legacy candidate and message reads.
3. Seed current `composerHeaders`, `composerData:*`, and `bubbleId:*` fixtures;
   write failing tests for ordered user/assistant normalization.
4. Implement the current global adapter with parameterized statements and
   bounded record sizes.
5. Add deterministic IDs, empty/unsupported bubble filtering, timestamp
   fallbacks, archived/draft handling, and malformed-record isolation.

## 3. Scanner and import contract

Files:

- Add `src/main/cursor/index.ts`.
- Update `src/main/projects/session-scanner.ts`.
- Update `src/shared/types.ts`.
- Update `src/shared/ipc-channels.ts` only if an additive channel is required.
- Update `src/preload/index.ts`.
- Update `src/main/ipc/app.ts`.
- Add or update scanner/import tests.

Steps:

1. Write a failing aggregate scan test showing Cursor candidates alongside
   Claude, Codex, and OpenCode without one source blocking another.
2. Extend the import source union to `cursor` and resolve the selected candidate
   by both source and ID.
3. Keep provider transcript caching separate from Cursor SQLite snapshots.
4. Return precise unavailable/unsupported errors without leaking message text or
   local database contents to logs.

## 4. Stored provenance and idempotent snapshot

Files:

- Update `src/main/db/database.ts`.
- Update `src/main/ipc/terminal-sessions.ts`.
- Update conversation projection tests.
- Add `tests/unit/cursor-import.test.ts`.

Steps:

1. Write failing migration/projection tests for nullable `origin_source`.
2. Add the column migration and typed row field.
3. Add one transaction that creates/revives a managed conversation, replaces
   the uncontinued Cursor snapshot idempotently, saves messages, schedules the
   initial context handoff, and updates FTS through existing triggers.
4. Refuse destructive snapshot replacement once a native provider segment has
   been recorded; return the existing managed root instead.
5. Project Cursor as sidebar source while retaining Claude Code as runnable
   `agentType`.

## 5. Desktop, iOS, and Android presentation

Files:

- Update `src/renderer/components/sidebar/NativeSessionImportModal.tsx`.
- Update `src/renderer/components/sidebar/Sidebar.tsx`.
- Update `src/renderer/App.tsx` and session-open helpers as needed.
- Update `src/shared/handoff.ts` and rotation-marker presentation as needed.
- Update `apps/mobile` conversation/source presentation.
- Update `apps/android` conversation/source presentation.
- Add focused renderer, mobile, and Android tests.

Steps:

1. Write failing desktop markup/filter tests for a Cursor provider badge and
   import action.
2. Render Cursor provenance consistently without treating Cursor as a provider
   adapter.
3. Ensure the first send starts cold and injects the bounded handoff exactly
   once; ensure later provider segments resume normally.
4. Add additive source parsing/presentation to both mobile clients and verify
   older/missing fields keep their existing behavior.

## 6. Signing readiness

Files:

- Add `scripts/signing-mode.mjs`.
- Add `tests/unit/signing-mode.test.ts`.
- Update `electron-builder.yml`.
- Add macOS entitlements under `build/` or `resources/`.
- Update `.github/workflows/release.yml`.
- Update `build/afterPack.js` if signed/unsigned branching requires it.
- Update `docs/releasing.md`.

Steps:

1. Write failing pure tests for absent, complete, and partial Apple and Windows
   credential sets.
2. Implement a secret-name-only classifier; never print credential values.
3. Enable hardened runtime and production signing when credentials are
   complete, preserve ad-hoc unsigned packaging when absent, and fail before
   packaging when partial.
4. Verify TeamIdentifier/notarization or Authenticode status in the platform job
   before upload.
5. Document exact required secret names and retain the unsigned warning path.

## 7. Close completed roadmap items and parity records

Files:

- Update `docs/plan.md`.
- Update `docs/notes/roadmap-deferred.md`.
- Add `docs/feature-parity/cursor-import.json`.
- Add `docs/feature-parity/conditional-release-signing.json`.
- Update affected existing parity records only where their behavior changed.

Steps:

1. Record focused launch-config hot-reload/`wait_for` regression evidence.
2. Record transcript compatibility/profile-switch regression evidence.
3. Mark those stale roadmap entries shipped with links to their implementations
   and tests.
4. Cover Desktop, React Native/iOS, native Android, shared contract, storage,
   and rollout in both new parity manifests.

## 8. Verification and adversarial review

1. Run every new test in red state before its implementation.
2. Run targeted suites after each green step.
3. Run `npm run typecheck` and `npm test`.
4. Run mobile typecheck/tests and native Android unit tests.
5. Run `npm run validate:feature-parity -- --base origin/main`.
6. Run `npm run build`.
7. Run local macOS packaging and verify the explicit unsigned classification;
   do not claim production signing because this machine has no identity.
8. Invoke the Claude code-review workflow in auto mode on the complete branch
   diff against `origin/main` using the supplied OAuth profile rotation wrapper.
9. Fix every confirmed critical/warning finding test-first and repeat affected
   gates.

## 9. Release

1. Fetch and rebase onto the latest `origin/main` in the isolated worktree.
2. Re-run the release gate after conflict resolution.
3. Select the next free patch version (`0.8.38` unless another session has used
   it), add release notes, and update package lockfiles consistently.
4. Commit the version, create the matching `v*` tag, and push the branch/commit
   and tag with `--follow-tags` only after all evidence is green.
5. Monitor the release workflow until all platform build and asset-verification
   jobs finish.
6. Verify the GitHub release is published with all required assets and record
   whether each platform artifact is signed or unsigned.
7. Perform the available local post-release smoke checks; record hardware update
   installation as unexercised unless it is actually performed.

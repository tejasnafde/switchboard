# v0.8.35 to v0.8.46 Upgrade Certification Implementation Plan

**Design:** `docs/plans/2026-08-24-v0835-to-v0846-upgrade-certification-design.md`  
**Method:** Red-green-refactor for every behavioral fix  
**Working branch:** `fix/upgrade-0835-0846`, based on published v0.8.46  
**Release target:** v0.8.47 and synchronized mobile releases only if v0.8.46 cannot be certified unchanged

The `writing-plans` skill referenced by the brainstorming workflow is not installed in this session. This document is the equivalent executable plan.

## Working rules

- Never launch a test binary against the production Switchboard identity or user-data directory. The user's running v0.8.35 installation remains untouched.
- Observe each new behavioral test fail for the expected reason before editing production code.
- Keep old-client decoding backward compatible. Add wire fields and states only when older released clients safely ignore them.
- Treat database, Git, provider dispatch, and release publication as external boundaries requiring durable intent before the side effect.
- Add or update one cross-surface feature-parity manifest with real evidence for every behavior-bearing slice.
- Remove `$TMPDIR/sb-*` and `/tmp/sb-*` after every E2E or packaged rehearsal.
- Do not publish or move a GitHub release tag until all available gates are green and unexercised hardware is recorded.

## Phase 1: Re-establish the v0.8.46 baseline

Run root typecheck and tests after both root and React Native dependencies are installed. Run the mobile TypeScript check, Android JVM test/lint gates with Java 17, feature-parity validation, and production dependency audit. Record environment-only failures separately from product failures.

The first baseline run already established that root typecheck passes. A concurrently running root test started before `apps/mobile` finished installing and therefore reported three missing-Expo suites; rerun it after installation rather than treating those as product failures. The production audit is genuinely red with thirteen advisories, including high-severity `js-yaml`, `electron-updater` runtime, Hono/URI, and IP parsing paths.

## Phase 2: Release-channel correctness

### Red

Extend `tests/unit/android-native-ci.test.ts` and add a release-channel contract test proving:

- mobile GitHub releases are created with `--latest=false`;
- desktop releases are the only workflow allowed to become GitHub Latest;
- required desktop manifests are asserted before the release is considered usable;
- a missing `latest-mac.yml` or `latest.yml` maps to an update error, never “up to date.”

### Green

Make the mobile release workflow explicitly non-latest. Remove the updater's missing-manifest success special case and provide actionable UI copy. Add a metadata verification script that can inspect the live `latest` release without installing it.

### Verify

Run workflow contract tests, updater tests, and inspect the live v0.8.46 asset set and manifest versions read-only.

## Phase 3: Renderer Markdown trust boundary

### Red

Extend `tests/unit/code-block-copy-controls.test.ts` with payloads for script tags, event handlers, `javascript:` links, SVG/MathML execution vectors, iframes, forms, and malicious content adjacent to generated copy buttons. Prove ordinary Markdown, safe links, code text, provisional/settled state, and copy-button attributes survive.

### Green

Sanitize the complete marked output before `dangerouslySetInnerHTML` using an allow-list that includes only Switchboard's generated copy-control attributes. Upgrade DOMPurify to a non-advisory version. Keep file-pill post-processing on sanitized DOM only.

### Verify

Run Markdown, message-pill, copy-lifecycle, renderer typecheck, and production audit checks.

## Phase 4: Remote authorization and event scopes

### Red

Add WS and TCP tests proving a chat-only client cannot:

- bypass launch/workspace configuration protection by changing the caller-supplied repository root;
- reach the file through `..`, case aliases, an absolute path, a symlinked root, or a symlinked `.switchboard` directory;
- receive terminal output/data events or another event channel requiring a scope it lacks.

Also prove ordinary repository file diff mutations and provider/chat events still work.

### Green

Move protected-file authorization to the file handler after canonical path resolution, using authenticated request context. Keep the host check only as an early rejection. Filter outbound events per authenticated client's scopes in both WS and TCP transports.

### Verify

Run device-auth, files IPC, backend host, WS auth/resume, TCP host, and mobile transport suites.

## Phase 5: Durable ambiguous-turn recovery

### Red

Add store and provider acceptance cases for a process crash after `dispatching`, response loss after provider acceptance, a completed provider turn with a missing transcript commit, and a genuinely unknown provider outcome. Prove that later turns do not remain permanently blocked and that the same origin is never dispatched twice.

### Green

Introduce an explicit durable reconciliation state/receipt. On session recovery, reconcile the frozen envelope against provider/native conversation evidence where exact identity exists. When delivery cannot be proven, expose an explicit user recovery action that resolves the blocker without silently redelivering; preserve the ambiguous turn as an auditable transcript status. Subsequent dispatch is enabled only after that durable resolution.

### Verify

Run turn-acceptance store, atomic submission, all provider adapter recovery, mobile outbox, React Native process restoration, and native Android outbox suites.

## Phase 6: Released mobile response compatibility

### Red

Replay v0.8.35-era positional calls and released mobile decoder fixtures against the v0.8.46 backend for accepted, duplicate-completed, reserved/pending, dispatching/ambiguous, conflict, rejection, disconnect, and response-loss cases. Add equivalent native Android wire fixtures.

### Green

Keep the legacy positional result shape stable and make both current mobile clients preserve any unknown or ambiguous result rather than dropping the outbox record. Capability negotiation selects the typed endpoint only when advertised; transport failures never downgrade and dispatch again.

### Verify

Run `mobile-api-turn-compat`, mobile outbox/delivery/submit suites, Android remote decoder/outbox suites, and a backend-client integration test over real loopback transport.

## Phase 7: Worktree deletion and crash recovery

### Red

Add real-Git tests proving:

- explicit removal of a clean but advanced managed worktree removes the checkout without force-deleting the unmerged branch;
- ordinary rollback deletes only an exact base-commit branch;
- a crash after external rollback but before journal finalization never rematerializes the worktree or resurrects its branch;
- restart completes a recorded compensation intent idempotently for exact, branch-only, and already-absent states.

### Green

Replace unconditional branch force-deletion with safe deletion where user commits may exist. Persist a compensating phase before Git rollback. Recovery of that phase resumes cleanup/finalization and never returns to materialization.

### Verify

Run legacy worktree, Git adapter, service, compensation, recovery, liveness, fork-owner, Kanban-owner, and real temporary repository suites.

## Phase 8: Feature-parity evidence enforcement

### Red

Extend `tests/unit/feature-parity-policy.test.ts` with nonexistent paths, directories where a file is required, evidence belonging only to another surface, and a behavior diff whose manifest cites no changed implementation/test evidence.

### Green

Resolve evidence relative to the repository, require it to exist, and enforce surface-appropriate path families. For changed-manifest validation, require implemented affected slices to cite at least one changed or newly added implementation/test artifact. Preserve valid shared evidence and documented N/A reasons.

### Verify

Run the policy suite and `npm run validate:feature-parity -- --all`, then validate the final base-to-head diff.

## Phase 9: Dependency remediation

Use the audit output as the failing gate. Upgrade direct dependencies and lockfile-resolvable transitives to patched compatible versions first. Treat SDK/electron-updater major or behavior changes as separate red-green slices with adapter/updater contract tests. Do not use `npm audit fix --force`.

Run root and mobile production audits after updates. If an advisory has no compatible fix or does not ship/reach the product, record the exact dependency chain, exposure analysis, and follow-up instead of claiming zero risk.

## Phase 10: v0.8.35 database fixture and direct migration

### Red

Create a deterministic database from the v0.8.35 schema/code in a temporary `SWITCHBOARD_DATA_DIR`. Populate representative projects, conversations, messages, archives, bookmarks, provider instances, layouts, Kanban/worktree links, and settings. Record stable invariant hashes. Open it with v0.8.46 code and assert schema integrity, foreign keys, durable identity, counts/content, and relaunch idempotency.

Add failure injection around migration transactions and prove the pre-upgrade database remains usable after a failed attempt.

### Green

Fix only migrations/invariants that fail. Migration changes must be additive or transactional transforms and idempotent on a second open.

### Verify

Run the migration suite under the Node and Electron native bindings without reading the production database.

## Phase 11: Isolated packaged upgrade rehearsal

Build/download verified v0.8.35 and v0.8.46 artifacts into a disposable root. Launch with a test identity and explicit isolated user-data path; never acquire the production single-instance lock. Exercise v0.8.35 fixture workflows, close the test instance, launch v0.8.46 over the same fixture, and rerun invariants and smoke flows. Repeat relaunch and update-check behavior.

Clean every generated E2E directory immediately after the run. Record macOS architecture/signing status and leave Windows/iOS/Android hardware as unexercised unless a real runner/device executes them.

## Phase 12: Cross-surface gates and release decision

Run:

- root typecheck, full Vitest suite, gated build, smoke test, and feature-parity validation;
- React Native/iOS TypeScript/tests and OTA configuration validation;
- native Android JVM tests, lint, assemble, instrumentation compilation, package/version/signature verification where credentials permit;
- production audits and live release-metadata inspection;
- packaged direct-upgrade rehearsal.

If v0.8.46 passes unchanged, publish a certification report only. If any production fix lands, update desktop to v0.8.47 and bump native/OTA mobile versions monotonically, generate release notes naming direct v0.8.35 upgrade support, publish desktop first, verify it is Latest with all manifests, then publish mobile as non-latest. Never mutate the existing v0.8.46 tag or assets.

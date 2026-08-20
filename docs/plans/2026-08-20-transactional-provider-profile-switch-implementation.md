# Transactional Provider Profile Switching Implementation Plan

## Goal

Make same-provider Claude and Codex OAuth profile switches content-safe and crash-safe on desktop and mobile without adding a persistent phase state machine.

## Task 1: Provider JSONL compatibility

Files:

- add `src/main/provider/transcript-compatibility.ts`
- add `tests/unit/transcript-compatibility.test.ts`

Write failing tests for missing target, equal records, target prefix, source prefix, divergence, malformed records, incomplete trailing records, and file mutation evidence. Implement an asynchronous line-oriented comparator that returns typed evidence for the exact source and target paths. File size and modification time are change detectors only.

Verify with:

```sh
npx vitest run tests/unit/transcript-compatibility.test.ts
```

## Task 2: Verified provider-specific preparation

Files:

- modify `src/main/provider/claude-session-migrate.ts`
- modify `src/main/provider/codex-session-migrate.ts`
- modify `tests/unit/claude-session-migrate.test.ts`
- modify `tests/unit/codex-session-migrate.test.ts`

Replace size/mtime authority with exact source/target preparation. Keep discovery helpers for preflight and recovery, but do not compare unrelated profile copies during a switch. Add verified same-directory temp-copy and pre-rename restats. Preserve every source. Return a typed conflict containing source and target locations without overwriting either.

Verify with:

```sh
npx vitest run tests/unit/transcript-compatibility.test.ts tests/unit/claude-session-migrate.test.ts tests/unit/codex-session-migrate.test.ts
```

## Task 3: Atomic conversation commit

Files:

- modify `src/main/db/database.ts`
- modify `tests/unit/conversation-segments.test.ts`

Add one database transaction that updates the conversation's provider instance and current native session ID and records the returned provider segment idempotently. Test success, rotated-root resolution, and rollback on a failed update.

Verify with:

```sh
npx vitest run tests/unit/conversation-segments.test.ts
```

## Task 4: Registry sequencing and execution epochs

Files:

- modify `src/main/provider/provider-registry.ts`
- modify `tests/unit/provider-switch-ws.test.ts`

Refactor source stop so it returns the final descriptor and credential snapshot after the adapter drains but before registry teardown. Keep source events valid through that point, then retire its execution epoch. Prepare the target transcript only after stop, start the target behind the existing event gate, commit its instance/session atomically, and flush events.

Write failing tests for:

- migration occurring after source stop;
- session-ID rotation emitted during stop;
- late source events being fenced;
- target startup and database commit rollback;
- missing/equal/prefix/conflict preparation;
- source authority after every precommit failure.

Verify with:

```sh
npx vitest run tests/unit/provider-switch-ws.test.ts
```

## Task 5: Divergence recovery contract

Files:

- modify `src/shared/provider-events.ts`
- modify `src/main/provider/provider-registry.ts`
- modify `src/renderer/components/chat/ChatPanel.tsx`
- modify relevant desktop source-contract tests

Add a `context-conflict` failure carrying non-secret profile labels and a request option to continue with a fresh native session. Desktop asks whether to stay on the source or start fresh on the target. A fresh continuation starts without `resumeSessionId`, returns `continuity: 'degraded'`, and schedules the existing bounded handoff preamble for the next turn. Label same-provider degraded handoff as a new provider session rather than `Claude → Claude` or `Codex → Codex`.

Verify with focused shared/renderer tests plus the provider switch suite.

## Task 6: Mobile parity

Files:

- modify `apps/mobile/src/lib/api.ts`
- modify `apps/mobile/src/screens/ThreadScreen.tsx`
- modify `tests/unit/mobile-profile-picker.test.ts` or add a focused rotation test

Add the typed `switchInstance` client method. Same-provider profile rotation must call it instead of independently stopping and starting the session. On `context-conflict`, show a native alert with Stay and Start Fresh actions and retry using the explicit degraded-continuation option. Cross-provider switching remains outside this change.

Verify with focused mobile tests.

## Task 7: Verification and review

Run:

```sh
npm run typecheck
npm test
git diff --check
```

Then run the Claude adversarial code-review workflow over all branch changes relative to the branch point. Fix every confirmed critical or warning finding test-first and rerun the affected suites, typecheck, and full tests.

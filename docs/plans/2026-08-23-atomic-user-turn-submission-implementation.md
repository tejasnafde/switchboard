# Atomic user-turn submission implementation plan

The `writing-plans` skill referenced by the brainstorming workflow is not
installed in this session. This document provides the equivalent executable
plan. Every production step follows a failing behavioral test.

## 1. Shared contract

1. Add failing contract tests for envelope validation, canonical hashing, and
   result decoding.
2. Add `UserTurnSubmissionV1`, its result union, validation, and full canonical
   payload hash to `src/shared/provider-events.ts`.
3. Add `ProviderChannels.SUBMIT_USER_TURN` and advertise an
   `atomic_user_turn_v1` backend capability while retaining
   `ProviderChannels.SEND_TURN` unchanged.

## 2. Durable acceptance and atomic commit

1. Extend real SQLite tests to require additive acceptance columns, complete
   envelope retention, a per-thread unresolved barrier, canonical completion,
   definite release, ambiguous recovery, and upgrade behavior.
2. Migrate `mobile_turn_acceptances` with nullable `envelope_json`,
   `message_id`, and canonical timestamps plus a nonunique thread/state index.
3. Implement transaction methods that reserve the envelope, reject other
   unresolved origins on the thread, complete the exact user row with display
   metadata, commit title and handoff effects, and release definite failures.
4. Retain legacy hashes and nullable envelope data for rows created by older
   builds.

## 3. Submission service and provider registry

1. Add a behavioral service test with real SQLite, a controlled adapter
   boundary, and captured publication.
2. Cover seven valid sub-budget images, over-budget rejection, startup/session
   rejection, checkpoint rejection, post-boundary ambiguity, same-origin
   duplicate, changed payload conflict, lost acknowledgement replay, pills and
   handoff, and later-origin blocking.
3. Implement one submission coordinator used by the typed channel and the
   origin-aware positional compatibility channel.
4. Publish only the canonical committed event. Return structured typed results
   on the new channel and preserve legacy positional failure semantics.
5. Move OpenCode first-turn summary persistence behind provider acceptance if
   its current pre-prompt write can survive a rejected submission.

## 4. Desktop renderer and preload

1. Replace the source-order contract test with a renderer submission-controller
   test covering exact origin reuse, composer retention, event/response races,
   remount, and unresolved-head blocking.
2. Add the typed preload method. Convert a missing remote handler into explicit
   upgrade guidance without positional downgrade.
3. Introduce an origin-keyed Desktop submission tracker outside component
   lifetime. Cache the exact prepared envelope, including converted images and
   handoff payload.
4. Remove the optimistic sent bubble, renderer user-row write, early status,
   activity, title, marker, and handoff-clear mutations.
5. Append and bump activity only from canonical `user.message`. Clear the exact
   composer snapshot after accepted response or matching replayed origin.
6. Keep rejected and ambiguous text, pills, and `File` attachments recoverable.
   Restore idle only for definite rejection. Show actionable byte-limit,
   upgrade, conflict, and unconfirmed-delivery errors.

## 5. React Native and iOS

1. Add failing outbox tests proving that resolved pending or ambiguous results
   do not delete attachments, completed duplicates do not dispatch again,
   handoff wire text is byte-stable, and canonical origin replay reconciles.
2. Decode the acceptance union instead of typing `sendTurn` as `Promise<void>`.
3. Persist the prepared provider text and handoff intent additively in the
   existing AsyncStorage outbox record.
4. Mark optimistic messages pending or failed, keep rejected records editable,
   and defer title and permanent running presentation until confirmation.
5. Preserve positional fallback for older backends and envelope capability use
   for upgraded backends.

## 6. Native Android

1. Run the existing Room, sender, response decoder, coordinator, and private
   attachment materializer tests before changes.
2. Add only failing coverage identified by the audit, especially typed-envelope
   compatibility and byte-stable handoff payload if Android prepares one.
3. Preserve stable origin, blocked/ambiguous state, and private files until
   accepted confirmation. Avoid a production rewrite if the tests prove these
   behaviors already hold.

## 7. Parity, review, and verification

1. Update `docs/feature-parity/atomic-image-turns.json` for all six impact areas,
   the acceptance-table migration, rollout compatibility, and separately
   recorded automated, Desktop manual, iOS hardware, Android hardware, and
   unexercised checks.
2. Run focused Vitest and Android tests after each green cycle.
3. Run `npm run typecheck`, `npm test`, and
   `npm run validate:feature-parity -- --base origin/main` in the isolated
   worktree.
4. Run a Desktop Electron smoke or E2E only if it can be automated safely. If
   run, remove all required `sb-*` temporary directories afterward.
5. Run the requested deep Claude adversarial review against the branch, address
   confirmed findings with new failing tests, and rerun verification.
6. Record the seven-real-screenshot Desktop smoke as unexercised unless it is
   genuinely performed with backend logs and durable acceptance evidence.

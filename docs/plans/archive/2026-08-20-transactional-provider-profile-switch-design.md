# Transactional Provider Profile Switching

## Problem

Switchboard can move a live Claude or Codex conversation between OAuth profiles while preserving the provider-native session. The current switch path prepares the target transcript before stopping the source adapter and chooses among transcript copies by size and modification time. This works for the normal append-only case, but it leaves three avoidable failure modes:

1. the source can change after the target copy is prepared;
2. independently changed same-ID copies can be mistaken for a newer prefix;
3. callbacks from a stopped adapter can arrive after the target becomes active.

The change must preserve Switchboard's local-first behavior, remote multi-client support, rollback semantics, and app-owned logical conversation model. It must not introduce profile-sharing policies, a global worktree lock, or a canonical event-sourcing rewrite.

## Decision

Use the conversation's persisted provider instance as the durable commit point. A switch remains sourced from the old instance until the target starts and the database commit succeeds. No multi-phase transition journal is necessary because every crash before that commit resolves to the source, while every crash after it resolves to the target.

Content compatibility, not file size or modification time, determines whether a transcript can move safely. Comparison is limited to the live source profile's exact native transcript and the selected target profile's exact resume path. Other configured roots may help locate a missing source during preflight, but an unrelated third copy cannot veto a switch.

## Switch Protocol

1. Validate the requested instance, expected current instance, idle status, outstanding turns, and checkpoint preparation exactly as today.
2. Claim the logical conversation with the in-process switch guard and allocate a new execution epoch.
3. Preflight that the current native session can be located. Ambiguous discovery fails before stopping the source.
4. Stop the source adapter. Continue accepting its events until `stopSession` resolves.
5. Capture the latest provider session ID after the stop resolves and before deleting registry state. This includes a session-ID rotation emitted while the adapter drains.
6. Retire the source epoch. Events from it arriving after the declared stop boundary are ignored.
7. Resolve the exact source file for the captured native session ID and the exact target resume path.
8. Compare complete provider JSONL records asynchronously.
9. Prepare the target according to the compatibility result.
10. Start the target adapter behind the existing event gate.
11. Atomically persist the target provider instance and returned native session ID/segment.
12. Commit the target epoch, publish buffered events, and release the switch guard.

If target startup or the database commit fails, stop the target and restart the source with its captured credentials and native session ID. The persisted instance remains unchanged unless the commit succeeds.

## Transcript Compatibility

The comparison result is one of:

- `target-missing`: the source can be copied to the target;
- `equal`: the target is already resumable;
- `target-prefix`: every complete target record is the beginning of the source, so the target can be advanced;
- `source-prefix`: every complete source record is the beginning of the target, so the target is the compatible superset and must not be overwritten;
- `divergent`: both sides contain unique complete records;
- `unreadable`: either side cannot be validated as provider JSONL.

The source must be a readable sequence of complete records. An invalid or truncated source is never copied. Provider-specific comparison adapters keep Claude and Codex format assumptions separate. If a provider file cannot be validated as record-oriented JSONL at runtime, an occupied unequal target goes to recovery.

For `target-missing` and `target-prefix`, copy through a same-directory temporary file and atomically rename it into place. Record source and target file identity, size, and modification time during comparison. Immediately before rename, restat both paths. Any change aborts the operation as concurrent modification. Hashes describe evidence and aid tests; they do not override record incompatibility.

No source copy is deleted.

## Crash Recovery

The database selection is the recovery record:

- Before commit, the source instance remains authoritative.
- After commit, the target instance is authoritative.
- A crash after a compatible copy can leave a harmless replica in the target profile.
- A crash during target startup can leave an occupied target transcript. A later switch compares it normally and either proves compatibility or enters recovery.

Electron already enforces one process per user-data directory. Remote desktop and mobile clients share one backend registry. A separately launched backend should use its own data directory; cross-process mutation of one Switchboard database is outside this change.

## Divergence Recovery

Divergent or unreadable transcripts are never overwritten. The profile switch reports that it did not happen and offers two explicit actions:

1. stay on the source profile;
2. start a new native session on the target profile, preserve the logical Switchboard conversation, and seed the new segment with the existing bounded handoff preamble.

The second action is a degraded continuation, not native resume. It must be labeled accordingly.

## Event Fencing

Each adapter start receives an execution epoch captured by its callback. Source events remain valid through the completion of `stopSession`; after that boundary, callbacks from the retired epoch cannot mutate descriptors, persistence, or renderer state. Target events remain staged until the database commit. A session event received during target startup updates the returned target session ID before commit.

The adapter contract is strengthened: `stopSession` must not resolve before its final session-ID event has been delivered. Tests cover this contract for Claude and Codex.

## Testing

Implementation follows test-driven development. Focused tests cover:

- missing, equal, both prefix directions, divergent, malformed, and truncated transcripts;
- provider-specific JSONL validation;
- source and target mutation between comparison and rename;
- atomic target replacement without source deletion;
- session-ID rotation during source shutdown;
- events arriving after the source epoch retires;
- failures after source stop, transcript preparation, target startup, and database commit;
- successful rollback and rollback failure;
- restart-equivalent behavior before and after the database commit;
- existing queued-turn, stale-selection, peer-delivery, remote-profile, and multi-client cases.

After focused tests, run the full unit suite and typecheck. Claude performs an adversarial review of the complete diff; confirmed findings are fixed and reverified before handoff.

## Alternatives Rejected

### Seven-state transition journal

Rejected because the proposed precommit phases all recover to the same persisted source. The additional schema suggests distinctions that recovery does not use.

### Stop-before-copy with size/mtime selection

Rejected because sequencing alone does not distinguish a stale prefix from independently divergent history.

### Shared provider home

Rejected because Switchboard intentionally keeps configured profiles isolated and moves only the selected conversation.

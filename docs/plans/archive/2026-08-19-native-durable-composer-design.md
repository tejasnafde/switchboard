# Native Android durable composer design

## Behavioral target

The native composer preserves unsent state independently for each connection and thread. Text, the selected runtime mode, and up to four image attachments survive configuration changes and process recreation. An image-only draft is sendable.

The desktop React app is a behavioral reference: drafts are thread-scoped, images have removable previews, and the composer clears after sending. The native implementation strengthens its durability: selected images are copied into app-private draft storage immediately instead of depending on a live browser `File` or an external URI permission.

## Ownership and persistence

Room remains the source of truth. Database version 3 adds an optional `editingOrigin` to `thread_preferences` and a `draft_attachments` child table keyed by thread and position. The v2-to-v3 migration is additive and preserves every existing preference, cached thread, outbox row, attachment, credential reference, and migration checkpoint.

An application-scoped, serial composer runtime hydrates saved drafts after startup, publishes them as state, and orders all Room mutations. Image selection first copies accepted content URIs into `files/draft-attachments`. Only successfully installed private files are recorded in Room. A failed copy or failed Room write remains visible as an error and never clears existing draft state.

Files have one owner at a time:

1. The composer owns files referenced by `draft_attachments`.
2. Send or in-place edit stages new outbox-owned copies.
3. The outbox transaction commits its message and attachment references.
4. The composer row is cleared.
5. Only then may the former draft-owned files be deleted.

Removal and draft replacement delete only canonical paths inside the app-owned draft directory. Outbox files are deleted only after acknowledged cleanup, a committed replacement that removes them, or an explicit dismiss of a non-pending terminal/ambiguous record.

## Outbox editing and delivery truth

`OutboxRuntime` publishes its actual durable records as a `StateFlow`; UI state is derived from those records, not from fake success flags. Pending records show queued/sending state. Ambiguous and terminal records remain visible with their persisted reason.

Retry transitions the same record back to pending while preserving `origin` and `bubbleId`. Edit locks the same origin, restores its payload into the composer, and resubmission replaces the record in place with the same identity. Every send attempt carries an internal attempt token; a callback from an older attempt is ignored after retry or edit so it cannot overwrite the newer payload or status.

Dismiss is unavailable for pending records. For terminal or ambiguous records it removes the database row first, then discards its app-owned attachments. A failed delete leaves both the row and files intact.

## Coordinator and UI flow

`ThreadSessionCoordinator` receives the saved composer state and outbox state for its exact connection/thread key. Draft text, selected mode, attachment additions/removals, and edit origin flow through the application-scoped composer runtime. Sending is allowed when trimmed text is non-empty or at least one attachment is present.

Android uses `ActivityResultContracts.OpenMultipleDocuments` for `image/*`. Selection policy accepts at most four images across restored and newly selected items, preserves selection order, and reports rejected overflow without discarding accepted items. The composer renders stable previews from private files, supports individual removal, and keeps all state on staging or durable-write failure.

Queued-turn cards expose only valid actions:

- Pending: Edit.
- Ambiguous: Retry, Edit, Dismiss.
- Terminal: Retry, Edit, Dismiss.

Acknowledged rows disappear only through the existing safe cleanup path.

## Verification

Pure JVM tests cover attachment-cap decisions, send enablement, delivery presentation/actions, exact identity preservation, stale callback fencing, ownership transitions, and composer restoration decisions. Room mapper/repository tests cover round trips and failures. Android database tests verify the v2-to-v3 migration preserves old data and creates the new child table and column. Compose/Android compile checks cover the activity-result picker integration; device smoke testing remains required for picker grants, previews, process death, and real image delivery.

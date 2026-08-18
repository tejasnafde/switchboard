# Native Android Projects, Conversations, and New Sessions

## Goal

Match the React Native Projects, Conversations, and New Session behavior while retaining the native app's exact connection-generation fencing, durable outbox, offline snapshot, and process-safe routes.

## Scope and identity

Every remote request is keyed by the current `TransportScope` (`connectionId` plus generation). Conversation state is additionally keyed by project path. Responses from another connection, project, generation, or superseded request are ignored.

Routes remain serializable and saveable. A new-session route carries only authoritative identifiers and display hints: connection id and label, project path and name. Runtime objects and credentials never enter saved state.

## Projects

Projects and workspaces load together. A workspace failure is non-fatal: projects remain usable as ungrouped. Workspace order follows the backend's `sortOrder`, then `createdAt`; ungrouped projects appear last. Unknown workspace references are ungrouped.

Collapse preferences are stored per connection in the existing app-preferences table. On the first scoped read, migrated React Native collapsed workspace ids seed the connection preference without deleting the legacy rows. Collapse is effective only with multiple groups and no active query. Searching forces matching groups open. Project search appears above six projects and matches name or path, case-insensitively.

Rows show the backend session count plus activity derived from the application-scoped thread activity index: summed unread count and live status. Protocol activity is fenced by exact transport scope so a replaced socket cannot update the list.

## Conversations and rename

Conversations are stored independently per `(connection, generation, project)`, sorted newest-first with a stable id tie-break. Search appears above eight rows and matches title case-insensitively.

Rename trims input and synchronously guards repeated submission. The native client first calls `createConversation` with the existing metadata because scanned transcripts may not yet have a database row, then calls `renameConversation`. The row updates optimistically while the command is in flight. A definite command failure restores the previous title and exposes an error. A successful command remains successful even if the follow-up conversation refresh fails; the optimistic title stays visible and the refresh failure is presented separately.

## New sessions

Provider order matches React Native: Claude Code, Codex, OpenCode. Provider instances come from `provider-instances:list`; enabled profiles are filtered by agent type, with the conventional default id first and remaining profiles ordered by display name, matching RN behavior. Backend response order is retained as a final stable tie-break.

Runtime mode, model, and profile defaults come from the backend settings. Defaults are loaded per provider with request fencing; malformed or missing runtime modes fall back safely to Sandbox. Switching provider clears selections from the previous provider before applying the new provider's authoritative defaults.

There is no general pre-session model endpoint. The native app therefore carries the exact RN static model catalogs and order. A backend model default not present in the catalog remains selectable and is shown without silently replacing it.

Starting uses the established sequence:

1. `createConversation`
2. `startSession`
3. optional first message through the durable outbox only
4. replace the route with the new thread

The first message never uses raw `sendTurn`, preventing duplicate bubbles and retaining retry/dedupe semantics. A durable-enqueue failure preserves the user's text as an error/draft outcome rather than pretending it was sent.

## Error and lifecycle behavior

Initial failures show retryable errors. Refresh failures preserve cached content. Project, workspace, conversation, rename, defaults, and start-session requests each have independent stale-response fences. Follow-up synchronization after a successful mutation is best-effort.

Pure tests cover grouping, collapse, thresholds, search, ordering, default resolution, model catalogs, request fencing, optimistic rename rollback, best-effort refresh, and new-session sequencing. Android lifecycle coverage verifies saveable routes and application-scoped activity state separately from screen composition.

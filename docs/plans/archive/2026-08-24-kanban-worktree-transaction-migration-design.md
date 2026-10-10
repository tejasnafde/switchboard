# Kanban worktree transaction migration

## Decision

Kanban's existing IPC channels remain the compatibility boundary, but worktree-producing operations delegate to the shared backend worktree creation transaction. The main process translates old and new Kanban calls into typed requests. It does not create a plain card before asking Git to materialize a worktree.

The response remains an ordinary `KanbanCard` with an additive worktree-creation snapshot. Older renderers ignore the extra field. A modern renderer uses it to show pending, failed, retryable, and cleanup-required states without hiding the preserved card.

## New card flow

`kanban:create` with `withWorktree` creates a stable card ID and creation ID, then submits one request whose owner contains the complete card draft. The backend reservation atomically creates the backlog card and links it to the creation journal before Git. A definite Git failure returns the preserved, editable backlog card plus the failed snapshot. It does not throw away the card or project a worktree path.

Plain card creation remains direct and compatible.

## Existing card attach flow

`kanban:create-worktree` fetches the current card and submits an attach request containing its `updatedAt` as the expected revision. A concurrent edit causes an owner conflict before Git. A successful attach returns the updated card plus the creation snapshot.

## Progress and recovery

The shared worktree creation API remains authoritative for progress, retry, reconciliation, and cleanup actions. Modern Kanban state retains the additive snapshot by card ID and applies progress events to it. Stable creation IDs allow callers to reconcile through the shared get/action API.

No new database delivery-state column is required. The worktree journal and the card's existing creation projection are sufficient.

## Launch behavior

The renderer no longer performs create, Git, provider start, message send, and status promotion as separate steps for `withWorktree`. When an initial-agent intent is supplied, it is stored in the shared request. Kanban owner startup currently remains pending in provisioning because provider startup supports conversation owners only. That gap is explicit and tested; this migration does not modify provider startup or the shared service.

## Compatibility

Old clients continue using the existing Kanban channels and receive all ordinary card fields. New optional input identity fields and additive response metadata do not break older clients. Old backends remain usable through renderer capability fallback, but the modern renderer does not recreate the unsafe multi-step orchestration.

## Verification

Behavioral tests cover new-card success and definite failure, expected-revision attach, stable duplicate identity, progress/error retention, old response compatibility, and removal of renderer-owned auto-launch. Existing shared service tests continue covering atomic owner reservation, rollback, and retry.

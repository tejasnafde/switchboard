# Chat rendering and idle-send feedback

## Problem

Two Desktop regressions remain in 0.8.49:

1. A rich chat turn can retain a stale TanStack Virtual height while its content
   grows. Later absolutely positioned turns then overlap it. Moving to another
   conversation and back repairs the view because the rows remount and measure
   synchronously.
2. The first send in an idle conversation shows no transcript or work feedback
   while the provider session starts. The atomic turn contract intentionally
   waits for durable backend acceptance before presenting a message as sent,
   but Desktop currently presents no pending state either.

The correction must preserve the atomic-delivery invariant: transient UI may
show intent immediately, but transcript persistence, activity, title, handoff
cleanup, and accepted presentation remain backend-owned.

## Selected design

### Transcript measurement

Keep virtualization for large histories. Each mounted turn owns a DOM ref and
remeasures itself in a layout effect whenever its grouped message presentation
changes. TanStack's ResizeObserver remains attached for descendant changes that
happen outside a React commit. Cache resets and DOM measurement happen on
separate animation frames: measuring immediately after a reset can compare
against TanStack's old measurement array without repopulating its size map.

The scroll container also observes visibility-sized transitions. When an
ancestor changes it from zero size to visible without changing the conversation
id, the list clears stale measurements and restores its bottom anchor unless a
search jump or user scroll lock owns the position.

### Pending Desktop turn

After image validation, handoff preparation, and stable-origin creation—but
before cold provider startup—Desktop appends one transient user message keyed
with the canonical echo id. It carries a renderer-only delivery state:

- `pending`: render the bubble and `Sending…`; do not persist it or mark the
  provider as running.
- accepted canonical `user.message`: replace the transient fields in place and
  clear the delivery state. Backend persistence remains the source of truth.
- definite rejection: remove the transient bubble; leave the exact composer
  payload editable.
- ambiguous or pending acknowledgement: retain the bubble as `Unconfirmed` and
  retain the exact composer payload/origin for recovery.
- user-abandoned uncertainty: retain the attempted bubble as
  `Delivery unresolved · not resent`, a terminal renderer-only audit state
  that neither claims acceptance nor continues to imply a blocking recovery.

Active-turn admission and provider-specific queue behavior do not change.

## Alternatives

Removing virtualization would eliminate this failure class but would mount and
parse every historical rich message, regressing large conversations and search.
Broad full-list remeasurement on every render is smaller, but does unnecessary
layout work during streaming and still misses hidden-to-visible transitions.
Provider prewarming alone cannot hide remote or failed startup latency and gives
no immediate acknowledgement.

## Cross-surface scope

1. **Desktop Electron:** renderer state, transcript layout, pending bubble,
   status copy, and Electron regression coverage change.
2. **React Native/iOS:** no behavior change. Its durable outbox already renders
   queued/ambiguous states and reconciles canonical origins.
3. **Native Android:** no behavior change. Its Room outbox already owns pending,
   ambiguous, terminal, and acknowledged presentation.
4. **Shared backend/API:** the versioned atomic submission and canonical event
   contract are unchanged. A renderer-only optional ChatMessage field may be
   shared for typing but never crosses the wire.
5. **Stored data/upgrades:** no schema or migration. Pending Desktop messages
   are never stored; 0.8.35 and 0.8.49 databases remain directly readable.
6. **Packaging/rollout:** release as 0.8.50. Exercise direct 0.8.35 → 0.8.50 and
   0.8.49 → 0.8.50 Desktop upgrades in isolated copies. Run mobile build/test
   lanes and record hardware checks separately; do not claim hardware parity
   from compilation.

## Verification

- Unit tests pin pending-message construction and accepted/rejected/ambiguous
  reconciliation without weakening atomic persistence.
- Electron E2E grows an already-mounted same-key turn and asserts adjacent row
  geometry never overlaps.
- Electron E2E sends content to a hidden tab, reveals it without changing its
  session id, and asserts measurement plus bottom anchoring.
- Existing full typecheck, unit, build, smoke, feature-parity, packaging, and
  release verification gates remain mandatory.
- An adversarial Claude review is repeated on the completed patch.

# Recovery inventory usability

## Problem

The native-session recovery inventory uses undefined `modal-overlay` and
`modal-content` classes. It therefore renders as a normal child of the sidebar,
below the footer. Its result list has `overflow-y: auto` but no bounded flex
height, so hundreds of native transcripts cannot be scrolled. The surface also
has no search or keyboard dismissal. Finally, raw scanner titles hide known
conversation names such as `v0`, even when Switchboard already has that title in
its database.

## Design

Recovery remains an explicit, non-destructive inventory, but opens as a real
application modal instead of occupying sidebar layout space. The modal is a
bounded flex column with an independently scrollable result region. It offers a
search field over title, provider, native role, and full session ID; shows the
filtered result count; and closes through an explicit button, Escape, or the
backdrop. Import remains disabled only while an import is active.

The main-process recovery projection enriches each scanner candidate with the
best durable title already known to Switchboard: first the conversation row for
the native ID, then its canonical root, then the scanner fallback. The import
handler uses the same title rule. Re-importing a known managed segment promotes
the existing canonical root again, which also unarchives it, rather than
returning a successful no-op.

## Boundaries

- Provider transcripts remain outside the ordinary sidebar until explicitly
  imported.
- Delegated runs remain labeled and require explicit promotion.
- Search is renderer-local; scanning and import IPC contracts stay additive.
- No transcript or database row is deleted or rewritten during inventory.

## Verification

- Component tests cover modal containment, scrolling structure, search,
  no-results state, Escape/backdrop/close dismissal, and import selection.
- Pure/main-process tests cover durable-title precedence and revival of an
  archived canonical root.
- The full typecheck, unit suite, production build, and release asset verifier
  must pass before shipping.

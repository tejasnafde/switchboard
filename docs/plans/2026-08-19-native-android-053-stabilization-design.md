# Native Android 0.5.3 stabilization

## Goal

Ship a narrow production-signed stabilization release before the full visual
parity pass. The release fixes three failures observed on 0.5.2: truncated
threads can stall and restart the app, threads open at the oldest message, and
the composer loses focus as soon as it is tapped.

The release does not migrate or clear user data. It preserves the production
package, signer, backend contract, stored connections, Room database, drafts,
outbox, and update channel.

## Truncated-history safety

The history-window row is ordinary product information, not an unknown runtime
event. Mapping a truncated response must therefore create a lightweight notice
that contains only the visible shown/total counts. It must never retain
`LoadedSession.raw`, message envelopes, image base64, tool payloads, or another
copy of the complete response.

Unknown provider events remain diagnostic, but their rendered raw payload is
bounded before it reaches Compose text layout. This is defense in depth rather
than the primary crash fix.

## Feed position

Match the React Native oracle structurally: render feed rows in reverse
chronological declaration order inside a reverse-layout `LazyColumn`. Index
zero is then the visual bottom and represents the newest row. Opening cached or
fresh history lands at the newest message, and new rows remain anchored while
the user is already at the bottom. Stable keys preserve the visible row when
the user has scrolled into older history; no unconditional scroll effect may
yank them back to the latest message.

Metadata and refresh status remain above the oldest message rather than being
mistaken for the newest feed rows.

## Composer focus

The composer owns exactly one `OutlinedTextField` for its entire composition.
Focusing it may reveal attachment, mode, voice, or other secondary controls,
but must not replace the text-field node. The field is multiline in both rest
and focused states, keeps the same `FocusRequester`, and remains pinned above
the keyboard and system inset.

Compact versus expanded presentation controls spacing and surrounding actions
only. Focus is an input to presentation, never a branch that creates a second
editable control.

## Tests and release evidence

- A multi-megabyte sentinel in `LoadedSession.raw` cannot appear in the mapped
  history-window row or its presentation.
- Truncation boundaries and image-bearing real messages remain correct.
- Feed-order policy maps chronological rows to reverse-layout declaration
  order with status and metadata above history.
- Compose tests prove a long thread opens at the newest row, appends stay
  anchored at the bottom, scrolling into history is not overridden, and a
  second thread does not inherit the first thread's position.
- Compose focus tests prove tapping the field keeps one focused editable node
  while secondary controls expand.
- Unit tests, lint, debug/release assembly, and Android-test compilation pass.
- Production CI verifies package ID, version code, signer continuity, and
  checksum before publishing 0.5.3.

Hardware behavior is reported separately. Without a connected ADB target,
automated tests cannot establish the exact prior fatal mechanism (OOM versus
text-layout failure) or verify keyboard feel on the user's phone.

## Deferred to 0.5.4

The next release rebuilds every native surface with the approved Material 3
component system and completes the RN behavior audit. That pass includes the
browse hierarchy, top bars, search, rows, disclosure controls, existing-thread
model/profile controls, optimistic image parity, context/cost presentation,
file-edit affordances, accessibility, and physical-device comparison.

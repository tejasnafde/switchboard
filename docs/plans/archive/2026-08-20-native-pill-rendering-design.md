# Native pill rendering parity

## Problem

Desktop user messages persist a tokenized `displayBody` such as
`[[pill:selection-id]] Continue from here` alongside `pillsMeta`. Android keeps
the display body but currently discards the metadata, so it exposes the wire
token as ordinary text.

## Design

- Add `pillsMeta` to the shared `user.message` runtime event. The backend reads
  it from the already-persisted user row and publishes only validated metadata.
- Decode the same metadata from loaded history on Android and carry it through
  `FeedItem.User`, runtime reduction, and the existing Room thread snapshot.
- Parse display bodies with one non-recursive token pass. Known tokens become
  pill segments, unknown well-formed tokens are dropped, and malformed text is
  left untouched.
- Render known segments as Material inline content inside the user message.
  The pill label and kind are presentation data only; expanded provider context
  remains in `content` and is never reconstructed on the phone.

## Safety

No schema, package, signing, update-channel, or provider-input changes. Corrupt
or missing pill metadata degrades to prose with well-formed internal tokens
removed; it cannot make the thread fail to load.

## Tests

- Desktop event contract publishes valid pill metadata and ignores corrupt DB
  metadata.
- Android history and live event decoders preserve metadata.
- Pure parser covers known, unknown, adjacent, malformed, and non-recursive
  tokens.
- Snapshot round-trip preserves pill metadata across process recreation.

# Sender line per turn

The backend puts one short line in front of each user turn it sends to the
provider. The agent then knows who is typing and where a localhost URL works.

## Rules

- Built in `ProviderRegistry` from the backend request context (the host's
  authenticated connection), never from the turn. `submitClientUserTurn`
  strips any `<switchboard-sender>` block the client sent before it stamps its
  own.
- Content: the surface (desktop app, iOS app, Android app, another client),
  the device model and name from the device session, the machine that runs the
  agent (the user's computer, or the SSH machine's host name on the headless
  server), and whether its localhost reaches the user (only the desktop app on
  its own computer). At most 200 characters, tags included.
- Only the provider gets it. The stored turn keeps the client's text. The
  transcript parser strips it on reload, so no client receives it and phones
  need no change. The session scanner strips it before it reads a title.
- No line for a slash command (it must stay first to run) or for a turn the
  backend sends itself: peer messages, approval results, startup prompts of a
  new worktree, resumed queued messages.
- Every adapter gets it, because it is prompt text added before
  `adapter.sendTurn`.
- Measurement: the `turn.dispatch` perf span carries `senderLineBytes` and
  `senderLineTurns` (stamped turns since the backend started).

## Review deferrals

- A phone on the IAP TCP host has no device session, so its line says
  "another client". Naming it needs a device identity on that connection.
- On an SSH machine the name is the OS host name, not the name the user gave
  the machine in Switchboard. Passing that name needs a provisioning change.
- A client can still type a sender tag in the middle of its own text. The
  backend line is always first and comes from the connection; the text after
  it is the user's own, and rewriting it would change what the user sent.

## TODO

- Add a dev-server note when the backend knows one (ports and URLs a local dev
  runner listens on). Out of scope for the first change.

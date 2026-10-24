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

## Dev servers (2026-10-24)

The line ends with up to three loopback addresses when terminals in the chat's
folder printed any: `Dev servers: localhost:5173, localhost:3000.` An entry
that does not fit in the 200-character cap is dropped, never cut.

- Source: terminal output. `PtyManager` feeds each PTY chunk to
  `terminal/dev-server-watch.ts`, which strips ANSI and reads
  `http(s)://localhost|127.0.0.1|0.0.0.0|[::1]|[::]:<port>` URLs and "listening
  / running / serving / started ... port N" lines. It keeps the newest three
  per PTY, keyed by the PTY's spawn cwd, plus 256 characters of carry so an
  address split across two chunks still reads. The PTY's entry goes when it
  exits or is killed. A turn reads the PTYs whose cwd is the chat's folder
  (`sessionCwd`) or a folder under it.
- Why this source: the desktop and the headless server run the same
  `PtyManager`, so both get it with no new process, and it costs nothing at
  turn time (a map read). A chunk with no likely marker costs one regex test.
  An `lsof` or `ss` probe would spawn a process per turn or need a cache and a
  timer, differs on macOS, Linux and Windows, and lists every listening port on
  the machine, not the project's.
- Limitations: a dev server started outside a Switchboard terminal (another
  terminal app, an agent's own shell tool) is not seen. A server stopped with
  Ctrl-C while its shell stays open stays listed until the PTY exits. The PTY's
  cwd is its spawn folder; a `cd` elsewhere is not followed. A chat in a
  worktree does not see a terminal in the main checkout. Path matching is
  case-sensitive, also on Windows and macOS.

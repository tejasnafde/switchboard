# Security

## Reporting a vulnerability

Report it privately through GitHub:
[Report a vulnerability](https://github.com/tejasnafde/switchboard/security/advisories/new).
Do not open a public issue for it.

Say what an attacker can do, what they need first (a paired phone, local
access, a malicious repository), and how to reproduce it. Expect a first answer
within a week. Fixes ship in the next release, and the advisory is published
once a fixed build is out.

## Supported versions

Only the latest release. Switchboard updates itself, so a fix reaches users
through the normal update channel.

## What counts

Switchboard runs coding agents with your credentials, opens shells, and lets a
paired phone drive them. These matter most:

- A paired phone, or anything on the network, gaining a power its scope denies
  (see `src/shared/device-auth.ts`), such as opening a terminal.
- An agent posting to GitHub or Bitbucket, or messaging another session,
  without the approval card the Switchboard MCP server is meant to show.
- Credentials (provider tokens, Bitbucket app passwords, pairing secrets)
  reaching logs, the settings table, the renderer, or another process's
  command line.
- A file path or git ref from an agent or a repository escaping the project
  folder.

Out of scope: anything that needs the attacker to already run code as your
user on your machine. The embedded IDE (`--auth none` on `127.0.0.1`), the
PTYs and the agents share that trust boundary by design.

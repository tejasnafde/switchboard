# Running the Switchboard backend on a remote VM

Switchboard can run its backend (PTYs, providers, SQLite, files) on a remote
machine and drive it from your laptop over an ssh tunnel. This is the deploy
side of the M4 "machine layer". The app handles connecting; this doc covers what
has to exist on the VM.

## The deploy contract

When you click Connect on a remote machine, the app:

1. allocates a free local port,
2. opens `ssh -L <localPort>:127.0.0.1:8765 <host> "PORT=8765 switchboard-server"`,
3. polls `ws://127.0.0.1:<localPort>` until the backend answers.

So two things must be true on the VM:

- **`switchboard-server` is on the ssh-login PATH** and boots the headless
  backend bound to `$PORT` (default 8765). See `REMOTE_COMMAND` /
  `REMOTE_PORT` in `src/main/machines/connectDeps.ts`.
- **ssh works non-interactively** (key auth; the tunnel uses `BatchMode=yes`).
  An entry in `~/.ssh/config` is the easy path - add the machine in Switchboard
  by its config alias and ssh resolves user/port/key.

## Building and installing the server

The server bundle is Electron-free JavaScript:

```
npm run build:server        # -> out/server/index.cjs
```

Copy `out/server/index.cjs` to the VM. Its native deps (`better-sqlite3`,
`node-pty`) are **not** bundled and must be built for the VM's **Node** ABI (the
dev tree is built for Electron's ABI, which is why full server end-to-end can't
run on the dev laptop). On the VM:

```
mkdir -p ~/switchboard && cd ~/switchboard
# copy index.cjs here, then:
npm init -y
npm install better-sqlite3 node-pty
```

Then put a `switchboard-server` launcher on PATH, e.g. `/usr/local/bin/switchboard-server`:

```sh
#!/bin/sh
exec node "$HOME/switchboard/index.cjs"
```

`chmod +x` it. `PORT` is read from the environment (the tunnel command sets it).

## Environment

- `PORT` - WS listen port (the tunnel sets `8765`; match `REMOTE_PORT`).
- `SWITCHBOARD_DATA_DIR` - where the remote SQLite db + logs live. Defaults to
  `~/.switchboard`; set it explicitly to keep state predictable.
- `SWITCHBOARD_SECRET` - passphrase for encrypting env-mode provider credentials
  at rest. A VM has no OS keychain, so without this, env-mode secrets fall back
  to plaintext on disk (logged as a warning). Set it for any machine that stores
  API keys. See `src/main/crypto/secret-box.ts`.

## Providers (OAuth) on the VM

OAuth lives in each agent CLI's own config dir, and those dirs are **not**
forwarded over the tunnel - the remote backend uses the VM's own logins. So log
in on the VM, in the same home the server runs under:

```
claude        # complete the OAuth flow once
codex login
opencode auth login
```

After that the remote's `ProviderRegistry` resolves instances against the VM's
credentials. Provider/instance switching in the app (the daily plan-hop) works
against a remote session because the switch is just a `startSession` on the
remote backend - it picks the instance from the VM's `provider_instances` table.

Env-mode instances (API keys) are stored in the remote db, encrypted with
`SWITCHBOARD_SECRET`. Manage them from the app's Providers settings while
connected, or seed them on the VM.

## What is not wired yet

- Starting a brand-new chat on a remote project (only opening existing remote
  chats is wired) and remote PTY creation.
- Reconnect/backoff on a dropped tunnel (currently a drop -> `error`, click
  Connect again).

See `docs/notes/remote-machines-handoff.md` for the full state.

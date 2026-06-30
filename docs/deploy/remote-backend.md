# Running the Switchboard backend on a remote VM

Switchboard can run its backend (PTYs, providers, SQLite, files) on a remote
machine and drive it from your laptop over an ssh tunnel. This is the deploy
side of the M4 "machine layer". The app handles connecting; this doc covers what
has to exist on the VM.

## What you provide on the VM

Provisioning is automatic, so the VM only needs:

- **node + npm** on the ssh-login PATH (no compiler needed for common triples -
  prebuilt binaries are used; see below).
- **non-interactive ssh** (key auth; the app uses `BatchMode=yes`). An entry in
  `~/.ssh/config` is the easy path - add the machine by its alias and ssh
  resolves user/port/key.

## What Connect does (auto-provisioning)

On Connect the app:

1. ssh-probes the remote for node + an installed server version marker
   (`~/.switchboard-server/version`).
2. if missing or stale, uploads the server bundle + a generated `package.json`
   and runs `npm install` there. `better-sqlite3` pulls a prebuilt via
   prebuild-install; `node-pty` is aliased to
   `@homebridge/node-pty-prebuilt-multiarch` (ships the linux prebuilds upstream
   node-pty lacks). So no build toolchain is required for common triples.
3. opens `ssh -L <localPort>:127.0.0.1:8765 <host> "PORT=8765 node $HOME/.switchboard-server/index.cjs"`
   and polls `ws://127.0.0.1:<localPort>` until the backend answers.

Relevant code: `src/main/machines/provisioner.ts`, `provisionSetup.ts`,
`provisionDeps.ts`, `connectDeps.ts`. The server bundle ships inside the app
(built by `npm run build:server`, included via `out/**`).

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

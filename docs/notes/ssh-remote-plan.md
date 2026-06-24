# Switchboard Remote (SSH "Connect to Remote") — Implementation Plan

> Reference impl: `pingdotgg/t3code` `packages/ssh` (cloned at `~/.cache/claude/repos/pingdotgg/t3code`).
> **Caveat:** t3code's SSH layer is built on the Effect framework (`Effect.fn`, `ChildProcessSpawner`,
> Effect Service/RPC). Switchboard does **not** use Effect — every "port" below is a *plain Node/TS rewrite*,
> not a verbatim copy. No `ssh2`, no SFTP, no in-process SSH stack: SSH is only a port-forwarding transport.

## Core insight

The renderer never touches `ipcRenderer` directly — it only calls `window.api.*` (defined in `src/preload/index.ts`).
Every method is either `ipcRenderer.invoke(channel, ...args)` (request/response) or `ipcRenderer.on(channel, handler)`
(push). A WS RPC carrying `{channel, args}` frames maps **1:1** onto today's IPC. Remote = same backend, different
transport. The backend "server" is everything `registerXHandlers()` registers, bound to a WS message loop instead
of `ipcMain`.

```
Desktop ──ssh -N -L 127.0.0.1:LOCAL:127.0.0.1:REMOTE host──► remote `node server.js` (HTTP+WS)
         │  renderer hits 127.0.0.1:LOCAL as if local          │ owns PTYs, adapters, file IO, SQLite
         └──── channel-RPC over one WebSocket ──────────────────┘
```

## Phases (dependency order)

| Phase | What | Effort | Blocks |
|---|---|---|---|
| 0 | Renderer transport abstraction (`Transport` iface + `IpcTransport`, no behavior change) | S (1d) | everything |
| 1 | Backend extraction → `BackendHost` (handlers take a host, not `ipcMain`/`BrowserWindow`) | L (4–6d) | 1.5+ |
| 1.5 | Standalone `server.ts` + `WsHost` + `WsTransport`; validate against `127.0.0.1` before any SSH | M (3–4d) | 2,4,5,6 |
| 2 | SSH tunnel manager — plain-Node rewrite of t3code `tunnel.ts` (`-L`, `ExitOnForwardFailure`, `ServerAlive*`) | M (2–3d) | 6 |
| 3 | Host discovery from `~/.ssh/config` (+`Include`) + `known_hosts` — no manual host-entry UI | S–M (2d) | UI |
| 4 | Remote auto-launch script (POSIX `sh` over ssh stdin; node discovery nvm/volta/fnm/mise/asdf; install-and-serve) | M–L (3–5d) | 6 |
| 5 | Pairing-token auth guarding the loopback WS port (token rides inside the SSH channel) | S (1–2d) | 6 |
| 6 | Reconnect / history reattach / remote provider-availability UX | L (4–5d) | — |
| 7 | Integration: connect to `localhost` over ssh end-to-end | M (2–3d) | ship |

**Total ~5–6 weeks.** Critical path 0→1→1.5. Hard gate after 1.5: drive the full app against a locally-spawned
`node server.js` with zero regressions before any SSH code merges.

## Riskiest seams (Phase 1)
1. `ProviderRegistry` holds a `BrowserWindow` + calls DB directly → decouple to `BackendHost`.
2. `app.getPath('userData')` / `app.getAppPath()` coupling in `pty-manager.ts`, `database.ts`, claude adapter →
   inject a `BackendPaths` context; remote fills from `os.homedir()` + a server data dir.
3. `better-sqlite3` + `node-pty` are native → the **remote** server runs under system Node and `npm install`s its own
   native deps at launch. Do **not** ship the Electron-built binary remotely. Local mode stays in-process (no ABI problem).
4. `provider:event` / `terminal:output` are high-frequency → `WsHost.emit` needs an in-order per-connection send queue.
5. `assertCwdReadable` (macOS TCC) is meaningless remotely → no-op when backend platform ≠ darwin.

## Deferred to v2
Relay/cloud hosted pairing; Tailscale endpoint provider; `known_hosts` TOFU prompt UI (rely on system ssh);
password/askpass (assume key auth, `BatchMode`); direct `ws://` pre-existing-server mode; t3code's external/managed
dual-state reuse (simplify to single pid-file reuse).

## Critical files
- `src/preload/index.ts` — transport seam (Phase 0)
- `src/main/index.ts` — backend wiring → `BackendHost` (Phase 1)
- `src/main/provider/provider-registry.ts` — riskiest `BrowserWindow`/DB coupling (Phase 1)
- `src/shared/ipc-channels.ts` — the registry the WS RPC tunnels 1:1 (Phase 1.5/3)
- `src/main/db/database.ts` — Electron `app` path coupling + new `remote_environments` migration (Phase 1/6)

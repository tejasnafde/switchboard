# Remote machines + SSH backend - handoff

Status snapshot for picking this up in a fresh session. Everything below is on
`main` unless noted.

## The goal

Run Switchboard's backend (PTYs, providers, SQLite, files) either locally or on
a remote VM over a WebSocket, and surface remote hosts in the sidebar as a new
top level: **Machine -> Workspace -> Project -> Chat**. UX mock:
`docs/demos/machine-hierarchy.html`.

Key product constraint: provider/instance switching (the daily 5-hour-limit
plan-hop between Claude plans, fallback to Codex/Gemini) MUST survive a remote
backend. Proven in `tests/unit/provider-switch-ws.test.ts`.

## Shipped (merged)

### Remote backend boundary (Phase 1 + 1.5)
- `src/preload/transport.ts` - `Transport` interface + `IpcTransport`.
- `src/shared/transport.ts` - the canonical `Transport` interface.
- `src/main/backend/host.ts` - `BackendHost` + `ElectronIpcHost`. Every IPC
  handler registers against a host, not `ipcMain`, so the same handlers run
  in-process or remote.
- `src/shared/ws-protocol.ts` - wire frames (req/res/snd/evt), JSON codec.
- `src/shared/ws-transport.ts` - client `Transport` over the global `WebSocket`
  (zero dep). Queues pre-open frames, 30s invoke timeout.
- `src/main/backend/ws-host.ts` - server `BackendHost` over `ws`.
- `src/main/runtime.ts` - lazy Electron shim (`userDataDir` / `appRootDir` /
  `getSafeStorage`) so backend modules load headless. Electron is confined to
  `index.ts`, `ipc/app-desktop.ts`, `runtime.ts`, `updater.ts`,
  `protocol/sb-favicon.ts`, `backend/host.ts`.
- `src/main/crypto/secret-box.ts` - passphrase AES-256-GCM for env-mode creds
  on a keychain-less VM (`SWITCHBOARD_SECRET`). `providerInstances` picks
  safeStorage (desktop) -> passphrase (headless) -> plaintext, by blob magic.
- `src/server/index.ts` + `scripts/build-server.mjs` - standalone `node`
  backend over a `WsHost`. `npm run build:server` / `npm run server`.
- `src/preload/hybrid-transport.ts` - when `SWITCHBOARD_BACKEND_URL` is set,
  routes data channels to the remote WS but keeps local-only channels
  (`OPEN_FOLDER`, `EXPORT_MARKDOWN`, `RELAUNCH`, `SET_VIBRANCY`,
  `CHECK_FOR_UPDATES`, all `machines:*`) on Electron IPC. `on` subscribes both.

### Machine layer
- **M1** `src/main/machines/sshConfig.ts` (parser), `src/main/db/machines.ts`
  (CRUD + `machine_snapshots`), `src/main/ipc/machines.ts`, `MachineChannels`,
  `@shared/machines`.
- **M2a** `src/renderer/components/sidebar/machineList.ts` (`buildMachineList`),
  `src/renderer/stores/machine-store.ts`. Hydrated in `App.tsx`.
- **M2b** `src/renderer/components/sidebar/MachineLayer.tsx` (local pinned,
  wraps the workspace tree; remotes as rows), `AddMachineModal.tsx`.
- **M2c** drag-reorder remotes (@dnd-kit; local pinned).
- **M3** `machineSnapshot.ts` (`syncedAgoLabel` / `cachedProjects`),
  `machine_snapshots` table + `saveMachineSnapshot` / `getMachineSnapshots`,
  `machines:get-snapshots`. Offline remotes with a snapshot render a greyed
  read-only tree. NOT YET POPULATED (M4b writes it on connect).
- **M4a** `src/main/machines/sshTunnel.ts` (`buildTunnelCommand`),
  `src/main/machines/connectionStatus.ts` (`nextConnectionStatus` reducer).
  `MachineStatus` gained `'error'` + a red pip.

## What's left: M4b (the big architectural half)

1. **Spawn + health**: a main-process connection manager that, on connect:
   allocate a free local port; `spawn` the tunnel from `buildTunnelCommand`
   (start the remote server bound to a remote port, forwarded to local); poll
   `ws://127.0.0.1:<localPort>` for health; drive `nextConnectionStatus`; emit
   per-machine status events to the renderer (pip goes connecting -> connected).
   `machines:connect` / `machines:disconnect` IPC. Wire the Connect button
   (currently the remote body says "ships in a later update").
2. **Per-machine transport routing** (the hard part): today the renderer has ONE
   transport chosen at preload load. A connected remote's sessions/terminals/
   files need to use THAT machine's `WsTransport` while local stays on IPC.
   Options to weigh: (a) per-window backend (simpler - a window targets one
   machine; matches multi-window habit), (b) true per-session routing (a
   transport registry keyed by the session's machine). Recommend starting with
   (a). This touches how `window.api.*` dispatches - design before coding.
3. **Populate the M3 snapshot on connect**: after connect, scan the remote's
   projects/sessions and call `saveMachineSnapshot` so offline browse works.
4. **OAuth on the VM**: providers log in on the remote (oauth dirs are not
   forwarded), consistent with t3code. Env-mode creds use `SWITCHBOARD_SECRET`.

## Testing

- Unit: `npm test` (959). Machine bits: `ssh-config`, `machines-db`,
  `machine-list`, `machine-store`, `machine-snapshot`, `ssh-tunnel`,
  `connection-status`, `hybrid-transport`, `provider-switch-ws`, `secret-box`,
  `ws-transport`, `headless-server`.
- E2E (need `npm run build` first, macOS desktop or xvfb):
  - `npm run test:e2e` - BackendHost over local IPC (13 checks).
  - `npm run test:e2e:remote` - real app + `SWITCHBOARD_BACKEND_URL` -> stub
    WsHost; proves data channels cross the wire.
  - `npm run test:e2e:machines` - sidebar machine layer renders + Add-machine
    modal opens.
- Native-ABI caveat: the standalone server needs better-sqlite3 / node-pty built
  for the Node ABI (a fresh `npm install` on the VM does this). The dev tree is
  Electron-ABI, so full-server end-to-end can't run locally; `build:server`
  bundling proves the import graph is Electron-free instead.

## Conventions (enforced)

- No em dashes anywhere (code/comments/copy/commits/docs). See CLAUDE.md.
- Pre-commit runs lint-staged eslint + full vitest. CI = typecheck + test +
  build on macOS/Ubuntu/Windows. ALWAYS merge, never rebase.
- Windows CI is CPU-starved and trips vitest's 5s default on spawn-handshake
  tests; bump the file's `testTimeout` (see `codex-adapter.test.ts`) rather than
  chase the flake.

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
- **M4b step 1 (spawn + health)** `src/main/machines/connectionManager.ts`
  (`ConnectionManager` - DI lifecycle, unit-tested) +
  `src/main/machines/connectDeps.ts` (node impls: `allocatePort`, `spawnTunnel`,
  `waitForHealth`; deploy contract = `switchboard-server` on the remote PATH).
  `machines:connect` / `machines:disconnect` / `machines:status` channels, store
  actions + status subscription, and a live Connect/Disconnect button in
  `MachineLayer`. Connecting flips the pip; it does NOT yet route data (step 2).
- **M4b step 2 (per-session routing)** chosen model: ONE window live-mixes local
  + multiple remotes, each call routed to its session's backend.
  - **2a** `src/preload/transport-router.ts` (`TransportRouter`): holds one
    Transport per machine ('local' + a WsTransport per remote), routes
    invoke/send by a resolver, `invokeOn(machineId, ...)` to target one directly,
    and fans `on()` out to every transport (current + future) so events merge.
  - **2b** `src/preload/routing-table.ts` (`RoutingTable`): `resolve(channel,
    args)` keys off arg0 (threadId / terminal id) or `opts.threadId`/`opts.id`;
    create-style calls carry an explicit `opts.machineId`. `window.api.routing.
    {bind,unbind,connectMachine,disconnectMachine,invokeOn}`. `machines:status`
    now carries the local ws URL; the store registers/unregisters a WsTransport
    on connect/disconnect.
- **M4b step 3 (snapshot on connect)** `machineSnapshot.projectsToSnapshot`,
  `machines:save-snapshot`, `machine-store.syncMachine` - on connect the store
  invokes `app:get-projects` ON the remote, trims to `CachedProject[]`, persists
  via `saveMachineSnapshot`, and updates the live tree.
- **M4b step 4 (launch path)** `AgentSession.machineId`; `App.handleSessionSelect`
  takes a `machineId` and `routing.bind(session.id, machineId)`s before any
  backend call (all keyed by `session.id`), so load/createConversation/
  startSession/sendTurn route to the remote; `ChatPanel` re-binds before
  `startSession`. The connected remote tree renders clickable chats
  (`MachineLayer` -> `Sidebar.onSessionSelect` -> `handleSessionSelect`). Provider
  instance + model resolve on the remote's registry (so the plan-hop works once
  creds exist there). NOT e2e-verified locally (native-ABI caveat); unit-tested
  pieces only.

## What's left: M4b

1. **OAuth on the VM**: providers log in on the remote (oauth dirs are not
   forwarded), consistent with t3code. Env-mode creds use `SWITCHBOARD_SECRET`.
   This is a deploy/ops task, verifiable only against a real VM.
2. **Remote terminals + new-chat-on-remote**: the launch path covers opening an
   existing remote chat. Starting a brand-new chat on a remote project and remote
   PTY creation (bind the terminal id at `terminal:create`) are not wired yet.
3. **E2E on a real VM**: stand up `switchboard-server` on a box, validate
   connect -> snapshot -> open remote chat -> provider switch end to end.

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

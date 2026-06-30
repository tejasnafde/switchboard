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
  read-only tree. Populated on connect by `syncMachine` (M4b step 3).
- **M4a** `src/main/machines/sshTunnel.ts` (`buildTunnelCommand`),
  `src/main/machines/connectionStatus.ts` (`nextConnectionStatus` reducer).
  `MachineStatus` gained `'error'` + a red pip.
- **M4b step 1 (spawn + health)** `src/main/machines/connectionManager.ts`
  (`ConnectionManager` - DI lifecycle, unit-tested) +
  `src/main/machines/connectDeps.ts` (node impls: `allocatePort`, `spawnTunnel`,
  `waitForHealth`). `machines:connect` / `machines:disconnect` /
  `machines:status` channels, store actions + status subscription, and a live
  Connect/Disconnect button in `MachineLayer`.
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

### Auto-provisioning (VS Code-style; no manual install)
Connecting to a host now installs the server itself. The VM only needs node +
npm + key-based ssh; no compiler for common triples (prebuilt binaries).
- **P1** `remoteProbe.parseProbeOutput`, `provisionPlan.planProvision`
  (`ready`/`install`/`upgrade`/`no-node`), `provisionCommands.buildProbeCommand`
  + `buildRemoteShellCommand`. `sshHostArgs` factored out of `buildTunnelCommand`.
- **P2** `provisionSetup.ts`: `remotePackageJson` (better-sqlite3 pinned;
  `node-pty` aliased to `@homebridge/node-pty-prebuilt-multiarch` for the linux
  prebuilds upstream lacks) + `remoteInstallScript` (npm install, version marker
  written last). npm's own prebuild-install / bundled prebuilds fetch binaries.
- **P3** `provisioner.ts`: `provisionRemote(machine, inputs, ProcRunner)` -
  probe -> plan -> on install/upgrade: mkdir, `cat >` bundle + package.json, run
  install. DI'd runner, unit-tested.
- **P4** `provisionDeps.ts`: real `child_process` runner + `readServerBundle`
  (from `out/server/index.cjs`, shipped via `out/**`). `ConnectionManager` runs
  `provision` before the tunnel (`no-node`/throw -> error, no tunnel).
  `REMOTE_COMMAND` = `PORT=8765 node $HOME/.switchboard-server/index.cjs`.
  `build` / `build:fast` now run `build:server`. Deploy doc:
  `docs/deploy/remote-backend.md`.

## What's left (pick up here)

None of the remote/provisioning flow is e2e-verified - the dev tree is
Electron-ABI so the headless server can't run locally (native-ABI wall). Order:

1. **E2E on a real VM (do this first - unblocks the rest).** Add a linux box to
   `~/.ssh/config`, Add machine in the sidebar, click Connect. Validate: probe ->
   provision (npm install, prebuilts, no compiler) -> tunnel -> health ->
   `syncMachine` populates the tree -> open a remote chat -> provider/instance
   switch. Most likely break points: (a) node-pty fork version - `REMOTE_NODE_PTY`
   in `provisionSetup.ts` is pinned `^0.12.0`; confirm it installs + is
   API-compatible with `pty-manager.ts`'s spawn/onData/onExit/write/resize/kill,
   bump if not; (b) `SWITCHBOARD_DATA_DIR`/`SWITCHBOARD_SECRET` are read from the
   remote process env - `REMOTE_COMMAND` only sets `PORT`, so set the rest in the
   VM shell profile or extend the launch command.
2. **New-chat-on-remote + remote PTY.** Launch path covers OPENING an existing
   remote chat. Starting a NEW chat on a remote project (sidebar new-chat under a
   remote node -> `createConversation` routed to the machine + `routing.bind`) and
   remote terminals (bind the terminal id at `terminal:create`; `TerminalCreateOptions`
   already accepts `machineId` via the routing resolver) are not wired.
3. **OAuth on the VM.** `claude` / `codex login` / `opencode auth login` in the
   VM's home (oauth dirs are not forwarded). Env-mode creds use
   `SWITCHBOARD_SECRET`. Deploy/ops, validated on the box.
4. **Tunnel reconnect/backoff.** A dropped tunnel -> `error`; reconnect is manual
   (click Connect). `ConnectionManager` is the place; `nextConnectionStatus`
   already has the states.

## Testing

- Unit: `npm test` (1015). Machine bits: `ssh-config`, `machines-db`,
  `machine-list`, `machine-store`, `machine-snapshot`, `ssh-tunnel`,
  `connection-status`, `connection-manager`, `transport-router`, `routing-table`,
  `provision-plan`, `provision-setup`, `provisioner`, `hybrid-transport`,
  `provider-switch-ws`, `secret-box`, `ws-transport`, `headless-server`.
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

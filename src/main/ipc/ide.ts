/**
 * Embedded-IDE IPC: composes the tested pieces (CodeServerManager,
 * BridgeServer, seedBridgeExtension, ensureBinary) behind IdeChannels.
 * One code-server process and one bridge per app, both lazy - nothing
 * spawns until the first ENSURE.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import type { BackendHost } from '../backend/host'
import { IdeChannels } from '@shared/ipc-channels'
import { CodeServerManager, seedBridgeExtension, needsJupyterSeed, JUPYTER_EXTENSION_IDS, type IdeStatus } from '../ide/code-server-manager'
import { patchWorkbenchSettings, themeToColorTheme } from '../ide/settings'
import { ensureBinary } from '../ide/binary'
import { bundledExtensionDir } from '../ide/bundled'
import { BridgeServer } from '../ide/bridge-server'
import { wireBridgeChannels } from '../ide/bridge-channels'
import { allocatePort } from '../machines/connectDeps'
import { assertCwdReadable } from '../path-access'
import { getSetting, setSetting } from '../db/database'
import { createMainLogger } from '../logger'

/** Last port the workbench served on - reused across restarts so the
 *  origin-scoped IndexedDB (extension auth/state) survives. */
const IDE_PORT_SETTING = 'ide.port'

function storedIdePort(): number | undefined {
  const raw = Number(getSetting(IDE_PORT_SETTING))
  return Number.isInteger(raw) && raw > 1024 && raw < 65536 ? raw : undefined
}

function rememberIdePort(port: number): void {
  if (storedIdePort() !== port) setSetting(IDE_PORT_SETTING, String(port))
}

/** One-time Open VSX install of the notebook stack during boot. Failure only
 *  logs - the IDE must still boot (notebooks open as JSON until a later boot). */
async function seedJupyterExtensions(binaryPath: string, extensionsDir: string): Promise<void> {
  if (!needsJupyterSeed(extensionsDir)) return
  log.info('seeding notebook extensions', { ids: JUPYTER_EXTENSION_IDS })
  await new Promise<void>((resolvePromise) => {
    const args = [
      '--extensions-dir',
      extensionsDir,
      ...JUPYTER_EXTENSION_IDS.flatMap((id) => ['--install-extension', id]),
    ]
    const child = spawn(binaryPath, args, { env: process.env })
    let settled = false
    const settle = (): void => {
      if (!settled) {
        settled = true
        resolvePromise()
      }
    }
    const timeout = setTimeout(() => {
      log.warn('notebook extension seed timed out - continuing boot')
      child.kill()
      settle()
    }, 180_000)
    child.stderr.on('data', (d) => log.debug(`ext-seed err: ${String(d).trimEnd()}`))
    child.on('error', (err) => {
      log.warn('notebook extension seed failed to spawn', err)
      clearTimeout(timeout)
      settle()
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code !== 0) log.warn(`notebook extension seed exited ${code}`)
      else log.info('notebook extensions installed')
      settle()
    })
  })
}

const log = createMainLogger('ipc:ide')

interface IdeRuntime {
  manager: CodeServerManager
}

/** Renderer-facing status: manager states plus the one-time download. */
export type IdePublicStatus = IdeStatus | 'downloading'

export function registerIdeHandlers(host: BackendHost): void {
  let runtime: IdeRuntime | null = null
  let booting: Promise<IdeRuntime | null> | null = null
  // Held separately from `runtime`, and assigned the moment it is constructed:
  // `runtime` only lands when boot() resolves, which would leave a window where
  // an extension host could hello into a null bridge and lose its queued open.
  let bridge: BridgeServer | null = null

  const pushStatus = (status: IdePublicStatus, port?: number, pct?: number): void => {
    host.emit(IdeChannels.STATUS, { status, port, pct })
  }

  const settingsPath = (): string =>
    join(app.getPath('userData'), 'code-server', 'data', 'User', 'settings.json')

  /** Merge a patch into the workbench user settings - code-server applies it live. */
  const patchUserSettings = (patch: Record<string, unknown>): void => {
    void patchWorkbenchSettings(settingsPath(), patch, log)
  }

  // OPEN + SET_THEME and the BridgeServer callbacks, shared with the remote
  // host. Lazy getter: the bridge does not exist until the first boot().
  const bridgeCallbacks = wireBridgeChannels(host, { getBridge: () => bridge, settingsPath, log })

  async function boot(skipDownload: boolean): Promise<IdeRuntime | null> {
    const userDataRoot = app.getPath('userData')
    const binaryPath = await ensureBinary(
      userDataRoot,
      (pct) => pushStatus('downloading', undefined, pct ?? undefined),
      { skipDownload }
    )
    if (!binaryPath) return null
    // First-run defaults (autosave, no welcome tab, no trust popup). A merge
    // with an empty patch seeds them only when no settings file exists yet.
    patchUserSettings({})

    const extensionsDir = join(userDataRoot, 'code-server', 'extensions')
    // Jupyter first: --install-extension rewrites extensions.json, and the
    // bridge seeder's manifest clear must run LAST so code-server rescans
    // every folder (a manifest missing sb-bridge marks it removed).
    await seedJupyterExtensions(binaryPath, extensionsDir)
    seedBridgeExtension(bundledExtensionDir(), extensionsDir)

    const bridgePort = await allocatePort()
    const bridgeToken = randomUUID()
    const wss = new WebSocketServer({ host: '127.0.0.1', port: bridgePort })
    bridge = new BridgeServer(wss, bridgeToken, bridgeCallbacks)

    const manager = new CodeServerManager(
      {
        spawn: (bin, args, env) => {
          const child = spawn(bin, args, { env: { ...process.env, ...env } })
          child.stdout.on('data', (d) => log.debug(`code-server: ${String(d).trimEnd()}`))
          child.stderr.on('data', (d) => log.debug(`code-server err: ${String(d).trimEnd()}`))
          child.on('error', (err) => log.error('code-server spawn error', err))
          return child
        },
        allocatePort,
        probeHealth: async (url) => {
          try {
            // Timeout guards a code-server that binds the port but never
            // responds - an un-aborted fetch here hung the ENSURE handler
            // forever (the health poll awaits each probe).
            const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
            return res.ok
          } catch {
            return false
          }
        },
        delay: (ms) => delay(ms),
      },
      {
        binaryPath,
        extensionsDir,
        userDataDir: join(userDataRoot, 'code-server', 'data'),
        env: { SB_BRIDGE_PORT: String(bridgePort), SB_BRIDGE_TOKEN: bridgeToken },
        // Stable workbench origin across restarts: extension state (auth,
        // onboarding flags, kernel picks) lives in origin-scoped IndexedDB.
        ...(storedIdePort() ? { preferredPort: storedIdePort() } : {}),
        // Crash after ready must reach the renderer - a webview pointed at a
        // dead port with no retry affordance is the worst failure mode.
        onExit: () => pushStatus('stopped'),
      }
    )
    return { manager }
  }

  host.handle<[string, { theme?: string; skipDownload?: boolean } | undefined]>(
    IdeChannels.ENSURE,
    async (folder: string, opts?: { theme?: string; skipDownload?: boolean }) => {
      try {
        // TCC pre-flight: also on reuse - a new project folder may be denied
        // even while the server is already up for another one.
        await assertCwdReadable(folder)
        // Theme lands in settings.json BEFORE the workbench first serves the
        // folder, so the first paint is already the right theme (writing it
        // after ready flashed light for seconds until the bridge caught up).
        if (opts?.theme) patchUserSettings({ 'workbench.colorTheme': themeToColorTheme(opts.theme) })
        if (!runtime) {
          booting ??= boot(opts?.skipDownload ?? false)
            .catch((err) => {
              booting = null
              throw err
            })
            .then((rt) => {
              if (!rt) booting = null
              return rt
            })
          runtime = await booting
          if (!runtime) {
            // Prewarm without an installed binary: stay idle silently - the
            // real download happens when the user explicitly opens the pane.
            return { ok: false as const, error: 'binary-not-installed' }
          }
        }
        pushStatus('starting')
        const port = await runtime.manager.ensureStarted()
        rememberIdePort(port)
        pushStatus('ready', port)
        return { ok: true as const, port }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('ide ensure failed', err)
        pushStatus('error')
        return { ok: false as const, error: message }
      }
    }
  )

  host.handle(IdeChannels.STOP, async () => {
    // Idle shutdown: reclaim the server process; the webview blanks renderer-side.
    runtime?.manager.stop()
    pushStatus('stopped')
    return { ok: true }
  })

  app.on('before-quit', () => runtime?.manager.stop())
}

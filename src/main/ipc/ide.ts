/**
 * Embedded-IDE IPC: composes the tested pieces (CodeServerManager,
 * BridgeServer, seedBridgeExtension, ensureBinary) behind IdeChannels.
 * One code-server process and one bridge per app, both lazy - nothing
 * spawns until the first ENSURE.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import type { BackendHost } from '../backend/host'
import { IdeChannels } from '@shared/ipc-channels'
import { CodeServerManager, seedBridgeExtension, type IdeStatus } from '../ide/code-server-manager'
import { mergeUserSettings, themeToColorTheme } from '../ide/settings'
import { ensureBinary } from '../ide/binary'
import { BridgeServer } from '../ide/bridge-server'
import { allocatePort } from '../machines/connectDeps'
import { assertCwdReadable } from '../path-access'
import { writeFileSafe } from '../files/writing'
import { createMainLogger } from '../logger'

const log = createMainLogger('ipc:ide')

interface IdeRuntime {
  manager: CodeServerManager
  bridge: BridgeServer
}

/** Renderer-facing status: manager states plus the one-time download. */
export type IdePublicStatus = IdeStatus | 'downloading'

function bundledExtensionDir(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'sb-bridge'),
    join(app.getAppPath(), 'resources', 'sb-bridge'),
  ]
  const found = candidates.find((p) => p && existsSync(p))
  if (!found) throw new Error(`sb-bridge extension not found in: ${candidates.join(', ')}`)
  return found
}

export function registerIdeHandlers(host: BackendHost): void {
  let runtime: IdeRuntime | null = null
  let booting: Promise<IdeRuntime | null> | null = null
  /** Latest unrouted open per folder - flushed on that workbench's hello. */
  const pendingOpens = new Map<string, { path: string; line?: number; endLine?: number }>()

  const pushStatus = (status: IdePublicStatus, port?: number, pct?: number): void => {
    host.emit(IdeChannels.STATUS, { status, port, pct })
  }

  const settingsPath = (): string =>
    join(app.getPath('userData'), 'code-server', 'data', 'User', 'settings.json')

  /** Merge a patch into the workbench user settings - code-server applies it live. */
  const patchUserSettings = (patch: Record<string, unknown>): void => {
    const p = settingsPath()
    mkdirSync(join(p, '..'), { recursive: true })
    let existing: string | null = null
    try {
      existing = readFileSync(p, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('settings read failed', err)
      existing = null
    }
    const merged = mergeUserSettings(existing, patch)
    if (merged === null) {
      // Unparseable (JSONC hand edits) - never clobber; the bridge push still
      // applies live changes through the workbench's own config service.
      log.warn('settings.json unparseable - skipping file write', { path: p })
      return
    }
    // Atomic temp-then-rename: code-server live-watches this file and must
    // never see a torn write.
    void writeFileSafe(p, merged, {}).then((res) => {
      if (!res.ok) log.warn('settings write failed', res.error)
    })
  }

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
    seedBridgeExtension(bundledExtensionDir(), extensionsDir)

    const bridgePort = await allocatePort()
    const bridgeToken = randomUUID()
    const wss = new WebSocketServer({ host: '127.0.0.1', port: bridgePort })
    const bridge = new BridgeServer(wss, bridgeToken, {
      onSelection: (msg) => host.emit(IdeChannels.SELECTION, msg),
      onTerminalRequest: () => {
        log.info('workbench terminal intent forwarded')
        host.emit(IdeChannels.TERMINAL_REQUEST)
      },
      // Pill clicks while the workbench is still booting are stashed and
      // flushed when its extension host dials home.
      onHello: (folder) => {
        const pending = pendingOpens.get(folder)
        if (pending) {
          pendingOpens.delete(folder)
          bridge.openFile(folder, pending.path, pending.line, pending.endLine)
        }
      },
    })

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
            const res = await fetch(url)
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
        // Crash after ready must reach the renderer - a webview pointed at a
        // dead port with no retry affordance is the worst failure mode.
        onExit: () => pushStatus('stopped'),
      }
    )
    return { manager, bridge }
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

  host.handle<[{ folder: string; path: string; line?: number; endLine?: number }]>(
    IdeChannels.OPEN,
    async ({ folder, path, line, endLine }) => {
      const absPath = isAbsolute(path) ? path : resolve(folder, path)
      const routed = runtime?.bridge.openFile(folder, absPath, line, endLine) ?? false
      if (!routed) {
        // Workbench cold or booting: remember the intent, flush on hello.
        pendingOpens.set(folder, { path: absPath, line, endLine })
        log.info('ide open queued - workbench not connected yet', { folder })
      }
      return { ok: routed }
    }
  )

  host.handle<[string]>(IdeChannels.SET_THEME, async (theme: string) => {
    try {
      const patch = { 'workbench.colorTheme': themeToColorTheme(theme) }
      // Prefer the bridge push: the extension's config.update persists to the
      // same settings.json through the workbench's own writer (JSONC-safe, no
      // second-writer race). Fall back to the file only when no workbench is
      // connected to carry it.
      const delivered = runtime?.bridge.broadcastConfig(patch) ?? 0
      if (delivered === 0) patchUserSettings(patch)
      return { ok: true }
    } catch (err) {
      log.warn('set-theme failed', err)
      return { ok: false }
    }
  })

  host.handle(IdeChannels.STOP, async () => {
    // Idle shutdown: reclaim the server process; the webview blanks renderer-side.
    runtime?.manager.stop()
    pushStatus('stopped')
    return { ok: true }
  })

  app.on('before-quit', () => runtime?.manager.stop())
}

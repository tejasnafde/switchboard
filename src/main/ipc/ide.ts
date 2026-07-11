/**
 * Embedded-IDE IPC: composes the tested pieces (CodeServerManager,
 * BridgeServer, seedBridgeExtension, ensureBinary) behind IdeChannels.
 * One code-server process and one bridge per app, both lazy - nothing
 * spawns until the first ENSURE.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  let booting: Promise<IdeRuntime> | null = null

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
    } catch {
      existing = null
    }
    writeFileSync(p, mergeUserSettings(existing, patch))
  }

  async function boot(): Promise<IdeRuntime> {
    const userDataRoot = app.getPath('userData')
    const binaryPath = await ensureBinary(userDataRoot, (pct) =>
      pushStatus('downloading', undefined, pct ?? undefined)
    )
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
      }
    )
    return { manager, bridge }
  }

  host.handle<[string]>(IdeChannels.ENSURE, async (folder: string) => {
    try {
      // TCC pre-flight: also on reuse - a new project folder may be denied
      // even while the server is already up for another one.
      await assertCwdReadable(folder)
      if (!runtime) {
        booting ??= boot().catch((err) => {
          booting = null
          throw err
        })
        runtime = await booting
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
  })

  host.handle<[{ folder: string; path: string; line?: number; endLine?: number }]>(
    IdeChannels.OPEN,
    async ({ folder, path, line, endLine }) => {
      const absPath = isAbsolute(path) ? path : resolve(folder, path)
      const routed = runtime?.bridge.openFile(folder, absPath, line, endLine) ?? false
      if (!routed) log.warn('ide open not routed - no extension host for folder', { folder })
      return { ok: routed }
    }
  )

  host.handle<[string]>(IdeChannels.SET_THEME, async (theme: string) => {
    try {
      const patch = { 'workbench.colorTheme': themeToColorTheme(theme) }
      // File write covers the next boot; the bridge push applies it to any
      // live workbench immediately (the file watcher alone is unreliable).
      patchUserSettings(patch)
      runtime?.bridge.broadcastConfig(patch)
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

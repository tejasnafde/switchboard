/**
 * code-server lifecycle: spawn-arg construction, release-asset lookup, and
 * bridge-extension seeding for the single per-app server.
 * See docs/plans/2026-07-10-embedded-ide-design.md.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Folder name follows VS Code's <publisher>.<name>-<version> install convention. */
export const BRIDGE_EXTENSION_DIRNAME = 'switchboard.sb-bridge-0.0.1'

/**
 * Copy the bundled sb-bridge extension into code-server's --extensions-dir.
 * A stale extensions.json (or .obsolete) left by a previous server run marks
 * folders it does not list as removed, so both are cleared - code-server
 * rebuilds them from the folder scan on next boot. Idempotent.
 */
export function seedBridgeExtension(bundledDir: string, extensionsDir: string): void {
  mkdirSync(extensionsDir, { recursive: true })
  cpSync(bundledDir, join(extensionsDir, BRIDGE_EXTENSION_DIRNAME), { recursive: true, force: true })
  rmSync(join(extensionsDir, 'extensions.json'), { force: true })
  rmSync(join(extensionsDir, '.obsolete'), { force: true })
}

export const CODE_SERVER_VERSION = '4.127.0'

/** GitHub release asset suffix per (platform, arch). Windows has no standalone build. */
const ASSET_SUFFIX: Record<string, string> = {
  'darwin-arm64': 'macos-arm64',
  'darwin-x64': 'macos-amd64',
  'linux-x64': 'linux-amd64',
  'linux-arm64': 'linux-arm64',
}

export interface DownloadAsset {
  assetName: string
  url: string
}

export function resolveDownloadAsset(version: string, platform: string, arch: string): DownloadAsset {
  const suffix = ASSET_SUFFIX[`${platform}-${arch}`]
  if (!suffix) {
    throw new Error(`code-server has no standalone build for unsupported platform ${platform}/${arch}`)
  }
  const assetName = `code-server-${version}-${suffix}.tar.gz`
  return {
    assetName,
    url: `https://github.com/coder/code-server/releases/download/v${version}/${assetName}`,
  }
}

export interface SpawnArgOpts {
  port: number
  extensionsDir: string
  userDataDir: string
}

export function buildSpawnArgs(opts: SpawnArgOpts): string[] {
  return [
    '--auth',
    'none',
    '--bind-addr',
    `127.0.0.1:${opts.port}`,
    '--extensions-dir',
    opts.extensionsDir,
    '--user-data-dir',
    opts.userDataDir,
  ]
}

export type IdeStatus = 'stopped' | 'starting' | 'ready' | 'error'

/** Minimal child-process surface the manager needs; keeps tests binary-free. */
export interface ChildLike {
  on(event: 'exit', cb: (code: number | null) => void): void
  kill(): void
}

export interface ManagerDeps {
  spawn(binaryPath: string, args: string[], env: NodeJS.ProcessEnv): ChildLike
  allocatePort(): Promise<number>
  probeHealth(url: string): Promise<boolean>
  delay(ms: number): Promise<void>
}

export interface ManagerConfig {
  binaryPath: string
  extensionsDir: string
  userDataDir: string
  env: NodeJS.ProcessEnv
}

const HEALTH_RETRIES = 30
const HEALTH_INTERVAL_MS = 200
const SPAWN_ATTEMPTS = 2 // initial + one retry on early exit (EADDRINUSE)

export class CodeServerManager {
  status: IdeStatus = 'stopped'
  private child: ChildLike | null = null
  private port: number | null = null
  private starting: Promise<number> | null = null

  constructor(
    private deps: ManagerDeps,
    private cfg: ManagerConfig
  ) {}

  /** Spawn if not running; concurrent callers share one boot. */
  async ensureStarted(): Promise<number> {
    if (this.child && this.port !== null) return this.port
    if (this.starting) return this.starting
    this.status = 'starting'
    this.starting = this.boot().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  stop(): void {
    const child = this.child
    this.child = null
    this.port = null
    this.status = 'stopped'
    child?.kill()
  }

  private async boot(): Promise<number> {
    let lastErr: Error = new Error('code-server failed to start')
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const port = await this.deps.allocatePort()
      let exited = false
      const child = this.deps.spawn(
        this.cfg.binaryPath,
        buildSpawnArgs({ port, extensionsDir: this.cfg.extensionsDir, userDataDir: this.cfg.userDataDir }),
        this.cfg.env
      )
      child.on('exit', () => {
        exited = true
        // Crash after ready: forget the process so the next open respawns.
        if (this.child === child) {
          this.child = null
          this.port = null
          this.status = 'stopped'
        }
      })
      try {
        await this.waitHealthy(port, () => exited)
        this.child = child
        this.port = port
        this.status = 'ready'
        return port
      } catch (err) {
        lastErr = err as Error
        // Snapshot before kill(): kill itself fires 'exit' and would otherwise
        // masquerade as an early exit worth retrying.
        const exitedOnItsOwn = exited
        if (!exitedOnItsOwn) child.kill()
        // Early exit (code-server exits 1 cleanly on EADDRINUSE): retry once
        // on a fresh port. A health timeout with a live process is not retried.
        if (!exitedOnItsOwn) break
      }
    }
    this.status = 'error'
    throw lastErr
  }

  private async waitHealthy(port: number, hasExited: () => boolean): Promise<void> {
    const url = `http://127.0.0.1:${port}/healthz`
    for (let i = 0; i < HEALTH_RETRIES; i++) {
      if (hasExited()) throw new Error('code-server exited during boot')
      const healthy = await this.deps.probeHealth(url)
      // Re-check after the await: the process may have died mid-probe.
      if (hasExited()) throw new Error('code-server exited during boot')
      if (healthy) return
      await this.deps.delay(HEALTH_INTERVAL_MS)
    }
    throw new Error(`code-server /healthz never succeeded on port ${port}`)
  }
}

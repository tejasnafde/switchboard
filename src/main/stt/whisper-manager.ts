/**
 * whisper-server lifecycle, copied from CodeServerManager's discipline
 * (src/main/ide/code-server-manager.ts): injected spawn/port/health deps so
 * tests run binary-free, EADDRINUSE retry-once, capped health poll, respawn on
 * the next ensureStarted after a crash. Two deltas from code-server:
 *   - the health poll is longer, because whisper loads a ~574 MB model before
 *     it binds the port;
 *   - the manager owns idle shutdown (15 min after the last transcription),
 *     because unlike the IDE there is no renderer pane watching visibility.
 * Same-user trust boundary as code-server: 127.0.0.1, no auth (see the
 * embedded-IDE security ADR).
 */

export type WhisperStatus = 'stopped' | 'starting' | 'ready' | 'error'

/** Minimal child-process surface the manager needs; keeps tests binary-free. */
export interface ChildLike {
  on(event: 'exit', cb: (code: number | null) => void): void
  kill(): void
}

export interface WhisperManagerDeps {
  spawn(binaryPath: string, args: string[], env: NodeJS.ProcessEnv): ChildLike
  allocatePort(): Promise<number>
  probeHealth(url: string): Promise<boolean>
  delay(ms: number): Promise<void>
}

export interface WhisperManagerConfig {
  binaryPath: string
  modelPath: string
  env: NodeJS.ProcessEnv
  /** Fired when a READY server exits on its own (not via stop()). */
  onExit?: () => void
  /** Override for tests. Default 15 minutes. */
  idleStopMs?: number
}

export function buildWhisperServerArgs(opts: { port: number; modelPath: string }): string[] {
  return [
    '--host',
    '127.0.0.1',
    '--port',
    String(opts.port),
    '--model',
    opts.modelPath,
    // Auto-detect keeps dictation working in the device locale; the vocabulary
    // prompt still biases identifier spelling either way.
    '--language',
    'auto',
  ]
}

const HEALTH_RETRIES = 240
const HEALTH_INTERVAL_MS = 500
const SPAWN_ATTEMPTS = 2 // initial + one retry on early exit (EADDRINUSE)
export const WHISPER_IDLE_STOP_MS = 15 * 60 * 1000

export class WhisperServerManager {
  status: WhisperStatus = 'stopped'
  private child: ChildLike | null = null
  private port: number | null = null
  private starting: Promise<number> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private deps: WhisperManagerDeps,
    private cfg: WhisperManagerConfig,
  ) {}

  /** Spawn if not running; concurrent callers share one boot. */
  async ensureStarted(): Promise<number> {
    if (this.child && this.port !== null) {
      this.touch()
      return this.port
    }
    if (this.starting) return this.starting
    this.status = 'starting'
    this.starting = this.boot().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** Reset the idle-shutdown clock. Called after each transcription. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (!this.child) return
    this.idleTimer = setTimeout(() => this.stop(), this.cfg.idleStopMs ?? WHISPER_IDLE_STOP_MS)
    // A pending idle stop must not pin a headless server process open.
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
  }

  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const child = this.child
    this.child = null
    this.port = null
    this.status = 'stopped'
    child?.kill()
  }

  private async boot(): Promise<number> {
    let lastErr: Error = new Error('whisper-server failed to start')
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const port = await this.deps.allocatePort()
      let exited = false
      const child = this.deps.spawn(
        this.cfg.binaryPath,
        buildWhisperServerArgs({ port, modelPath: this.cfg.modelPath }),
        this.cfg.env,
      )
      child.on('exit', () => {
        exited = true
        // Crash after ready: forget the process so the next call respawns.
        if (this.child === child) {
          this.child = null
          this.port = null
          this.status = 'stopped'
          if (this.idleTimer) {
            clearTimeout(this.idleTimer)
            this.idleTimer = null
          }
          this.cfg.onExit?.()
        }
      })
      try {
        await this.waitHealthy(port, () => exited)
        this.child = child
        this.port = port
        this.status = 'ready'
        this.touch()
        return port
      } catch (err) {
        lastErr = err as Error
        // Snapshot before kill(): kill itself fires 'exit' and would otherwise
        // masquerade as an early exit worth retrying.
        const exitedOnItsOwn = exited
        if (!exitedOnItsOwn) child.kill()
        // Early exit (EADDRINUSE) retries once on a fresh port. A health
        // timeout with a live process is not retried.
        if (!exitedOnItsOwn) break
      }
    }
    this.status = 'error'
    throw lastErr
  }

  /**
   * whisper-server has no /healthz; it binds the port only after the model is
   * loaded, so any HTTP answer at all means ready. The poll is capped high
   * because a cold large model takes tens of seconds to load.
   */
  private async waitHealthy(port: number, hasExited: () => boolean): Promise<void> {
    const url = `http://127.0.0.1:${port}/`
    for (let i = 0; i < HEALTH_RETRIES; i++) {
      if (hasExited()) throw new Error('whisper-server exited during boot')
      const healthy = await this.deps.probeHealth(url)
      // Re-check after the await: the process may have died mid-probe.
      if (hasExited()) throw new Error('whisper-server exited during boot')
      if (healthy) return
      await this.deps.delay(HEALTH_INTERVAL_MS)
    }
    throw new Error(`whisper-server never answered on port ${port}`)
  }
}

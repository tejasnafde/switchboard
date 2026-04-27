import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { IPty } from 'node-pty'
import type { TerminalCreateOptions } from '@shared/types'

/**
 * Prepare a ZDOTDIR for zsh shells so our keybinding fixes apply without
 * touching the user's real ~/.zshrc. The staged .zshrc sources the
 * user's real config first, then appends our bindkey / word-style
 * additions.
 *
 * Runs once at first PTY spawn per app launch; the directory lives at
 * `<userData>/shell/`.
 */
let cachedZdotdir: string | null = null
function ensureZdotdir(): string | null {
  if (cachedZdotdir) return cachedZdotdir
  try {
    // Stage the zshrc in userData so zsh has a writable, stable path.
    const dir = join(app.getPath('userData'), 'shell')
    mkdirSync(dir, { recursive: true })
    // In dev, `app.getAppPath()` is the repo root. When packaged, it's
    // the asar archive — Node can still read files out of it.
    const src = join(app.getAppPath(), 'resources', 'shell', 'switchboard.zshrc')
    if (!existsSync(src)) return null
    const contents = readFileSync(src, 'utf-8')
    writeFileSync(join(dir, '.zshrc'), contents)
    cachedZdotdir = dir
    return dir
  } catch {
    return null
  }
}

export type PtyDataCallback = (id: string, data: string) => void
export type PtyExitCallback = (id: string, exitCode: number, signal?: number) => void

interface ManagedPty {
  pty: IPty
  id: string
}

/**
 * Resolve a working shell path.
 *
 * Electron doesn't always inherit the user's env, so process.env.SHELL
 * can be empty or point to a non-existent path. Fall through a priority
 * list per platform.
 *
 * On Windows we prefer PowerShell 7 (`pwsh.exe`) when present, then
 * Windows PowerShell, then COMSPEC (which the system populates with
 * `cmd.exe` on virtually every install). We can't probe `existsSync`
 * for the bare names because Windows resolves them via PATH at spawn
 * time — node-pty handles this correctly when given the basename.
 */
function resolveShell(requested?: string): string {
  if (process.platform === 'win32') {
    if (requested) return requested
    // Honor an explicit override from the environment (rare, but useful
    // for users who set up a Cygwin/MSYS bash they prefer).
    if (process.env.SHELL) return process.env.SHELL
    // node-pty on Windows accepts a basename; ConPTY resolves it against
    // PATH. We do not pre-validate because PATH lookup at spawn time is
    // far more reliable than guessing install locations.
    return process.env.COMSPEC || 'powershell.exe'
  }

  const candidates = [
    requested,
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh',
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return '/bin/sh'
}

/**
 * Manages PTY lifecycle — create, write, resize, kill.
 * Keeps no reference to Electron; IPC layer wires events to the window.
 */
export class PtyManager {
  private ptys = new Map<string, ManagedPty>()
  private onData: PtyDataCallback
  private onExit: PtyExitCallback

  constructor(onData: PtyDataCallback, onExit: PtyExitCallback) {
    this.onData = onData
    this.onExit = onExit
  }

  async create(opts: TerminalCreateOptions): Promise<void> {
    // Dynamic import — node-pty is a native module, keep it lazy
    const pty = await import('node-pty')

    const shell = resolveShell(opts.shell)
    const isWin = process.platform === 'win32'
    // For zsh, point ZDOTDIR at our staged config so keybindings work
    // out-of-the-box. Non-zsh shells spawn untouched. The ZDOTDIR setup
    // is POSIX-only (depends on `/Users/...` paths and zsh semantics);
    // skip it on Windows where the shell is PowerShell or cmd.
    const envOverrides: Record<string, string> = {}
    if (!isWin && shell.endsWith('/zsh')) {
      const zdotdir = ensureZdotdir()
      if (zdotdir) envOverrides.ZDOTDIR = zdotdir
    }
    // Spawn zsh/bash as a login shell so /etc/zprofile + ~/.zprofile (and
    // bash's ~/.bash_profile) run. Electron processes launched from Finder
    // don't inherit the user's interactive PATH; without -l, Homebrew's
    // shellenv (which lives in ~/.zprofile on Apple Silicon) is skipped
    // and tools like `carapace`/`starship` referenced from ~/.zshrc fail
    // with "command not found." Terminal.app and iTerm both default to
    // login shells for this exact reason.
    const loginArgs =
      !isWin && (shell.endsWith('/zsh') || shell.endsWith('/bash'))
        ? ['-l']
        : []
    const instance = pty.spawn(shell, loginArgs, {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...envOverrides, ...opts.env } as Record<string, string>,
      // ConPTY (Win10 1809+) gives full ANSI/VT support and is the only
      // backend node-pty uses on modern Windows; opt-in is explicit.
      // No-op on POSIX.
      ...(isWin ? { useConpty: true } : {}),
    })

    const managed: ManagedPty = { pty: instance, id: opts.id }
    this.ptys.set(opts.id, managed)

    instance.onData((data) => this.onData(opts.id, data))
    instance.onExit(({ exitCode, signal }) => {
      this.ptys.delete(opts.id)
      this.onExit(opts.id, exitCode, signal)
    })

    // Run initial command after shell has time to initialize
    if (opts.initialCommand) {
      setTimeout(() => {
        if (this.ptys.has(opts.id)) {
          instance.write(opts.initialCommand + '\n')
        }
      }, 500)
    }
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.ptys.get(id)?.pty.resize(cols, rows)
  }

  kill(id: string): void {
    const managed = this.ptys.get(id)
    if (!managed) return
    managed.pty.kill()
    this.ptys.delete(id)
  }

  killAll(): void {
    for (const [id] of this.ptys) {
      this.kill(id)
    }
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }
}

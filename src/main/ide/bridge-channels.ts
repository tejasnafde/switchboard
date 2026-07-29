/**
 * The sb-bridge WIRE behaviour, shared by both workbench hosts.
 *
 * The two hosts differ in lifecycle, not protocol: locally ipc/ide.ts owns the
 * binary download, CodeServerManager and idle shutdown; on a VM the ssh
 * bootstrap spawns code-server and ide/bridge-host.ts only has to answer the
 * extension. What must stay identical is everything below - the callback set,
 * the one-pending-open-per-folder rule, and the theme write precedence - because
 * both feed the same IdeChannels and the same renderer handlers.
 *
 * Electron-free: this is bundled into out/server/index.cjs.
 */
import { isAbsolute, resolve } from 'node:path'
import { IdeChannels } from '@shared/ipc-channels'
import type { BackendHost } from '../backend/host'
import type { BridgeCallbacks, BridgeServer } from './bridge-server'
import { patchWorkbenchSettings, themeToColorTheme } from './settings'

/** The subset of the scoped logger this module uses. */
export interface BridgeLog {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

export interface BridgeChannelDeps {
  /** Resolved lazily: the local host creates its bridge during an async boot. */
  getBridge: () => BridgeServer | null
  /** Absolute path to the workbench's User/settings.json on THIS machine. */
  settingsPath: () => string
  log: BridgeLog
}

/**
 * Register the bridge-backed IPC handlers (OPEN, SET_THEME) and return the
 * callbacks to hand to `new BridgeServer(...)`. Owns the pending-open queue.
 */
export function wireBridgeChannels(host: BackendHost, deps: BridgeChannelDeps): BridgeCallbacks {
  const { getBridge, settingsPath, log } = deps
  /** Latest unrouted open per folder - flushed on that workbench's hello. */
  const pendingOpens = new Map<string, { path: string; line?: number; endLine?: number }>()

  host.handle<[{ folder: string; path: string; line?: number; endLine?: number }]>(
    IdeChannels.OPEN,
    async ({ folder, path, line, endLine }) => {
      const absPath = isAbsolute(path) ? path : resolve(folder, path)
      const routed = getBridge()?.openFile(folder, absPath, line, endLine) ?? false
      if (!routed) {
        // Workbench cold or booting: remember the intent, flush on hello.
        pendingOpens.set(folder, { path: absPath, line, endLine })
        log.info('ide open queued - workbench not connected yet', { folder })
      }
      return { ok: routed }
    },
  )

  host.handle<[{ theme: string }]>(IdeChannels.SET_THEME, async ({ theme }) => {
    try {
      const patch = { 'workbench.colorTheme': themeToColorTheme(theme) }
      // Prefer the bridge push: the extension's config.update persists to the
      // same settings.json through the workbench's own writer (JSONC-safe, no
      // second-writer race). Fall back to the file only when no workbench is
      // connected to carry it.
      if ((getBridge()?.broadcastConfig(patch) ?? 0) === 0) {
        await patchWorkbenchSettings(settingsPath(), patch, log)
      }
      return { ok: true }
    } catch (err) {
      log.warn('set-theme failed', err)
      return { ok: false }
    }
  })

  return {
    onSelection: (msg) => host.emit(IdeChannels.SELECTION, msg),
    onTerminalRequest: () => {
      log.info('workbench terminal intent forwarded')
      host.emit(IdeChannels.TERMINAL_REQUEST)
    },
    onDsModeRequest: () => {
      log.info('workbench data-scientist-mode intent forwarded')
      host.emit(IdeChannels.DS_MODE_REQUEST)
    },
    // Pill clicks while the workbench is still booting are stashed and
    // flushed when its extension host dials home.
    onHello: (folder) => {
      const bridge = getBridge()
      if (!bridge) return
      const pending = pendingOpens.get(folder)
      if (pending) {
        pendingOpens.delete(folder)
        bridge.openFile(folder, pending.path, pending.line, pending.endLine)
      } else {
        // Fresh workbench with no queued file: land on the file explorer.
        // Otherwise VS Code restores the last-active viewlet, which a
        // third-party extension (Atlassian/Bitbucket) may have grabbed.
        // ponytail: viewlet is restore-based, so one focus on boot holds;
        // if an extension actively re-steals, move this to a per-reveal push.
        bridge.focusExplorer(folder)
      }
    },
  }
}

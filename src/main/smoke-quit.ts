/**
 * `--smoke-quit`: the post-launch half of the smoke test. The boot smoke
 * (`--smoke-test`) exits before anything is opened, so it never runs the quit
 * teardown. This one does a real startup, opens what a user's session holds
 * at quit (PTYs through the renderer's own IPC path, file watchers, the
 * database), then asks the app to quit the way a user does.
 * `scripts/smoke-quit.mjs` launches it and checks the exit and the teardown.
 */
import type { BrowserWindow } from 'electron'
import { watchLaunchConfig } from './launch-config/launch-config-store'
import { watchHead } from './git/head-watcher'
import type { ShutdownStepReport } from './shutdown-sequence'
import { createMainLogger } from './logger'

const log = createMainLogger('smoke')

export const SMOKE_QUIT_FLAG = '--smoke-quit'
const TERMINALS = 2
const OPEN_TIMEOUT_MS = 20_000

export function isQuitSmoke(): boolean {
  return process.argv.includes(SMOKE_QUIT_FLAG)
}

let sessionOpened = false

/** Logged (so on stdout) for the launcher to parse, only if the session opened. */
export function reportQuitSmoke(reports: ShutdownStepReport[]): void {
  if (!sessionOpened) return
  log.info(`[smoke-quit] shutdown ${JSON.stringify(reports)}`)
}

export async function runQuitSmoke(window: BrowserWindow, quit: () => void): Promise<void> {
  const projectDir = process.env.SB_SMOKE_PROJECT
  if (!projectDir) throw new Error('SB_SMOKE_PROJECT is not set')
  if (window.webContents.isLoading()) {
    await new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()))
  }
  watchLaunchConfig(projectDir)
  await watchHead(projectDir, () => {})
  // Through window.api, so the PTYs are created exactly as a terminal pane does.
  const opened = await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const ids = Array.from({ length: ${TERMINALS} }, (_, i) => 'smoke-quit-' + i)
      const seen = new Set()
      const off = window.api.terminal.onOutput((id) => {
        if (!ids.includes(id)) return
        seen.add(id)
        if (seen.size === ids.length) { off(); resolve(seen.size) }
      })
      setTimeout(() => reject(new Error('terminals printed nothing within ${OPEN_TIMEOUT_MS}ms')), ${OPEN_TIMEOUT_MS})
      for (const id of ids) {
        window.api.terminal.create({ id, cwd: ${JSON.stringify(projectDir)}, cols: 80, rows: 24 }).catch(reject)
      }
    })
  `)
  log.info(`[smoke-quit] ${opened} terminals live, quitting`)
  sessionOpened = true
  quit()
}

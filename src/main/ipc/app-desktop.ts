/**
 * Desktop-only IPC handlers: native dialogs (folder picker, save dialog), app
 * lifecycle (relaunch), and window vibrancy. They need Electron's app / dialog /
 * BrowserWindow, so they can't run on a headless backend - registered on
 * ipcMain in the Electron main process only, never on the WsHost.
 */
import { ipcMain, dialog, app, type BrowserWindow } from 'electron'
import { basename } from 'path'
import { writeFile } from 'fs/promises'
import { AppChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import { scanAllSessions } from '../projects/session-scanner'
import { addProject, getArchivedConversationIds } from '../db/database'
import { claudeCandidateDirs } from '../provider/claude-session-migrate'
import type { Project } from '@shared/types'

const log = createLogger('ipc:app-desktop')

export type ResolvedTheme = 'dark' | 'light' | 'translucent'

export function applyMacWindowTheme(
  window: BrowserWindow,
  theme: ResolvedTheme,
  fullscreen = window.isFullScreen(),
): void {
  if (process.platform !== 'darwin') return
  if (theme === 'translucent' && !fullscreen) {
    // The visual-effect view is created with the BrowserWindow and must stay
    // alive; frame invalidation makes AppKit composite it after first paint.
    window.setVibrancy('sidebar')
    window.setBackgroundColor('#00000000')
    const bounds = window.getBounds()
    window.setBounds({ ...bounds, height: bounds.height + 1 })
    window.setBounds(bounds)
    return
  }
  // Keep the construction-time visual-effect view and transparent backing
  // alive. Opaque renderer surfaces cover them in Dark, Light, and fullscreen.
  window.setBackgroundColor('#00000000')
}

export function restoreMacWindowGlass(window: BrowserWindow): void {
  if (process.platform !== 'darwin' || window.isDestroyed() || window.isFullScreen()) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- null clears vibrancy (Electron types lag)
  window.setVibrancy(null as any)
  applyMacWindowTheme(window, 'translucent', false)
}

export function registerAppDesktopHandlers(window: BrowserWindow): void {
  ipcMain.removeHandler(AppChannels.OPEN_FOLDER)
  ipcMain.removeHandler(AppChannels.EXPORT_MARKDOWN)
  ipcMain.removeHandler(AppChannels.RELAUNCH)
  ipcMain.removeHandler(AppChannels.SET_VIBRANCY)

  ipcMain.handle(AppChannels.OPEN_FOLDER, async () => {
    log.info('open-folder dialog')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Add Project Folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const folderPath = result.filePaths[0]
    const name = basename(folderPath)
    log.info(`folder selected: ${folderPath}`)

    addProject(folderPath, name)

    const rawSessions = await scanAllSessions(folderPath, claudeCandidateDirs())
    const archivedSet = getArchivedConversationIds()
    const sessions = rawSessions.filter((s) => !archivedSet.has(s.id))
    log.info(`found ${sessions.length} sessions for ${folderPath} (${rawSessions.length - sessions.length} archived)`)

    const project: Project = { path: folderPath, name, sessions, workspaceId: null }
    return project
  })

  ipcMain.handle(AppChannels.RELAUNCH, () => {
    log.info('relaunching app...')
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle(AppChannels.EXPORT_MARKDOWN, async (_event, params: { suggestedFilename: string; content: string }) => {
    const result = await dialog.showSaveDialog(window, {
      title: 'Export Conversation',
      defaultPath: params.suggestedFilename,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      await writeFile(result.filePath, params.content, 'utf-8')
      log.info(`exported markdown: ${result.filePath}`)
      return { ok: true, path: result.filePath }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      log.error(`export failed: ${message}`)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(AppChannels.SET_VIBRANCY, (_event, theme: 'dark' | 'light' | 'translucent') => {
    if (window.isDestroyed()) return
    applyMacWindowTheme(window, theme)
    if (process.platform === 'darwin' && theme === 'translucent' && window.isFullScreen()) {
      window.webContents.send('app:fullscreen-changed', true)
    }
  })
}

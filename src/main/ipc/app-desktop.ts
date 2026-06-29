/**
 * Desktop-only IPC handlers: native dialogs (folder picker, save dialog), app
 * lifecycle (relaunch), and window vibrancy. They need Electron's app / dialog /
 * BrowserWindow, so they can't run on a headless backend — registered on
 * ipcMain in the Electron main process only, never on the WsHost.
 */
import { ipcMain, dialog, app, type BrowserWindow } from 'electron'
import { basename } from 'path'
import { writeFile } from 'fs/promises'
import { AppChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import { scanAllSessions } from '../projects/session-scanner'
import { addProject, getArchivedConversationIds } from '../db/database'
import { claudeCandidateDirs } from './app'
import type { Project } from '@shared/types'

const log = createLogger('ipc:app-desktop')

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

  ipcMain.handle(AppChannels.SET_VIBRANCY, (_event, enabled: boolean) => {
    if (window.isDestroyed()) return
    if (process.platform === 'darwin') {
      if (enabled) {
        window.setVibrancy('sidebar')
        window.setBackgroundColor('#00000000')
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron types reject null but it is the documented way to clear vibrancy
        window.setVibrancy(null as any)
        window.setBackgroundColor('#0a0a0a')
      }
    }
  })
}

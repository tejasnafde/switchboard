/**
 * The desktop side of the agent's `preview_visual`: main asks its window to
 * draw the block (`VisualPreviewChannels.REQUEST`), and the window answers
 * with the image (`RESULT`). The window draws it as a hidden live page in the
 * preview sandbox (renderer `services/visual-preview.ts`), so every rule of
 * `preview-session.ts` applies: no network, no Node, bundled libraries only.
 */
import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import { VisualPreviewChannels } from '@shared/ipc-channels'
import type { VisualPreviewRequest, VisualPreviewResult } from '@shared/visual-preview'
import { createMainLogger } from '../logger'
import { setVisualPreviewRenderer } from '../mcp/visual-preview-tool'

const log = createMainLogger('preview:visual')

export function registerVisualPreviewHost(getWindow: () => BrowserWindow | null): void {
  const pending = new Map<string, { senderId: number; resolve: (result: VisualPreviewResult) => void }>()

  ipcMain.removeHandler(VisualPreviewChannels.RESULT)
  ipcMain.handle(VisualPreviewChannels.RESULT, (event, id: unknown, result: unknown) => {
    const entry = typeof id === 'string' ? pending.get(id) : undefined
    // Only the window that was asked may answer.
    if (!entry || entry.senderId !== event.sender.id) return
    pending.delete(id as string)
    entry.resolve(result as VisualPreviewResult)
  })

  setVisualPreviewRenderer((request: VisualPreviewRequest, signal: AbortSignal) => {
    const win = getWindow()
    if (!win || win.isDestroyed())
      return Promise.resolve({ ok: false, error: 'Preview is not available: no Switchboard window is open.' })
    const id = randomUUID()
    return new Promise<VisualPreviewResult>((resolve) => {
      pending.set(id, { senderId: win.webContents.id, resolve })
      signal.addEventListener('abort', () => {
        if (!pending.delete(id)) return
        log.debug('preview dropped', { kind: request.kind })
        if (!win.isDestroyed()) win.webContents.send(VisualPreviewChannels.CANCEL, id)
      })
      win.webContents.send(VisualPreviewChannels.REQUEST, id, request)
    })
  })
}

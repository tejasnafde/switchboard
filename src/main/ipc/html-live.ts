/**
 * Backend side of inline live pages (```html-live): the still image the
 * desktop captured and the Save as file path, by source hash, so phones can
 * show a page they never run. Runs on every backend (desktop and headless).
 */
import { HtmlLiveChannels } from '@shared/ipc-channels'
import {
  isHtmlLiveImage,
  isHtmlLiveImageKey,
  isHtmlLiveOpenRequest,
  isHtmlLiveSavedPath,
  type HtmlLiveState,
} from '@shared/html-live'
import type { BackendHost } from '../backend/host'
import { getHtmlLivePage, updateHtmlLivePage } from '../db/database'
import { createMainLogger } from '../logger'

const log = createMainLogger('ipc:html-live')

export function registerHtmlLiveHandlers(host: BackendHost): void {
  host.handle(HtmlLiveChannels.LOAD, (key: unknown): HtmlLiveState => {
    if (!isHtmlLiveImageKey(key)) return { image: null, savedPath: null }
    try {
      return getHtmlLivePage(key)
    } catch (err) {
      log.warn('live page read failed', err)
      return { image: null, savedPath: null }
    }
  })

  host.handle(HtmlLiveChannels.UPDATE, (key: unknown, patch: unknown): { ok: boolean } => {
    if (!isHtmlLiveImageKey(key) || typeof patch !== 'object' || patch === null) return { ok: false }
    const { image, savedPath } = patch as { image?: unknown; savedPath?: unknown }
    if (image !== undefined && !isHtmlLiveImage(image)) return { ok: false }
    if (savedPath !== undefined && !isHtmlLiveSavedPath(savedPath)) return { ok: false }
    if (image === undefined && savedPath === undefined) return { ok: false }
    try {
      updateHtmlLivePage(key, { image, savedPath })
      return { ok: true }
    } catch (err) {
      log.warn('live page write failed', err)
      return { ok: false }
    }
  })

  // A phone cannot run the page; a desktop window on this backend opens it in its pane.
  host.handle(HtmlLiveChannels.OPEN_ON_DESKTOP, (request: unknown): { ok: boolean } => {
    if (!isHtmlLiveOpenRequest(request)) return { ok: false }
    log.info('live page open requested', { bytes: Buffer.byteLength(request.source, 'utf8') })
    host.emit(HtmlLiveChannels.OPEN_REQUEST, request)
    return { ok: true }
  })
}

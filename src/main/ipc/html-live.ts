/**
 * Backend side of inline live pages (```html-live): the still image the
 * desktop captured and the Save as file path, by source hash, so phones can
 * show a page they never run. Runs on every backend (desktop and headless).
 */
import { HtmlLiveChannels } from '@shared/ipc-channels'
import {
  HTML_LIVE_OPEN_LIMIT,
  HTML_LIVE_OPEN_WINDOW_MS,
  htmlLiveOpenLimitMessage,
  isHtmlLiveImage,
  isHtmlLiveImageKey,
  isHtmlLiveOpenRequest,
  isHtmlLiveSavedPath,
  type HtmlLiveState,
} from '@shared/html-live'
import type { BackendHost } from '../backend/host'
import { currentBackendRequestContext } from '../backend/request-context'
import { getHtmlLivePage, updateHtmlLivePage } from '../db/database'
import { createMainLogger } from '../logger'
import { AgentWriteBudget } from '../mcp/agent-write-budget'

const log = createMainLogger('ipc:html-live')

export function registerHtmlLiveHandlers(host: BackendHost): void {
  // The same sliding window as an agent's pull request writes, keyed by the phone's device session.
  const openBudget = new AgentWriteBudget(HTML_LIVE_OPEN_LIMIT, HTML_LIVE_OPEN_WINDOW_MS)

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
  host.handle(HtmlLiveChannels.OPEN_ON_DESKTOP, (request: unknown): { ok: boolean; error?: string } => {
    if (!isHtmlLiveOpenRequest(request)) return { ok: false }
    const context = currentBackendRequestContext()
    if (context?.transport === 'remote') {
      const charge = openBudget.take(context.deviceSessionId ?? context.clientScope)
      if (!charge.ok) {
        log.warn('live page open refused, rate limited', { waitS: charge.waitS })
        return { ok: false, error: htmlLiveOpenLimitMessage(charge.waitS) }
      }
    }
    log.info('live page open requested', { bytes: Buffer.byteLength(request.source, 'utf8') })
    host.emit(HtmlLiveChannels.OPEN_REQUEST, request)
    return { ok: true }
  })
}

/**
 * "Open on desktop" from a phone: a backend pushes `HtmlLiveChannels.OPEN_REQUEST`
 * and this window opens the page in its preview pane, in that chat.
 */
import { useEffect } from 'react'
import { htmlLiveFileName, isHtmlLiveOpenRequest } from '@shared/html-live'
import { useAgentStore } from '../stores/agent-store'
import { useLayoutStore } from '../stores/layout-store'
import { htmlLiveKey } from './html-live-theme'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('chat:html-live-open')

export function useHtmlLiveOpenRequests(): void {
  useEffect(() => {
    return window.api.htmlLive.onOpenRequest((machineId, request) => {
      if (!isHtmlLiveOpenRequest(request)) {
        log.warn('live page open request refused')
        return
      }
      const remote = machineId === 'local' ? null : machineId
      const session = useAgentStore
        .getState()
        .sessions.find(
          (s) =>
            s.id === request.conversationId && (s.machineId && s.machineId !== 'local' ? s.machineId : null) === remote,
        )
      void htmlLiveKey(request.source).then(
        (key) => {
          useLayoutStore.getState().openHtmlPreview({
            path: htmlLiveFileName(request.title),
            root: session?.worktreePath ?? session?.projectPath ?? '',
            machineId: remote,
            sessionId: session?.id ?? null,
            live: { key, source: request.source, title: request.title },
          })
        },
        (err: unknown) => log.warn('live page open request failed', err),
      )
    })
  }, [])
}

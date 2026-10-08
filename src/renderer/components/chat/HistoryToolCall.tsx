import { useRef, useState } from 'react'
import type { ToolCall } from '@shared/types'
import { createRendererLogger } from '../../logger'
import { perfSpan } from '../../perf'
import { ToolCallBlock } from './ToolCallBlock'

const log = createRendererLogger('chat:history-tool-call')

// Rows unmount as the list scrolls; keep recent calls so reopening one does
// not fetch it again. ponytail: count-capped, a byte budget if calls grow.
const MAX_LOADED = 32
const loaded = new Map<string, ToolCall>()

function remember(key: string, call: ToolCall): void {
  loaded.delete(key)
  loaded.set(key, call)
  if (loaded.size > MAX_LOADED) loaded.delete(loaded.keys().next().value as string)
}

/**
 * A tool call from a history load with `toolPreviews` is shortened. The first
 * click on it (expanding it) loads the whole call, which then replaces the
 * preview. `contents` keeps the wrapper out of the layout.
 */
export function HistoryToolCall({ toolCall, sessionId, messageId }: { toolCall: ToolCall; sessionId?: string; messageId: string }) {
  const key = sessionId ? `${sessionId}\0${messageId}\0${toolCall.id}` : ''
  const [full, setFull] = useState<ToolCall | null>(() => (toolCall.preview && loaded.get(key)) || null)
  const requested = useRef(false)

  // A call that was still running when it loaded has finished since: load it again.
  const current = full && !(full.output === undefined && toolCall.output !== undefined) ? full : null

  const load = () => {
    if (!toolCall.preview || !sessionId || current || requested.current) return
    requested.current = true
    const span = perfSpan('chat.load-tool-call', { thread: sessionId })
    window.api.app.loadToolCall(sessionId, messageId, toolCall.id)
      .then((result) => {
        requested.current = false
        span.end({ outcome: result?.toolCall ? 'loaded' : 'missing' })
        if (!result?.toolCall) {
          log.warn('history tool call not found', { sessionId, messageId, toolCallId: toolCall.id })
          return
        }
        remember(key, result.toolCall)
        setFull(result.toolCall)
      })
      .catch((err) => {
        span.end({ outcome: 'error' })
        requested.current = false
        log.warn('history tool call load failed', { sessionId, messageId, err })
      })
  }

  return (
    <div className="contents" onClickCapture={load}>
      <ToolCallBlock toolCall={current ?? toolCall} />
    </div>
  )
}

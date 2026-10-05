import type { ChatLoadDiagnostics } from '@shared/perf-chat'
import type { ChatMessage } from '@shared/types'
import type { PerfFields, PerfSpan } from '@shared/perf-timing'
import { perfSpan } from '../perf'

let pending: { span: PerfSpan; thread: string; messages?: ChatMessage[]; fields?: PerfFields } | undefined
const committed = new Map<string, ChatMessage[]>()

export function beginChatOpen(thread: string) {
  pending?.span.end({ outcome: 'superseded' })
  const span = perfSpan('chat.open', { thread })
  pending = { span, thread }
  return {
    ready(target: string, messages: ChatMessage[], fields: PerfFields = {}, load: ChatLoadDiagnostics | null = {}) {
      if (pending?.span !== span) return
      if (!load || load.loadStatus === 'error' || load.loadStatus === 'missing') {
        span.end({ outcome: load?.loadStatus === 'missing' ? 'load-missing' : 'load-error' })
        pending = undefined
        return
      }
      pending = { span, thread: target, messages, fields }
      if (committed.get(target) === messages) finishChatOpen(target, messages)
    },
    cancel(outcome: string) {
      span.end({ outcome })
      if (pending?.span === span) pending = undefined
    },
  }
}

function finishChatOpen(thread: string, messages: ChatMessage[]) {
  const open = pending
  if (!open || open.thread !== thread || open.messages !== messages) return
  requestAnimationFrame(() => {
    if (pending !== open || committed.get(thread) !== messages) return
    open.span.end({ ...open.fields, messages: messages.length, outcome: 'rendered' })
    pending = undefined
  })
}

export function chatMessagesCommitted(thread: string, messages: ChatMessage[], visible = true) {
  if (!visible) {
    committed.delete(thread)
    return
  }
  const previous = committed.get(thread)
  committed.set(thread, messages)
  const loaded = pending?.thread === thread ? pending.messages : undefined
  if (loaded && loaded !== messages && (previous === loaded || extendsLoaded(loaded, messages))) {
    pending = { ...pending!, messages }
  }
  finishChatOpen(thread, messages)
}

/** A store replacement that landed before the loaded array committed still starts
 *  with the loaded messages. ponytail: an empty load has nothing to match, so its
 *  span waits for cancel or the next open; this is timing only. */
function extendsLoaded(loaded: ChatMessage[], messages: ChatMessage[]): boolean {
  return loaded.length > 0 && messages.length >= loaded.length && loaded.every((m, i) => messages[i]?.id === m.id)
}

export function chatMessagesUnmounted(thread: string) {
  committed.delete(thread)
  if (pending?.thread === thread) {
    pending.span.end({ outcome: 'unmounted' })
    pending = undefined
  }
}

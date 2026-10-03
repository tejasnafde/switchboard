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
    ready(target: string, messages: ChatMessage[], fields: PerfFields = {}) {
      if (pending?.span !== span) return
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
    if (pending !== open || !committed.has(thread)) return
    open.span.end({ ...open.fields, messages: messages.length, outcome: 'rendered' })
    pending = undefined
  })
}

export function chatMessagesCommitted(thread: string, messages: ChatMessage[], visible = true) {
  if (!visible) {
    committed.delete(thread)
    return
  }
  committed.set(thread, messages)
  finishChatOpen(thread, messages)
}

export function chatMessagesUnmounted(thread: string) {
  committed.delete(thread)
  if (pending?.thread === thread) {
    pending.span.end({ outcome: 'unmounted' })
    pending = undefined
  }
}

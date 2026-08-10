import type { ChatMessage } from '@shared/types'
import { fmtDuration } from '@shared/format'

export type TurnPresentationItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'activity'; messages: ChatMessage[]; toolCount: number }
  | { kind: 'files'; messages: ChatMessage[] }

export function activitySummaryLabel(toolCount: number, durationMs?: number): string {
  const tools = `Used ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`
  const duration = durationMs === undefined ? undefined : fmtDuration(durationMs).replace(/\.0s$/, 's')
  return duration === undefined ? tools : `${tools} · ${duration}`
}

function isToolOnly(message: ChatMessage): boolean {
  return !!message.toolCalls?.length
    && !message.content
    && !message.images?.length
    && !message.approval
    && !message.plan
    && !message.todos?.items.length
    && !message.question
    && !message.fileDiff
    && !message.denial
}

function itemKind(message: ChatMessage): TurnPresentationItem['kind'] {
  if (isToolOnly(message)) return 'activity'
  if (message.fileDiff && !message.content) return 'files'
  return 'message'
}

export function projectTurnPresentation(messages: ChatMessage[]): TurnPresentationItem[] {
  const items: TurnPresentationItem[] = []

  for (const message of messages) {
    const kind = itemKind(message)
    const previous = items.at(-1)

    if (kind === 'activity' && previous?.kind === 'activity') {
      previous.messages.push(message)
      previous.toolCount += message.toolCalls?.length ?? 0
    } else if (kind === 'files' && previous?.kind === 'files') {
      previous.messages.push(message)
    } else if (kind === 'activity') {
      items.push({ kind, messages: [message], toolCount: message.toolCalls?.length ?? 0 })
    } else if (kind === 'files') {
      items.push({ kind, messages: [message] })
    } else {
      items.push({ kind, message })
    }
  }

  return items
}

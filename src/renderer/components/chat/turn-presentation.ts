import type { ChatMessage } from '@shared/types'
import { fmtDuration } from '@shared/format'

export type TurnPresentationItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'activity'; messages: ChatMessage[]; toolCount: number }
  | { kind: 'files'; messages: ChatMessage[] }

export function changedFilesLabel(fileCount: number): string {
  return `Changed ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`
}

/** A changed-files group renders expanded when the user opted in globally,
 *  or expanded just this turn's group via the collapsed toggle button. */
export function isFilesGroupExpanded(
  showFileDiffCards: boolean,
  expandedGroups: ReadonlySet<string>,
  groupKey: string,
): boolean {
  return showFileDiffCards || expandedGroups.has(groupKey)
}

/** If `isTarget` matches a message inside a collapsed changed-files group of
 *  this turn, returns that group's key so the caller can expand it before
 *  scrolling to the message. Returns null when there's no match, or the
 *  matching group is already expanded. */
export function findCollapsedFilesGroupKey(
  messages: ChatMessage[],
  isTarget: (message: ChatMessage) => boolean,
  showFileDiffCards: boolean,
  expandedGroups: ReadonlySet<string>,
): string | null {
  for (const item of projectTurnPresentation(messages)) {
    if (item.kind !== 'files' || !item.messages.some(isTarget)) continue
    const groupKey = item.messages[0].id
    return isFilesGroupExpanded(showFileDiffCards, expandedGroups, groupKey) ? null : groupKey
  }
  return null
}

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

import { visibleUserMessageText } from '@shared/provider-events'
import { pillBodyText } from '@shared/pill-body-text'
import { splitSyntheticUserText } from '@shared/synthetic-message'
import { systemRowView } from '@shared/system-markers'
import { parseMergeBackMarker } from '@shared/merge-back'
import type { ChatMessage } from '@shared/types'
import type { FeedItem } from '../stores/chat'

type UserItem = Extract<FeedItem, { kind: 'user' }>

/**
 * Background-task notifications and interrupts ride the user role in a
 * provider transcript: they get their own rows, and only the typed remainder
 * stays a bubble. Drops an item left with neither text nor images.
 */
export function splitTranscriptUserItem(item: UserItem): FeedItem[] {
  const split = splitSyntheticUserText(item.text)
  const rows: FeedItem[] = (split?.parts ?? []).map((part, i) => ({ kind: 'synthetic', id: `${item.id}-s${i}`, part, at: item.at }))
  const text = split ? split.userText : item.text
  if (text.trim() || item.images?.length) rows.push({ ...item, text })
  return rows
}

/**
 * Caches written before synthetic rows existed hold history user rows
 * unsplit, and they render whenever a history load fails.
 * ponytail: the cache never recorded whether a row's text was typed, so every
 * history row (`h-` id) counts as transcript here; a typed one that starts
 * with a marker is misread until the next history load reseeds the feed.
 */
export function splitLegacyCachedItems(items: FeedItem[]): FeedItem[] {
  return items.flatMap((item) => (item.kind === 'user' && item.id.startsWith('h-') ? splitTranscriptUserItem(item) : [item]))
}

/** Map backend history into the same rows used by the live event reducer. */
export function historyToItems(messages: ChatMessage[]): FeedItem[] {
  const items: FeedItem[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const urls = (message.images ?? []).map((image) => image.url).filter(Boolean)
      const visible = visibleUserMessageText(message.content, message.displayBody)
      const text = visible !== null && message.displayBody !== undefined ? pillBodyText(visible, message.pillsMeta) : visible
      // Context-only text is hidden, but images sent with it still show.
      if (text === null && urls.length === 0) continue
      const item: UserItem = {
        kind: 'user',
        id: `h-${message.id}`,
        text: text ?? '',
        at: message.timestamp,
        images: urls.length > 0 ? urls : undefined,
      }
      // Only provider transcript text is classified. A typed displayBody that
      // starts with a marker such as "[Request interrupted by user]" is the
      // user's own words and stays a bubble.
      items.push(...(message.displayBody === undefined ? splitTranscriptUserItem(item) : [item]))
      continue
    }
    if (message.role === 'system') {
      items.push(systemRowItem(message.id, message.content))
      continue
    }
    if (message.content.trim()) {
      items.push({
        kind: 'text', id: `h-${message.id}`, text: message.content,
        stream: 'assistant', done: true,
      })
    }
    for (const tool of message.toolCalls ?? []) {
      items.push({
        kind: 'tool', id: `h-${message.id}-t-${tool.id}`,
        toolName: tool.name, input: tool.input, output: tool.output, state: 'done',
      })
    }
    const diff = message.fileDiff
    if (diff) {
      // Same id as the live row, so a reload and a live event coalesce.
      items.push({
        kind: 'fileEdit', id: `f-${diff.fileEditId}`, relPath: diff.relPath,
        changeKind: diff.changeKind, oldContent: diff.oldContent, newContent: diff.newContent,
      })
    }
  }
  return items
}

/** A stored system row as a feed item; a live event for the same row uses the same id. */
export function systemRowItem(messageId: string, content: string): FeedItem {
  const id = `h-${messageId}`
  const mergeBack = parseMergeBackMarker(content)
  if (mergeBack) return { kind: 'mergeBack', id, messageId, row: mergeBack }
  const view = systemRowView(content)
  if (view.kind === 'peer-undelivered') return { kind: 'undelivered', id, messageId, row: view.row }
  if (view.kind === 'error') return { kind: 'error', id, message: view.message }
  return { kind: 'notice', id, text: view.body ? `${view.title}: ${view.body}` : view.title }
}

function historyItemIdentity(item: FeedItem): string {
  if (item.kind === 'text' && item.id.startsWith('h-')) return `m-${item.id.slice(2)}-${item.stream}`
  if (item.kind === 'tool' && item.id.startsWith('h-')) return `t-${item.id.slice(item.id.lastIndexOf('-t-') + 3)}`
  if (item.kind === 'user' && item.id.startsWith('h-remote_')) return item.id.slice(2)
  return item.id
}

/** A history response must retain rows that arrived while it was in flight. */
export function mergeHistoryItems(history: FeedItem[], live: FeedItem[]): FeedItem[] {
  const result = [...history]
  const indexes = new Map(result.map((item, index) => [historyItemIdentity(item), index]))
  for (const item of live) {
    const identity = historyItemIdentity(item)
    const index = indexes.get(identity)
    if (index === undefined) {
      indexes.set(identity, result.length)
      result.push(item)
    } else {
      const previous = result[index]
      result[index] = previous.kind === 'text' && item.kind === 'text' && previous.text.includes(item.text)
        ? { ...item, text: previous.text } : item
    }
  }
  return result
}

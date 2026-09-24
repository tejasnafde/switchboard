import { visibleUserMessageText } from '@shared/provider-events'
import { splitSyntheticUserText } from '@shared/synthetic-message'
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
  const rows: FeedItem[] = (split?.parts ?? []).map((part, i) => ({ kind: 'synthetic', id: `${item.id}-s${i}`, part }))
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
      const text = visibleUserMessageText(message.content, message.displayBody)
      if (text === null) continue
      const item: UserItem = {
        kind: 'user',
        id: `h-${message.id}`,
        text,
        at: message.timestamp,
        images: urls.length > 0 ? urls : undefined,
      }
      // Only provider transcript text is classified. A typed displayBody that
      // starts with a marker such as "[Request interrupted by user]" is the
      // user's own words and stays a bubble.
      items.push(...(message.displayBody === undefined ? splitTranscriptUserItem(item) : [item]))
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
  }
  return items
}

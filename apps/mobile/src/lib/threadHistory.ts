import { visibleUserMessageText } from '@shared/provider-events'
import { splitSyntheticUserText } from '@shared/synthetic-message'
import type { ChatMessage } from '@shared/types'
import type { FeedItem } from '../stores/chat'

/** Map backend history into the same rows used by the live event reducer. */
export function historyToItems(messages: ChatMessage[]): FeedItem[] {
  const items: FeedItem[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const urls = (message.images ?? []).map((image) => image.url).filter(Boolean)
      const visible = visibleUserMessageText(message.content, message.displayBody)
      // Background-task notifications and interrupts ride the user role;
      // they get their own rows and only the typed remainder is a bubble.
      const split = message.displayBody === undefined && visible !== null ? splitSyntheticUserText(visible) : null
      split?.parts.forEach((part, i) => items.push({ kind: 'synthetic', id: `h-${message.id}-s${i}`, part }))
      const text = split ? split.userText : visible
      if (text !== null && (text.trim() || urls.length > 0)) {
        items.push({
          kind: 'user',
          id: `h-${message.id}`,
          text,
          at: message.timestamp,
          images: urls.length > 0 ? urls : undefined,
        })
      }
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

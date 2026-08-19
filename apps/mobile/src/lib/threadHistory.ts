import { visibleUserMessageText } from '@shared/provider-events'
import type { ChatMessage } from '@shared/types'
import type { FeedItem } from '../stores/chat'

/** Map backend history into the same rows used by the live event reducer. */
export function historyToItems(messages: ChatMessage[]): FeedItem[] {
  const items: FeedItem[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const urls = (message.images ?? []).map((image) => image.url).filter(Boolean)
      const text = visibleUserMessageText(message.content, message.displayBody)
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

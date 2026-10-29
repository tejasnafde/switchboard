/**
 * Every archive of a conversation, whoever wrote it (the sidebar, a kanban
 * card moved to Done), tells the listeners after the row is written. The
 * registry registers its cleanup here (`notifyConversationArchived`), so the
 * db layer never imports the provider layer and no caller can forget it.
 */
import { createMainLogger } from '../logger'

const log = createMainLogger('db:archive')

type ArchiveListener = (conversationId: string) => void
const listeners = new Set<ArchiveListener>()

export function onConversationArchived(listener: ArchiveListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitConversationArchived(conversationId: string): void {
  for (const listener of listeners) {
    try {
      listener(conversationId)
    } catch (err) {
      log.warn(`an archive listener failed for ${conversationId}`, err)
    }
  }
}

/**
 * Saved-secret masking for everything the backend writes to or reads from the
 * `messages` table (`secrets/secret-redactor.ts`). Every writer of a message's
 * text goes through `maskStoredText`, so neither a row nor the FTS index the
 * triggers fill ever holds a live value. One map lookup when no secret is live.
 */
import { getDb } from './database'
import { resolveRootThreadId } from './conversations'
import { secretRedactor, type SecretScope } from '../secrets/secret-redactor'

/** Fork chains are short; this only stops a corrupt cycle. */
const MAX_FORK_DEPTH = 32

/**
 * The root ids whose secrets apply to a conversation: its own root, then the
 * root of each chat it was forked from. A fork's transcript starts with a copy
 * of its parent's, so the parent's live values must be masked there too.
 */
export function secretScope(conversationId: string): string[] {
  const parentOf = getDb().prepare('SELECT parent_conversation_id AS parent FROM conversations WHERE id = ?')
  const roots: string[] = []
  let current: string | null = conversationId
  while (current !== null && roots.length < MAX_FORK_DEPTH) {
    const root = resolveRootThreadId(current)
    if (roots.includes(root)) break
    roots.push(root)
    current = (parentOf.get(root) as { parent: string | null } | undefined)?.parent ?? null
  }
  return roots
}

/** The armed scope of a conversation, or null when none of its chats holds a live secret. */
export function armedSecretScope(conversationId: string): SecretScope | null {
  if (!secretRedactor.any()) return null
  const scope = secretScope(conversationId)
  return secretRedactor.armed(scope) ? scope : null
}

/** `text` with the conversation's live secrets masked. */
export function maskStoredText(conversationId: string, text: string): string
export function maskStoredText(conversationId: string, text: string | null): string | null
export function maskStoredText(conversationId: string, text: string | null): string | null {
  if (text === null) return null
  const scope = armedSecretScope(conversationId)
  return scope === null ? text : (secretRedactor.redactText(scope, text) ?? text)
}

/** Every string inside `value` masked the same way; the same object when nothing matched. */
export function maskStoredValue<T>(conversationId: string, value: T): T {
  const scope = armedSecretScope(conversationId)
  return scope === null ? value : secretRedactor.redactDeep(scope, value).value
}

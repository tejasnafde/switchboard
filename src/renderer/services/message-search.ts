import { MESSAGE_SEARCH_LIMIT, orderMessageSearchResults, type MessageSearchResult } from '@shared/message-search'
import { withTimeout } from '@shared/promise-timeout'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('search:messages')

/** A backend that takes longer than this to answer costs only its own hits. */
const SEARCH_TARGET_TIMEOUT_MS = 8000

/** A search hit and the machine whose backend holds that chat. */
export interface MachineSearchHit extends MessageSearchResult {
  machineId: string
}

export interface SearchTarget {
  machineId: string
  search: (query: string) => Promise<MessageSearchResult[] | null | undefined>
}

/**
 * Search every given backend at once (this machine and each connected remote)
 * and merge the hits into one list in the shared display order. A backend
 * that fails or answers late costs only its own hits.
 */
export async function searchMessagesOnMachines(
  query: string,
  targets: readonly SearchTarget[],
): Promise<MachineSearchHit[]> {
  const answers = await Promise.all(
    targets.map(async (target) => {
      try {
        const hits = await withTimeout(
          target.search(query),
          SEARCH_TARGET_TIMEOUT_MS,
          `message search on ${target.machineId}`,
        )
        return (hits ?? []).map((hit): MachineSearchHit => ({ ...hit, machineId: target.machineId }))
      } catch (err) {
        log.warn('message search failed on a machine', { machineId: target.machineId, err })
        return []
      }
    }),
  )
  return orderMessageSearchResults(answers.flat()).slice(0, MESSAGE_SEARCH_LIMIT)
}

/**
 * The chat a search hit's find should run in: the hit's own chat when it is
 * the one now focused, else null (the open failed or another open replaced
 * it), so the find never lands in an unrelated chat.
 */
export function searchHitShownId(
  hit: Pick<MessageSearchResult, 'conversationId'>,
  focusedId: string | null,
): string | null {
  return focusedId === hit.conversationId ? focusedId : null
}

export interface SearchHitReadyDeps {
  /** The chat now focused, read fresh (it can change while history loads). */
  focusedId: () => string | null
  /** The hit's chat's currently loaded rows, or undefined if it isn't open. */
  sessionMessages: (conversationId: string) => readonly { id: string }[] | undefined
  /** The full-history path cmd+F already uses, keyed by conversation id. */
  ensureFullHistory: (conversationId: string) => Promise<boolean>
}

/**
 * The chat id to report once a search hit's chat is open AND its message is
 * loaded - not just once the chat is focused. A hit that predates the newest
 * history window isn't in the session's rows right after it opens, so load
 * the rest here (the same path cmd+F uses) before telling the modal the hit
 * is ready, instead of leaving the jump to land only if something else
 * happens to load the rest later.
 *
 * Still resolves to the focused id when the full load cannot find the
 * message (an edge case: a deleted row, a cursor the backend no longer has),
 * so the in-pane find still opens and falls back to its nearest match rather
 * than silently doing nothing. Resolves to null when another hit, or a
 * manual navigation, moved focus elsewhere while history loaded, so the jump
 * never lands in a chat the user is no longer looking at.
 */
export async function searchHitReadyId(
  hit: Pick<MessageSearchResult, 'conversationId' | 'messageId'>,
  deps: SearchHitReadyDeps,
): Promise<string | null> {
  const shownId = searchHitShownId(hit, deps.focusedId())
  if (!shownId) return null
  const alreadyLoaded = deps.sessionMessages(shownId)?.some((m) => m.id === hit.messageId)
  if (!alreadyLoaded) await deps.ensureFullHistory(shownId)
  return searchHitShownId(hit, deps.focusedId())
}

import {
  MESSAGE_SEARCH_LIMIT,
  orderMessageSearchResults,
  type MessageSearchResult,
} from '@shared/message-search'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('search:messages')

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
  const answers = await Promise.all(targets.map(async (target) => {
    try {
      const hits = await target.search(query)
      return (hits ?? []).map((hit): MachineSearchHit => ({ ...hit, machineId: target.machineId }))
    } catch (err) {
      log.warn('message search failed on a machine', { machineId: target.machineId, err })
      return []
    }
  }))
  return orderMessageSearchResults(answers.flat()).slice(0, MESSAGE_SEARCH_LIMIT)
}

/**
 * The chat a search hit's find should run in: the hit's own chat when it is
 * the one now focused, else null (the open failed or another open replaced
 * it), so the find never lands in an unrelated chat.
 */
export function searchHitShownId(hit: Pick<MessageSearchResult, 'conversationId'>, focusedId: string | null): string | null {
  return focusedId === hit.conversationId ? focusedId : null
}

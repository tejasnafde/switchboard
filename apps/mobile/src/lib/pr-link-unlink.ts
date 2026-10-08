/**
 * Unlinks a pull request from a chat and says why it did not, so the screen
 * can show the user every failure, not only a refusal from the backend.
 */
import { createLogger } from '@shared/logger'
import type { PrLinkResult } from '@shared/pull-request-links'
import type { PrRef } from '@shared/pull-requests'

const log = createLogger('lib:pr-link-unlink')

export interface PrUnlinkClient {
  unlinkPullRequest(threadId: string, ref: PrRef): Promise<PrLinkResult>
}

/** Resolves to `null` once unlinked, or to the message to show; never rejects. */
export async function unlinkPrLink(
  client: PrUnlinkClient | null | undefined,
  threadId: string,
  ref: PrRef,
): Promise<string | null> {
  if (!client) return 'This connection is not open. Reconnect, then try again.'
  try {
    const result = await client.unlinkPullRequest(threadId, ref)
    return result.ok ? null : result.message
  } catch (err) {
    log.warn('unlinking a pull request failed', err)
    return 'The request did not reach the backend. Check the connection, then try again.'
  }
}

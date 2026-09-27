import type { PrLinkResult } from '@shared/pull-request-links'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('reviews:links')

/**
 * A chat picked for review context when the PR has no linked chat is linked
 * first; the context is delivered only once that link holds. Returns the
 * reason to show when it did not, `null` when the context was delivered.
 */
export async function linkThenDeliver(
  needsLink: boolean,
  link: () => Promise<PrLinkResult>,
  deliver: () => Promise<void>,
): Promise<string | null> {
  if (needsLink) {
    let result: PrLinkResult
    try {
      result = await link()
    } catch (err) {
      log.warn('linking the picked chat failed', err)
      return 'Could not link that chat; see the log.'
    }
    if (!result.ok) {
      log.warn('linking the picked chat failed', result.message)
      return result.message
    }
  }
  await deliver()
  return null
}

/** The picked chat needs a link when it is not already linked, even if another chat is. */
export function pickNeedsLink(linked: ReadonlyArray<{ id: string }>, pickedId: string): boolean {
  return !linked.some((c) => c.id === pickedId)
}

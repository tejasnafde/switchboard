/**
 * "Ask the agent" from Reviews: the review context becomes ONE `review` pill
 * in a chat's composer. It goes to the PR's linked chat when there is exactly
 * one; otherwise the Reviews view asks which chat (`pendingAsk`).
 */
import type { PrLinkChat } from '@shared/pull-request-links'
import { prKey, type PrChangedFile, type PrRef } from '@shared/pull-requests'
import { expandReviewContext, reviewContextLabel, type ReviewContext } from '@shared/review-context'
import { focusComposer } from '../../services/composer-registry'
import { createRendererLogger } from '../../logger'
import { useDraftStore } from '../../stores/draft-store'
import { useReviewStore } from '../../stores/review-store'

const log = createRendererLogger('reviews:to-chat')

/** Opens a chat (App's sidebar path) and returns the session id its composer uses. */
type ChatOpener = (chat: PrLinkChat) => Promise<string | null>
let opener: ChatOpener | null = null

export function registerReviewChatOpener(fn: ChatOpener | null): void {
  opener = fn
}

export async function openReviewChat(chat: PrLinkChat): Promise<string | null> {
  try {
    return (await opener?.(chat)) ?? null
  } catch (err) {
    log.warn('opening a linked chat failed', err)
    return null
  }
}

export async function deliverReviewContext(chat: PrLinkChat, ctx: ReviewContext): Promise<void> {
  const sessionId = await openReviewChat(chat)
  if (!sessionId) {
    log.warn('could not open the chat for review context', { chat: chat.id })
    return
  }
  const pillId = `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const drafts = useDraftStore.getState()
  drafts.addPill(sessionId, {
    id: pillId,
    kind: 'review',
    label: reviewContextLabel(ctx),
    content: expandReviewContext(ctx),
  })
  // The composer hydrates chips from `[[pill:id]]` tokens in the draft, so this
  // works whether or not the chat's composer is mounted yet.
  drafts.appendDraft(sessionId, `[[pill:${pillId}]] `)
  requestAnimationFrame(() => focusComposer(sessionId))
}

export async function askAgent(ctx: ReviewContext): Promise<void> {
  if (ctx.items.length === 0) return
  const chats = await useReviewStore.getState().loadLinkedChats(ctx.pr)
  if (chats.length === 1) await deliverReviewContext(chats[0], ctx)
  else useReviewStore.getState().setPendingAsk(ctx)
}

/** The PR's changed files for diff excerpts; an empty list when they cannot be read. */
export async function filesFor(ref: PrRef): Promise<PrChangedFile[]> {
  const key = prKey(ref)
  const read = () => useReviewStore.getState().resources[key]?.files
  await useReviewStore.getState().load(ref, 'files')
  // `load` returns at once while another read of the same tab is in flight.
  if (read()?.status === 'loading') {
    await new Promise<void>((resolve) => {
      const stop = useReviewStore.subscribe((s) => {
        if (s.resources[key]?.files?.status === 'loading') return
        stop()
        resolve()
      })
    })
  }
  const files = read()
  return files?.status === 'ok' ? files.data : []
}

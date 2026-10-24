/**
 * Opening a chat from Reviews, optionally with a review pill waiting in its
 * composer (the next send carries it, `reviewPillTurn`).
 */
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { createLogger } from '@shared/logger'
import type { PrLinkChat } from '@shared/pull-request-links'
import { workOnPrPill, type PhoneReviewPill, type WorkOnPrPlace } from '@shared/pull-request-phone'
import type { PrDetail } from '@shared/pull-requests'
import type { RootStackParamList } from '../../App'
import { threadKey, useChatStore } from '../stores/chat'
import { getClient } from '../stores/connections'
import { enqueue } from '../stores/outbox'
import { usePrefsStore } from '../stores/prefs'
import { queuedTurnBody } from './outbox-model'
import { buildTurn } from './turn-submit'

const log = createLogger('lib:pr-chat')

export function newReviewPillId(): string {
  return `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Leaves the pill on the chat (persisted with its draft), then opens it. */
export function attachReviewPill(connectionId: string, threadId: string, pill: PhoneReviewPill): void {
  usePrefsStore.getState().setReviewPill(threadKey(connectionId, threadId), { id: newReviewPillId(), ...pill })
}

export function openChatWithPill(
  navigation: Pick<NativeStackNavigationProp<RootStackParamList>, 'navigate'>,
  connectionId: string,
  chat: Pick<PrLinkChat, 'id' | 'title' | 'projectPath'>,
  pill?: PhoneReviewPill,
): void {
  if (pill) attachReviewPill(connectionId, chat.id, pill)
  navigation.navigate('Thread', { connectionId, threadId: chat.id, title: chat.title, projectPath: chat.projectPath })
}

/**
 * The first turn of a "Work on PR" chat, once the chat exists: link the PR to
 * it (`manual`, as the desktop's Reviews does) and send the review pill with
 * the user's text. A failed link is logged, not fatal: the chat still works.
 */
export async function startWorkOnPrChat(input: {
  connectionId: string
  threadId: string
  pr: PrDetail
  place: WorkOnPrPlace
  text: string
  runtimeMode?: string
}): Promise<void> {
  const client = getClient(input.connectionId)
  await client
    ?.linkPullRequest(input.threadId, input.pr.ref)
    .then((result) => {
      if (!result.ok) log.warn('linking the pull request to the new chat was refused', { message: result.message })
    })
    .catch((err: unknown) => log.warn('linking the pull request to the new chat failed', err))
  const pill = { id: newReviewPillId(), ...workOnPrPill(input.pr, input.place) }
  const key = threadKey(input.connectionId, input.threadId)
  const turn = buildTurn({
    connectionId: input.connectionId,
    threadId: input.threadId,
    text: input.text,
    runtimeMode: input.runtimeMode,
    titleCandidate: input.pr.title,
    reviewPill: pill,
  })
  const shown = queuedTurnBody(turn.queued)
  useChatStore.getState().addUserMessage(key, shown.displayBody, undefined, turn.bubbleId, shown.pillsMeta)
  try {
    await enqueue(turn.queued)
  } catch (err) {
    log.warn('queueing the first Work on PR turn failed', err)
    useChatStore.getState().removeUserMessage(key, turn.bubbleId)
    // Nothing is lost: the pill and the text wait in the composer.
    usePrefsStore.getState().setReviewPill(key, pill)
    usePrefsStore.getState().rememberDraft(key, input.text)
  }
}

/**
 * What a chat needs from the user, and the chat list grouped by it: Needs you
 * (an open approval, question or plan, or an error), Working, then Done
 * recently. The same rules as the desktop sidebar's Recents
 * (`renderer/components/sidebar/recent-groups.ts`) and native Android's
 * `BrowseConversationGroups`. Open cards come from the backend's record
 * (`provider:get-pending-requests` plus live events), never the transcript.
 */
import type { PendingBlockingEvent } from '@shared/pending-requests'
import type { ProviderSessionStatus } from '@shared/provider-events'

export type ChatActivity = 'approval' | 'input' | 'plan' | 'failed' | 'working' | null
export type ChatGroupKey = 'needs-you' | 'working' | 'done'

export const CHAT_GROUP_LABELS: Record<ChatGroupKey, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  done: 'Done recently',
}

/** An approval outranks a question, a question a plan, and an error all but a card. */
export function chatActivity(
  thread: { status?: ProviderSessionStatus; pendingRequests?: readonly PendingBlockingEvent[] } | undefined,
): ChatActivity {
  const pending = thread?.pendingRequests ?? []
  if (pending.some((e) => e.type === 'request.opened')) return 'approval'
  if (pending.some((e) => e.type === 'question.asked')) return 'input'
  if (pending.some((e) => e.type === 'plan.proposed')) return 'plan'
  if (thread?.status === 'error') return 'failed'
  // 'connecting' is also what a chat restored from disk shows, so it is not work.
  if (thread?.status === 'running') return 'working'
  return null
}

export function chatGroupKey(activity: ChatActivity): ChatGroupKey {
  if (activity === 'working') return 'working'
  return activity === null ? 'done' : 'needs-you'
}

export interface ChatGroup<T> {
  key: ChatGroupKey
  label: string
  items: T[]
}

/**
 * Split an already sorted list into its groups, keeping the order inside each
 * and dropping empty ones. A list where nothing needs you or works returns []
 * and stays one plain list: a lone "Done recently" header says nothing.
 */
export function groupChats<T>(items: readonly T[], keyOf: (item: T, index: number) => ChatGroupKey): ChatGroup<T>[] {
  const byKey: Record<ChatGroupKey, T[]> = { 'needs-you': [], working: [], done: [] }
  items.forEach((item, index) => byKey[keyOf(item, index)].push(item))
  if (byKey['needs-you'].length === 0 && byKey.working.length === 0) return []
  return (['needs-you', 'working', 'done'] as const)
    .map((key) => ({ key, label: CHAT_GROUP_LABELS[key], items: byKey[key] }))
    .filter((group) => group.items.length > 0)
}

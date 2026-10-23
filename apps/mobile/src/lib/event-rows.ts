import type { FeedItem } from '../stores/chat'

/** Title and body lines of the feed rows that report a runtime event, as native Android words them. */
export interface EventRowCopy {
  title: string
  lines: string[]
  /** Small print under the body. */
  meta?: string
}

type EventItem = Extract<FeedItem, { kind: 'retry' | 'drift' | 'spendBlocked' | 'peer' }>

export function eventRowCopy(item: EventItem, formatTime: (ms: number) => string): EventRowCopy {
  switch (item.kind) {
    case 'retry':
      return { title: item.active ? 'Retrying' : 'Retry finished', lines: [item.message] }
    case 'drift':
      return { title: 'Worktree changed', lines: [item.branch, item.worktreePath] }
    case 'spendBlocked': {
      const target = [item.instanceId, item.model].filter(Boolean).join(' · ')
      return {
        title: 'Spend blocked',
        lines: [
          target,
          item.reason ?? '',
          `scope: ${item.scope}`,
          item.resetsAtMs === null ? '' : `resets: ${formatTime(item.resetsAtMs)}`,
        ].filter(Boolean),
      }
    }
    case 'peer':
      return {
        title: `${item.direction === 'sent' ? 'Sent' : 'Received'} · ${item.peerLabel}`,
        lines: [item.text],
        meta: `${item.initiator} · ${item.peerThreadId}`,
      }
  }
}

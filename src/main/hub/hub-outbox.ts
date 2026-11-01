/**
 * The outbox on a child machine: what a child here sends its parent on
 * another machine's hub (a wake, or a `send_agent_message` along the lineage
 * edge) waits in `hub_outbox` until that desktop pulls and acks it.
 *
 * `hub-remote:outbox-pull` answers only items for parent stubs whose
 * `remote_hub` is the caller's install id, unacked, in (created_at, id) order;
 * `hub-remote:outbox-ack` marks only that desktop's items. Both answer with
 * `hub_remote_children` off too, so running work can finish. Acked items are
 * deleted after 7 days, at start and on each ack.
 */
import {
  HUB_OUTBOX_KEEP_ACKED_MS,
  parseHubOutboxAckRequest,
  parseHubOutboxPullRequest,
  type HubOutboxItem,
} from '@shared/hub-remote'
import { ackHubOutbox, listHubOutbox, pruneHubOutbox } from '../db/database'
import { createMainLogger } from '../logger'

const log = createMainLogger('hub:outbox')

export function pullHubOutbox(raw: unknown): { v: 1; items: HubOutboxItem[] } {
  const parsed = parseHubOutboxPullRequest(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  const { desktopInstallId, after, limit } = parsed.request
  const { items, malformed } = listHubOutbox(desktopInstallId, { ...(after ? { after } : {}), limit })
  if (malformed.length > 0) log.warn('outbox rows that no longer parse were left out', { ids: malformed })
  return { v: 1, items }
}

export function ackHubOutboxItems(raw: unknown): { v: 1; acked: number } {
  const parsed = parseHubOutboxAckRequest(raw)
  if (!parsed.ok) throw new Error(parsed.message)
  const acked = ackHubOutbox(parsed.request.desktopInstallId, parsed.request.ids)
  pruneAckedHubOutbox()
  return { v: 1, acked }
}

/** Deletes items acked more than 7 days ago. */
export function pruneAckedHubOutbox(): void {
  try {
    const n = pruneHubOutbox(HUB_OUTBOX_KEEP_ACKED_MS)
    if (n > 0) log.info('pruned acked outbox items', { n })
  } catch (err) {
    log.warn('could not prune acked outbox items', err)
  }
}

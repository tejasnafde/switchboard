import { prKey } from '@shared/pull-requests'
import type { PrLink } from '@shared/pull-request-links'
import type { SnoozePrChoice } from './SnoozeMenu'

/** The PR a snooze can wait on: the newest link not known to be merged or closed. */
export function snoozePrOf(links: readonly PrLink[]): SnoozePrChoice | null {
  const open = links
    .filter((link) => link.state !== 'merged' && link.state !== 'closed')
    .sort((a, b) => b.linkedAt - a.linkedAt)[0]
  return open ? { key: prKey(open.ref), number: open.ref.number } : null
}

export async function linkedSnoozePr(id: string, machineId: string): Promise<SnoozePrChoice | null> {
  // A local bind also clears a remote binding left on the same id.
  window.api.routing.bind(id, machineId)
  return snoozePrOf(await window.api.pullRequests.links(id))
}

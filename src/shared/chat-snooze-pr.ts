/** The PR a snooze can wait on, for the desktop and both phones (Kotlin `ChatSnooze.snoozePrOf`). */
import type { PrLink } from './pull-request-links'
import { prKey } from './pull-requests'

/** A linked open PR a snooze can wait on. */
export interface SnoozePrChoice {
  key: string
  number: number
}

/** The newest link not known to be merged or closed. */
export function snoozePrOf(links: readonly Pick<PrLink, 'ref' | 'state' | 'linkedAt'>[]): SnoozePrChoice | null {
  const open = links
    .filter((link) => link.state !== 'merged' && link.state !== 'closed')
    .sort((a, b) => b.linkedAt - a.linkedAt)[0]
  return open ? { key: prKey(open.ref), number: open.ref.number } : null
}

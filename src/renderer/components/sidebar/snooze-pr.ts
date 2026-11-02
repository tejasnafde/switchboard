import { snoozePrOf, type SnoozePrChoice } from '@shared/chat-snooze-pr'

export async function linkedSnoozePr(id: string, machineId: string): Promise<SnoozePrChoice | null> {
  // A local bind also clears a remote binding left on the same id.
  window.api.routing.bind(id, machineId)
  return snoozePrOf(await window.api.pullRequests.links(id))
}

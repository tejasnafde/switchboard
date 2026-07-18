/**
 * Post-turn diff-card hygiene for notebook workspaces. Applied by the
 * registry to checkpoint-derived file.edited events: drop the ones the
 * mirror system already covers (mirror-path events - synthetics are their
 * sole card source - and .ipynb writes performed by the sync engine itself).
 * A DIRECT .ipynb edit that bypassed the mirror (e.g. a provider without the
 * redirect wired) is NOT explained and keeps its raw card, so no notebook
 * mutation is ever invisible.
 */
import type { RuntimeFileEditedEvent } from '@shared/provider-events'

export function filterNotebookFileEdits(
  events: RuntimeFileEditedEvent[],
  explains: (event: RuntimeFileEditedEvent) => boolean
): RuntimeFileEditedEvent[] {
  return events.filter((event) => !explains(event))
}

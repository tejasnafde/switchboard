/**
 * Which answers the phone offers on an approval card. A pull request write an
 * agent asked for is approvable only on a backend that says it takes a
 * phone's approval (`HOST_WRITE_PHONE_APPROVAL_CAPABILITY` from
 * `@shared/host-write-phone`); an older backend
 * refuses it, so the card offers Deny only there. So does a card whose content
 * the phone cannot show in full (`hostWritePreview` is null): approving it
 * would post text the user never saw.
 */
import {
  hostWritePreview,
  hostWriteShownDigest,
  phoneHostWriteButtons,
  type HostWritePreview,
  type PhoneHostWriteButton,
} from '@shared/host-write-phone'
import { isAgentApprovalCardId } from '@shared/agent-approval-cards'
import type { HostWriteResponse } from '@shared/agent-host-writes'
import type { FeedItem } from '../stores/chat'

export type ApprovalActions =
  | { kind: 'plain' }
  | { kind: 'deny-only' }
  | { kind: 'host-write'; buttons: PhoneHostWriteButton[]; preview: HostWritePreview }

export function approvalActions(
  item: Extract<FeedItem, { kind: 'approval' }>,
  backendTakesPhoneApproval: boolean,
): ApprovalActions {
  if (item.hostWrite) {
    const card = item.hostWrite
    const preview = backendTakesPhoneApproval ? hostWritePreview(card) : null
    const shown = preview && hostWriteShownDigest(item.requestId, card)
    if (!preview || !shown) return { kind: 'deny-only' }
    // Every approval says which draft it showed in full; the backend refuses one that does not.
    const buttons = phoneHostWriteButtons(card).map((b) => ({ ...b, response: { ...b.response, shown } }))
    return { kind: 'host-write', buttons, preview }
  }
  // Cached before the card rode along on the item.
  if (item.desktopOnly) return { kind: 'deny-only' }
  return { kind: 'plain' }
}

/**
 * Whether the card offers "Don't wake the agent": one the Switchboard server
 * opened (it does not hold the agent's turn), on a backend that takes a quiet
 * answer (`AGENT_ASYNC_APPROVAL_CAPABILITY`).
 */
export function offersQuiet(item: Extract<FeedItem, { kind: 'approval' }>, backendAsyncApproval: boolean): boolean {
  return backendAsyncApproval && isAgentApprovalCardId(item.requestId)
}

/** The response an answer sends when the user chose not to wake the agent. */
export function quietly(response: HostWriteResponse | undefined, quiet: boolean): HostWriteResponse | undefined {
  return quiet ? { ...response, quiet: true } : response
}

/** A button's label when quiet: Deny becomes Dismiss, an approval says it is quiet. */
export function quietLabel(label: string, decision: 'approve' | 'deny', quiet: boolean): string {
  if (!quiet) return label
  return decision === 'deny' ? 'Dismiss' : `${label} quietly`
}

/**
 * Which answers the phone offers on an approval card. A pull request write an
 * agent asked for is approvable only on a backend that says it takes a
 * phone's approval (`HOST_WRITE_PHONE_APPROVAL_CAPABILITY` from
 * `@shared/host-write-phone`); an older backend
 * refuses it, so the card offers Deny only there. So does a card whose content
 * the phone cannot show in full (`hostWritePreview` is null): approving it
 * would post text the user never saw.
 */
import { hostWritePreview, hostWriteShownDigest, phoneHostWriteButtons, type HostWritePreview, type PhoneHostWriteButton } from '@shared/host-write-phone'
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

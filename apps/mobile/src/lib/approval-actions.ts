/**
 * Which answers the phone offers on an approval card. A pull request write an
 * agent asked for is approvable only on a backend that says it takes a
 * phone's approval (`HOST_WRITE_PHONE_APPROVAL_CAPABILITY` from
 * `@shared/host-write-phone`); an older backend
 * refuses it, so the card offers Deny only there. So does a card whose content
 * the phone cannot show in full (`hostWritePreview` is null): approving it
 * would post text the user never saw.
 */
import { hostWritePreview, phoneHostWriteButtons, type HostWritePreview, type PhoneHostWriteButton } from '@shared/host-write-phone'
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
    const preview = backendTakesPhoneApproval ? hostWritePreview(item.hostWrite) : null
    return preview
      ? { kind: 'host-write', buttons: phoneHostWriteButtons(item.hostWrite), preview }
      : { kind: 'deny-only' }
  }
  // Cached before the card rode along on the item.
  if (item.desktopOnly) return { kind: 'deny-only' }
  return { kind: 'plain' }
}

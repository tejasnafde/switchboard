/**
 * Which answers the phone offers on an approval card. A pull request write an
 * agent asked for is approvable only on a backend that says it takes a
 * phone's approval (`HOST_WRITE_PHONE_APPROVAL_CAPABILITY` from
 * `@shared/host-write-phone`); an older backend
 * refuses it, so the card offers Deny only there.
 */
import { phoneHostWriteButtons, type PhoneHostWriteButton } from '@shared/host-write-phone'
import type { FeedItem } from '../stores/chat'

export type ApprovalActions =
  | { kind: 'plain' }
  | { kind: 'deny-only' }
  | { kind: 'host-write'; buttons: PhoneHostWriteButton[] }

export function approvalActions(
  item: Extract<FeedItem, { kind: 'approval' }>,
  backendTakesPhoneApproval: boolean,
): ApprovalActions {
  if (item.hostWrite) {
    return backendTakesPhoneApproval
      ? { kind: 'host-write', buttons: phoneHostWriteButtons(item.hostWrite) }
      : { kind: 'deny-only' }
  }
  // Cached before the card rode along on the item.
  if (item.desktopOnly) return { kind: 'deny-only' }
  return { kind: 'plain' }
}

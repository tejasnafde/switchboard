/**
 * Child chats on the phone (flag `hub_children`, rules in `@shared/hub`): the
 * view as this phone shows it and the chat list without listed children.
 */
import { nestHubChildren, type HubChatView, type SessionHubField } from '@shared/hub'

/** The view without `remote` while the backend does not advertise `hub_remote_children_v1`. */
export function phoneHubView(view: HubChatView, remoteOn: boolean): HubChatView {
  if (remoteOn) return view
  return { ...view, children: view.children.map(({ remote: _remote, ...child }) => child) }
}

/** Whether a `hub.children-changed` for the parent `changedId` concerns this chat; any does before its first view. */
export function hubChangeConcerns(view: HubChatView | null, threadId: string, changedId: string): boolean {
  if (!view?.self) return true
  return changedId === threadId || view.self.familyIds.includes(changedId) || view.parent?.id === changedId
}

/** Chat list rows without the open children whose parent is in the list too, as the desktop sidebar nests them. */
export function topLevelChatRows<T extends { id: string; hub?: SessionHubField }>(rows: readonly T[]): T[] {
  return nestHubChildren(rows).map((entry) => entry.session)
}

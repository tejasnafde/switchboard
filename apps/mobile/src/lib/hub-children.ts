/**
 * Child chats on the phone (flag `hub_children`, rules in `@shared/hub`): the
 * view as this phone shows it and the chat list without listed children.
 */
import {
  nestHubChildren,
  type HubChatRef,
  type HubChatView,
  type HubChildView,
  type SessionHubField,
} from '@shared/hub'

/**
 * A child as its row shows it: without `remote` while the backend does not
 * advertise `hub_remote_children_v1`. Stop and Open still read the child's own
 * `remote`, so a remote child never opens as an empty local chat.
 */
export function shownHubChild<T extends Pick<HubChildView, 'remote'>>(child: T, remoteOn: boolean): T {
  if (remoteOn || !child.remote) return child
  const { remote: _remote, ...rest } = child
  return rest as T
}

/** The view as its chip shows it: no machine count without `hub_remote_children_v1`. */
export function phoneHubView(view: HubChatView, remoteOn: boolean): HubChatView {
  return remoteOn ? view : { ...view, children: view.children.map((child) => shownHubChild(child, false)) }
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

/** The Thread route of a child: its worktree too, since the session starts before the chat's history says where it runs. */
export function hubChatRoute(connectionId: string, chat: HubChatRef) {
  return {
    connectionId,
    threadId: chat.id,
    title: chat.title,
    projectPath: chat.projectPath,
    worktreePath: chat.worktreePath ?? null,
  }
}

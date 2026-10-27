/**
 * The row a parent's chat shows for one delivered child update: per child its
 * title, what happened and its summary, and "Open in child". The agent got
 * the same update as a turn, which the chat does not show.
 */
import { hubWakeKindLabel, type HubChatRef, type HubUpdateRowEntry } from '@shared/hub'
import { useHubStore } from '../../stores/hub-store'
import { Button } from '../ui/button'
import { openHubChat } from './hub-actions'

export function HubUpdateRow({
  entries,
  messageId,
  sessionId,
}: {
  entries: HubUpdateRowEntry[]
  messageId: string
  sessionId: string | undefined
}) {
  // ChatPanel keeps the view of its own chat loaded; a settled child is no longer in it.
  const view = useHubStore((s) => (sessionId ? s.views[sessionId] : undefined))
  const plainRef = (id: string, title: string, projectPath = ''): HubChatRef => ({
    id,
    familyIds: [id],
    title,
    agentType: 'claude-code',
    projectPath,
    updatedAt: 0,
  })
  const parent = view?.self ?? (sessionId ? plainRef(sessionId, '') : null)
  const refOf = (e: HubUpdateRowEntry): HubChatRef =>
    view?.children.find((c) => c.chat.id === e.childId)?.chat ?? plainRef(e.childId, e.title, parent?.projectPath)
  return (
    <div
      data-message-id={messageId}
      data-testid="hub-update-row"
      className="mx-4 my-2 rounded-[8px] border border-[var(--border)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
    >
      <div className="font-[600] text-[var(--text-primary)]">
        {entries.length === 1 ? 'Update from a child chat' : `Updates from child chats (${entries.length})`}
      </div>
      <ul className="m-0 mt-1 list-none p-0">
        {entries.map((e, i) => (
          <li key={`${e.childId}-${i}`} className="flex flex-wrap items-start gap-x-[8px] py-[2px]">
            <div className="min-w-[min(100%,240px)] flex-1">
              <span className="font-[600] text-[var(--text-primary)]">{e.title}</span>
              <span className="ml-[6px] text-[11px] text-[var(--text-muted)]">{hubWakeKindLabel(e.kind)}</span>
              <div className="max-h-[120px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{e.summary}</div>
            </div>
            {parent && (
              <Button variant="ghost" size="sm" onClick={() => void openHubChat(refOf(e), parent)}>
                Open in child
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

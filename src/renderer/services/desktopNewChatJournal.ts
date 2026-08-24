import { parseWorktreeCreationRequest } from '../../shared/worktree-creation'
import type {
  DesktopNewChatIntent,
  DesktopNewChatJournal,
  DesktopNewChatJournalEntry,
} from './desktopNewChatCreation'

const STORAGE_KEY = 'switchboard.worktree-creations.desktop.v1'

function isIntent(value: unknown): value is DesktopNewChatIntent {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<DesktopNewChatIntent>
  return typeof input.projectPath === 'string'
    && typeof input.machineId === 'string'
    && input.checkout === 'worktree'
    && (input.agentType === 'claude-code' || input.agentType === 'codex' || input.agentType === 'opencode')
    && (input.runtimeMode === 'plan'
      || input.runtimeMode === 'sandbox'
      || input.runtimeMode === 'accept-edits'
      || input.runtimeMode === 'full-access')
}

export function createDesktopNewChatJournal(storage: Pick<Storage, 'getItem' | 'setItem'>):
DesktopNewChatJournal & { list(): DesktopNewChatJournalEntry[] } {
  const read = (): DesktopNewChatJournalEntry[] => {
    try {
      const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]') as unknown
      if (!Array.isArray(value)) return []
      return value.flatMap((entry): DesktopNewChatJournalEntry[] => {
        if (!entry || typeof entry !== 'object') return []
        const candidate = entry as { intent?: unknown; request?: unknown }
        const parsed = parseWorktreeCreationRequest(candidate.request)
        return isIntent(candidate.intent) && parsed.ok
          ? [{ intent: candidate.intent, request: parsed.value }]
          : []
      })
    } catch {
      return []
    }
  }
  const write = (entries: DesktopNewChatJournalEntry[]) => {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries))
  }
  return {
    list: read,
    save(entry) {
      write([...read().filter((item) => item.request.creationId !== entry.request.creationId), entry])
    },
    remove(creationId) {
      write(read().filter((item) => item.request.creationId !== creationId))
    },
  }
}

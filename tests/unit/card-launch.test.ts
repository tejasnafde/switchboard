/**
 * Unit tests for the kanban-card → chat-launch helpers. Two pure
 * functions: `deriveCardLaunch` (separates parent project from agent
 * cwd so the session lands under the right project in the sidebar) and
 * `buildKanbanFirstTurn` (the auto-sent first message).
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import {
  deriveCardLaunch,
  buildKanbanFirstTurn,
  launchCardChat,
  resolveCardRuntimeMode,
} from '../../src/renderer/components/kanban/cardLaunch'
import {
  useAgentStore,
  setStoreDefaultRuntimeMode,
} from '../../src/renderer/stores/agent-store'
import type { KanbanCard } from '../../src/shared/kanban'

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'card_1',
    projectPath: '/repo',
    title: 'Do the thing',
    description: '',
    tags: [],
    status: 'backlog',
    costCapUsd: null,
    costUsedUsd: null,
    runtimeMode: 'accept-edits',
    conversationId: null,
    worktreePath: null,
    worktreeBranch: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...overrides,
  }
}

describe('deriveCardLaunch', () => {
  it('uses the parent project path when no worktree is set', () => {
    const out = deriveCardLaunch(card({ projectPath: '/repo' }))
    expect(out).toEqual({ projectPath: '/repo', cwd: '/repo', title: 'Do the thing' })
  })

  it('keeps projectPath as the parent but routes cwd to the worktree', () => {
    // The bug we are fixing: previously cwd was used as projectPath,
    // which broke sidebar grouping (the worktree dir is not a registered
    // project). Sidebar matches on strict equality of session.projectPath
    // === project.path, so we must keep the parent as the grouping key.
    const out = deriveCardLaunch(
      card({ projectPath: '/repo', worktreePath: '/repo/.switchboard/worktrees/x' }),
    )
    expect(out.projectPath).toBe('/repo')
    expect(out.cwd).toBe('/repo/.switchboard/worktrees/x')
    expect(out.title).toBe('Do the thing')
  })
})

describe('buildKanbanFirstTurn', () => {
  it('returns the title alone when there is no description', () => {
    expect(buildKanbanFirstTurn(card({ title: 'Refactor login' }))).toBe('Refactor login')
  })

  it('joins title and description with a blank line between them', () => {
    expect(
      buildKanbanFirstTurn(card({ title: 'Refactor login', description: 'Use OAuth instead.' })),
    ).toBe('Refactor login\n\nUse OAuth instead.')
  })

  it('trims whitespace-only descriptions to just the title', () => {
    expect(
      buildKanbanFirstTurn(card({ title: 'Refactor login', description: '   \n\t' })),
    ).toBe('Refactor login')
  })

  it('falls back to a placeholder when both are empty', () => {
    // Defensive: card create requires a title, but an empty-string title
    // can sneak in via update. We send *something* so the agent gets a
    // turn instead of an immediate context-empty error.
    expect(buildKanbanFirstTurn(card({ title: '', description: '' }))).toBe(
      'Start working on this card.',
    )
  })
})

// ---------- launchCardChat ----------

interface MockApi {
  app: {
    createConversation: ReturnType<typeof vi.fn>
    saveMessage: ReturnType<typeof vi.fn>
    renameConversation: ReturnType<typeof vi.fn>
    unarchiveConversation: ReturnType<typeof vi.fn>
    getConversationRuntimeMode: ReturnType<typeof vi.fn>
    setConversationRuntimeMode: ReturnType<typeof vi.fn>
  }
  provider: {
    startSession: ReturnType<typeof vi.fn>
    sendTurn: ReturnType<typeof vi.fn>
    setRuntimeMode: ReturnType<typeof vi.fn>
  }
  kanban: {
    update: ReturnType<typeof vi.fn>
  }
}

function installApiMock(persistedMode: string | null = null): MockApi {
  const api: MockApi = {
    app: {
      createConversation: vi.fn(async () => undefined),
      saveMessage: vi.fn(async () => undefined),
      renameConversation: vi.fn(async () => undefined),
      unarchiveConversation: vi.fn(async () => undefined),
      getConversationRuntimeMode: vi.fn(async () => ({ mode: persistedMode })),
      setConversationRuntimeMode: vi.fn(async () => ({ ok: true })),
    },
    provider: {
      startSession: vi.fn(async () => ({ ok: true })),
      sendTurn: vi.fn(async () => undefined),
      setRuntimeMode: vi.fn(async () => undefined),
    },
    kanban: {
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
        id,
        projectPath: '/repo',
        title: 't',
        description: '',
        tags: [],
        status: 'in_progress',
        costCapUsd: null,
        costUsedUsd: null,
        runtimeMode: 'accept-edits',
        conversationId: null,
        worktreePath: null,
        worktreeBranch: null,
        createdAt: 0,
        updatedAt: 0,
        completedAt: null,
        ...patch,
      })),
    },
  }
  ;(globalThis as { window?: unknown }).window = { api }
  return api
}

describe('resolveCardRuntimeMode', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessions: [], activeSessionId: null })
    setStoreDefaultRuntimeMode('sandbox')
  })

  it('prefers persisted DB mode (reflects mid-conversation mode changes)', async () => {
    installApiMock('full-access')
    const mode = await resolveCardRuntimeMode('plan', 'conv_123')
    expect(mode).toBe('full-access')
  })

  it('falls back to per-card mode when DB has nothing', async () => {
    installApiMock(null)
    setStoreDefaultRuntimeMode('sandbox')
    const mode = await resolveCardRuntimeMode('plan', 'conv_123')
    expect(mode).toBe('plan')
  })

  it('falls back to user default when no DB row and no per-card mode', async () => {
    installApiMock(null)
    setStoreDefaultRuntimeMode('accept-edits')
    const mode = await resolveCardRuntimeMode(null, 'conv_123')
    expect(mode).toBe('accept-edits')
  })

  it('uses user default when no conversation is linked and no per-card mode', async () => {
    installApiMock('full-access') // present, but no convId so not queried
    setStoreDefaultRuntimeMode('plan')
    const mode = await resolveCardRuntimeMode(null, null)
    expect(mode).toBe('plan')
  })

  it('rejects garbage values from the DB and falls back to the next tier', async () => {
    installApiMock('not-a-mode')
    setStoreDefaultRuntimeMode('full-access')
    const mode = await resolveCardRuntimeMode(null, 'conv_123')
    expect(mode).toBe('full-access')
  })
})

describe('launchCardChat', () => {
  beforeEach(() => {
    useAgentStore.setState({ sessions: [], activeSessionId: null })
    setStoreDefaultRuntimeMode('sandbox')
  })

  it('starts the provider with cwd = worktree, registers the session under the parent project, and auto-sends the first turn', async () => {
    const api = installApiMock()
    const c = card({
      id: 'card_x',
      projectPath: '/repo',
      worktreePath: '/repo/.switchboard/worktrees/x',
      title: 'Refactor auth',
      description: 'Use OAuth.',
    })

    const result = await launchCardChat(c, { openChat: false })

    expect(result.sessionId).toMatch(/^agent_/)
    // Session registered under the parent project, not the worktree, so
    // the sidebar groups it correctly.
    const session = useAgentStore.getState().sessions.find((s) => s.id === result.sessionId)
    expect(session?.projectPath).toBe('/repo')
    // Provider got the worktree as cwd.
    expect(api.provider.startSession).toHaveBeenCalledTimes(1)
    expect(api.provider.startSession.mock.calls[0][0]).toMatchObject({
      threadId: result.sessionId,
      cwd: '/repo/.switchboard/worktrees/x',
    })
    // First turn auto-sent with title + description.
    expect(api.provider.sendTurn).toHaveBeenCalledTimes(1)
    expect(api.provider.sendTurn.mock.calls[0][1]).toBe('Refactor auth\n\nUse OAuth.')
    // Card linked to the new conversation.
    expect(api.kanban.update).toHaveBeenCalledWith('card_x', expect.objectContaining({
      conversationId: result.sessionId,
    }))
  })

  it('jumps to the existing session if the card is already linked', async () => {
    const api = installApiMock()
    useAgentStore.setState({
      sessions: [{
        id: 'existing_1',
        type: 'claude-code',
        status: 'idle',
        projectPath: '/repo',
        title: 't',
        messages: [],
        unreadCount: 0,
        runtimeMode: 'sandbox',
      }],
      activeSessionId: null,
    })
    const c = card({ conversationId: 'existing_1' })

    const result = await launchCardChat(c, { openChat: true })

    expect(result.sessionId).toBe('existing_1')
    expect(api.provider.startSession).not.toHaveBeenCalled()
    expect(api.provider.sendTurn).not.toHaveBeenCalled()
  })

  it('unarchives the linked conversation before reusing its session (resume-from-done)', async () => {
    // When a card is in the Done column its conversation is archived;
    // clicking play to resume the chat must unarchive first or the
    // conversation will keep getting filtered out of project scans.
    const api = installApiMock()
    useAgentStore.setState({
      sessions: [{
        id: 'conv_done',
        type: 'claude-code',
        status: 'idle',
        projectPath: '/repo',
        title: 't',
        messages: [],
        unreadCount: 0,
        runtimeMode: 'sandbox',
      }],
      activeSessionId: null,
    })
    const c = card({ conversationId: 'conv_done', status: 'done' })

    await launchCardChat(c, { openChat: true })

    expect(api.app.unarchiveConversation).toHaveBeenCalledWith('conv_done')
  })

  it('does not call unarchive when the card has no linked conversation', async () => {
    const api = installApiMock()
    const c = card({ conversationId: null })

    await launchCardChat(c, { openChat: false })

    expect(api.app.unarchiveConversation).not.toHaveBeenCalled()
  })

  it("forwards the card's chosen runtime mode to startSession and sendTurn", async () => {
    // Regression: kanban v1 hardcoded `sandbox` here, which silently
    // ignored the create-modal's mode picker. Both calls must honour the
    // card field so users see the mode they asked for.
    const api = installApiMock()
    const c = card({ id: 'card_rm', runtimeMode: 'plan' })

    await launchCardChat(c, { openChat: false })

    expect(api.provider.startSession.mock.calls[0][0].runtimeMode).toBe('plan')
    expect(api.provider.sendTurn.mock.calls[0][2]).toBe('plan')
  })

  it('falls back to parent projectPath as cwd when no worktree is set', async () => {
    const api = installApiMock()
    const c = card({ projectPath: '/repo', worktreePath: null, title: 'No wt' })

    await launchCardChat(c, { openChat: false })

    expect(api.provider.startSession.mock.calls[0][0].cwd).toBe('/repo')
  })

  it('persists the chosen runtime mode against the new conversation row', async () => {
    // Regression: without this, reopening the card after app restart would
    // show the module default instead of the mode the user picked at create.
    const api = installApiMock(null)
    const c = card({ id: 'card_full', title: 'a', runtimeMode: 'full-access' })

    const result = await launchCardChat(c, { openChat: false })

    expect(api.provider.startSession.mock.calls[0][0].runtimeMode).toBe('full-access')
    expect(api.provider.sendTurn.mock.calls[0][2]).toBe('full-access')
    const session = useAgentStore.getState().sessions.find((s) => s.id === result.sessionId)
    expect(session?.runtimeMode).toBe('full-access')
    expect(api.app.setConversationRuntimeMode).toHaveBeenCalledWith(result.sessionId, 'full-access')
  })

  it('hydrates a reused session whose in-memory mode is stale from the DB', async () => {
    // Simulate the "open card after app restart" path: the session was
    // added via a sidebar click with the module default ('sandbox'), but
    // the user's actual saved mode for this conversation is 'full-access'.
    const api = installApiMock('full-access')
    useAgentStore.setState({
      sessions: [{
        id: 'existing_1',
        type: 'claude-code',
        status: 'idle',
        projectPath: '/repo',
        title: 't',
        messages: [],
        unreadCount: 0,
        runtimeMode: 'sandbox',
      }],
      activeSessionId: null,
    })
    const c = card({ conversationId: 'existing_1' })

    const result = await launchCardChat(c, { openChat: true })

    expect(result.reused).toBe(true)
    const session = useAgentStore.getState().sessions.find((s) => s.id === 'existing_1')
    // Bug-fix assertion: the chip now reflects the DB source of truth.
    expect(session?.runtimeMode).toBe('full-access')
    // And the change is propagated to any running provider session.
    expect(api.provider.setRuntimeMode).toHaveBeenCalledWith('existing_1', 'full-access')
  })
})

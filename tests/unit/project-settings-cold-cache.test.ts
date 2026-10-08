/**
 * The first new chat in a project after launch: the renderer's override
 * cache is still empty when the chat picks its mode. Reading it
 * synchronously took the global mode, and the chat sent that explicitly, so
 * the backend's own resolution never ran and the override was lost. Every
 * value picked once at creation now waits for the project's overrides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useAgentStore,
  setStoreDefaultRuntimeMode,
  runtimeModeToSend,
  adoptStartedRuntimeMode,
} from '../../src/renderer/stores/agent-store'
import { useProjectSettingsStore, ensureProjectOverrides } from '../../src/renderer/stores/project-settings-store'
import { newChatDefaultsFor } from '../../src/renderer/services/effective-settings'
import { invalidateSessionEnvModeCache } from '../../src/renderer/services/session-env-mode'
import { resolveCardRuntimeMode, launchCardChat } from '../../src/renderer/components/kanban/card-launch'
import type { KanbanCard } from '../../src/shared/kanban'

const APP = '/work/app'
const OTHER = '/work/other'

let projectOverrides: ReturnType<typeof vi.fn>

beforeEach(() => {
  useProjectSettingsStore.setState({ byProject: {} })
  useAgentStore.setState({ sessions: [], activeSessionId: null })
  setStoreDefaultRuntimeMode('accept-edits')
  invalidateSessionEnvModeCache()
  // The backend answers after a round trip, as over IPC.
  projectOverrides = vi.fn(async (paths: string[]) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return Object.fromEntries(
      paths.map((path) => [
        path,
        path === APP ? { 'chat.defaultRuntimeMode': 'plan', defaultSessionEnvMode: 'worktree' } : {},
      ]),
    )
  })
  ;(globalThis as { window?: unknown }).window = {
    api: { settings: { projectOverrides, get: async () => null } },
  }
})

describe('the first new chat in a project, with a cold cache', () => {
  it("shows the project's override and environment, and leaves the mode for the backend to pick", async () => {
    const { runtimeMode, envMode } = await newChatDefaultsFor(APP)
    expect({ runtimeMode, envMode }).toEqual({ runtimeMode: undefined, envMode: 'worktree' })
    // The draft is added with no mode: unresolved, showing the now-known override.
    useAgentStore
      .getState()
      .addSession({ id: 'd', type: 'claude-code', status: 'idle', projectPath: APP, title: 'New chat', runtimeMode })
    expect(useAgentStore.getState().sessions[0]).toMatchObject({ runtimeMode: 'plan', runtimeModeUnresolved: true })
  })

  it('drops a mode carried over from another chat when the project overrides it, and keeps it otherwise', async () => {
    expect((await newChatDefaultsFor(APP, 'full-access')).runtimeMode).toBeUndefined()
    expect((await newChatDefaultsFor(OTHER, 'full-access')).runtimeMode).toBe('full-access')
    expect(await newChatDefaultsFor(OTHER)).toEqual({ runtimeMode: undefined, envMode: 'local' })
  })

  it('reads a project once however many callers wait on it, and not again once cached', async () => {
    await Promise.all([ensureProjectOverrides(APP), ensureProjectOverrides(APP), newChatDefaultsFor(APP)])
    await ensureProjectOverrides(APP)
    expect(projectOverrides).toHaveBeenCalledTimes(1)
  })

  it('asks again after a failed read instead of caching the failure', async () => {
    projectOverrides.mockRejectedValueOnce(new Error('backend restarting'))
    expect(await ensureProjectOverrides(APP)).toBe(false)
    expect((await newChatDefaultsFor(APP)).envMode).toBe('worktree')
  })
})

/**
 * A failed read must not pass the global mode off as the project's: the chat
 * sends no mode and the backend, which reads the overrides itself, decides
 * (`sessionDefaultsFor` with no requested mode takes the project override,
 * pinned in project-settings-backend.test.ts).
 */
describe("when the project's overrides cannot be read", () => {
  beforeEach(() => {
    projectOverrides.mockRejectedValue(new Error('backend restarting'))
  })

  it("leaves a new chat's mode unset and falls back to the global environment", async () => {
    expect(await newChatDefaultsFor(APP)).toEqual({ runtimeMode: undefined, envMode: 'local' })
  })

  it('still honours a mode carried over from the focused chat, which the user chose', async () => {
    expect((await newChatDefaultsFor(APP, 'full-access')).runtimeMode).toBe('full-access')
  })

  it('sends no mode for an unresolved chat, then adopts the one the backend started it in', () => {
    useAgentStore.getState().addSession({
      id: 'd',
      type: 'claude-code',
      status: 'idle',
      projectPath: APP,
      title: 'New chat',
      runtimeModeUnresolved: true,
    })
    const session = () => useAgentStore.getState().sessions.find((s) => s.id === 'd')!
    // It shows the global mode as a guess, but never sends it.
    expect(session().runtimeMode).toBe('accept-edits')
    expect(runtimeModeToSend(session())).toBeUndefined()
    adoptStartedRuntimeMode('d', { threadId: 'd', runtimeMode: 'plan' })
    expect(session()).toMatchObject({ runtimeMode: 'plan', runtimeModeUnresolved: undefined })
    expect(runtimeModeToSend(session())).toBe('plan')
  })

  it('treats a mode the user picks as chosen', () => {
    useAgentStore.getState().addSession({
      id: 'd',
      type: 'claude-code',
      status: 'idle',
      projectPath: APP,
      title: 'New chat',
      runtimeModeUnresolved: true,
    })
    useAgentStore.getState().setRuntimeMode('d', 'full-access')
    expect(runtimeModeToSend(useAgentStore.getState().sessions.find((s) => s.id === 'd'))).toBe('full-access')
  })

  it('launches a kanban card with no mode of its own without sending or storing one', async () => {
    const startSession = vi.fn(async () => ({ threadId: 'x', runtimeMode: 'plan' }))
    const submitUserTurn = vi.fn(async () => ({
      status: 'accepted',
      accepted: true,
      duplicate: false,
      state: 'completed',
      acceptedAt: 1,
    }))
    const setConversationRuntimeMode = vi.fn(async () => ({ ok: true }))
    ;(globalThis as { window?: { api: Record<string, unknown> } }).window!.api = {
      settings: { projectOverrides, get: async () => null },
      app: { createConversation: vi.fn(async () => undefined), setConversationRuntimeMode },
      provider: { startSession, submitUserTurn },
      kanban: { update: vi.fn(async () => ({})) },
    }
    const card = {
      id: 'c',
      projectPath: APP,
      title: 'Do it',
      description: '',
      runtimeMode: null,
      conversationId: null,
      worktreePath: null,
    } as unknown as KanbanCard
    expect(await resolveCardRuntimeMode(null, null)).toBeUndefined()
    const { sessionId } = await launchCardChat(card, { openChat: false })
    expect(startSession.mock.calls[0][0]).toMatchObject({ runtimeMode: undefined })
    expect(submitUserTurn.mock.calls[0][0]).toMatchObject({ runtimeMode: undefined })
    expect(setConversationRuntimeMode).not.toHaveBeenCalled()
    expect(useAgentStore.getState().sessions.find((s) => s.id === sessionId)?.runtimeMode).toBe('plan')
  })
})

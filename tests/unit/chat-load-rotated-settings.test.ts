/**
 * A chat opened by its rotated session id (the id the sidebar and the phone
 * list show once Claude assigns one) loads the provider, profile, mode, model
 * and effort the root conversation stores. The rotated id owns a row of its
 * own whose settings columns are empty.
 */
import { createMigratedDb } from './helpers/test-db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end: () => {} }) }))
const { registerAppHandlers } = await import('../../src/main/ipc/app')
const { AppChannels } = await import('../../src/shared/ipc-channels')
const db = await import('../../src/main/db/database')

type Meta = {
  agentType: string
  providerInstanceId: string | null
  runtimeMode: string | null
  model: string | null
  reasoningEffort: string | null
}

function loadMeta(id: string): Promise<{ meta: Meta | null }> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerAppHandlers(
    { handle: (c: string, h: (...args: unknown[]) => unknown) => handlers.set(c, h), emit: () => {} } as never,
    {},
  )
  return handlers.get(AppChannels.LOAD_SESSION_BY_ID)!(id, { window: true, limit: 50 }) as Promise<{
    meta: Meta | null
  }>
}

beforeEach(() => {
  createMigratedDb().prepare("INSERT INTO projects (path, name) VALUES ('/repo', 'repo')").run()
  db.createConversation('agent_1', '/repo', 'claude-code', 'Chat')
  db.setConversationProviderInstanceId('agent_1', 'claude-work')
  db.setConversationRuntimeMode('agent_1', 'plan')
  db.setConversationModel('agent_1', 'opus')
  db.setConversationReasoningEffort('agent_1', 'high')
  db.createConversation('uuid-1', '/repo', 'claude-code', 'Chat')
  db.recordThreadSession('uuid-1', 'agent_1')
})

describe('history load settings for a rotated id', () => {
  it('reads the stored settings of the root conversation', async () => {
    const { meta } = await loadMeta('uuid-1')
    expect(meta).toMatchObject({
      agentType: 'claude-code',
      providerInstanceId: 'claude-work',
      runtimeMode: 'plan',
      model: 'opus',
      reasoningEffort: 'high',
    })
  })

  it('shows a change made through the rotated id on the next load by either id', async () => {
    db.setConversationRuntimeMode('uuid-1', 'full-access')
    db.setConversationProviderInstanceId('uuid-1', 'claude-home')
    for (const id of ['uuid-1', 'agent_1']) {
      const { meta } = await loadMeta(id)
      expect(meta).toMatchObject({ runtimeMode: 'full-access', providerInstanceId: 'claude-home' })
    }
  })
})

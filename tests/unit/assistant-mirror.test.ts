/**
 * Live assistant replies must reach SQLite, not just the provider's own
 * transcript file. Claude Code prunes and rotates those files, so a reply that
 * lived only there could become unrecoverable. The registry folds `content`
 * deltas per turn and mirrors them on turn.completed (and on a mid-turn stop,
 * where no turn.completed is coming).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/main/db/providerInstances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

const saved: Array<{ id: string; conversationId: string; role: string; content: string }> = []
vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: (id: string, conversationId: string, role: string, content: string) => {
    saved.push({ id, conversationId, role, content })
    return true
  },
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import type { RuntimeEvent } from '../../src/shared/provider-events'

/** Drives `publish` directly - the mirror is a property of the event stream. */
function makeRegistry(): { publish: (e: RuntimeEvent) => void; registry: ProviderRegistry } {
  const host = { handle: () => {}, emit: () => {}, on: () => {} }
  const registry = new ProviderRegistry(host as never)
  const publish = (e: RuntimeEvent) => (registry as unknown as {
    publish: (e: RuntimeEvent) => void
  }).publish(e)
  return { publish, registry }
}

const content = (threadId: string, messageId: string, text: string, append?: boolean): RuntimeEvent => ({
  type: 'content', threadId, messageId, text, append, streamKind: 'assistant',
} as RuntimeEvent)

const turnEnd = (threadId: string): RuntimeEvent => ({ type: 'turn.completed', threadId } as RuntimeEvent)

describe('live assistant mirror', () => {
  beforeEach(() => { saved.length = 0 })

  it('persists the folded reply once the turn completes', () => {
    const { publish } = makeRegistry()
    publish(content('t1', 'm1', 'Hello'))
    publish(content('t1', 'm1', ' world', true))
    expect(saved).toHaveLength(0)

    publish(turnEnd('t1'))
    expect(saved).toEqual([
      { id: 'm1', conversationId: 't1', role: 'assistant', content: 'Hello world' },
    ])
  })

  it('does not mirror reasoning or plan streams', () => {
    const { publish } = makeRegistry()
    publish({ type: 'content', threadId: 't1', messageId: 'r1', text: 'thinking', streamKind: 'reasoning' } as RuntimeEvent)
    publish(turnEnd('t1'))
    expect(saved).toHaveLength(0)
  })

  it('skips a message that streamed only whitespace', () => {
    const { publish } = makeRegistry()
    publish(content('t1', 'm1', '   '))
    publish(turnEnd('t1'))
    expect(saved).toHaveLength(0)
  })

  it('keeps threads separate so one turn end does not flush another', () => {
    const { publish } = makeRegistry()
    publish(content('t1', 'm1', 'from one'))
    publish(content('t2', 'm2', 'from two'))
    publish(turnEnd('t1'))
    expect(saved).toEqual([
      { id: 'm1', conversationId: 't1', role: 'assistant', content: 'from one' },
    ])
  })

  it('does not re-persist a flushed turn when a later turn ends', () => {
    const { publish } = makeRegistry()
    publish(content('t1', 'm1', 'first'))
    publish(turnEnd('t1'))
    publish(turnEnd('t1'))
    expect(saved).toHaveLength(1)
  })
})

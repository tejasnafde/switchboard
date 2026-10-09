/**
 * Claude thinking effort: the chat's level goes on the query as `effort`, a
 * level the catalog says the model does not take is left off, and a change
 * mid-chat reaches the running query through `applyFlagSettings`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelOption } from '../../src/shared/models'

let captured: { effort?: string } | null = null
const applyFlagSettings = vi.fn(async () => {})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: typeof captured }) => {
    captured = args.options
    // A query that never yields: the test only needs its options.
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      interrupt: vi.fn(),
      setPermissionMode: vi.fn(),
      applyFlagSettings,
      close: vi.fn(),
    }
  }),
}))

// No claude binary, so no auth probe runs against a real profile.
vi.mock('../../src/main/provider/managed-bin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/managed-bin')>()
  return { ...actual, createExecutableCache: () => ({ refresh: () => null, current: () => null }) }
})

async function startTurn(opts: { reasoningEffort?: 'low' | 'max'; model?: string; knownModels?: ModelOption[] }) {
  const { ClaudeAdapter } = await import('../../src/main/provider/adapters/claude-adapter')
  const adapter = new ClaudeAdapter()
  await adapter.startSession({ threadId: 't1', provider: 'claude', cwd: '/tmp', runtimeMode: 'sandbox', ...opts }, vi.fn())
  await adapter.sendTurn('t1', 'hello', 'sandbox')
  await vi.waitFor(() => expect(captured).not.toBeNull())
  return adapter
}

beforeEach(() => {
  captured = null
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Claude effort', () => {
  it('starts the query with the chat\'s effort', async () => {
    const adapter = await startTurn({ reasoningEffort: 'low' })
    expect(captured!.effort).toBe('low')
    await adapter.stopSession('t1')
  })

  it('sends no effort when the chat has none, so the CLI default applies', async () => {
    const adapter = await startTurn({})
    expect(captured).not.toHaveProperty('effort')
    await adapter.stopSession('t1')
  })

  it('leaves off a level the catalog says the model does not take', async () => {
    const adapter = await startTurn({
      reasoningEffort: 'max',
      model: 'haiku',
      knownModels: [{ id: 'haiku', label: 'Haiku', tier: 'fast', effortLevels: [] }],
    })
    expect(captured).not.toHaveProperty('effort')
    await adapter.stopSession('t1')
  })

  it('applies a change to the running query', async () => {
    const adapter = await startTurn({ reasoningEffort: 'low' })
    await adapter.setReasoningEffort('t1', 'max')
    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' })
    await adapter.stopSession('t1')
  })
})

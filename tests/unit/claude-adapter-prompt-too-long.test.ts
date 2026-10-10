/**
 * "Prompt is too long" (seen on the first turn after a profile switch to an
 * account with a smaller context window): the adapter compacts and sends the
 * turn again once, as one turn, and never shows the CLI's raw text.
 */
import { describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  read: [] as string[],
  /** How many more times a non-compact prompt is refused as too long. */
  refuse: 0,
  refuseCompact: false,
  /** Holds the first reply until the test has queued a message behind it. */
  gate: null as Promise<void> | null,
}))

function tooLong(): unknown[] {
  return [
    {
      type: 'assistant',
      error: 'invalid_request',
      parent_tool_use_id: null,
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'Prompt is too long' }] },
    },
    { type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long', terminal_reason: 'prompt_too_long' },
  ]
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const msg of args.prompt) {
        const text = typeof msg.message.content === 'string' ? msg.message.content : ''
        sdk.read.push(text)
        yield { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: {} } }
        if (sdk.gate) {
          await sdk.gate
          sdk.gate = null
        }
        if (text === '/compact') {
          if (sdk.refuseCompact) {
            yield* tooLong()
          } else {
            yield { type: 'system', subtype: 'compact_boundary' }
            yield { type: 'result', subtype: 'success', is_error: false, result: '' }
          }
        } else if (sdk.refuse > 0) {
          sdk.refuse--
          yield* tooLong()
        } else {
          yield { type: 'result', subtype: 'success', is_error: false, result: 'done' }
        }
      }
    },
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    getContextUsage: vi.fn(async () => ({})),
    close: vi.fn(),
  })),
}))

vi.mock('../../src/main/provider/managed-bin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/managed-bin')>()
  return { ...actual, createExecutableCache: () => ({ refresh: () => null, current: () => null }) }
})

async function runTurn(message: string, queueBehind?: string) {
  const { ClaudeAdapter } = await import('../../src/main/provider/adapters/claude-adapter')
  const adapter = new ClaudeAdapter()
  const onEvent = vi.fn()
  await adapter.startSession({ threadId: 't1', provider: 'claude', cwd: '/tmp', runtimeMode: 'sandbox' }, onEvent)
  let release: () => void = () => {}
  if (queueBehind) sdk.gate = new Promise<void>((resolve) => { release = resolve })
  await adapter.sendTurn('t1', message, 'sandbox')
  if (queueBehind) {
    await vi.waitFor(() => expect(sdk.read).toContain(message))
    await adapter.sendTurn('t1', queueBehind, 'sandbox', undefined, 'queue', 'q1')
    release()
  }
  await vi.waitFor(() => expect(onEvent.mock.calls.filter(([e]) => e.type === 'turn.completed').length).toBeGreaterThanOrEqual(1))
  // Anything a wrong implementation would still send arrives within a few ticks.
  await new Promise((resolve) => setTimeout(resolve, 50))
  await adapter.stopSession('t1')
  const events = onEvent.mock.calls.map(([e]) => e)
  return {
    errors: events.filter((e) => e.type === 'error').map((e) => e.message as string),
    notices: events.filter((e) => e.type === 'content').map((e) => e.text as string),
    turnEnds: events.filter((e) => e.type === 'turn.completed').length,
    held: events.some((e) => e.type === 'turn.queue-held' && e.held),
    lastStatus: events.filter((e) => e.type === 'status').at(-1)?.status,
  }
}

describe('Claude prompt too long', () => {
  it('compacts and sends the turn again, as one turn with no error', async () => {
    Object.assign(sdk, { read: [], refuse: 1, refuseCompact: false })
    const result = await runTurn('carry on')
    expect(sdk.read).toEqual(['carry on', '/compact', 'carry on'])
    expect(result.errors).toEqual([])
    expect(result.notices.some((t) => /compacting/i.test(t))).toBe(true)
    expect(result.turnEnds).toBe(1)
    expect(result.lastStatus).toBe('idle')
  })

  it('tries once: still too long after compacting shows a clear message, not the raw one', async () => {
    Object.assign(sdk, { read: [], refuse: 2, refuseCompact: false })
    const result = await runTurn('carry on')
    expect(sdk.read).toEqual(['carry on', '/compact', 'carry on'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/context window/)
    expect(result.errors[0]).not.toMatch(/^Prompt is too long$/)
    expect(result.turnEnds).toBe(1)
  })

  it('does not compact again when the compaction itself is too long', async () => {
    Object.assign(sdk, { read: [], refuse: 1, refuseCompact: true })
    const result = await runTurn('carry on')
    expect(sdk.read).toEqual(['carry on', '/compact'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/context window/)
    expect(result.turnEnds).toBe(1)
  })

  it('does not compact when the user\'s own /compact is too long', async () => {
    Object.assign(sdk, { read: [], refuse: 0, refuseCompact: true })
    const result = await runTurn('/compact')
    expect(sdk.read).toEqual(['/compact'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/context window/)
    expect(result.turnEnds).toBe(1)
  })

  it('does not compact ahead of a queued message, and says what to do', async () => {
    Object.assign(sdk, { read: [], refuse: 1, refuseCompact: false })
    const result = await runTurn('carry on', 'next thing')
    expect(sdk.read).not.toContain('/compact')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/Send \/compact/)
    expect(result.held).toBe(true)
  })
})

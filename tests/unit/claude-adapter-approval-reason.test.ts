/**
 * Claude approval cards say why Claude asked: `canUseTool` reads the SDK's
 * `decisionReason` and `matchedAskRule` into `request.opened.reason`. In full
 * access the SDK asks only when a safety check or an ask rule stopped the
 * action, so those asks open a card instead of being allowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMode } from '../../src/shared/types'

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<{ behavior: string; message?: string }>
let captured: { canUseTool: CanUseTool } | null = null

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: typeof captured }) => {
    captured = args.options
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
      interrupt: vi.fn(),
      setPermissionMode: vi.fn(),
      close: vi.fn(),
    }
  }),
}))

vi.mock('../../src/main/provider/managed-bin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/managed-bin')>()
  return { ...actual, createExecutableCache: () => ({ refresh: () => null, current: () => null }) }
})

async function startTurn(mode: RuntimeMode) {
  const { ClaudeAdapter } = await import('../../src/main/provider/adapters/claude-adapter')
  const adapter = new ClaudeAdapter()
  const onEvent = vi.fn()
  await adapter.startSession({ threadId: 't1', provider: 'claude', cwd: '/tmp', runtimeMode: mode }, onEvent)
  await adapter.sendTurn('t1', 'hello', mode)
  await vi.waitFor(() => expect(captured).not.toBeNull())
  return { adapter, onEvent }
}

function openedRequest(onEvent: ReturnType<typeof vi.fn>) {
  return onEvent.mock.calls.map(([e]) => e).find((e) => e.type === 'request.opened')
}

const baseOptions = { signal: new AbortController().signal, toolUseID: 'tu1', requestId: 'r1' }

beforeEach(() => {
  captured = null
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Claude approval reason', () => {
  it('puts the SDK decision reason on the approval request', async () => {
    const { adapter, onEvent } = await startTurn('sandbox')
    void captured!.canUseTool(
      'Bash',
      { command: 'rm -rf build' },
      { ...baseOptions, decisionReason: 'This command deletes files.' },
    )
    await vi.waitFor(() => expect(openedRequest(onEvent)).toBeDefined())
    expect(openedRequest(onEvent).reason).toBe('This command deletes files.')
    await adapter.stopSession('t1')
  })

  it('names the matched ask rule', async () => {
    const { adapter, onEvent } = await startTurn('sandbox')
    void captured!.canUseTool(
      'Bash',
      { command: 'git push' },
      { ...baseOptions, matchedAskRule: { source: 'userSettings', toolName: 'Bash', ruleContent: 'git push:*' } },
    )
    await vi.waitFor(() => expect(openedRequest(onEvent)).toBeDefined())
    expect(openedRequest(onEvent).reason).toBe('Your ask rule Bash(git push:*) from userSettings matched.')
    await adapter.stopSession('t1')
  })

  it('opens no reason when the SDK gives none', async () => {
    const { adapter, onEvent } = await startTurn('sandbox')
    void captured!.canUseTool('Bash', { command: 'ls' }, baseOptions)
    await vi.waitFor(() => expect(openedRequest(onEvent)).toBeDefined())
    expect(openedRequest(onEvent).reason).toBeUndefined()
    await adapter.stopSession('t1')
  })

  it('opens a card in full access for a safety check, and says why', async () => {
    const { adapter, onEvent } = await startTurn('full-access')
    void captured!.canUseTool(
      'Edit',
      { file_path: '/tmp/.git/config' },
      { ...baseOptions, decisionReason: 'Edits to .git need approval.', decisionReasonType: 'safetyCheck' },
    )
    await vi.waitFor(() => expect(openedRequest(onEvent)).toBeDefined())
    expect(openedRequest(onEvent).reason).toBe(
      'A safety check or your ask rule stopped this action. Edits to .git need approval.',
    )
    await adapter.stopSession('t1')
  })

  it('opens a card in full access for an ask rule', async () => {
    const { adapter, onEvent } = await startTurn('full-access')
    void captured!.canUseTool(
      'Bash',
      { command: 'git push' },
      { ...baseOptions, matchedAskRule: { source: 'projectSettings', toolName: 'Bash' } },
    )
    await vi.waitFor(() => expect(openedRequest(onEvent)).toBeDefined())
    expect(openedRequest(onEvent).reason).toBe(
      'A safety check or your ask rule stopped this action. Your ask rule Bash from projectSettings matched.',
    )
    await adapter.stopSession('t1')
  })

  it('opens a card in accept edits for an edit tool a safety check stopped', async () => {
    const { adapter, onEvent } = await startTurn('accept-edits')
    void captured!.canUseTool(
      'Edit',
      { file_path: '/tmp/.git/config' },
      { ...baseOptions, decisionReason: 'Edits to .git need approval.', decisionReasonType: 'safetyCheck' },
    )
    await vi.waitFor(() => expect(openedRequest(onEvent)).toBeDefined())
    expect(openedRequest(onEvent).reason).toBe('Edits to .git need approval.')
    await adapter.stopSession('t1')
  })

  it('keeps plan mode read-only allows without a card', async () => {
    const { adapter, onEvent } = await startTurn('plan')
    const safety = await captured!.canUseTool(
      'Read',
      { file_path: '/etc/hosts' },
      { ...baseOptions, decisionReason: 'Outside the project.', decisionReasonType: 'safetyCheck' },
    )
    const rule = await captured!.canUseTool(
      'WebFetch',
      { url: 'https://example.com' },
      { ...baseOptions, matchedAskRule: { source: 'userSettings', toolName: 'WebFetch' } },
    )
    expect(safety.behavior).toBe('allow')
    expect(rule.behavior).toBe('allow')
    expect(openedRequest(onEvent)).toBeUndefined()
    await adapter.stopSession('t1')
  })

  it('still allows a plain full access ask without a card', async () => {
    const { adapter, onEvent } = await startTurn('full-access')
    const decision = await captured!.canUseTool(
      'Bash',
      { command: 'ls' },
      { ...baseOptions, decisionReason: 'Mode switch in flight.', decisionReasonType: 'mode' },
    )
    expect(decision.behavior).toBe('allow')
    expect(openedRequest(onEvent)).toBeUndefined()
    await adapter.stopSession('t1')
  })
})

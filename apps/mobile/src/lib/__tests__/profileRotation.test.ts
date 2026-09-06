/**
 * ThreadScreen's `rotateProfile` used to throw on ANY `!result.ok` from
 * `switchInstance`, including `context-unavailable` (no live backend session
 * yet - e.g. a freshly created thread nobody has sent a first message on).
 * The desktop's ChatPanel already treats that case specially: a DB-only
 * write of the picked instance id, no session start/stop, no data loss. The
 * phone had no equivalent, so picking a profile on a not-yet-started thread
 * surfaced as a plain "could not switch profile" error with nothing repaired.
 *
 * `classifySwitchResult` is the pure decision extracted so it is testable
 * without mounting ThreadScreen (which needs react-native / jest-expo).
 */
import type { ProviderInstanceSwitchResult } from '@shared/provider-events'
import { classifySwitchResult, rotateWithinAgent, type RotateWithinAgentDeps } from '../profileRotation'

function ok(): ProviderInstanceSwitchResult {
  return {
    ok: true,
    threadId: 't1',
    provider: 'claude',
    previousInstanceId: null,
    instanceId: 'claude-work',
    instanceName: 'Work',
    continuity: 'preserved',
  }
}

function failure(
  code: Extract<ProviderInstanceSwitchResult, { ok: false }>['code'],
  message = 'failed',
): ProviderInstanceSwitchResult {
  return { ok: false, code, message, currentInstanceId: null }
}

describe('classifySwitchResult', () => {
  it('is a plain switch on success', () => {
    expect(classifySwitchResult(ok())).toEqual({ kind: 'switched' })
  })

  it('surfaces context-conflict for the start-fresh confirmation prompt', () => {
    expect(classifySwitchResult(failure('context-conflict', 'histories differ'))).toEqual({
      kind: 'conflict',
      message: 'histories differ',
    })
  })

  it('routes context-unavailable to the DB-only repoint path, not an error', () => {
    expect(classifySwitchResult(failure('context-unavailable', 'no live session'))).toEqual({
      kind: 'db-only-repoint',
    })
  })

  it('treats every other failure code as a visible error', () => {
    expect(classifySwitchResult(failure('invalid-instance', 'nope'))).toEqual({
      kind: 'error',
      message: 'nope',
    })
    expect(classifySwitchResult(failure('busy', 'busy now'))).toEqual({
      kind: 'error',
      message: 'busy now',
    })
  })
})

describe('rotateWithinAgent', () => {
  function deps(overrides: Partial<RotateWithinAgentDeps> = {}): RotateWithinAgentDeps {
    return {
      switchInstance: jest.fn().mockResolvedValue(ok()),
      setConversationProviderInstanceId: jest.fn().mockResolvedValue({ ok: true }),
      confirmStartFresh: jest.fn().mockResolvedValue(true),
      ...overrides,
    }
  }

  it('applies a plain switch and never touches the DB-only path', async () => {
    const d = deps()
    const result = await rotateWithinAgent('thread-1', 'claude-personal', 'claude-work', d)
    expect(result).toEqual({ applied: true })
    expect(d.setConversationProviderInstanceId).not.toHaveBeenCalled()
  })

  it('repoints via the DB-only write on context-unavailable, without starting or stopping anything', async () => {
    const d = deps({ switchInstance: jest.fn().mockResolvedValue(failure('context-unavailable')) })
    const result = await rotateWithinAgent('thread-1', undefined, 'claude-work', d)
    expect(result).toEqual({ applied: true })
    expect(d.setConversationProviderInstanceId).toHaveBeenCalledWith('thread-1', 'claude-work')
  })

  it('prompts on conflict, and retries with start-fresh when the user accepts', async () => {
    const switchInstance = jest
      .fn()
      .mockResolvedValueOnce(failure('context-conflict', 'histories differ'))
      .mockResolvedValueOnce(ok())
    const d = deps({ switchInstance, confirmStartFresh: jest.fn().mockResolvedValue(true) })
    const result = await rotateWithinAgent('thread-1', 'claude-personal', 'claude-work', d)
    expect(result).toEqual({ applied: true })
    expect(d.confirmStartFresh).toHaveBeenCalledWith('histories differ')
    expect(switchInstance).toHaveBeenLastCalledWith('thread-1', expect.objectContaining({ onContextConflict: 'start-fresh' }))
  })

  it('leaves the current profile in place when the user declines the conflict prompt', async () => {
    const switchInstance = jest.fn().mockResolvedValue(failure('context-conflict', 'histories differ'))
    const d = deps({ switchInstance, confirmStartFresh: jest.fn().mockResolvedValue(false) })
    const result = await rotateWithinAgent('thread-1', 'claude-personal', 'claude-work', d)
    expect(result).toEqual({ applied: false })
    expect(switchInstance).toHaveBeenCalledTimes(1)
  })

  it('throws a user-facing error for any other failure, and never repoints the DB', async () => {
    const d = deps({ switchInstance: jest.fn().mockResolvedValue(failure('invalid-instance', 'nope')) })
    await expect(rotateWithinAgent('thread-1', 'claude-personal', 'claude-work', d)).rejects.toThrow('nope')
    expect(d.setConversationProviderInstanceId).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { TurnWatchdog, StderrTail, countToolBrackets } from '../../src/main/provider/turn-watchdog'

/**
 * TurnWatchdog detects a turn that has gone silent: no SDK messages for
 * `stallMs` while nothing legitimately silent (running tool, pending
 * approval) is in flight. Repro: a turn hung after sendTurn with zero
 * feedback - the UI spun forever and only the dev log knew why.
 */
describe('TurnWatchdog', () => {
  const STALL = 120_000

  function make() {
    const onStall = vi.fn()
    const dog = new TurnWatchdog(STALL, onStall)
    return { dog, onStall }
  }

  it('does not report when no turn is in flight', () => {
    const { dog, onStall } = make()
    dog.check(STALL * 10)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('reports once after stallMs of silence in a turn', () => {
    const { dog, onStall } = make()
    dog.turnStarted(0)
    dog.check(STALL - 1)
    expect(onStall).not.toHaveBeenCalled()
    dog.check(STALL)
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall).toHaveBeenCalledWith(STALL)
  })

  it('does not repeat the report while the silence continues', () => {
    const { dog, onStall } = make()
    dog.turnStarted(0)
    dog.check(STALL)
    dog.check(STALL * 2)
    dog.check(STALL * 3)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('re-arms after new activity', () => {
    const { dog, onStall } = make()
    dog.turnStarted(0)
    dog.check(STALL)
    expect(onStall).toHaveBeenCalledTimes(1)
    dog.activity(STALL + 1_000)
    dog.check(STALL + 2_000)
    expect(onStall).toHaveBeenCalledTimes(1)
    dog.check(STALL + 1_000 + STALL)
    expect(onStall).toHaveBeenCalledTimes(2)
  })

  it('activity resets the idle clock', () => {
    const { dog, onStall } = make()
    dog.turnStarted(0)
    dog.activity(STALL - 1)
    dog.check(STALL)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('suppresses reports while a tool or approval is in flight', () => {
    const { dog, onStall } = make()
    dog.turnStarted(0)
    dog.suspend()
    dog.check(STALL * 5)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('resumes reporting after the suspension lifts', () => {
    const { dog, onStall } = make()
    dog.turnStarted(0)
    dog.suspend()
    dog.check(STALL)
    dog.resume(STALL) // tool finished at STALL - counts as activity
    dog.check(STALL + STALL - 1)
    expect(onStall).not.toHaveBeenCalled()
    dog.check(STALL + STALL)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('nested suspensions require every resume before reporting', () => {
    const { dog, onStall } = make()
    dog.turnStarted(0)
    dog.suspend()
    dog.suspend()
    dog.resume(1_000)
    dog.check(STALL * 2)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('stops reporting once the turn ends', () => {
    const { dog, onStall } = make()
    dog.turnStarted(0)
    dog.turnEnded()
    dog.check(STALL * 2)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('a new turn clears suspensions left open by the last one', () => {
    // A turn interrupted mid-tool never delivers its tool_result, so its
    // suspend() has no matching resume(). Without a reset the next turn
    // would start permanently suspended and never report a stall again.
    const { dog, onStall } = make()
    dog.turnStarted(0)
    dog.suspend()
    dog.turnEnded()

    dog.turnStarted(1_000)
    dog.check(1_000 + STALL)
    expect(onStall).toHaveBeenCalledTimes(1)
  })
})

describe('countToolBrackets', () => {
  const STALL = 120_000

  function armed() {
    const onStall = vi.fn()
    const dog = new TurnWatchdog(STALL, onStall)
    dog.turnStarted(0)
    return { dog, onStall }
  }

  const assistantWithTools = (n: number) => ({
    type: 'assistant',
    message: { content: Array.from({ length: n }, (_, i) => ({ type: 'tool_use', id: `t${i}` })) },
  })
  const toolResults = (n: number) => ({
    type: 'user',
    message: { content: Array.from({ length: n }, (_, i) => ({ type: 'tool_result', tool_use_id: `t${i}` })) },
  })

  it('suspends for the duration of a running tool', () => {
    const { dog, onStall } = armed()
    countToolBrackets(assistantWithTools(1), dog, 0)
    dog.check(STALL * 4)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('resumes once the tool result lands', () => {
    const { dog, onStall } = armed()
    countToolBrackets(assistantWithTools(1), dog, 0)
    countToolBrackets(toolResults(1), dog, 0)
    dog.check(STALL * 4)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('handles parallel tool calls - stays suspended until all return', () => {
    const { dog, onStall } = armed()
    countToolBrackets(assistantWithTools(3), dog, 0)
    countToolBrackets(toolResults(2), dog, 0)
    dog.check(STALL * 4)
    expect(onStall).not.toHaveBeenCalled()
    countToolBrackets(toolResults(1), dog, 0)
    dog.check(STALL * 8)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('ignores messages with no tool blocks', () => {
    const { dog, onStall } = armed()
    countToolBrackets({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, dog, 0)
    dog.check(STALL)
    expect(onStall).toHaveBeenCalledTimes(1)
  })

  it('tolerates malformed messages', () => {
    const { dog } = armed()
    expect(() => countToolBrackets({ type: 'assistant' }, dog, 0)).not.toThrow()
    expect(() => countToolBrackets({}, dog, 0)).not.toThrow()
    expect(() => countToolBrackets({ type: 'user', message: { content: 'plain string' } }, dog, 0)).not.toThrow()
  })
})

describe('StderrTail', () => {
  it('returns everything under the cap', () => {
    const tail = new StderrTail(100)
    tail.push('one\n')
    tail.push('two\n')
    expect(tail.tail()).toBe('one\ntwo\n')
  })

  it('keeps only the last maxChars', () => {
    const tail = new StderrTail(10)
    tail.push('aaaaaaaaaa')
    tail.push('bbbbb')
    expect(tail.tail()).toBe('aaaaabbbbb')
  })

  it('is empty before any push', () => {
    expect(new StderrTail(10).tail()).toBe('')
  })
})

import { describe, expect, it } from 'vitest'
import { ChildTaskNotes, HubIdleReaper, NativeSubagents, type HubReaperHost } from '../../src/main/hub/hub-stop'
import { parsePs, processTree } from '../../src/main/hub/hub-measure'
import type { HubWakeKind } from '../../src/shared/hub'

describe('NativeSubagents', () => {
  it('counts an Agent call as running until its result, and a background one until its notice', () => {
    const s = new NativeSubagents()
    s.observe({ type: 'tool.started', threadId: 't', toolId: 'a1', toolName: 'Agent', input: {} })
    s.observe({ type: 'tool.started', threadId: 't', toolId: 'a2', toolName: 'Task', input: {} })
    // A subagent's own call is part of its topmost one.
    s.observe({
      type: 'tool.started',
      threadId: 't',
      toolId: 'a3',
      toolName: 'Agent',
      input: {},
      parentToolCallId: 'a1',
    })
    s.observe({ type: 'tool.started', threadId: 't', toolId: 'r1', toolName: 'Read', input: {} })
    expect(s.runningOf('t')).toBe(2)
    s.observe({ type: 'tool.completed', threadId: 't', toolId: 'a1', output: 'Done: 3 files.' })
    s.observe({ type: 'tool.completed', threadId: 't', toolId: 'a2', output: 'Async agent launched successfully.' })
    expect(s.countsOf('t')).toEqual({ running: 1, done: 1, failed: 0 })
    s.observe({
      type: 'task.notification',
      threadId: 't',
      messageId: 'n1',
      taskId: 'k',
      status: 'failed',
      summary: 'x',
      toolUseId: 'a2',
      at: 0,
    })
    expect(s.countsOf('t')).toEqual({ running: 0, done: 1, failed: 1 })
  })

  it('drops running calls when the process ends, and counts a stop as failed', () => {
    const s = new NativeSubagents()
    s.observe({ type: 'tool.started', threadId: 't', toolId: 'a1', toolName: 'Agent', input: {} })
    s.stopped('t')
    expect(s.countsOf('t')).toEqual({ running: 0, done: 0, failed: 1 })
    s.observe({ type: 'tool.started', threadId: 't', toolId: 'a2', toolName: 'Agent', input: {} })
    s.observe({ type: 'status', threadId: 't', status: 'stopped' })
    expect(s.runningOf('t')).toBe(0)
  })
})

describe('ChildTaskNotes', () => {
  it('lets Switchboard write one wake per task, none after a report, none without a task', () => {
    const n = new ChildTaskNotes()
    expect(n.claim('c')).toBe(false)
    n.task('c')
    expect(n.claim('c')).toBe(true)
    expect(n.claim('c')).toBe(false)
    n.task('c')
    n.tell('c')
    expect(n.claim('c')).toBe(false)
  })
})

describe('processTree', () => {
  it('finds a process and everything below it', () => {
    const rows = parsePs(['  10 1 100 0.5', '  11 10 50 1.0', '  12 11 25 0', '  13 1 999 9'].join('\n'))
    expect(
      processTree(rows, 10)
        ?.map((r) => r.pid)
        .sort(),
    ).toEqual([10, 11, 12])
    expect(processTree(rows, 99)).toBeNull()
  })
})

function reaperHarness(opts: { wake?: HubWakeKind; idle?: boolean; subagents?: number; minutes?: number | null }) {
  let now = 0
  const alive = new Set([500, 501, 502])
  const signals: string[] = []
  const stopped: string[] = []
  const host: HubReaperHost = {
    idleReapMinutes: () => (opts.minutes === undefined ? 20 : opts.minutes),
    openChildren: () => [{ childId: 'child1', parentId: 'parent1' }],
    lastWakes: () => new Map(opts.wake ? [['child1', { kind: opts.wake }]] : []),
    liveThread: () => 'child1',
    idle: () => opts.idle ?? true,
    subagentsRunning: () => opts.subagents ?? 0,
    agentPid: () => 500,
    stop: async (childId) => {
      stopped.push(childId)
      // The agent exits with its session; a test runner it started stays.
      alive.delete(500)
    },
  }
  const reaper = new HubIdleReaper(
    host,
    {
      ps: async () => ['500 1 100 0', '501 500 100 0', '502 501 100 0', '600 1 100 0'].join('\n'),
      alive: (pid) => alive.has(pid),
      kill: (pid, signal) => {
        signals.push(`${signal}:${pid}`)
        if (signal === 'SIGKILL' || pid === 501) alive.delete(pid)
      },
      wait: async () => {},
    },
    () => now,
  )
  return {
    reaper,
    stopped,
    signals,
    at: (minutes: number) => {
      now = minutes * 60_000
    },
  }
}

describe('HubIdleReaper', () => {
  it('stops a reported child idle for the set time and kills what is left of its tree', async () => {
    const h = reaperHarness({ wake: 'report' })
    await h.reaper.tick()
    h.at(19)
    await h.reaper.tick()
    expect(h.stopped).toEqual([])
    h.at(20)
    await h.reaper.tick()
    expect(h.stopped).toEqual(['child1'])
    // 600 is not in the tree; 502 outlived SIGTERM.
    expect(h.signals).toEqual(['SIGTERM:501', 'SIGTERM:502', 'SIGKILL:502'])
  })

  it('counts idle time from the last turn end', async () => {
    const h = reaperHarness({ wake: 'report' })
    await h.reaper.tick()
    h.at(15)
    h.reaper.onTurnEnded('child1')
    h.at(30)
    await h.reaper.tick()
    expect(h.stopped).toEqual([])
    h.at(35)
    await h.reaper.tick()
    expect(h.stopped).toEqual(['child1'])
  })

  it('leaves a child that did not report, runs a subagent, is busy, or when reaping is off', async () => {
    for (const opts of [
      { wake: 'question' as const },
      { wake: 'report' as const, subagents: 1 },
      { wake: 'report' as const, idle: false },
      { wake: 'report' as const, minutes: null },
    ]) {
      const h = reaperHarness(opts)
      await h.reaper.tick()
      h.at(500)
      await h.reaper.tick()
      expect(h.stopped).toEqual([])
    }
  })
})

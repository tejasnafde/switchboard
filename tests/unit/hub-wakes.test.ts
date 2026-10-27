import { createMigratedDb } from './helpers/test-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, getHubParent, insertHubChild, listPendingHubWakes, setHubParentHeld } from '../../src/main/db/database'
import { HubWakeScheduler, type HubWakeHost } from '../../src/main/hub/hub-wakes'
import {
  HUB_UPDATE_OPEN,
  HUB_WAKE_NO_START_MS,
  HUB_WAKE_QUIET_MS,
  HUB_WAKES_PER_HOUR,
  parseHubUpdateMarker,
} from '../../src/shared/hub'

const PARENT = 'agent_parent'

function harness(opts: { send?: () => Promise<boolean>; enabled?: boolean } = {}) {
  const sent: Array<{ threadId: string; body: string }> = []
  const rows: string[] = []
  const interrupted: string[] = []
  let idle = true
  const host: HubWakeHost = {
    enabled: () => opts.enabled ?? true,
    liveThread: (id) => id,
    idle: () => idle,
    send: async (threadId, body) => {
      sent.push({ threadId, body })
      return opts.send ? opts.send() : true
    },
    interrupt: async (threadId) => {
      interrupted.push(threadId)
    },
    announce: (_parentId, content) => rows.push(content),
    changed: () => {},
  }
  const s = new HubWakeScheduler(host)
  const report = (childId: string, summary: string) =>
    s.record({
      parentId: PARENT,
      childId,
      kind: 'report',
      summary,
      pointer: { childId, toolCallId: `call_${childId}`, at: Date.now() },
    })
  return {
    s,
    sent,
    rows,
    interrupted,
    report,
    setIdle: (v: boolean) => {
      idle = v
    },
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  createMigratedDb()
  for (const [i, id] of ['agent_a', 'agent_b', 'agent_c'].entries())
    insertHubChild({
      childId: id,
      parentId: PARENT,
      batchId: 'b1',
      ordinal: i,
      title: `Child ${id.slice(-1).toUpperCase()}`,
      brief: 'Do it',
      location: 'worktree',
      grantedMode: 'sandbox',
      depsMode: 'none',
    })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('HubWakeScheduler', () => {
  it('sends three reports made within 10 s as one wake turn after the quiet time', async () => {
    const h = harness()
    h.report('agent_a', 'A done')
    await vi.advanceTimersByTimeAsync(4000)
    h.report('agent_b', 'B done')
    await vi.advanceTimersByTimeAsync(4000)
    h.report('agent_c', 'C done')
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS - 1)
    expect(h.sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.sent).toHaveLength(1)
    const body = h.sent[0]!.body
    expect(body.startsWith(HUB_UPDATE_OPEN)).toBe(true)
    for (const t of ['Child A (result_ready): A done', 'Child B', 'Child C', 'at: "call_agent_a"'])
      expect(body).toContain(t)
    // Delivered only once the provider shows activity.
    expect(listPendingHubWakes(PARENT)).toHaveLength(3)
    h.s.onActivity(PARENT)
    expect(listPendingHubWakes(PARENT)).toHaveLength(0)
    expect(parseHubUpdateMarker(h.rows[0]!)?.map((e) => e.title)).toEqual(['Child A', 'Child B', 'Child C'])
    h.s.onActivity(PARENT)
    expect(h.rows).toHaveLength(1)
  })

  it('waits while the parent runs and sends at its next idle', async () => {
    const h = harness()
    h.setIdle(false)
    h.report('agent_a', 'A done')
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS * 4)
    expect(h.sent).toHaveLength(0)
    h.setIdle(true)
    h.s.onIdleChance(PARENT)
    await flush()
    expect(h.sent).toHaveLength(1)
  })

  it('counts activity that arrives before the send call returns', async () => {
    let finish!: (ok: boolean) => void
    const h = harness({ send: () => new Promise((r) => (finish = r)) })
    h.report('agent_a', 'A done')
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
    h.s.onActivity(PARENT)
    finish(true)
    await flush()
    expect(listPendingHubWakes(PARENT)).toHaveLength(0)
  })

  it('ends a wake turn with no activity for 2 minutes, retries once, then holds the wakes', async () => {
    const h = harness()
    h.report('agent_a', 'A done')
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
    expect(h.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(HUB_WAKE_NO_START_MS)
    expect(h.interrupted).toEqual([PARENT])
    expect(listPendingHubWakes(PARENT)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
    expect(h.sent).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(HUB_WAKE_NO_START_MS)
    expect(getHubParent(PARENT)).toMatchObject({ held: true, heldReason: 'no_start' })
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS * 4)
    expect(h.sent).toHaveLength(2)
    expect(listPendingHubWakes(PARENT)).toHaveLength(1)

    // Deliver lifts the hold and sends; this time the turn starts.
    h.s.deliverHeld(PARENT)
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
    expect(h.sent).toHaveLength(3)
    h.s.onActivity(PARENT)
    expect(listPendingHubWakes(PARENT)).toHaveLength(0)
    expect(getHubParent(PARENT)?.held).toBe(false)
  })

  it('counts a wake turn that ends with no output of the agent as a failed try', async () => {
    const h = harness()
    h.report('agent_a', 'A done')
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
    h.s.onTurnEnded(PARENT)
    expect(listPendingHubWakes(PARENT)).toHaveLength(1)
    expect(h.rows).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
    expect(h.sent).toHaveLength(2)
  })

  it('delivers a wake once after a refused send', async () => {
    let refuse = true
    const h = harness({ send: async () => !refuse })
    h.report('agent_a', 'A done')
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
    expect(h.sent).toHaveLength(1)
    refuse = false
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
    expect(h.sent).toHaveLength(2)
    h.s.onActivity(PARENT)
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS * 4)
    expect(h.sent).toHaveLength(2)
    expect(h.rows).toHaveLength(1)
  })

  it('holds past the hourly budget', async () => {
    const h = harness()
    for (let i = 0; i < HUB_WAKES_PER_HOUR; i++) {
      h.report('agent_a', `r${i}`)
      await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
      h.s.onActivity(PARENT)
    }
    expect(h.sent).toHaveLength(HUB_WAKES_PER_HOUR)
    h.report('agent_a', 'one more')
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
    expect(h.sent).toHaveLength(HUB_WAKES_PER_HOUR)
    expect(getHubParent(PARENT)).toMatchObject({ held: true, heldReason: 'budget' })
  })

  it('keeps wakes held by a Stop, whoever made them', async () => {
    const h = harness()
    setHubParentHeld(PARENT, true, 'stop')
    h.report('agent_a', 'A done')
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS * 2)
    expect(h.sent).toHaveLength(0)
  })

  it('sends nothing with the flag off and keeps the wakes', async () => {
    const h = harness({ enabled: false })
    h.report('agent_a', 'A done')
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS * 2)
    expect(h.sent).toHaveLength(0)
    expect(listPendingHubWakes(PARENT)).toHaveLength(1)
  })

  it('carries pending wakes on a user turn, delivered in its commit, and lifts a hold', async () => {
    const h = harness()
    h.setIdle(false)
    setHubParentHeld(PARENT, true, 'budget')
    h.report('agent_a', 'A done')
    const claim = h.s.claimForTurn(PARENT)!
    expect(claim.apply('merge it')).toMatch(/^<switchboard-hub-update>[\s\S]*<\/switchboard-hub-update>\n\nmerge it$/)
    // A second turn meanwhile does not take the same wakes.
    expect(h.s.claimForTurn(PARENT)).toBeNull()
    const d = claim.dispatched()
    const db = getDb()
    db.transaction(() => d.commitInTransaction(db, 123))()
    d.afterCommit(true)
    expect(listPendingHubWakes(PARENT)).toHaveLength(0)
    expect(h.rows).toHaveLength(1)
    expect(getHubParent(PARENT)?.held).toBe(false)
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS * 2)
    expect(h.sent).toHaveLength(0)
  })

  it('leaves wakes pending when the carrying turn does not commit', () => {
    const h = harness()
    h.setIdle(false)
    h.report('agent_a', 'A done')
    const claim = h.s.claimForTurn(PARENT)!
    claim.dispatched().afterCommit(false)
    expect(listPendingHubWakes(PARENT)).toHaveLength(1)
    expect(h.s.claimForTurn(PARENT)).not.toBeNull()
  })

  it('picks up wakes left from before a restart', async () => {
    harness().report('agent_a', 'A done')
    const h = harness()
    h.s.start()
    h.s.onIdleChance(PARENT)
    await vi.advanceTimersByTimeAsync(HUB_WAKE_QUIET_MS)
    expect(h.sent).toHaveLength(1)
  })
})

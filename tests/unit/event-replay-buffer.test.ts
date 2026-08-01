/**
 * The replay buffer decides whether a reconnecting client can be told "here is
 * exactly what you missed" or has to be told "re-seed, I lost it". Getting the
 * boundary wrong in the optimistic direction produces a transcript with a
 * silent hole, which is the failure this whole mechanism exists to prevent.
 */
import { describe, it, expect } from 'vitest'
import { EventReplayBuffer } from '../../src/shared/event-replay-buffer'

const frame = (seq: number, pad = ''): string => JSON.stringify({ k: 'evt', seq, pad })

describe('EventReplayBuffer', () => {
  it('replays everything after the cursor, oldest first', () => {
    const buf = new EventReplayBuffer()
    for (let i = 1; i <= 5; i++) buf.push(i, frame(i))
    const { frames, gap } = buf.since(2)
    expect(gap).toBe(false)
    expect(frames.map((f) => JSON.parse(f).seq)).toEqual([3, 4, 5])
  })

  it('reports no gap when the cursor is exactly one behind the oldest retained frame', () => {
    const buf = new EventReplayBuffer(3)
    for (let i = 1; i <= 5; i++) buf.push(i, frame(i))
    // 3,4,5 retained. A client at 2 missed nothing that was evicted.
    expect(buf.oldestSeq).toBe(3)
    expect(buf.since(2)).toEqual({ frames: [frame(3), frame(4), frame(5)], gap: false })
  })

  it('reports a gap when the cursor predates what is still retained', () => {
    const buf = new EventReplayBuffer(3)
    for (let i = 1; i <= 5; i++) buf.push(i, frame(i))
    // A client at 1 missed frame 2, which has been evicted.
    expect(buf.since(1).gap).toBe(true)
  })

  it('evicts by count', () => {
    const buf = new EventReplayBuffer(2)
    for (let i = 1; i <= 5; i++) buf.push(i, frame(i))
    expect(buf.size).toBe(2)
    expect(buf.oldestSeq).toBe(4)
    expect(buf.latestSeq).toBe(5)
  })

  it('evicts by bytes before the count cap binds', () => {
    const big = 'x'.repeat(400)
    const buf = new EventReplayBuffer(1_000, 1_000)
    for (let i = 1; i <= 5; i++) buf.push(i, frame(i, big))
    // Byte budget allows ~2 frames of this size, far short of the 1000 count cap.
    expect(buf.size).toBeLessThan(5)
    expect(buf.latestSeq).toBe(5)
  })

  it('retains a single frame larger than the whole byte budget rather than dropping it', () => {
    const buf = new EventReplayBuffer(1_000, 10)
    buf.push(1, frame(1, 'x'.repeat(500)), 'provider:event')
    // Evicting it would leave an empty buffer AND still not fit - the client
    // is better served by being able to replay the one thing we have.
    expect(buf.size).toBe(1)
    expect(buf.since(0).frames).toHaveLength(1)
  })

  it('applies the caller\'s channel filter, so a replay cannot outrank a live emit', () => {
    // emit() filters by scope on the way out. Without the same filter here a
    // scoped device would be handed, on reconnect, events it is not allowed to
    // receive live.
    const buf = new EventReplayBuffer()
    buf.push(1, frame(1), 'provider:event')
    buf.push(2, frame(2), 'secret:event')
    const { frames } = buf.since(0, (ch) => ch !== 'secret:event')
    expect(frames.map((f) => JSON.parse(f).seq)).toEqual([1])
  })

  it('an empty buffer is not a gap - a fresh server has genuinely sent nothing', () => {
    const buf = new EventReplayBuffer()
    expect(buf.since(0)).toEqual({ frames: [], gap: false })
    expect(buf.since(99)).toEqual({ frames: [], gap: false })
  })

  it('a cursor at or past the newest frame replays nothing and is not a gap', () => {
    const buf = new EventReplayBuffer()
    for (let i = 1; i <= 3; i++) buf.push(i, frame(i))
    expect(buf.since(3)).toEqual({ frames: [], gap: false })
  })
})

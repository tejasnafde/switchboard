/**
 * Buffering policy for the "Stream assistant messages" toggle (FU2).
 * When streaming is OFF, the renderer collects per-message latest-text
 * snapshots and only flushes them on turn.completed. When ON, the
 * buffer is bypassed (every content event is dispatched immediately).
 *
 * The component just calls `bufferContent(buffer, tid, msgId, text)`
 * and `drainTurn(buffer, tid)` — those are pure and tested here.
 */
import { describe, expect, it } from 'vitest'
import {
  createStreamingBuffer,
  bufferContent,
  drainTurn,
  type StreamingBuffer,
} from '../../src/renderer/services/streamingBuffer'

describe('streamingBuffer', () => {
  it('createStreamingBuffer returns an empty buffer', () => {
    const buf = createStreamingBuffer()
    expect(drainTurn(buf, 't1')).toEqual([])
  })

  it('bufferContent stores the latest text per (threadId, messageId)', () => {
    const buf = createStreamingBuffer()
    bufferContent(buf, 't1', 'm1', 'hello')
    bufferContent(buf, 't1', 'm1', 'hello world')
    const drained = drainTurn(buf, 't1')
    expect(drained).toEqual([{ messageId: 'm1', text: 'hello world' }])
  })

  it('drainTurn returns one entry per message in insertion order', () => {
    const buf = createStreamingBuffer()
    bufferContent(buf, 't1', 'm1', 'first')
    bufferContent(buf, 't1', 'm2', 'second')
    bufferContent(buf, 't1', 'm1', 'first updated')
    const drained = drainTurn(buf, 't1')
    expect(drained).toEqual([
      { messageId: 'm1', text: 'first updated' },
      { messageId: 'm2', text: 'second' },
    ])
  })

  it('drainTurn clears the per-thread buffer so the next turn starts fresh', () => {
    const buf = createStreamingBuffer()
    bufferContent(buf, 't1', 'm1', 'turn 1')
    drainTurn(buf, 't1')
    expect(drainTurn(buf, 't1')).toEqual([])

    bufferContent(buf, 't1', 'm2', 'turn 2')
    expect(drainTurn(buf, 't1')).toEqual([{ messageId: 'm2', text: 'turn 2' }])
  })

  it('drainTurn for one thread does not affect another thread (sessions are isolated)', () => {
    const buf = createStreamingBuffer()
    bufferContent(buf, 't1', 'm1', 'thread 1')
    bufferContent(buf, 't2', 'm1', 'thread 2')
    drainTurn(buf, 't1')
    expect(drainTurn(buf, 't2')).toEqual([{ messageId: 'm1', text: 'thread 2' }])
  })

  it('exports the buffer type so callers can hold it in a ref', () => {
    const buf: StreamingBuffer = createStreamingBuffer()
    bufferContent(buf, 't1', 'm1', 'x')
    expect(drainTurn(buf, 't1').length).toBe(1)
  })
})

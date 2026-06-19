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

  it('drainTurn for one thread does not affect another', () => {
    const buf = createStreamingBuffer()
    bufferContent(buf, 't1', 'm1', 'thread 1')
    bufferContent(buf, 't2', 'm1', 'thread 2')
    drainTurn(buf, 't1')
    expect(drainTurn(buf, 't2')).toEqual([{ messageId: 'm1', text: 'thread 2' }])
  })

  it('StreamingBuffer type is exported', () => {
    const buf: StreamingBuffer = createStreamingBuffer()
    bufferContent(buf, 't1', 'm1', 'x')
    expect(drainTurn(buf, 't1').length).toBe(1)
  })
})

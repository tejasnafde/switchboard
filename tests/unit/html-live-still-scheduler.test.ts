import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStillScheduler,
  hiddenStillKey,
  pickHiddenCaptures,
  type HtmlLiveStillFacts,
} from '../../src/renderer/services/html-live-still-scheduler'

const none = new Set<string>()

const eligible: HtmlLiveStillFacts = {
  key: 'k1',
  loadedKey: 'k1',
  hasImage: false,
  allowed: true,
  inPane: false,
  saved: false,
  inView: false,
  running: false,
}

describe('hiddenStillKey', () => {
  it('asks for a block that never came into view and has no image', () => {
    expect(hiddenStillKey(eligible)).toBe('k1')
  })

  it('never asks for a block the running rules forbid', () => {
    expect(hiddenStillKey({ ...eligible, allowed: false })).toBeNull()
    expect(hiddenStillKey({ ...eligible, inPane: true })).toBeNull()
    expect(hiddenStillKey({ ...eligible, saved: true })).toBeNull()
  })

  it('leaves a block in view, running or not yet observed to the normal path', () => {
    expect(hiddenStillKey({ ...eligible, inView: true })).toBeNull()
    expect(hiddenStillKey({ ...eligible, inView: null })).toBeNull()
    expect(hiddenStillKey({ ...eligible, running: true })).toBeNull()
  })

  it('waits for the key and the backend state, and skips a page with an image', () => {
    expect(hiddenStillKey({ ...eligible, key: null, loadedKey: null })).toBeNull()
    expect(hiddenStillKey({ ...eligible, loadedKey: null })).toBeNull()
    expect(hiddenStillKey({ ...eligible, loadedKey: 'old' })).toBeNull()
    expect(hiddenStillKey({ ...eligible, hasImage: true })).toBeNull()
  })
})

describe('pickHiddenCaptures', () => {
  const requests = [
    { id: 'a', key: 'ka', seq: 1 },
    { id: 'b', key: 'kb', seq: 2 },
    { id: 'c', key: 'kc', seq: 3 },
  ]

  it('fills only the slots the running frames leave, oldest request first', () => {
    expect([...pickHiddenCaptures(requests, none, none, 2)]).toEqual(['a', 'b'])
    expect([...pickHiddenCaptures(requests, new Set(['x']), none, 2)]).toEqual(['a'])
    expect(pickHiddenCaptures(requests, new Set(['x', 'y']), none, 2).size).toBe(0)
  })

  it('takes one capture per key and none for a done key', () => {
    const same = [
      { id: 'a', key: 'k', seq: 1 },
      { id: 'b', key: 'k', seq: 2 },
      { id: 'c', key: 'kc', seq: 3 },
    ]
    expect([...pickHiddenCaptures(same, none, none, 2)]).toEqual(['a', 'c'])
    expect([...pickHiddenCaptures(same, none, new Set(['k']), 2)]).toEqual(['c'])
  })
})

describe('createStillScheduler', () => {
  it('queues past the limit and starts the next one when a capture ends', () => {
    const s = createStillScheduler(2)
    s.request('a', 'ka')
    s.request('b', 'kb')
    s.request('c', 'kc')
    expect([...s.pick(none)]).toEqual(['a', 'b'])
    s.finish('a', 'ka')
    expect([...s.pick(none)]).toEqual(['b', 'c'])
  })

  it('a repeat request keeps its place in the queue', () => {
    const s = createStillScheduler(1)
    expect(s.request('a', 'ka')).toBe(true)
    s.request('b', 'kb')
    expect(s.request('a', 'ka')).toBe(false)
    expect([...s.pick(none)]).toEqual(['a'])
  })

  it('cancel drops a request and frees its slot', () => {
    const s = createStillScheduler(1)
    s.request('a', 'ka')
    s.request('b', 'kb')
    expect(s.cancel('a')).toBe(true)
    expect(s.cancel('a')).toBe(false)
    expect([...s.pick(none)]).toEqual(['b'])
  })

  it('never captures a key twice: finished or marked done elsewhere', () => {
    const s = createStillScheduler(2)
    s.request('a', 'k')
    s.finish('a', 'k')
    expect(s.request('b', 'k')).toBe(false)
    expect(s.pick(none).size).toBe(0)
    s.request('c', 'k2')
    s.markDone('k2')
    expect(s.pick(none).size).toBe(0)
  })
})

describe('html-live-frames with hidden captures', () => {
  type Frames = typeof import('../../src/renderer/services/html-live-frames')
  let frames: Frames
  // useFrameRunning and useFrameHiddenStill read the store through useSyncExternalStore,
  // which calls the snapshot getter during render; read the same getters here.
  const running = (id: string) => frames.useFrameRunning(id)
  const hidden = (id: string) => frames.useFrameHiddenStill(id)

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('react', async () => {
      const real = await vi.importActual<typeof import('react')>('react')
      return { ...real, useSyncExternalStore: (_sub: unknown, get: () => unknown) => get() }
    })
    frames = await import('../../src/renderer/services/html-live-frames')
  })

  it('gives a never-in-view frame a hidden capture', () => {
    frames.claimFrame('a')
    frames.setFrameStillRequest('a', 'ka')
    expect(hidden('a')).toBe(true)
    expect(running('a')).toBe(false)
  })

  it('counts frames in view against the limit and queues the capture', () => {
    for (const id of ['v1', 'v2', 'h']) frames.claimFrame(id)
    frames.setFrameWants('v1', true)
    frames.setFrameWants('v2', true)
    frames.setFrameStillRequest('h', 'kh')
    expect(running('v1') && running('v2')).toBe(true)
    expect(hidden('h')).toBe(false)
    frames.setFrameWants('v2', false)
    expect(hidden('h')).toBe(true)
  })

  it('the in-view path is unchanged: a frame that comes into view runs and its capture is dropped', () => {
    frames.claimFrame('a')
    frames.setFrameStillRequest('a', 'ka')
    frames.setFrameStillRequest('a', null)
    frames.setFrameWants('a', true)
    expect(running('a')).toBe(true)
    expect(hidden('a')).toBe(false)
  })

  it('cancels the capture when the frame unmounts', () => {
    frames.claimFrame('a')
    frames.claimFrame('b')
    frames.setFrameStillRequest('a', 'ka')
    frames.setFrameStillRequest('b', 'kb')
    frames.releaseFrame('a')
    expect(hidden('a')).toBe(false)
    expect(hidden('b')).toBe(true)
  })

  it('a still image for the key, from any frame, ends the capture and blocks another', () => {
    frames.claimFrame('a')
    frames.setFrameStillRequest('a', 'ka')
    frames.rememberImage('ka', 'data:image/png;base64,')
    expect(hidden('a')).toBe(false)
    frames.claimFrame('b')
    frames.setFrameStillRequest('b', 'ka')
    expect(hidden('b')).toBe(false)
  })

  it('a finished capture is not repeated for the same page', () => {
    frames.claimFrame('a')
    frames.setFrameStillRequest('a', 'ka')
    frames.finishHiddenStill('a', 'ka')
    frames.releaseFrame('a')
    frames.claimFrame('b')
    frames.setFrameStillRequest('b', 'ka')
    expect(hidden('b')).toBe(false)
  })
})

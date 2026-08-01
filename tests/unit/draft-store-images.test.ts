/**
 * Image attachments are per session, like drafts and pills.
 *
 * Regression: they used to be component-local useState in ChatInput, which
 * nothing remounts on a conversation switch, so a pasted image followed the
 * user into every chat and was sent from whichever one they hit Send in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useDraftStore, type ImageAttachment } from '../../src/renderer/stores/draft-store'

const revoked: string[] = []

beforeEach(() => {
  revoked.length = 0
  vi.stubGlobal('URL', {
    createObjectURL: (): string => 'blob:stub',
    revokeObjectURL: (url: string): void => {
      revoked.push(url)
    },
  })
  useDraftStore.setState({ imagesBySession: {} })
})

function img(id: string): ImageAttachment {
  return { id, file: { name: `${id}.png` } as File, previewUrl: `blob:${id}` }
}

const imagesFor = (session: string): ImageAttachment[] =>
  useDraftStore.getState().imagesBySession[session] ?? []

describe('imagesBySession', () => {
  it('keeps one session\'s attachments out of another', () => {
    useDraftStore.getState().addImages('session-a', [img('1')])

    expect(imagesFor('session-a')).toHaveLength(1)
    expect(imagesFor('session-b')).toHaveLength(0)
  })

  it('appends rather than replacing', () => {
    useDraftStore.getState().addImages('s', [img('1')])
    useDraftStore.getState().addImages('s', [img('2'), img('3')])

    expect(imagesFor('s').map((i) => i.id)).toEqual(['1', '2', '3'])
  })

  it('revokes the object URL when an image is removed', () => {
    useDraftStore.getState().addImages('s', [img('1'), img('2')])
    useDraftStore.getState().removeImage('s', '1')

    expect(imagesFor('s').map((i) => i.id)).toEqual(['2'])
    expect(revoked).toEqual(['blob:1'])
  })

  it('drops the key entirely once the last image goes, so the map stays bounded', () => {
    useDraftStore.getState().addImages('s', [img('1')])
    useDraftStore.getState().removeImage('s', '1')

    expect('s' in useDraftStore.getState().imagesBySession).toBe(false)
  })

  it('revokes every URL on clear', () => {
    useDraftStore.getState().addImages('s', [img('1'), img('2')])
    useDraftStore.getState().clearImages('s')

    expect(imagesFor('s')).toHaveLength(0)
    expect(revoked).toEqual(['blob:1', 'blob:2'])
  })

  it('clears only the session it was told to clear', () => {
    useDraftStore.getState().addImages('a', [img('1')])
    useDraftStore.getState().addImages('b', [img('2')])
    useDraftStore.getState().clearImages('a')

    expect(imagesFor('a')).toHaveLength(0)
    expect(imagesFor('b')).toHaveLength(1)
  })

  it('is a no-op for an unknown session or image id', () => {
    const before = useDraftStore.getState().imagesBySession
    useDraftStore.getState().clearImages('nope')
    useDraftStore.getState().removeImage('nope', 'x')
    expect(useDraftStore.getState().imagesBySession).toBe(before)
    expect(revoked).toEqual([])
  })

  it('starts empty - attachments must never be restored from a previous run', () => {
    // Each holds a live File and an object URL; neither survives a restart.
    expect(useDraftStore.getState().imagesBySession).toEqual({})
  })
})

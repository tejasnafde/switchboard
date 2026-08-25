import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as draftStoreModule from '../../src/renderer/stores/draft-store'
import { useDraftStore, type DraftPill, type ImageAttachment } from '../../src/renderer/stores/draft-store'

const revokeObjectURL = vi.fn()

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
  })
  vi.stubGlobal('URL', { revokeObjectURL })
  revokeObjectURL.mockClear()
  useDraftStore.setState({ drafts: {}, pillsBySession: {}, imagesBySession: {} })
})

describe('draft payload transaction', () => {
  it('exposes a lossless detach operation', () => {
    const store = useDraftStore.getState() as unknown as Record<string, unknown>

    expect(typeof store.detachDraftPayload).toBe('function')
  })

  it('removes and returns the complete payload without revoking image previews', () => {
    const pill: DraftPill = {
      id: 'pill-1',
      kind: 'file',
      label: 'file.ts',
      content: '@file.ts',
    }
    const image: ImageAttachment = {
      id: 'image-1',
      file: { name: 'image.png' } as File,
      previewUrl: 'blob:image-1',
    }
    useDraftStore.setState({
      drafts: { 'session-1': 'hello' },
      pillsBySession: { 'session-1': [pill] },
      imagesBySession: { 'session-1': [image] },
    })

    const payload = useDraftStore.getState().detachDraftPayload('session-1')

    expect(payload).toEqual({ text: 'hello', pills: [pill], images: [image] })
    expect(useDraftStore.getState().drafts).toEqual({})
    expect(useDraftStore.getState().pillsBySession).toEqual({})
    expect(useDraftStore.getState().imagesBySession).toEqual({})
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('restores a detached payload only when it cannot overwrite a newer draft', () => {
    const payload = {
      text: 'failed message',
      pills: [] as DraftPill[],
      images: [] as ImageAttachment[],
    }
    const store = useDraftStore.getState() as unknown as Record<string, unknown>
    expect(typeof store.restoreDraftPayloadIfEmpty).toBe('function')
    const restore = store.restoreDraftPayloadIfEmpty as (sessionId: string, value: typeof payload) => boolean

    useDraftStore.getState().setDraft('session-1', 'newer draft')
    expect(restore('session-1', payload)).toBe(false)
    expect(useDraftStore.getState().getDraft('session-1')).toBe('newer draft')

    useDraftStore.getState().clearDraft('session-1')
    expect(restore('session-1', payload)).toBe(true)
    expect(useDraftStore.getState().getDraft('session-1')).toBe('failed message')
  })

  it('releases detached image previews only after the payload is committed', () => {
    const discard = (draftStoreModule as unknown as Record<string, unknown>).discardDetachedDraftPayload
    expect(typeof discard).toBe('function')

    ;(discard as (payload: { text: string; pills: DraftPill[]; images: ImageAttachment[] }) => void)({
      text: 'sent',
      pills: [],
      images: [{
        id: 'image-1',
        file: { name: 'image.png' } as File,
        previewUrl: 'blob:image-1',
      }],
    })

    expect(revokeObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:image-1')
  })

  it('does not revoke a preview still owned by a retained recovery payload', () => {
    const image = {
      id: 'image-1',
      file: { name: 'image.png' } as File,
      previewUrl: 'blob:shared-image',
    }
    draftStoreModule.discardDetachedDraftPayload(
      { text: 'old', pills: [], images: [image] },
      [{ text: 'new', pills: [], images: [{ ...image }] }],
    )

    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('recognizes content-equivalent payloads after attachment arrays are recreated', () => {
    const equals = (draftStoreModule as unknown as Record<string, unknown>).draftPayloadEquals
    expect(typeof equals).toBe('function')
    const image = {
      id: 'image-1',
      file: { name: 'image.png', size: 12, type: 'image/png', lastModified: 34 } as File,
      previewUrl: 'blob:image-1',
    }
    const payload = {
      text: 'same message',
      pills: [{ id: 'pill-1', kind: 'file' as const, label: 'file.ts', content: '@file.ts' }],
      images: [image],
    }

    expect((equals as (left: typeof payload, right: typeof payload) => boolean)(payload, {
      text: payload.text,
      pills: [...payload.pills],
      images: [{ ...image }],
    })).toBe(true)
  })
})

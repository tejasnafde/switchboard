import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearComposerRegistry,
  focusComposer,
  registerComposer,
} from '../../src/renderer/services/composerRegistry'
import {
  cloneDraftPayload,
  withDraftProvenance,
  requiresDraftTransferConfirmation,
} from '../../src/renderer/services/draftTransfer'

afterEach(() => clearComposerRegistry())

describe('session composer registry', () => {
  it('focuses the registered target session rather than the first mounted composer', () => {
    const left = { focus: vi.fn() }
    const right = { focus: vi.fn() }
    registerComposer('left', left)
    registerComposer('right', right)

    expect(focusComposer('right')).toBe(true)
    expect(right.focus).toHaveBeenCalledOnce()
    expect(left.focus).not.toHaveBeenCalled()
  })

  it('does not unregister a newer remounted composer through stale cleanup', () => {
    const oldHandle = { focus: vi.fn() }
    const newHandle = { focus: vi.fn() }
    const unregisterOld = registerComposer('right', oldHandle)
    registerComposer('right', newHandle)
    unregisterOld()

    expect(focusComposer('right')).toBe(true)
    expect(newHandle.focus).toHaveBeenCalledOnce()
  })

  it('reports an unavailable target without falling back to another composer', () => {
    const left = { focus: vi.fn() }
    registerComposer('left', left)

    expect(focusComposer('closed')).toBe(false)
    expect(left.focus).not.toHaveBeenCalled()
  })
})

describe('copy prompt to another chat', () => {
  it('remaps pill tokens and clones image identity without sharing preview URLs', () => {
    const file = { name: 'diagram.png' } as File
    const result = cloneDraftPayload({
      text: 'Compare [[pill:file-1]] and [[pill:terminal-1]]',
      pills: [
        { id: 'file-1', kind: 'file', label: 'a.ts', content: '@src/a.ts' },
        { id: 'terminal-1', kind: 'terminal', label: 'Terminal', content: 'output' },
      ],
      images: [{ id: 'image-1', file, previewUrl: 'blob:source' }],
    }, {
      nextId: vi.fn()
        .mockReturnValueOnce('copy-file')
        .mockReturnValueOnce('copy-terminal')
        .mockReturnValueOnce('copy-image'),
      createPreviewUrl: () => 'blob:copy',
    })

    expect(result.text).toBe('Compare [[pill:copy-file]] and [[pill:copy-terminal]]')
    expect(result.pills.map((pill) => pill.id)).toEqual(['copy-file', 'copy-terminal'])
    expect(result.images).toEqual([{ id: 'copy-image', file, previewUrl: 'blob:copy' }])
  })

  it('does not mutate the source payload', () => {
    const source = {
      text: '[[pill:p1]]',
      pills: [{ id: 'p1', kind: 'chat-message' as const, label: 'quote', content: '> hi' }],
      images: [],
    }
    cloneDraftPayload(source, { nextId: () => 'p2', createPreviewUrl: () => 'unused' })
    expect(source).toEqual({
      text: '[[pill:p1]]',
      pills: [{ id: 'p1', kind: 'chat-message', label: 'quote', content: '> hi' }],
      images: [],
    })
  })

  it('requires confirmation across machines or provider profiles', () => {
    expect(requiresDraftTransferConfirmation(
      { machineId: 'local', instanceId: 'work' },
      { machineId: 'remote', instanceId: 'work' },
    )).toBe(true)
    expect(requiresDraftTransferConfirmation(
      { machineId: 'local', instanceId: 'work' },
      { machineId: 'local', instanceId: 'personal' },
    )).toBe(true)
    expect(requiresDraftTransferConfirmation(
      { machineId: 'local', instanceId: 'work' },
      { machineId: 'local', instanceId: 'work' },
    )).toBe(false)
  })

  it('adds visible source provenance to the copied prompt', () => {
    expect(withDraftProvenance('Compare this', 'API review · Codex')).toBe(
      '> Prompt copied from API review · Codex\n\nCompare this',
    )
  })
})

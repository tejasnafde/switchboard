// @vitest-environment jsdom
/**
 * Composer attachments: how dropped or picked files are sorted and refused,
 * the chips of saved files and folders, and the chat-view drop zone, whose highlight must clear on the window's dragend.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { attachmentLabel, MAX_IMAGE_BYTES, sortAttachments } from '../../src/renderer/services/attachment-intake'
import { attachmentPromptLine, parseAttachmentLine } from '../../src/shared/attachments'
import { pillChipModel, pillContentInMessage } from '../../src/renderer/services/pill-chip-model'
import { useChatDropZone } from '../../src/renderer/components/chat/useChatDropZone'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const file = (name: string, type: string, size = 10): File =>
  Object.defineProperty(new File(['x'], name, { type }), 'size', { value: size })

describe('sortAttachments', () => {
  it('sends images inline, other files and folders as paths, and names each refused file', () => {
    const png = file('a.png', 'image/png')
    const pdf = file('spec.pdf', 'application/pdf')
    const svg = file('logo.svg', 'image/svg+xml')
    const folder = file('shots', '')
    const sorted = sortAttachments(
      [
        png,
        pdf,
        svg,
        folder,
        file('scan.tiff', 'image/tiff'),
        file('huge.jpg', 'image/jpeg', MAX_IMAGE_BYTES + 1),
        file('design.sketch', '', 82 * 1024 * 1024),
      ],
      (f) => f === folder,
    )
    expect(sorted.images).toEqual([png])
    expect(sorted.files).toEqual([pdf, svg])
    expect(sorted.folders).toEqual([folder])
    expect(sorted.refused).toEqual([
      { name: 'scan.tiff', reason: 'TIFF images are not supported. Use PNG, JPEG, WebP or GIF.' },
      { name: 'huge.jpg', reason: '21 MB is over the 20 MB image limit.' },
      { name: 'design.sketch', reason: '82 MB is over the 50 MB file limit.' },
    ])
  })

  it('labels a chip with its pages, lines or folder entries', () => {
    expect(attachmentLabel('spec.pdf', { pages: 12 })).toBe('spec.pdf (12 pages)')
    expect(attachmentLabel('pasted-text-1.txt', { lines: 2140 })).toBe('pasted-text-1.txt (2,140 lines)')
    expect(attachmentLabel('shots', { entries: 14 })).toBe('shots/ (14 files)')
    expect(attachmentLabel('one.pdf', { pages: 1 })).toBe('one.pdf')
  })
})

describe('attachment chips', () => {
  const content = attachmentPromptLine('file', 'spec.pdf', '/data/attachments/u1/spec.pdf')

  it('reads back the saved path from the prompt line', () => {
    expect(parseAttachmentLine(content)).toEqual({
      kind: 'file',
      name: 'spec.pdf',
      path: '/data/attachments/u1/spec.pdf',
    })
    expect(parseAttachmentLine(attachmentPromptLine('folder', 'shots', '/x/shots'))?.kind).toBe('folder')
  })

  it('shows the count and the saved path, and finds its line in a sent message', () => {
    const model = pillChipModel({ kind: 'file', label: 'spec.pdf (12 pages)', content })
    expect(model).toMatchObject({ name: 'spec.pdf', count: '12 pages', source: 'Attachment', target: null })
    expect(model.preview).toEqual(['Saved at /data/attachments/u1/spec.pdf'])
    expect(pillContentInMessage('file', 'spec.pdf (12 pages)', `Compare with the spec\n\n${content}`)).toBe(content)
    const folder = attachmentPromptLine('folder', 'shots', '/x/shots')
    expect(pillChipModel({ kind: 'file', label: 'shots/ (14 files)', content: folder }).source).toBe('Folder')
    expect(pillContentInMessage('file', 'shots/ (14 files)', `look\n${folder}`)).toBe(folder)
  })
})

describe('useChatDropZone', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
  })

  function mount(onDrop: (e: DragEvent) => void): { panel: HTMLElement; state: () => boolean } {
    let dragging = false
    function Inner() {
      const ref = useRef<HTMLDivElement>(null)
      dragging = useChatDropZone(ref, onDrop).dragging
      return createElement('div', { ref })
    }
    const panel = document.createElement('div')
    panel.setAttribute('data-chat-panel', 'true')
    document.body.appendChild(panel)
    root = createRoot(panel)
    act(() => root!.render(createElement(Inner)))
    return { panel, state: () => dragging }
  }

  const drag = (type: string, types = ['Files']): Event => {
    const e = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'dataTransfer', { value: { types, files: [], dropEffect: 'none' } })
    return e
  }

  it('highlights the whole view for a file drag and clears on window dragend', () => {
    const { panel, state } = mount(vi.fn())
    act(() => panel.dispatchEvent(drag('dragenter')))
    expect(state()).toBe(true)
    act(() => window.dispatchEvent(new Event('dragend')))
    expect(state()).toBe(false)
  })

  it('ignores drags that carry no files and hands a file drop to the composer', () => {
    const onDrop = vi.fn()
    const { panel, state } = mount(onDrop)
    act(() => panel.dispatchEvent(drag('dragenter', ['text/plain'])))
    expect(state()).toBe(false)
    act(() => panel.dispatchEvent(drag('dragenter')))
    const drop = drag('drop')
    act(() => panel.dispatchEvent(drop))
    expect(onDrop).toHaveBeenCalledOnce()
    expect(drop.defaultPrevented).toBe(true)
    expect(state()).toBe(false)
  })
})

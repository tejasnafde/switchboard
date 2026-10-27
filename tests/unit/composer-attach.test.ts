// @vitest-environment jsdom
/**
 * Composer attachments: which dropped or picked files are refused and why, and
 * the chat-view drop zone, whose highlight must clear on the window's dragend.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MAX_IMAGE_BYTES, sortAttachments } from '../../src/renderer/services/attachment-intake'
import { useChatDropZone } from '../../src/renderer/components/chat/useChatDropZone'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const file = (name: string, type: string, size = 10): File =>
  Object.defineProperty(new File(['x'], name, { type }), 'size', { value: size })

describe('sortAttachments', () => {
  it('keeps supported images and names each refused file with its reason', () => {
    const png = file('a.png', 'image/png')
    const { images, refused } = sortAttachments([
      png,
      file('scan.tiff', 'image/tiff'),
      file('huge.jpg', 'image/jpeg', MAX_IMAGE_BYTES + 1),
      file('notes.txt', 'text/plain'),
    ])
    expect(images).toEqual([png])
    expect(refused).toEqual([
      { name: 'scan.tiff', reason: 'TIFF images are not supported. Use PNG, JPEG, WebP, GIF or HEIC.' },
      { name: 'huge.jpg', reason: '21 MB is over the 20 MB image limit.' },
      { name: 'notes.txt', reason: 'Only images can be attached.' },
    ])
  })

  it('takes the type from the extension and keeps HEIC for conversion', () => {
    const heic = file('IMG_1.HEIC', '')
    const shot = file('shot.png', 'application/octet-stream')
    expect(sortAttachments([heic, shot]).images).toEqual([heic, shot])
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

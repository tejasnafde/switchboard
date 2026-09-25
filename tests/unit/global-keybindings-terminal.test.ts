// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { resolveGlobalKeydown, type GlobalKeyAction } from '../../src/renderer/services/global-keybindings'

// App's listener runs on window in the capture phase, ahead of xterm, so a
// Ctrl chord it claims on macOS fired the app command AND reached the shell.
describe('global shortcuts with a focused terminal on macOS', () => {
  let term: Terminal
  let textarea: HTMLTextAreaElement
  const actions: GlobalKeyAction[] = []
  const sent: string[] = []
  const listener = (e: KeyboardEvent) => {
    const a = resolveGlobalKeydown(e, 'mac')
    if (a) { actions.push(a); e.preventDefault() }
  }

  beforeAll(async () => {
    Object.defineProperty(window, 'matchMedia', {
      value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    })
    const { Terminal } = await import('@xterm/xterm')
    const el = document.createElement('div')
    document.body.appendChild(el)
    term = new Terminal()
    term.open(el)
    term.onData((d) => sent.push(d))
    textarea = el.querySelector('textarea')!
    window.addEventListener('keydown', listener, true)
  })
  afterAll(() => {
    window.removeEventListener('keydown', listener, true)
    term.dispose()
  })

  function press(key: string, mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
    actions.length = 0
    sent.length = 0
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode: key.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true, ...mods }))
  }

  it.each([
    ['k', '\x0b'], ['j', '\n'], ['b', '\x02'], ['l', '\x0c'], ['t', '\x14'],
  ])('Ctrl+%s goes to the shell only', (key, byte) => {
    press(key, { ctrlKey: true })
    expect(actions).toEqual([])
    expect(sent).toEqual([byte])
  })

  it('Ctrl+Shift+K and Ctrl+1 fire nothing', () => {
    press('K', { ctrlKey: true, shiftKey: true })
    expect(actions).toEqual([])
    press('1', { ctrlKey: true })
    expect(actions).toEqual([])
  })

  it('⌘K still opens the quick prompt', () => {
    press('k', { metaKey: true })
    expect(actions).toEqual([{ type: 'quick-prompt' }])
  })
})

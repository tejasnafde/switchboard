import { describe, expect, it } from 'vitest'
import { resolvePickerKeydown, type PickerKeyState } from '../../src/renderer/components/chat/pickerKeydown'

const closed: PickerKeyState = { sendToMatches: null, atMatches: null, slashMatches: null }
const k = (key: string, altKey = false) => ({ key, altKey })

describe('resolvePickerKeydown', () => {
  it('does nothing with every picker closed', () => {
    for (const key of ['ArrowDown', 'Enter', 'Tab', 'Escape', 'a']) {
      expect(resolvePickerKeydown(k(key), closed)).toBeNull()
    }
  })

  it('drives the send-to picker first', () => {
    const s = { sendToMatches: 2, atMatches: 3, slashMatches: 3 }
    expect(resolvePickerKeydown(k('ArrowDown'), s)).toEqual({ menu: 'send-to', op: 'move', delta: 1 })
    expect(resolvePickerKeydown(k('ArrowUp'), s)).toEqual({ menu: 'send-to', op: 'move', delta: -1 })
    expect(resolvePickerKeydown(k('Enter'), s)).toEqual({ menu: 'send-to', op: 'pick' })
    expect(resolvePickerKeydown(k('Tab'), s)).toEqual({ menu: 'send-to', op: 'pick' })
    expect(resolvePickerKeydown(k('Escape'), s)).toEqual({ menu: 'send-to', op: 'dismiss' })
  })

  it('lets an empty send-to picker and unclaimed keys fall through to the next picker', () => {
    expect(resolvePickerKeydown(k('ArrowDown'), { ...closed, sendToMatches: 0, slashMatches: 1 })).toEqual({ menu: 'slash', op: 'next' })
    expect(resolvePickerKeydown(k('Enter', true), { ...closed, sendToMatches: 2, atMatches: 1 })).toBeNull()
  })

  it('drives @-mentions ahead of the slash menu', () => {
    const s = { ...closed, atMatches: 2, slashMatches: 2 }
    expect(resolvePickerKeydown(k('ArrowDown'), s)).toEqual({ menu: 'at', op: 'next' })
    expect(resolvePickerKeydown(k('ArrowUp'), s)).toEqual({ menu: 'at', op: 'prev' })
    expect(resolvePickerKeydown(k('Escape'), s)).toEqual({ menu: 'at', op: 'dismiss' })
    expect(resolvePickerKeydown(k('Enter'), s)).toEqual({ menu: 'at', op: 'pick', stopPropagation: true })
    expect(resolvePickerKeydown(k('Enter', true), s)).toBeNull()
    expect(resolvePickerKeydown(k('x'), s)).toBeNull()
  })

  it('an open @-mention picker with no matches only claims Escape, and blocks the slash menu', () => {
    const s = { ...closed, atMatches: 0, slashMatches: 2 }
    expect(resolvePickerKeydown(k('Enter'), s)).toBeNull()
    expect(resolvePickerKeydown(k('ArrowDown'), s)).toBeNull()
    expect(resolvePickerKeydown(k('Escape'), s)).toEqual({ menu: 'at', op: 'dismiss' })
  })

  it('drives the slash menu', () => {
    const s = { ...closed, slashMatches: 2 }
    expect(resolvePickerKeydown(k('ArrowDown'), s)).toEqual({ menu: 'slash', op: 'next' })
    expect(resolvePickerKeydown(k('ArrowUp'), s)).toEqual({ menu: 'slash', op: 'prev' })
    expect(resolvePickerKeydown(k('Tab'), s)).toEqual({ menu: 'slash', op: 'pick', stopPropagation: true })
    expect(resolvePickerKeydown(k('Escape'), s)).toEqual({ menu: 'slash', op: 'dismiss' })
    expect(resolvePickerKeydown(k('x'), s)).toBeNull()
  })

  it('an empty slash menu only claims Escape', () => {
    const s = { ...closed, slashMatches: 0 }
    expect(resolvePickerKeydown(k('Enter'), s)).toBeNull()
    expect(resolvePickerKeydown(k('Escape'), s)).toEqual({ menu: 'slash', op: 'dismiss' })
  })
})

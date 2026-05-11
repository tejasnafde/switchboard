/**
 * Pure ring-buffer for the editor's back / forward navigation. Tested
 * behaviors:
 *   - push appends; back / forward move the cursor
 *   - canBack / canForward gate the keybindings
 *   - pushing after `back` truncates the forward branch (VS Code-style)
 *   - cap of 50 entries; overflow drops oldest
 *   - same-path small-line-delta pushes coalesce (cursor jiggle)
 */
import { describe, expect, it } from 'vitest'
import {
  createHistoryStack,
  push,
  back,
  forward,
  current,
  canBack,
  canForward,
  type NavEntry,
} from '../../src/renderer/components/files/editor/navigation/historyStack'

const e = (path: string, line: number): NavEntry => ({ path, line, ch: 0 })

describe('historyStack', () => {
  it('starts empty with no current entry', () => {
    const s = createHistoryStack()
    expect(current(s)).toBeNull()
    expect(canBack(s)).toBe(false)
    expect(canForward(s)).toBe(false)
  })

  it('push appends and current points to the latest entry', () => {
    const s = push(push(createHistoryStack(), e('a', 1)), e('b', 2))
    expect(current(s)).toEqual(e('b', 2))
  })

  it('back walks toward older entries; canBack gates at the bottom', () => {
    let s = createHistoryStack()
    s = push(s, e('a', 1))
    s = push(s, e('b', 2))
    expect(canBack(s)).toBe(true)
    s = back(s)
    expect(current(s)).toEqual(e('a', 1))
    expect(canBack(s)).toBe(false)
  })

  it('forward walks back toward newer entries after a back', () => {
    let s = createHistoryStack()
    s = push(s, e('a', 1))
    s = push(s, e('b', 2))
    s = back(s)
    expect(canForward(s)).toBe(true)
    s = forward(s)
    expect(current(s)).toEqual(e('b', 2))
    expect(canForward(s)).toBe(false)
  })

  it('pushing after a back drops the forward stack', () => {
    let s = createHistoryStack()
    s = push(s, e('a', 1))
    s = push(s, e('b', 2))
    s = push(s, e('c', 3))
    s = back(s) // current = b, forward stack = [c]
    s = push(s, e('d', 4))
    expect(current(s)).toEqual(e('d', 4))
    expect(canForward(s)).toBe(false)
  })

  it('caps stack at the configured size; overflow drops oldest', () => {
    let s = createHistoryStack(50)
    for (let i = 0; i < 80; i++) s = push(s, e(`p${i}`, 1))
    let count = 0
    while (canBack(s)) {
      s = back(s)
      count++
    }
    expect(count).toBe(49)
    expect(current(s)).toEqual(e('p30', 1))
  })

  it('coalesces consecutive pushes of the same path within ~10 lines (cursor jiggle)', () => {
    let s = createHistoryStack()
    s = push(s, e('a', 10))
    s = push(s, e('a', 12))
    expect(canBack(s)).toBe(false)
    s = push(s, e('a', 80))
    expect(canBack(s)).toBe(true)
  })

  it('pushes a new entry when the path changes regardless of line proximity', () => {
    let s = createHistoryStack()
    s = push(s, e('a', 10))
    s = push(s, e('b', 10))
    expect(canBack(s)).toBe(true)
  })
})

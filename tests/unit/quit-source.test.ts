import { afterEach, describe, expect, it } from 'vitest'
import { noteQuitSource, quitSource, resetQuitSourceForTests } from '../../src/main/quit-source'

describe('quit source', () => {
  afterEach(() => resetQuitSourceForTests())

  it('reports system when nothing in the app asked to quit', () => {
    expect(quitSource().kind).toBe('system')
  })

  it('keeps the first reason, so a later quit call does not hide who started it', () => {
    noteQuitSource('signal', 'SIGTERM')
    noteQuitSource('menu')
    expect(quitSource()).toEqual({ kind: 'signal', detail: 'SIGTERM' })
  })

  it('omits an empty detail', () => {
    noteQuitSource('menu')
    expect(quitSource()).toEqual({ kind: 'menu' })
  })
})

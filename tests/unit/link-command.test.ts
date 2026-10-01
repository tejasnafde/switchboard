import { describe, it, expect } from 'vitest'
import { parseLinkCommand } from '../../src/renderer/components/chat/link-command'

describe('parseLinkCommand', () => {
  it('reads a /link target', () => {
    expect(parseLinkCommand('/link Worker A')).toEqual({ ok: true, kind: 'link', target: 'Worker A' })
  })

  it('needs a target for /link', () => {
    expect(parseLinkCommand('/link  ')).toMatchObject({ ok: false })
  })

  it('reads /unlink with and without a target', () => {
    expect(parseLinkCommand('/unlink Worker A')).toEqual({ ok: true, kind: 'unlink', target: 'Worker A' })
    expect(parseLinkCommand('/unlink')).toEqual({ ok: true, kind: 'unlink', target: null })
  })

  it('is not a link command otherwise', () => {
    expect(parseLinkCommand('/linked list')).toBeNull()
    expect(parseLinkCommand('please /link this')).toBeNull()
    expect(parseLinkCommand('/send-to a: b')).toBeNull()
  })
})

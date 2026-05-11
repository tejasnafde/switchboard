/**
 * LSP wire format is JSON-RPC over stdio with `Content-Length: N\r\n\r\n`
 * framing. The parser is a streaming state machine: feed it chunks of
 * stdout, get back complete frames. Tested behaviors:
 *   - parse one full frame
 *   - split frame across multiple chunks → reassembles
 *   - multiple frames in a single chunk → all yielded
 *   - tolerates other LSP headers (Content-Type, custom)
 *   - handles UTF-8 multibyte content correctly
 */
import { describe, expect, it } from 'vitest'
import { LspFramer } from '../../src/main/lsp/framing'

function frame(json: object): Buffer {
  const body = JSON.stringify(json)
  const bytes = Buffer.byteLength(body, 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes}\r\n\r\n`), Buffer.from(body, 'utf8')])
}

describe('LspFramer', () => {
  it('parses a single frame fed in one chunk', () => {
    const f = new LspFramer()
    const out = f.feed(frame({ id: 1, result: 'ok' }))
    expect(out).toEqual([{ id: 1, result: 'ok' }])
  })

  it('reassembles a frame split across chunks', () => {
    const f = new LspFramer()
    const buf = frame({ id: 2, result: 'split' })
    const a = buf.subarray(0, 10)
    const b = buf.subarray(10)
    expect(f.feed(a)).toEqual([])
    expect(f.feed(b)).toEqual([{ id: 2, result: 'split' }])
  })

  it('yields multiple frames packed into one chunk', () => {
    const f = new LspFramer()
    const merged = Buffer.concat([
      frame({ id: 1, result: 'a' }),
      frame({ id: 2, result: 'b' }),
    ])
    expect(f.feed(merged)).toEqual([
      { id: 1, result: 'a' },
      { id: 2, result: 'b' },
    ])
  })

  it('handles extra LSP headers like Content-Type', () => {
    const f = new LspFramer()
    const body = JSON.stringify({ id: 3, result: 'ct' })
    const bytes = Buffer.byteLength(body, 'utf8')
    const buf = Buffer.from(
      `Content-Length: ${bytes}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n${body}`,
      'utf8',
    )
    expect(f.feed(buf)).toEqual([{ id: 3, result: 'ct' }])
  })

  it('preserves UTF-8 multibyte characters across chunk boundaries', () => {
    const f = new LspFramer()
    const buf = frame({ id: 4, result: 'πëé' })
    const half = Math.floor(buf.length / 2)
    expect(f.feed(buf.subarray(0, half))).toEqual([])
    expect(f.feed(buf.subarray(half))).toEqual([{ id: 4, result: 'πëé' }])
  })
})

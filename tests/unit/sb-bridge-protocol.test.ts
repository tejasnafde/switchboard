/**
 * resources/sb-bridge/protocol.js is the pure half of the bridge extension:
 * message build/parse/validate + the reconnect backoff schedule. CommonJS on
 * purpose - the VS Code extension host requires() it.
 */
import { describe, it, expect } from 'vitest'
import { buildHello, buildSelection, parseMessage, backoffDelayMs } from '../../resources/sb-bridge/protocol'

describe('message builders', () => {
  it('buildHello carries the workspace folder', () => {
    expect(buildHello('/Users/x/proj')).toEqual({ type: 'hello', folder: '/Users/x/proj' })
  })

  it('buildSelection carries path, 1-based line range, and text', () => {
    expect(buildSelection('src/a.ts', 3, 7, 'const x = 1')).toEqual({
      type: 'selection',
      path: 'src/a.ts',
      startLine: 3,
      endLine: 7,
      text: 'const x = 1',
    })
  })
})

describe('parseMessage', () => {
  it('round-trips a built message through JSON', () => {
    const msg = parseMessage(JSON.stringify(buildHello('/p')))
    expect(msg).toEqual({ type: 'hello', folder: '/p' })
  })

  it('accepts an open message with optional line range', () => {
    expect(parseMessage('{"type":"open","path":"/p/a.ts"}')).toEqual({ type: 'open', path: '/p/a.ts' })
    expect(parseMessage('{"type":"open","path":"/p/a.ts","line":10,"endLine":20}')).toEqual({
      type: 'open',
      path: '/p/a.ts',
      line: 10,
      endLine: 20,
    })
  })

  it('returns null for malformed JSON', () => {
    expect(parseMessage('{nope')).toBeNull()
    expect(parseMessage('')).toBeNull()
  })

  it('returns null for unknown types and missing required fields', () => {
    expect(parseMessage('{"type":"evil"}')).toBeNull()
    expect(parseMessage('{"type":"hello"}')).toBeNull() // no folder
    expect(parseMessage('{"type":"open"}')).toBeNull() // no path
    expect(parseMessage('{"type":"selection","path":"a"}')).toBeNull() // no lines/text
    expect(parseMessage('{"type":"open","path":123}')).toBeNull() // wrong type
  })

  it('returns null for non-object payloads', () => {
    expect(parseMessage('"hello"')).toBeNull()
    expect(parseMessage('[1,2]')).toBeNull()
    expect(parseMessage('null')).toBeNull()
  })
})

describe('selection intent (cmd+k quick edit)', () => {
  it('round-trips buildSelection with an edit intent', () => {
    const msg = parseMessage(JSON.stringify(buildSelection('a.ts', 1, 2, 'x', 'edit')))
    expect(msg).toEqual({ type: 'selection', path: 'a.ts', startLine: 1, endLine: 2, text: 'x', intent: 'edit' })
  })

  it('omits intent when not given and rejects unknown intents', () => {
    expect(buildSelection('a.ts', 1, 2, 'x')).not.toHaveProperty('intent')
    expect(parseMessage('{"type":"selection","path":"a","startLine":1,"endLine":1,"text":"x","intent":"evil"}')).toBeNull()
  })
})

describe('terminal request (workbench terminal -> Switchboard terminal pane)', () => {
  it('accepts the bare terminal frame', () => {
    expect(parseMessage('{"type":"terminal"}')).toEqual({ type: 'terminal' })
  })
})

describe('focusExplorer (main -> ext reveal file explorer)', () => {
  it('accepts the bare focusExplorer frame', () => {
    expect(parseMessage('{"type":"focusExplorer"}')).toEqual({ type: 'focusExplorer' })
  })
})

describe('config messages (main -> ext live settings)', () => {
  it('accepts a config message with a settings object', () => {
    expect(parseMessage('{"type":"config","settings":{"workbench.colorTheme":"Default Light Modern"}}')).toEqual({
      type: 'config',
      settings: { 'workbench.colorTheme': 'Default Light Modern' },
    })
  })

  it('rejects config without a settings object', () => {
    expect(parseMessage('{"type":"config"}')).toBeNull()
    expect(parseMessage('{"type":"config","settings":"nope"}')).toBeNull()
  })
})

describe('backoffDelayMs', () => {
  it('starts small, grows, and caps', () => {
    expect(backoffDelayMs(0)).toBeGreaterThanOrEqual(250)
    expect(backoffDelayMs(0)).toBeLessThanOrEqual(1000)
    expect(backoffDelayMs(1)).toBeGreaterThan(backoffDelayMs(0))
    const cap = backoffDelayMs(50)
    expect(cap).toBeLessThanOrEqual(15000)
    expect(backoffDelayMs(51)).toBe(cap)
  })
})

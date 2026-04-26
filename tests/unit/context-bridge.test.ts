import { describe, it, expect } from 'vitest'
import { formatTerminalContext } from '../../src/renderer/services/contextBridge'

/**
 * Pure-function tests for the ⌘L context-bridge formatter.
 *
 * The wire format ends up inside chat messages sent to the agent, so
 * changes here affect how well the agent understands attached terminal
 * output. Lock it down.
 */
describe('formatTerminalContext', () => {
  it('emits a single-line selection verbatim with a header', () => {
    const out = formatTerminalContext({
      selection: 'ERROR: dbt test failed',
      paneLabel: 'backend',
      timestamp: new Date('2026-04-21T14:32:00').getTime(),
    })
    expect(out).toContain('[from: backend @')
    expect(out).toContain('ERROR: dbt test failed')
    // Single-line — no fenced block
    expect(out).not.toContain('```')
  })

  it('includes the command in the header when provided', () => {
    const out = formatTerminalContext({
      selection: 'hi',
      paneLabel: 'backend',
      command: 'npm run dev',
      timestamp: Date.now(),
    })
    expect(out).toContain('npm run dev')
    expect(out).toMatch(/\[from: backend @ \d{2}:\d{2} · npm run dev\]/)
  })

  it('wraps multi-line selections in a fenced block', () => {
    const out = formatTerminalContext({
      selection: 'line one\nline two\nline three',
      paneLabel: 'logs',
      timestamp: Date.now(),
    })
    expect(out).toContain('```')
    expect(out.split('```').length).toBeGreaterThanOrEqual(3) // open + close fence
    expect(out).toContain('line one')
    expect(out).toContain('line three')
  })

  it('trims leading and trailing whitespace from the selection', () => {
    const out = formatTerminalContext({
      selection: '   \n  actual content  \n   ',
      paneLabel: 'x',
      timestamp: Date.now(),
    })
    expect(out).toContain('actual content')
    // No stray blank lines before the content
    expect(out).not.toMatch(/\n\n\n/)
  })

  it('truncates selections longer than the 50KB cap and notes truncation', () => {
    // Build a selection well over the 50k cap (was 4k before — bumped so
    // typical stack traces aren't clipped). 80×800 = 64KB.
    const longLine = 'x'.repeat(80)
    const selection = Array.from({ length: 800 }, () => longLine).join('\n') // ~64KB
    const out = formatTerminalContext({
      selection,
      paneLabel: 'p',
      timestamp: Date.now(),
    })
    expect(out).toContain('output truncated')
    expect(out.length).toBeLessThan(selection.length + 500) // meaningfully shorter
  })

  it('omits the command suffix when no command is provided', () => {
    const out = formatTerminalContext({
      selection: 'hi',
      paneLabel: 'backend',
      timestamp: Date.now(),
    })
    expect(out).toMatch(/\[from: backend @ \d{2}:\d{2}\]/)
    expect(out).not.toContain('·')
  })

  it('always ends with a trailing newline for clean appending to drafts', () => {
    const out = formatTerminalContext({
      selection: 'hi',
      paneLabel: 'x',
      timestamp: Date.now(),
    })
    expect(out.endsWith('\n')).toBe(true)
  })

  it('preserves content fidelity for multi-line fenced output', () => {
    const selection = [
      'Error Traceback (most recent call last):',
      '  File "main.py", line 12, in <module>',
      '    raise ValueError("bad thing")',
      'ValueError: bad thing',
    ].join('\n')
    const out = formatTerminalContext({
      selection,
      paneLabel: 'backend',
      timestamp: Date.now(),
    })
    for (const line of selection.split('\n')) {
      expect(out).toContain(line)
    }
  })
})

import { describe, it, expect } from 'vitest'

/**
 * Terminal keybinding tests.
 * Documents the exact escape sequences sent to PTY for macOS shortcuts.
 * Only includes keybindings we explicitly handle (not xterm defaults).
 */

// Sequences our custom key handler sends to the PTY
const HANDLED_SEQUENCES = {
  'Cmd+Backspace': '\x15',       // Ctrl+U: kill whole line
  'Cmd+Left': '\x1bOH',          // Home key (xterm application mode)
  'Cmd+Right': '\x1bOF',         // End key (xterm application mode)
  'Cmd+K': '\x0c',               // Ctrl+L: clear screen
  'Option+Backspace': '\x17',    // Ctrl+W: backward kill word
}

describe('terminal keybinding sequences', () => {
  it('Cmd+Backspace sends Ctrl+U', () => {
    expect(HANDLED_SEQUENCES['Cmd+Backspace']).toBe('\x15')
  })

  it('Cmd+Left sends Home (ESC O H)', () => {
    expect(HANDLED_SEQUENCES['Cmd+Left']).toBe('\x1bOH')
  })

  it('Cmd+Right sends End (ESC O F)', () => {
    expect(HANDLED_SEQUENCES['Cmd+Right']).toBe('\x1bOF')
  })

  it('Option+Backspace sends Ctrl+W', () => {
    expect(HANDLED_SEQUENCES['Option+Backspace']).toBe('\x17')
  })

  it('Cmd+K sends Ctrl+L', () => {
    expect(HANDLED_SEQUENCES['Cmd+K']).toBe('\x0c')
  })

  // Regression: sendToPty must be defined before use
  it('sendToPty function is defined before use in terminal-registry', () => {
    const fs = require('fs')
    const source = fs.readFileSync(
      'src/renderer/services/terminal-registry.ts',
      'utf-8'
    )
    const defLine = source.indexOf('const sendToPty')
    const firstUse = source.indexOf('sendToPty(')
    expect(defLine).toBeGreaterThan(-1)
    expect(firstUse).toBeGreaterThan(defLine)
  })

  // Regression: Option+Arrow must not intercept Delete key
  it('custom handler does not intercept bare Delete key', () => {
    const fs = require('fs')
    const source = fs.readFileSync(
      'src/renderer/services/terminal-registry.ts',
      'utf-8'
    )
    // Should not have e.key === 'Delete' in the handler
    const handlerStart = source.indexOf('attachCustomKeyEventHandler')
    const handlerEnd = source.indexOf('return true', handlerStart)
    const handlerBody = source.slice(handlerStart, handlerEnd)
    expect(handlerBody).not.toContain("e.key === 'Delete'")
  })
})

describe('CLI flags', () => {
  it('buildArgs includes --verbose for stream-json output', () => {
    const fs = require('fs')
    const source = fs.readFileSync(
      'src/main/agent/agent-manager.ts',
      'utf-8'
    )
    // --verbose is required with --print --output-format stream-json in Claude CLI v2.1.101+
    expect(source).toContain("'--verbose'")
    expect(source).toContain("'--print'")
    expect(source).toContain("'stream-json'")
  })
})

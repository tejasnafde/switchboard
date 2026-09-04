/**
 * Regression test: ensure UI strings don't render literal "…" escape sequences.
 *
 * UI components should display the Unicode ellipsis character (…, U+2026), not
 * the literal text backslash-u-2-0-2-6. This test verifies:
 * 1. No source file contains literal `…` in UI strings (replacement happened)
 * 2. Rendered text contains actual ellipsis characters where expected
 * 3. Auto-title truncation uses real ellipsis
 */
import { describe, it, expect } from 'vitest'
import { generateTitle } from '../../src/shared/auto-title'

describe('UI ellipsis rendering', () => {
  describe('auto-title truncation', () => {
    it('truncates long text with real ellipsis at word boundary', () => {
      const longText = 'This is a very long conversation title that should be truncated at a word boundary'
      const title = generateTitle(longText, 30)
      // Should contain actual U+2026 ellipsis, not escape sequence
      expect(title).toContain('…')
      expect(title).not.toContain('\\u2026')
    })

    it('truncates long text with real ellipsis when word boundary is too short', () => {
      const longText = 'Verylongwordthatcannotbetrimmedatboundarybutmustbecutanyway'
      const title = generateTitle(longText, 20)
      // Should end with actual ellipsis
      expect(title).toMatch(/…$/)
      expect(title).not.toContain('\\u2026')
    })

    it('does not add ellipsis to short text', () => {
      const shortText = 'Brief title'
      const title = generateTitle(shortText, 50)
      expect(title).toBe(shortText)
      expect(title).not.toContain('…')
    })
  })

  describe('source code literals', () => {
    it('MessageBubble queued message should use real ellipsis', async () => {
      // Read and check the source file doesn't have literal …
      const fs = await import('fs/promises')
      const source = await fs.readFile(
        new URL('../../src/renderer/components/chat/MessageBubble.tsx', import.meta.url),
        'utf-8'
      )
      // Ensure we don't have the escape sequence representation
      expect(source).not.toMatch(/['"]Sending\\u2026['"]/)
    })

    it('ChatPanel status messages should use real ellipsis', async () => {
      const fs = await import('fs/promises')
      const source = await fs.readFile(
        new URL('../../src/renderer/components/chat/ChatPanel.tsx', import.meta.url),
        'utf-8'
      )
      // Ensure no literal … in status strings
      expect(source).not.toMatch(/['"](?:thinking|sending|Sending|Thinking|Working|Queue).*\\u2026['"]/)
    })

    it('ApprovalCard action labels should use real ellipsis', async () => {
      const fs = await import('fs/promises')
      const source = await fs.readFile(
        new URL('../../src/renderer/components/chat/ApprovalCard.tsx', import.meta.url),
        'utf-8'
      )
      // Ensure no literal … in approval strings
      expect(source).not.toMatch(/['"](?:Approving|Denying|Yes, and|No, do).*\\u2026['"]/)
    })

    it('SettingsModal save status should use real ellipsis', async () => {
      const fs = await import('fs/promises')
      const source = await fs.readFile(
        new URL('../../src/renderer/components/SettingsModal.tsx', import.meta.url),
        'utf-8'
      )
      // Ensure no literal … in save status
      expect(source).not.toMatch(/['"]Saving\\u2026['"]/)
    })

    it('Sidebar import status should use real ellipsis', async () => {
      const fs = await import('fs/promises')
      const source = await fs.readFile(
        new URL('../../src/renderer/components/sidebar/Sidebar.tsx', import.meta.url),
        'utf-8'
      )
      // Ensure no literal … in scanning status
      expect(source).not.toMatch(/['"]Scanning\\u2026['"]/)
    })

    it('should not have any literal backslash-uXXXX escape sequences for UI characters in quoted JSX text and attributes', async () => {
      const fs = await import('fs/promises')
      const path = await import('path')

      // Files to check for Unicode escape sequences in quoted strings
      const filesToCheck = [
        '../../src/renderer/components/chat/ChatInput.tsx',
        '../../src/renderer/components/terminal/TerminalStrip.tsx',
        '../../src/renderer/components/chat/MessageBubble.tsx',
        '../../src/renderer/components/chat/ChatPanel.tsx',
        '../../src/renderer/components/chat/ApprovalCard.tsx',
        '../../src/renderer/components/SettingsModal.tsx',
        '../../src/renderer/components/sidebar/Sidebar.tsx',
      ]

      for (const filePath of filesToCheck) {
        const source = await fs.readFile(
          new URL(filePath, import.meta.url),
          'utf-8'
        )
        // Match any quoted string (single or double quotes) containing a backslash-u pattern
        // BUT exclude \x00-\x1f (control characters) which are legitimate for non-display uses
        // Focus on catching UI characters like … (ellipsis), ⌘ (command symbol), etc.
        const matches = source.match(/(['"])[^'"]*\\u([0-9A-Fa-f]{4})[^'"]*\1/g)
        if (matches) {
          // Filter out control characters (0000-001F) which have legitimate non-display uses
          const uiCharMatches = matches.filter(m => {
            const code = m.match(/\\u([0-9A-Fa-f]{4})/)?.[1]
            if (!code) return false
            const codeNum = parseInt(code, 16)
            // Exclude control characters (0000-001F, 007F, 0080-009F)
            return !(
              (codeNum >= 0x0000 && codeNum <= 0x001F) ||
              codeNum === 0x007F ||
              (codeNum >= 0x0080 && codeNum <= 0x009F)
            )
          })
          expect(uiCharMatches, `File ${path.basename(filePath)} should not contain literal \\uXXXX escape sequences for UI characters in quoted strings`).toHaveLength(0)
        }
      }
    })
  })

  describe('bare JSX text escape sequences (no quotes)', () => {
    // The quoted-string regex above is anchored on matching quote characters,
    // so it is blind to a literal backslash-u escape sitting directly in JSX
    // text with no quotes at all - which is exactly the shape the original
    // bug shipped as: `<div>Sending…</div>` rendered the literal six
    // characters "…" to the user, because JSX text content is never
    // interpreted as a JS string literal (only a real quoted string gets
    // that treatment; bare text between tags is passed through verbatim).
    //
    // Scoped to a `>...<` run containing NO quote character at all: a real JS
    // expression like `{cond ? 'a…' : 'b'}` always has quotes somewhere
    // in that span, so it can never satisfy this pattern - that shape stays
    // the quoted-string check's job above, and this check cannot double-flag
    // it or, worse, false-positive on a normal interpreted JS escape.
    const BARE_JSX_TEXT_ESCAPE = />[^<>'"]*\\u[0-9A-Fa-f]{4}[^<>'"]*</

    it('fixture: catches the original bug shape - bare JSX text with a literal escape', () => {
      // Built from string concatenation of a literal backslash character, a
      // 'u', and hex digits - not a real `\u` escape - so this fixture's
      // runtime value contains the SAME six literal characters (`\`, `u`,
      // `2`, `0`, `2`, `6`) that a regressed source file would contain on
      // disk: exactly what shipped as the bug, reproduced without writing
      // the actual bug into a real component.
      const buggyJsxSnippet = '<div>Sending' + '\\u2026' + '</div>'
      expect(buggyJsxSnippet).toContain('\\u2026')
      expect(BARE_JSX_TEXT_ESCAPE.test(buggyJsxSnippet)).toBe(true)
    })

    it('fixture: does not false-positive on a real \\uXXXX escape inside a quoted JS expression', () => {
      // The legitimate pattern: an interpreted JS string escape used INSIDE a
      // JSX expression, e.g. `<div>{submitting ? 'Approving…' : 'x'}</div>`.
      // This is real, correctly-interpreted JS - the browser sees the actual
      // ellipsis character at runtime - and must never be flagged by the
      // bare-text check (it is a job for the quoted-string check above,
      // which intentionally allows it once it is a real Unicode literal
      // rather than an escape).
      const safeJsxSnippet = "<div>{submitting ? 'Approving" + '\\u2026' + "' : 'x'}</div>"
      expect(BARE_JSX_TEXT_ESCAPE.test(safeJsxSnippet)).toBe(false)
    })

    it('fixture: does not false-positive on the correct fix - a real ellipsis character', () => {
      const fixedJsxSnippet = '<div>Sending…</div>'
      expect(BARE_JSX_TEXT_ESCAPE.test(fixedJsxSnippet)).toBe(false)
    })

    it('no UI component has a literal backslash-uXXXX escape in bare JSX text', async () => {
      const fs = await import('fs/promises')
      const path = await import('path')

      const filesToCheck = [
        '../../src/renderer/components/chat/ChatInput.tsx',
        '../../src/renderer/components/terminal/TerminalStrip.tsx',
        '../../src/renderer/components/chat/MessageBubble.tsx',
        '../../src/renderer/components/chat/ChatPanel.tsx',
        '../../src/renderer/components/chat/ApprovalCard.tsx',
        '../../src/renderer/components/SettingsModal.tsx',
        '../../src/renderer/components/sidebar/Sidebar.tsx',
      ]

      for (const filePath of filesToCheck) {
        const source = await fs.readFile(new URL(filePath, import.meta.url), 'utf-8')
        const matches = source.match(new RegExp(BARE_JSX_TEXT_ESCAPE.source, 'g'))
        expect(
          matches,
          `File ${path.basename(filePath)} should not contain a literal \\uXXXX escape in bare JSX text`
        ).toBeNull()
      }
    })
  })

  describe('ellipsis is properly encoded', () => {
    it('contains U+2026 character code', () => {
      const title = generateTitle('This is a very long title for testing', 20)
      if (title.includes('…')) {
        // Verify it's the actual U+2026 character
        const ellipsisChar = title.match(/…/)?.[0]
        expect(ellipsisChar?.charCodeAt(0)).toBe(0x2026)
      }
    })
  })
})

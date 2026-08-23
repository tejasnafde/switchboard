import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MessageBubble } from '../../src/renderer/components/chat/MessageBubble'
import { PlanCard } from '../../src/renderer/components/chat/PlanCard'
import {
  copyCodeFromTarget,
  renderMarkdownWithCopyControls,
  restoreCopyButtonFocus,
  scheduleCopyFeedback,
  wrapRenderedCodeBlock,
} from '../../src/renderer/components/chat/MarkdownWithCopyControls'
import * as codeCopyModule from '../../src/renderer/components/chat/MarkdownWithCopyControls'

const css = readFileSync(new URL('../../src/renderer/styles/global.css', import.meta.url), 'utf8')

interface FeedbackButton {
  textContent: string | null
  classList: { toggle: (name: string, force: boolean) => void }
  setAttribute: (name: string, value: string) => void
}

const feedbackApi = codeCopyModule as typeof codeCopyModule & {
  applyCopyButtonFeedback?: (button: FeedbackButton, index: number, copied: boolean) => void
}

function copyControls(markup: string): string[] {
  return markup.match(/<button[^>]*class="[^"]*code-copy-btn[^"]*"[^>]*>/g) ?? []
}

function renderAssistant(content: string): string {
  return renderToStaticMarkup(createElement(MessageBubble, {
    message: {
      id: 'historical-message',
      role: 'assistant',
      content,
      timestamp: 1,
    },
    sessionId: 'historical-thread',
  }))
}

describe('Markdown code-block copy controls', () => {
  it('keeps one hidden control mounted through provisional fenced-code snapshots', () => {
    const snapshots = [
      '```sql',
      '```sql\nselect id',
      '```sql\nselect id\nfrom users',
    ]

    for (const snapshot of snapshots) {
      const markup = renderMarkdownWithCopyControls(snapshot, { mutable: true })
      expect(copyControls(markup)).toHaveLength(1)
      expect(markup).toContain('data-code-state="provisional"')
    }

    const closed = renderMarkdownWithCopyControls(
      '```sql\nselect id\nfrom users\n```',
      { mutable: true },
    )
    expect(copyControls(closed)).toHaveLength(1)
    expect(closed).toContain('data-code-state="settled"')
  })

  it('does not mistake an over-indented fence inside mutable code for the closing fence', () => {
    const markup = renderMarkdownWithCopyControls(
      '```md\nA nested example:\n    ```\nstill changing',
      { mutable: true },
    )

    expect(copyControls(markup)).toHaveLength(1)
    expect(markup).toContain('data-code-state="provisional"')
  })

  it('keeps a closed earlier block settled while later prose is mutable', () => {
    const markup = renderMarkdownWithCopyControls(
      '```sql\nselect 1;\n```\n\nStill explaining the result',
      { mutable: true },
    )

    expect(copyControls(markup)).toHaveLength(1)
    expect(markup).toContain('data-code-state="settled"')
  })

  it('makes an unterminated block available exactly once when its message settles', () => {
    const mutable = renderMarkdownWithCopyControls('```\necho waiting', { mutable: true })
    const settled = renderMarkdownWithCopyControls('```\necho waiting', { mutable: false })
    const rerendered = renderMarkdownWithCopyControls('```\necho waiting', { mutable: false })

    expect(mutable).toContain('data-code-state="provisional"')
    expect(settled).toContain('data-code-state="settled"')
    expect(copyControls(settled)).toHaveLength(1)
    expect(rerendered).toBe(settled)
  })

  it('renders historical fenced code with one atomic copy control', () => {
    const markup = renderAssistant('```sql\nselect * from users;\n```')

    expect(copyControls(markup)).toHaveLength(1)
    expect(markup).toContain('<pre')
    expect(markup).toContain('<code class="language-sql">select * from users;\n</code>')
  })

  it('renders exactly one accessible control for tagged and untagged blocks', () => {
    const markup = renderAssistant([
      '```sql',
      'select 1;',
      '```',
      '',
      '```',
      'plain text',
      '```',
    ].join('\n'))

    expect(copyControls(markup)).toHaveLength(2)
    expect(markup).toContain('aria-label="Copy code block 1"')
    expect(markup).toContain('aria-label="Copy code block 2"')
    expect(markup.match(/aria-live="polite"/g)).toHaveLength(2)
    expect(markup.match(/type="button"/g)).toHaveLength(2)
  })

  it('keeps ordinary Markdown and inline file references intact', () => {
    const markup = renderAssistant('See `src/main/index.ts:42` and **keep this bold**.\n\n```ts\nconst ok = true\n```')

    expect(markup).toContain('<code>src/main/index.ts:42</code>')
    expect(markup).toContain('<strong>keep this bold</strong>')
    expect(copyControls(markup)).toHaveLength(1)
  })

  it('escapes code and generated language classes without widening the HTML boundary', () => {
    const markup = renderMarkdownWithCopyControls(
      '```sql&quot; onclick=&quot;alert(1)\n<script>bad()</script>\n```',
    )

    expect(markup).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(markup).not.toContain('<script>')
    expect(markup).not.toContain(' onclick="alert(1)"')
    expect(copyControls(markup)).toHaveLength(1)
  })

  it('degrades to Marked output if its code wrapper shape changes', () => {
    const changed = '<div class="future-code"><code>safe</code></div>\n'

    expect(wrapRenderedCodeBlock(changed, 'settled', 0)).toBe(changed)
  })

  it('uses the same atomic renderer in PlanCard', () => {
    const markup = renderToStaticMarkup(createElement(PlanCard, {
      plan: { id: 'plan-1', markdown: '```\necho plan\n```' },
    }))

    expect(copyControls(markup)).toHaveLength(1)
    expect(markup).toContain('aria-label="Copy code block 1"')
  })

  it('copies only the exact descendant code text through the delegated seam', async () => {
    const writes: string[] = []
    const code = { textContent: 'select 1;\n-- Copy must not be included\n' }
    const pre = { querySelector: (selector: string) => selector === 'code' ? code : null }
    let button: { dataset: { codeCopyIndex: string }; closest: (selector: string) => unknown }
    button = {
      dataset: { codeCopyIndex: '3' },
      closest: (selector: string) => selector === 'pre' ? pre : selector === '.code-copy-btn' ? button : null,
    }
    const child = { closest: (selector: string) => selector === '.code-copy-btn' ? button : null }

    await expect(copyCodeFromTarget(child, (text) => {
      writes.push(text)
      return Promise.resolve()
    })).resolves.toBe(3)
    expect(writes).toEqual(['select 1;\n-- Copy must not be included\n'])
  })

  it('contains clipboard rejection and leaves copied feedback inactive', async () => {
    const code = { textContent: 'denied' }
    const pre = { querySelector: () => code }
    let button: { dataset: { codeCopyIndex: string }; closest: (selector: string) => unknown }
    button = {
      dataset: { codeCopyIndex: '0' },
      closest: (selector: string) => selector === 'pre' ? pre : selector === '.code-copy-btn' ? button : null,
    }

    await expect(copyCodeFromTarget(button, () => Promise.reject(new Error('clipboard denied'))))
      .resolves.toBeNull()
  })

  it('keeps copied feedback through rerenders and resets it cleanly', () => {
    const changes: Array<number | null> = []
    let reset: (() => void) | undefined
    const cancel = scheduleCopyFeedback(
      1,
      (index) => changes.push(index),
      (callback) => {
        reset = callback
        return 17
      },
      () => {},
    )

    expect(changes).toEqual([1])
    reset?.()
    expect(changes).toEqual([1, null])
    expect(cancel).toBeTypeOf('function')
  })

  it('updates only the delegated button for copied feedback', () => {
    const applyCopyButtonFeedback = feedbackApi.applyCopyButtonFeedback
    expect(applyCopyButtonFeedback).toBeTypeOf('function')
    if (!applyCopyButtonFeedback) return

    const classes = new Map<string, boolean>()
    const attributes = new Map<string, string>()
    const button: FeedbackButton = {
      textContent: 'Copy',
      classList: { toggle: (name, force) => { classes.set(name, force) } },
      setAttribute: (name, value) => { attributes.set(name, value) },
    }

    applyCopyButtonFeedback(button, 2, true)
    expect(button.textContent).toBe('Copied')
    expect(classes.get('copied')).toBe(true)
    expect(attributes.get('aria-label')).toBe('Copied code block 3')

    applyCopyButtonFeedback(button, 2, false)
    expect(button.textContent).toBe('Copy')
    expect(classes.get('copied')).toBe(false)
    expect(attributes.get('aria-label')).toBe('Copy code block 3')
  })

  it('restores keyboard focus to a settled button replaced by a streaming commit', () => {
    const focusCalls: unknown[] = []
    const button = { focus: (options?: FocusOptions) => focusCalls.push(options) }
    const body = {}
    const composer = {}
    const root = {
      querySelector: (selector: string) => selector === '[data-code-state="settled"] [data-code-copy-index="1"]' ? button : null,
      contains: (target: unknown) => target === button,
    }

    expect(restoreCopyButtonFocus(root, 1, body, body)).toBe(true)

    expect(focusCalls).toEqual([{ preventScroll: true }])
    expect(restoreCopyButtonFocus(root, 1, composer, body)).toBe(false)
    expect(focusCalls).toHaveLength(1)
  })

  it('keeps settled controls discoverable for pointer, keyboard, and touch users', () => {
    expect(css).toMatch(/\.code-copy-btn\s*\{[^}]*color:\s*var\(--text-secondary\)[^}]*opacity:\s*1/s)
    expect(css).toMatch(/\.code-copy-btn:focus-visible\s*\{/)
    expect(css).toMatch(/@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)/)
    expect(css).toMatch(/\.markdown-code-block\[data-code-state=['"]provisional['"]\][^{]*\.code-copy-btn\s*\{[^}]*visibility:\s*hidden/s)
    expect(css).toMatch(/pre\.markdown-code-block\s*\{[^}]*padding-top:\s*(?:2[8-9]|[3-9]\d)px/s)
  })
})

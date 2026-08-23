import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

const bubble = read('../../src/renderer/components/chat/MessageBubble.tsx')
const plan = read('../../src/renderer/components/chat/PlanCard.tsx')
const markdown = read('../../src/renderer/components/chat/MarkdownWithCopyControls.tsx')
const panel = read('../../src/renderer/components/chat/ChatPanel.tsx')
const toolCall = read('../../src/renderer/components/chat/ToolCallBlock.tsx')
const css = read('../../src/renderer/styles/global.css')

describe('code-copy integration contract', () => {
  it('keeps copy ownership in the shared renderer instead of post-processing DOM walks', () => {
    expect(bubble).toContain('<MarkdownWithCopyControls')
    expect(plan).toContain('<MarkdownWithCopyControls')
    expect(bubble).not.toMatch(/querySelectorAll\(['"]pre['"]\)/)
    expect(plan).not.toMatch(/querySelectorAll\(['"]pre['"]\)/)
    expect(markdown).toContain('onClick={handleClick}')
    expect(markdown).toContain('onFocusCapture={handleFocusCapture}')
    expect(markdown).toContain('restoreCopyButtonFocus(')
    expect(markdown).toContain('event.relatedTarget')
    expect(markdown).not.toContain('requestAnimationFrame')
    expect(markdown).not.toContain('addEventListener')
    expect(markdown).not.toContain('copiedBlockIndex: renderedCopiedIndex')
  })

  it('keys mutability to the message and preserves flush-before-settle ordering', () => {
    expect(bubble).toContain('useMessageMutable(sessionId, message.id)')
    expect(bubble).not.toContain('sessionStatus')
    expect(panel).toContain('prepareRuntimeEventLifecycle(')
    expect(panel).toContain('finishRuntimeEventLifecycle(event, messageLifecycle)')
  })

  it('settles transient copy state in local interruption and provider-stop fallbacks', () => {
    const settleCalls = panel.match(/messageLifecycle\.settleThread\(sessionId\)/g) ?? []
    expect(settleCalls.length).toBeGreaterThanOrEqual(2)
    expect(panel).toMatch(/await window\.api\.provider\?\.interrupt\?\.\(sessionId\)[^]*?flushThread\(sessionId\)[^]*?messageLifecycle\.settleThread\(sessionId\)/)
    expect(panel).toMatch(/onClearMessages=\{\(\) => \{[^]*?messageLifecycle\.settleThread\(sessionId\)[^]*?clearMessages\(sessionId\)/)
    expect(panel).toMatch(/onArchive=\{\(\) => \{[^]*?messageLifecycle\.settleThread\(sessionId\)[^]*?removeSession\(sessionId\)/)
  })

  it('aligns the React-owned tool code button with the accessible shared contract', () => {
    expect(toolCall).toContain("aria-label={`${copied ? 'Copied' : 'Copy'} code block`}")
    expect(toolCall).toContain('aria-live="polite"')
    expect(toolCall).toContain('className="tool-code-toolbar"')
    expect(toolCall).toContain("padding: '6px 10px'")
    expect(toolCall).toContain("const codeRef = useRef<HTMLSpanElement>(null)")
    expect(toolCall).toMatch(/tool-code-toolbar[^]*?<button[^]*?<\/div>[^]*?<pre[^]*?<span ref=\{codeRef\}>\{children\}<\/span>/)
    expect(css).toMatch(/\.tool-code-block \.tool-code-toolbar \.code-copy-btn\s*\{[^}]*position:\s*static/s)
  })
})

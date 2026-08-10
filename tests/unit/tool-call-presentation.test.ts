import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolCallBlock } from '../../src/renderer/components/chat/ToolCallBlock'

describe('ToolCallBlock presentation', () => {
  it('uses a flat neutral disclosure without status dots or colored tiles', () => {
    const markup = renderToStaticMarkup(createElement(ToolCallBlock, {
      toolCall: { id: 'read', name: 'Read', input: 'src/App.tsx', output: 'ok' },
    }))

    expect(markup).toContain('class="tool-call-row"')
    expect(markup).not.toContain('border-radius:50%')
    expect(markup).not.toContain('background:var(--success)')
  })
})

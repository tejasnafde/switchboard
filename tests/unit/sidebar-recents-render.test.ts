import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RecentSessionsSection } from '../../src/renderer/components/sidebar/RecentSessionsSection'
import type { RecentSessionItem } from '../../src/renderer/components/sidebar/recentSessions'

const item: RecentSessionItem = {
  session: {
    id: 'approval',
    source: 'switchboard',
    title: 'Fix auth retry race',
    startedAt: 100,
    messageCount: 1,
    filePath: '',
  },
  projectPath: '/repo',
  projectName: 'repo',
  machineId: 'vm',
  attentionLabel: 'Approval',
}

describe('RecentSessionsSection', () => {
  it('renders native conversation buttons with actionable text and no status dots', () => {
    const markup = renderToStaticMarkup(createElement(RecentSessionsSection, {
      items: [item],
      activeSessionId: null,
      onSelect: () => {},
    }))

    expect(markup).toContain('<button')
    expect(markup).toContain('Fix auth retry race')
    expect(markup).toContain('Approval')
    expect(markup).not.toContain('sidebar-thread-dot')
  })
})

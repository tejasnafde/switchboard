import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RecentSessionsSection } from '../../src/renderer/components/sidebar/RecentSessionsSection'
import type { RecentSessionItem } from '../../src/renderer/components/sidebar/recentSessions'
import { RecentConversationsSetting } from '../../src/renderer/components/SettingsModal'

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
  status: 'approval',
}

describe('RecentSessionsSection', () => {
  it('renders a semantic icon and label without blinking status dots', () => {
    const markup = renderToStaticMarkup(createElement(RecentSessionsSection, {
      items: [item],
      activeSessionId: null,
      onSelect: () => {},
    }))

    expect(markup).toContain('<button')
    expect(markup).toContain('Fix auth retry race')
    expect(markup).toContain('Approval')
    expect(markup).toContain('sidebar-recent-status approval')
    expect(markup).not.toContain('sidebar-thread-dot')
    expect(markup).not.toContain('pulse')
    expect(markup).not.toContain('blink')
  })

  it('collapses to the configured baseline and offers the remaining count', () => {
    const items = Array.from({ length: 7 }, (_, index): RecentSessionItem => ({
      ...item,
      session: { ...item.session, id: `session-${index}`, title: `Session ${index}` },
      status: undefined,
    }))
    const markup = renderToStaticMarkup(createElement(RecentSessionsSection, {
      items,
      initialLimit: 4,
      activeSessionId: null,
      onSelect: () => {},
    }))

    expect(markup).toContain('Session 3')
    expect(markup).not.toContain('Session 4')
    expect(markup).toContain('Show 3 more')
  })

  it('offers every supported collapsed baseline in General settings', () => {
    const markup = renderToStaticMarkup(createElement(RecentConversationsSetting))

    expect(markup).toContain('Recent conversations')
    for (const limit of [4, 6, 8, 12]) {
      expect(markup).toContain(`value="${limit}"`)
    }
  })
})

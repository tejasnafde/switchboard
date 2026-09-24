import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RecentSessionsSection } from '../../src/renderer/components/sidebar/RecentSessionsSection'
import type { RecentSessionItem } from '../../src/renderer/components/sidebar/recent-sessions'
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
  statusLine: 'Waiting on your approval: Bash',
}

describe('RecentSessionsSection', () => {
  it('renders a two-line row with a labelled dot and no blinking status', () => {
    const markup = renderToStaticMarkup(createElement(RecentSessionsSection, {
      items: [item],
      activeSessionId: null,
      onSelect: () => {},
    }))

    expect(markup).toContain('<button')
    expect(markup).toContain('Fix auth retry race')
    expect(markup).toContain('Waiting on your approval: Bash')
    expect(markup).toContain('data-dot="needs-you"')
    expect(markup).toContain('aria-label="Needs you"')
    expect(markup).not.toContain('sidebar-thread-dot')
    expect(markup).not.toContain('pulse')
    expect(markup).not.toContain('blink')
  })

  it('heads each group with its label and counts only the urgent ones', () => {
    const markup = renderToStaticMarkup(createElement(RecentSessionsSection, {
      items: [
        item,
        { ...item, session: { ...item.session, id: 'working', title: 'Working chat' }, status: 'working', statusLine: 'Writing tests' },
        { ...item, session: { ...item.session, id: 'idle', title: 'Idle chat' }, status: undefined, statusLine: 'repo' },
      ],
      activeSessionId: null,
      onSelect: () => {},
    }))

    expect(markup.indexOf('Needs you')).toBeLessThan(markup.indexOf('>Working<'))
    expect(markup.indexOf('>Working<')).toBeLessThan(markup.indexOf('Done recently'))
    // Plain counts: the row dot carries the colour, the count does not.
    expect(markup.match(/<span class="sidebar-recent-count">1<\/span>/g)).toHaveLength(2)
    expect(markup).toContain('data-dot="idle"')
  })

  it('collapses to the configured baseline and offers only the next five rows', () => {
    const items = Array.from({ length: 14 }, (_, index): RecentSessionItem => ({
      ...item,
      session: { ...item.session, id: `session-${index}`, title: `Session ${index}` },
      status: undefined,
      statusLine: 'repo',
    }))
    const markup = renderToStaticMarkup(createElement(RecentSessionsSection, {
      items,
      initialLimit: 4,
      activeSessionId: null,
      onSelect: () => {},
    }))

    expect(markup).toContain('Session 3')
    expect(markup).not.toContain('Session 4')
    expect(markup).toContain('Show 5 more')
    expect(markup).not.toContain('Show 10 more')
  })

  it('offers every supported collapsed baseline in General settings', () => {
    const markup = renderToStaticMarkup(createElement(RecentConversationsSetting))

    expect(markup).toContain('Recent conversations')
    for (const limit of [4, 6, 8, 12]) {
      expect(markup).toContain(`value="${limit}"`)
    }
  })
})

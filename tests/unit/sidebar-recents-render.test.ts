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

  it('shows the digest preview instead of the "Working" label for a working session', () => {
    const workingItem: RecentSessionItem = {
      ...item,
      status: 'working',
      previewLine: 'Writing cost-per-model table, 2 of 4 providers done',
    }
    const markup = renderToStaticMarkup(createElement(RecentSessionsSection, {
      items: [workingItem],
      activeSessionId: null,
      onSelect: () => {},
    }))

    expect(markup).toContain('Writing cost-per-model table, 2 of 4 providers done')
    expect(markup).not.toContain('>Working<')
    expect(markup).toContain('sidebar-recent-status working')
  })

  it('keeps the plain status word for approval/input/failed even with a previewLine', () => {
    const approvalWithPreview: RecentSessionItem = {
      ...item,
      status: 'approval',
      previewLine: 'Done: ready for review',
    }
    const markup = renderToStaticMarkup(createElement(RecentSessionsSection, {
      items: [approvalWithPreview],
      activeSessionId: null,
      onSelect: () => {},
    }))

    expect(markup).toContain('Approval')
    expect(markup).not.toContain('Done: ready for review')
  })

  it('shows the raw preview in the detail slot when there is no status', () => {
    const idleWithPreview: RecentSessionItem = {
      ...item,
      status: undefined,
      previewLine: 'Done: 6 review fixes pushed, tests green',
    }
    const markup = renderToStaticMarkup(createElement(RecentSessionsSection, {
      items: [idleWithPreview],
      activeSessionId: null,
      onSelect: () => {},
    }))

    expect(markup).toContain('Done: 6 review fixes pushed, tests green')
    expect(markup).toContain('sidebar-recent-preview')
  })

  it('falls back to the relative time when there is no status and no previewLine', () => {
    const idleNoPreview: RecentSessionItem = { ...item, status: undefined }
    const markup = renderToStaticMarkup(createElement(RecentSessionsSection, {
      items: [idleNoPreview],
      activeSessionId: null,
      onSelect: () => {},
    }))

    expect(markup).not.toContain('sidebar-recent-preview')
    expect(markup).toContain('sidebar-recent-detail')
  })

  it('collapses to the configured baseline and offers only the next five rows', () => {
    const items = Array.from({ length: 14 }, (_, index): RecentSessionItem => ({
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

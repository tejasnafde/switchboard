// @vitest-environment jsdom
/**
 * The chip viewer's "Go to source": offered only when the source resolves,
 * named after where it goes, and a review chip opens its pull request in
 * Reviews.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { openPillTarget, pillSourceAction } from '../../src/renderer/services/pill-chip-open'
import { useTerminalStore, type SessionLayout } from '../../src/renderer/stores/terminal-store'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { useReviewStore } from '../../src/renderer/stores/review-store'
import { useLayoutStore } from '../../src/renderer/stores/layout-store'
import type { PrListData, PrSummary } from '../../src/shared/pull-requests'

const layout = (label: string) =>
  ({ rows: [], windows: {}, activeWindowId: null, panes: { p1: { id: 'p1', label } } }) as unknown as SessionLayout

const pr = (owner: string, name: string, number: number) =>
  ({ ref: { host: 'github', owner, name, number } }) as unknown as PrSummary

beforeEach(() => {
  useTerminalStore.setState({ layouts: {} })
  useAgentStore.setState({ sessions: [] })
  useReviewStore.setState({ list: null, selectedKey: null })
  useLayoutStore.setState({ appView: 'chats' })
})

describe('pillSourceAction', () => {
  it('offers a terminal pane only while it exists', () => {
    const target = { type: 'terminal' as const, paneLabel: 'api' }
    expect(pillSourceAction(target, 's1')).toBeNull()
    useTerminalStore.setState({ layouts: { s1: layout('api') } })
    expect(pillSourceAction(target, 's1')).toBe('Open pane')
  })

  it('opens a file in the editor, a review in Reviews, and nothing without a target', () => {
    expect(pillSourceAction({ type: 'file', path: 'a.ts', startLine: 1, endLine: 2 }, 's1')).toBe('Open in editor')
    expect(pillSourceAction({ type: 'review', number: 7, repo: null }, 's1')).toBe('Open in Reviews')
    expect(pillSourceAction(null, 's1')).toBeNull()
  })

  it('names the other chat a quote came from when it is loaded', () => {
    const quote = (conversationId: string | null) => ({
      type: 'message' as const,
      role: 'assistant' as const,
      quote: 'x',
      source: conversationId ? { conversationId, messageId: 'm1' } : null,
    })
    expect(pillSourceAction(quote(null), 's1')).toBe('Show in chat')
    expect(pillSourceAction(quote('s1'), 's1')).toBe('Show in chat')
    expect(pillSourceAction(quote('s2'), 's1')).toBe('Show in chat')
    useAgentStore.setState({ sessions: [{ id: 's2', title: 'OAuth retry fix' }] as never })
    expect(pillSourceAction(quote('s2'), 's1')).toBe('Show in “OAuth retry fix”')
  })
})

describe('openPillTarget review', () => {
  const list = (prs: PrSummary[]) => ({ prs }) as unknown as PrListData

  it('selects the pull request in its repository and shows Reviews', async () => {
    useReviewStore.setState({ list: list([pr('acme', 'web', 612), pr('acme', 'api', 612)]) })
    expect(await openPillTarget({ type: 'review', number: 612, repo: 'acme/api' }, 's1')).toBe(true)
    expect(useReviewStore.getState().selectedKey).toBe('github:acme/api#612')
    expect(useLayoutStore.getState().appView).toBe('reviews')
  })

  it('selects nothing when the number alone matches two repositories', async () => {
    useReviewStore.setState({ list: list([pr('acme', 'web', 612), pr('acme', 'api', 612)]) })
    expect(await openPillTarget({ type: 'review', number: 612, repo: null }, 's1')).toBe(true)
    expect(useReviewStore.getState().selectedKey).toBeNull()
    expect(useLayoutStore.getState().appView).toBe('reviews')
  })
})

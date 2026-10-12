/**
 * The pull request detail: the status card in the mock's words, checks that
 * expand in place with failures first, the quiet "Merge on desktop" note and
 * no write action, and the Work on PR sheet's choices.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import type { PrCheck, PrDetail, PrSummary } from '@shared/pull-requests'
import type { PrLinkChat } from '@shared/pull-request-links'
import { PrDetailView } from '../PullRequestScreen'
import { WorkOnPrSheet } from '../../components/WorkOnPrSheet'
import { renderComponent } from '../../test/render'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cases = require('../../../../../tests/fixtures/phone-pr-cases.json') as {
  now: number
  prs: Record<string, PrSummary>
  checks: { input: PrCheck[] }
}

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

let mockCapable = true
const mockLinkable: PrLinkChat[] = [
  {
    id: 'c2',
    familyIds: ['c2'],
    title: 'Sync backoff',
    agentType: 'codex',
    projectPath: '/p/switchboard',
    updatedAt: 1,
  },
]
jest.mock('../../stores/connections', () => ({
  getClient: () => ({
    supportsCapability: (name: string) => (name === 'worktree_existing_branch_v1' ? mockCapable : undefined),
    linkablePullRequestChats: async () => mockLinkable,
  }),
}))

function detail(summary: PrSummary): PrDetail {
  return {
    ...summary,
    description: 'Uploads fail with `403` when a signed URL expires.',
    headSha: null,
    mergeBlockers: [],
    mergeStrategies: ['merge_commit'],
    activity: [],
    checkList: [
      ...cases.checks.input,
      ...Array.from({ length: 4 }, (_, i) => ({ ...cases.checks.input[0], id: `ok-${i}` })),
    ],
    viewerCanManage: true,
  }
}

const linked: PrLinkChat = {
  id: 'c1',
  familyIds: ['c1'],
  title: 'Fix flaky upload test',
  agentType: 'claude-code',
  projectPath: '/p/switchboard',
  updatedAt: 1,
  linkSource: 'created',
}

const pressable = (view: ReturnType<typeof renderComponent>, testID: string) => view.root.findByProps({ testID })

describe('PrDetailView', () => {
  it('words the status card, expands checks failures first, and offers no write action', () => {
    const onAsk = jest.fn()
    const view = renderComponent(
      <PrDetailView
        pr={detail(cases.prs.failed)}
        chats={[linked]}
        now={cases.now}
        onOpenChat={jest.fn()}
        onAskAboutFailures={onAsk}
        onWorkOnPr={jest.fn()}
      />,
    )
    expect(view.texts()).toEqual(
      expect.arrayContaining([
        'Retry uploads when the signed URL expires',
        'fix/upload-retry → main',
        '2 of 14 failed',
        'Changes requested · 1 approval',
        '3 open',
        'None with main',
        'Merge on desktop. ',
        'Fix flaky upload test',
        'Claude Code · opened by the agent',
        'Reviews, comments and merges post as you on GitHub, so they stay on the desktop app.',
        'Work on PR',
      ]),
    )
    expect(view.texts().some((t) => /^(Merge|Approve|Comment|Re-run)$/.test(t))).toBe(false)
    expect(view.root.findAllByProps({ testID: 'pr-checks' })).toHaveLength(0)

    act(() => pressable(view, 'pr-status-checks').props.onPress())
    const checks = view.root.findByProps({ testID: 'pr-checks' })
    const names = checks
      .findAll((n) => typeof n.type === 'string' && typeof n.props.children === 'string')
      .map((n) => n.props.children)
    expect(names.slice(0, 6)).toEqual([
      'close-circle-outline',
      'unit (macos-14)',
      'failed · 4m 12s',
      'close-circle-outline',
      'e2e / reviews',
      'failed · 9m 40s',
    ])
    // The hidden rest holds a skipped check, so it is not "passed".
    expect(names).toContain('+ 4 more')
    expect(names).toContain('Re-run failed jobs on the desktop.')

    act(() => pressable(view, 'pr-ask-failures').props.onPress())
    expect(onAsk).toHaveBeenCalledWith(
      expect.objectContaining({ label: '2 failed checks · #1482 · unit (macos-14), e2e / reviews' }),
    )
  })
})

describe('WorkOnPrSheet', () => {
  const render = (summary: PrSummary, chats: PrLinkChat[] = [linked]) => {
    const onOpenChat = jest.fn()
    const onStartChat = jest.fn()
    const view = renderComponent(
      <WorkOnPrSheet
        connectionId="conn"
        pr={detail(summary)}
        linkedChats={chats}
        onOpenChat={onOpenChat}
        onStartChat={onStartChat}
        onClose={jest.fn()}
      />,
    )
    return { view, onOpenChat, onStartChat }
  }

  it('starts a chat on the branch in a worktree when the backend can', () => {
    mockCapable = true
    const { view, onStartChat } = render(cases.prs.failed)
    expect(view.texts()).toEqual(
      expect.arrayContaining([
        'Work on #1482',
        'LINKED CHAT',
        'Fix flaky upload test',
        'fix/upload-retry',
        "In a worktree of switchboard on the PR's branch.",
      ]),
    )
    act(() => pressable(view, 'work-on-pr-start').props.onPress())
    expect(onStartChat).toHaveBeenCalledWith('/p/switchboard')
  })

  it('falls back to the project checkout on an older backend or a Bitbucket fork', () => {
    mockCapable = false
    expect(render(cases.prs.failed).view.texts()).toContain('In switchboard. The agent checks out the PR first.')
    mockCapable = true
    expect(render(cases.prs.conflictsBb).view.texts()).toContain('In switchboard. The agent checks out the PR first.')
  })

  it('cannot start a chat when no project covers the repository', () => {
    const { view, onStartChat } = render({ ...cases.prs.failed, projectPaths: [] })
    expect(view.texts()).toContain('No project on this machine covers this repository.')
    act(() => pressable(view, 'work-on-pr-start').props.onPress())
    expect(onStartChat).not.toHaveBeenCalled()
  })

  it('attaches the PR to another chat as a review pill', async () => {
    const { view, onOpenChat } = render(cases.prs.failed)
    await act(async () => {
      pressable(view, 'work-on-pr-attach').props.onPress()
      await Promise.resolve()
    })
    expect(view.texts()).toEqual(expect.arrayContaining(['Attach to a chat', 'Fix flaky upload test', 'Sync backoff']))
    const row = view.root.findAll(
      (n) => n.props.accessibilityRole === 'button' && n.findAll((c) => c.props.children === 'Sync backoff').length > 0,
    )[0]
    act(() => row.props.onPress())
    expect(onOpenChat).toHaveBeenCalledWith(
      mockLinkable[0],
      expect.objectContaining({ label: expect.stringContaining('#1482') }),
    )
  })
})

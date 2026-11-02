import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PrLink } from '../../src/shared/pull-request-links'
import { rollupChecks, type PrListData, type PrSummary } from '../../src/shared/pull-requests'
import { buildWindow, type ProviderUsage } from '../../src/shared/provider-usage'
import { linkedPrRow } from '../../src/renderer/components/reviews/linked-pr-picker'
import {
  branchValue,
  changesValue,
  editorLabel,
  machineValue,
  prValue,
  usageBars,
} from '../../src/renderer/components/chat/chat-details-model'
import { ChatDetailsPopover } from '../../src/renderer/components/chat/ChatDetailsPopover'

const NOW = Date.parse('2026-11-02T12:00:00Z')

function pr(number: number, over: Partial<PrSummary> = {}): PrSummary {
  return {
    ref: { host: 'github', owner: 'o', name: 'repo', number },
    title: `PR ${number}`,
    url: '',
    author: { login: 'me', displayName: 'Me', avatarUrl: null },
    authorId: 'me',
    state: 'open',
    draft: false,
    sourceBranch: `feat/${number}`,
    targetBranch: 'main',
    createdAt: NOW - number,
    updatedAt: NOW,
    mergedAt: null,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    unresolvedConversations: 0,
    mergeConflicts: false,
    conflictedFiles: [],
    checks: rollupChecks([{ state: 'success' }]),
    reviewers: [],
    approvals: { given: 0, required: null },
    viewer: { isAuthor: true, isRequestedReviewer: false, hasReviewed: false, hasCommented: false },
    projectPaths: [],
    ...over,
  }
}

function rows(prs: PrSummary[]) {
  const list: PrListData = { prs, sources: [], unsupportedProjects: [], fetchedAt: NOW, hidden: [] }
  return prs.map((p) => {
    const link: PrLink = { ref: p.ref, source: 'auto', linkedAt: NOW }
    return linkedPrRow(link, list)
  })
}

function usage(windows: { kind: 'weekly' | 'session'; percent: number | null }[]): ProviderUsage {
  return {
    instanceId: 'claude-code-default',
    agentType: 'claude-code',
    status: 'ok',
    plan: null,
    account: null,
    windows: windows.map((w) =>
      buildWindow({
        id: w.kind,
        label: w.kind,
        kind: w.kind,
        percent: w.percent,
        resetsAtMs: null,
        windowMinutes: null,
      }),
    ),
    overage: [],
    fetchedAtMs: NOW,
  }
}

describe('machine and editor labels', () => {
  it('names a local chat This Mac', () => {
    expect(machineValue(undefined, undefined)).toBe('This Mac')
    expect(machineValue('local', undefined)).toBe('This Mac')
    expect(editorLabel('local', undefined)).toBe('Open in editor')
  })

  it('names a remote chat by its host', () => {
    expect(machineValue('m1', 'dev-vm')).toBe('dev-vm · SSH')
    expect(editorLabel('m1', 'dev-vm')).toBe('Open in editor on dev-vm')
  })
})

describe('branchValue', () => {
  it('shows the branch, a detached HEAD, and None outside a repository', () => {
    expect(branchValue({ ok: true, branch: 'main' })).toEqual({ text: 'main' })
    expect(branchValue({ ok: true, branch: null })).toEqual({ text: 'Detached HEAD' })
    expect(branchValue({ ok: false, error: 'not a git repository' })).toEqual({ text: 'None', muted: true })
  })
})

describe('prValue', () => {
  it('is null when no PR is linked', () => {
    expect(prValue([])).toBeNull()
  })

  it('shows the first open PR with its failing checks marked bad', () => {
    const failing = rollupChecks([{ state: 'failure' }, { state: 'failure' }, { state: 'success' }])
    const value = prValue(rows([pr(1, { state: 'merged' }), pr(2, { title: 'Fix login', checks: failing })]))
    expect(value).toEqual({
      title: 'Fix login',
      detail: [{ text: '#2' }, { text: '2 checks failed', bad: true }],
    })
  })

  it('shows a merged PR when none is open', () => {
    expect(prValue(rows([pr(7, { state: 'merged' })]))?.detail).toEqual([{ text: '#7' }, { text: 'merged' }])
  })
})

describe('changesValue', () => {
  it('reads zero lines as No changes and keeps the counts otherwise', () => {
    expect(changesValue({ ok: true, added: 0, removed: 0 })).toEqual({ text: 'No changes', muted: true })
    expect(changesValue({ ok: true, added: 12, removed: 3 })).toEqual({ added: 12, removed: 3 })
    expect(changesValue({ ok: false, error: 'x' })).toEqual({ text: 'None', muted: true })
  })
})

describe('usageBars', () => {
  it('turns used percent into what is left, with tones', () => {
    const [weekly, session, context] = usageBars(
      usage([
        { kind: 'weekly', percent: 85 },
        { kind: 'session', percent: 95 },
      ]),
      false,
      40,
    )
    expect(weekly).toMatchObject({ label: 'Weekly', used: 85, left: 15, tone: 'warning' })
    expect(session).toMatchObject({ label: '5-hour session', used: 95, left: 5, tone: 'error' })
    expect(context).toMatchObject({ label: 'Context', used: 40, left: 60, tone: 'neutral' })
  })

  it('marks a limit that cannot be read, and one still being read', () => {
    const [weekly, session, context] = usageBars(usage([{ kind: 'weekly', percent: null }]), false, null)
    expect(weekly).toMatchObject({ used: null, left: null, tone: 'neutral', pending: false })
    expect(session).toMatchObject({ used: null, left: null, pending: false })
    expect(context.left).toBeNull()
    expect(usageBars(undefined, true, null).map((bar) => bar.pending)).toEqual([true, true, false])
  })
})

describe('ChatDetailsPopover', () => {
  it('renders a closed Details button', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatDetailsPopover, {
        sessionId: 's1',
        machineId: undefined,
        machineName: undefined,
        cwd: '/repo',
        instanceId: 'claude-code-default',
        contextUsage: undefined,
      }),
    )
    expect(markup).toContain('class="chat-header-action"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('>Details</button>')
  })
})

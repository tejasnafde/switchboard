/**
 * The rows of the chat Details sheet, as data: machine, branch, linked pull
 * request, working-tree changes and the usage bars. Same rules and text as
 * the desktop's `chat-details-model.ts` and Android's `ChatDetails.kt`.
 */
import type { BranchRead, DiffRead } from '@shared/chat-details'
import { linkHeaderState, type PrLink } from '@shared/pull-request-links'
import { prKey, type PrListData, type PrState, type PrSummary } from '@shared/pull-requests'
import type { ProviderUsage, UsageWindowKind } from '@shared/provider-usage'
import { leftPercent, leftTone, type LeftTone } from '@shared/usage-left'

export interface DetailsValue {
  text: string
  muted?: boolean
}

const PENDING: DetailsValue = { text: '…', muted: true }
const NONE: DetailsValue = { text: 'None', muted: true }

/** `undefined` while the read is in flight; a failed read (not a repository) is None. */
export function branchValue(read: BranchRead | undefined): DetailsValue {
  if (!read) return PENDING
  if (!read.ok) return NONE
  return read.branch ? { text: read.branch } : { text: 'Detached HEAD' }
}

export type ChangesValue = DetailsValue | { added: number; removed: number }

export function changesValue(read: DiffRead | undefined): ChangesValue {
  if (!read) return PENDING
  if (!read.ok) return NONE
  if (read.added === 0 && read.removed === 0) return { text: 'No changes', muted: true }
  return { added: read.added, removed: read.removed }
}

/** One part of the PR row's second line. A `bad` part reads in red. */
export interface PrPart {
  text: string
  bad?: boolean
}

export interface PrValue {
  title: string
  /** "#612 · 2 checks failed". */
  detail: PrPart[]
}

interface LinkRow {
  link: PrLink
  pr: PrSummary | null
  state: PrState | null
}

function linkRow(link: PrLink, list: PrListData | null): LinkRow {
  const pr = list?.prs.find((p) => prKey(p.ref) === prKey(link.ref)) ?? null
  return { link, pr, state: linkHeaderState(link, pr?.state ?? null, list?.fetchedAt ?? null) }
}

function checksPart({ pr, state }: LinkRow): PrPart | null {
  if (state !== 'open') return state ? { text: state } : null
  if (!pr) return { text: 'open' }
  switch (pr.checks.state) {
    case 'failure':
      return { text: `${pr.checks.failed} ${pr.checks.failed === 1 ? 'check' : 'checks'} failed`, bad: true }
    case 'pending':
      return { text: 'checks running' }
    case 'success':
      return { text: 'checks passed' }
    case 'none':
      return { text: 'no checks' }
  }
}

/**
 * The first open linked PR, else the newest (created time when the Reviews
 * list has it, else link time, then the higher number); null when none is linked.
 */
export function prValue(links: readonly PrLink[], list: PrListData | null): PrValue | null {
  const created = (row: LinkRow) => row.pr?.createdAt ?? row.link.linkedAt
  const row = links
    .map((link) => linkRow(link, list))
    .sort(
      (a, b) =>
        Number(b.state === 'open') - Number(a.state === 'open') ||
        created(b) - created(a) ||
        b.link.ref.number - a.link.ref.number,
    )[0]
  if (!row) return null
  const checks = checksPart(row)
  return {
    title: row.pr?.title ?? `${row.link.ref.owner}/${row.link.ref.name}`,
    detail: [{ text: `#${row.link.ref.number}` }, ...(checks ? [checks] : [])],
  }
}

export interface UsageBar {
  label: string
  /** 0..100, the fill width; null when the limit cannot be read. */
  used: number | null
  left: number | null
  tone: LeftTone
  /** No number yet because the read is in flight (not Unavailable). */
  pending: boolean
}

function bar(label: string, used: number | null, reading = false): UsageBar {
  const left = leftPercent(used)
  return {
    label,
    used: left === null ? null : 100 - left,
    left,
    tone: leftTone(left),
    pending: left === null && reading,
  }
}

function windowUsed(usage: ProviderUsage | undefined, kind: UsageWindowKind): number | null {
  if (usage?.status !== 'ok') return null
  return usage.windows.find((w) => w.kind === kind)?.usedPercent ?? null
}

/** `usage` is undefined while the read is in flight or after it failed (`reading` tells them apart). */
export function usageBars(usage: ProviderUsage | undefined, reading: boolean, contextUsed: number | null): UsageBar[] {
  const pending = reading && usage === undefined
  return [
    bar('Weekly', windowUsed(usage, 'weekly'), pending),
    bar('5-hour session', windowUsed(usage, 'session'), pending),
    bar('Context', contextUsed),
  ]
}

/** "Weekly, 42 percent left", or "Weekly, unavailable". */
export function barAccessibilityLabel(bar: UsageBar): string {
  if (bar.left !== null) return `${bar.label}, ${bar.left} percent left`
  return `${bar.label}, ${bar.pending ? 'reading' : 'unavailable'}`
}

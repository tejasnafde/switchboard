/**
 * The rows of the chat header's Details popover, as data. Pure, so the
 * labels, empty states and tones are tested without a DOM.
 */
import type { ProviderUsage, UsageWindowKind } from '@shared/provider-usage'
import { leftPercent, leftTone, type LeftTone } from '@shared/usage-left'
import { rowTitle, sortLinkedPrRows, type LinkedPrRow, type RowPart } from '../reviews/linked-pr-picker'

export interface DetailsValue {
  text: string
  muted?: boolean
}

const PENDING: DetailsValue = { text: '…', muted: true }
const NONE: DetailsValue = { text: 'None', muted: true }

function isLocal(machineId: string | undefined): boolean {
  return !machineId || machineId === 'local'
}

export function machineValue(machineId: string | undefined, machineName: string | undefined): string {
  return isLocal(machineId) ? 'This Mac' : `${machineName ?? machineId} · SSH`
}

export function editorLabel(machineId: string | undefined, machineName: string | undefined): string {
  return isLocal(machineId) ? 'Open in editor' : `Open in editor on ${machineName ?? machineId}`
}

export type BranchRead = { ok: true; branch: string | null } | { ok: false; error: string }

/** `undefined` while the read is in flight; a failed read (not a repository) is None. */
export function branchValue(read: BranchRead | undefined): DetailsValue {
  if (!read) return PENDING
  if (!read.ok) return NONE
  return read.branch ? { text: read.branch } : { text: 'Detached HEAD' }
}

export type DiffRead = { ok: true; added: number; removed: number } | { ok: false; error: string }

export type ChangesValue = DetailsValue | { added: number; removed: number }

export function changesValue(read: DiffRead | undefined): ChangesValue {
  if (!read) return PENDING
  if (!read.ok) return NONE
  if (read.added === 0 && read.removed === 0) return { text: 'No changes', muted: true }
  return { added: read.added, removed: read.removed }
}

export interface PrValue {
  title: string
  /** "#612 · 2 checks failed"; a `bad` part reads in the error colour. */
  detail: RowPart[]
}

function checksPart(row: LinkedPrRow): RowPart | null {
  const { pr } = row
  if (row.state !== 'open') return row.state ? { text: row.state } : null
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

/** The first open linked PR, else the most recent one; null when none is linked. */
export function prValue(rows: readonly LinkedPrRow[]): PrValue | null {
  const row = sortLinkedPrRows(rows)[0]
  if (!row) return null
  const checks = checksPart(row)
  return { title: rowTitle(row), detail: [{ text: `#${row.link.ref.number}` }, ...(checks ? [checks] : [])] }
}

export interface UsageBar {
  label: string
  /** 0..100, the fill width; null when the limit cannot be read. */
  used: number | null
  left: number | null
  tone: LeftTone
  /** No number yet because the first read is in flight (not Unavailable). */
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

/** `reading` is true while the account's first usage read is in flight. */
export function usageBars(usage: ProviderUsage | undefined, reading: boolean, contextUsed: number | null): UsageBar[] {
  const pending = reading && usage === undefined
  return [
    bar('Weekly', windowUsed(usage, 'weekly'), pending),
    bar('5-hour session', windowUsed(usage, 'session'), pending),
    bar('Context', contextUsed),
  ]
}

/**
 * The rows of the chat header's linked pull request picker: order, search,
 * the ten-row cap and each row's text. Pure, so the rules are tested without
 * a DOM.
 */
import { linkHeaderState, linkSourceLabel, type PrLink } from '@shared/pull-request-links'
import { prKey, type PrListData, type PrState, type PrSummary } from '@shared/pull-requests'

/** Rows shown before "Show N more". */
export const LINKED_PR_ROW_CAP = 10

export interface LinkedPrRow {
  key: string
  link: PrLink
  /** The Reviews list's summary with the link's newer state over it; `null` when the list lacks the PR. */
  pr: PrSummary | null
  state: PrState | null
}

/** One part of a row's second line. `bad` parts read in the error colour. */
export interface RowPart {
  text: string
  bad?: boolean
}

export function linkedPrRow(link: PrLink, list: PrListData | null): LinkedPrRow {
  const key = prKey(link.ref)
  const listed = list?.prs.find((pr) => prKey(pr.ref) === key) ?? null
  const state = linkHeaderState(link, listed?.state ?? null, list?.fetchedAt ?? null)
  const pr =
    listed && state && state !== listed.state
      ? { ...listed, state, mergedAt: listed.mergedAt ?? link.stateAt ?? null }
      : listed
  return { key, link, pr, state }
}

/** Open PRs (drafts too) first, then the newest: created time when listed, else link time, then the higher number. */
export function sortLinkedPrRows(rows: readonly LinkedPrRow[]): LinkedPrRow[] {
  const created = (row: LinkedPrRow) => row.pr?.createdAt ?? row.link.linkedAt
  return [...rows].sort(
    (a, b) =>
      Number(b.state === 'open') - Number(a.state === 'open') ||
      created(b) - created(a) ||
      b.link.ref.number - a.link.ref.number,
  )
}

export function repoName(row: LinkedPrRow): string {
  return `${row.link.ref.owner}/${row.link.ref.name}`
}

/** True when the chat's links span more than one repository, so each row names its own. */
export function spansRepos(rows: readonly LinkedPrRow[]): boolean {
  return new Set(rows.map(repoName)).size > 1
}

/** The first line: the PR title, or the repository while the Reviews list has not read the PR. */
export function rowTitle(row: LinkedPrRow): string {
  return row.pr?.title ?? repoName(row)
}

/** What an open PR needs: draft, build failed or checks running, then open conversations. */
function statusPhrases(row: LinkedPrRow): RowPart[] {
  const { pr } = row
  if (!pr || row.state !== 'open') return []
  const parts: RowPart[] = []
  if (pr.draft) parts.push({ text: 'draft' })
  else if (pr.checks.state === 'failure') parts.push({ text: 'build failed', bad: true })
  else if (pr.checks.state === 'pending') parts.push({ text: 'checks running' })
  const open = pr.unresolvedConversations ?? 0
  if (open > 0) parts.push({ text: `${open} open conversation${open === 1 ? '' : 's'}` })
  return parts
}

/**
 * The second line: "#612 · open · build failed · 3 open conversations", then
 * the repository when the chat spans several, then how it was linked unless
 * automatically (that one is only in the row's tooltip).
 */
export function rowDetail(row: LinkedPrRow, multiRepo: boolean): RowPart[] {
  const parts: RowPart[] = [{ text: `#${row.link.ref.number}` }]
  if (row.state) parts.push({ text: row.state })
  parts.push(...statusPhrases(row))
  if (multiRepo) parts.push({ text: repoName(row) })
  if (row.link.source !== 'auto') parts.push({ text: linkSourceLabel(row.link.source) })
  return parts
}

export function rowTooltip(row: LinkedPrRow): string {
  return [linkSourceLabel(row.link.source), row.pr?.sourceBranch].filter(Boolean).join(' · ')
}

function haystack(row: LinkedPrRow): string {
  const n = row.link.ref.number
  return [
    String(n),
    `#${n}`,
    row.pr?.title,
    row.pr?.sourceBranch,
    row.state,
    repoName(row),
    ...statusPhrases(row).map((part) => part.text),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/** Every word of the query must appear in the number, title, branch, repository or state words ("merged", "draft", "build failed"). */
export function filterLinkedPrRows(rows: readonly LinkedPrRow[], query: string): LinkedPrRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter((row) => {
    const text = haystack(row)
    return words.every((word) => text.includes(word))
  })
}

/** The rows to draw and how many "Show N more" hides. */
export function capLinkedPrRows(
  rows: readonly LinkedPrRow[],
  showAll: boolean,
): { shown: LinkedPrRow[]; hidden: number } {
  if (showAll || rows.length <= LINKED_PR_ROW_CAP) return { shown: [...rows], hidden: 0 }
  return { shown: rows.slice(0, LINKED_PR_ROW_CAP), hidden: rows.length - LINKED_PR_ROW_CAP }
}

/** The chip: "2 open · 106 linked". */
export function chipCounts(rows: readonly LinkedPrRow[]): { open: number; linked: number } {
  return { open: rows.filter((row) => row.state === 'open').length, linked: rows.length }
}

/** The row whose status the chip's icon shows: an open PR with a failed build, else the first row. */
export function chipIconRow(sorted: readonly LinkedPrRow[]): LinkedPrRow {
  return sorted.find((row) => row.state === 'open' && row.pr?.checks.state === 'failure') ?? sorted[0]
}

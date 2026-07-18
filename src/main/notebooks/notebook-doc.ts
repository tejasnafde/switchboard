/**
 * nbformat JSON handling for the notebook mirror sync: cell identity,
 * mirror-cell extraction, mirror application and serialization.
 *
 * Identity prefers the native `cell.id` field (nbformat 4.5+); older
 * documents fall back to `metadata.cellbridge_id`. Whichever field carries
 * the id, the mirror marker format is identical.
 */
import { randomUUID } from 'node:crypto'
import type { MirrorCell } from './mirror-format'

export type NotebookDoc = Record<string, unknown>
type NotebookCell = Record<string, unknown>

const cellsOf = (doc: NotebookDoc): NotebookCell[] => (doc.cells as NotebookCell[] | undefined) ?? []

/** nbformat 4.5 introduced the top-level cell `id` field. */
function supportsNativeIds(doc: NotebookDoc): boolean {
  const major = (doc.nbformat as number | undefined) ?? 4
  const minor = (doc.nbformat_minor as number | undefined) ?? 0
  return major > 4 || (major === 4 && minor >= 5)
}

function idOf(cell: NotebookCell): string | null {
  if (typeof cell.id === 'string' && cell.id) return cell.id
  const meta = cell.metadata as Record<string, unknown> | undefined
  const legacy = meta?.cellbridge_id
  return typeof legacy === 'string' && legacy ? legacy : null
}

/**
 * Return a copy of the document where every cell has a stable id, plus
 * whether anything was assigned (callers persist the doc only when changed).
 */
export function ensureCellIds(doc: NotebookDoc): { doc: NotebookDoc; changed: boolean } {
  const native = supportsNativeIds(doc)
  let changed = false
  const cells = cellsOf(doc).map((cell) => {
    if (idOf(cell)) return cell
    changed = true
    const fresh = randomUUID()
    if (native) return { ...cell, id: fresh }
    return { ...cell, metadata: { ...(cell.metadata as object | undefined), cellbridge_id: fresh } }
  })
  return { doc: changed ? { ...doc, cells } : doc, changed }
}

const joinSource = (source: unknown): string =>
  Array.isArray(source) ? source.join('') : typeof source === 'string' ? source : ''

/** Extract the mirror view of a document. Cells must already have ids. */
export function mirrorCellsOf(doc: NotebookDoc): MirrorCell[] {
  return cellsOf(doc).map((cell) => ({
    id: idOf(cell) ?? '',
    cellType: (cell.cell_type as MirrorCell['cellType'] | undefined) ?? 'code',
    source: joinSource(cell.source),
  }))
}

/** nbformat stores source as lines, each keeping its trailing newline except the last. */
const splitSource = (source: string): string[] => {
  const lines = source.split('\n')
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line))
}

function newCell(mc: MirrorCell, native: boolean): NotebookCell {
  const identity = native ? { id: mc.id, metadata: {} } : { metadata: { cellbridge_id: mc.id } }
  const base = { cell_type: mc.cellType, ...identity, source: splitSource(mc.source) }
  // Only code cells carry outputs/execution_count - extra keys on markdown/raw
  // cells fail nbformat validation.
  return mc.cellType === 'code' ? { ...base, outputs: [], execution_count: null } : base
}

/**
 * Apply an edited mirror to a notebook document: mirror order wins, surviving
 * cells keep everything except source (outputs, execution_count, attachments
 * and FULL metadata - CellIQ dropped all metadata but cellbridge_id), deleted
 * cells drop, new cells are created with their id persisted.
 *
 * The caller passes the freshly-read document, so outputs re-attach from live
 * state rather than an open-time snapshot (the CellIQ staleness fix).
 */
export function applyMirror(doc: NotebookDoc, mirrorCells: MirrorCell[]): NotebookDoc {
  const native = supportsNativeIds(doc)
  const existing = new Map<string, NotebookCell>()
  for (const cell of cellsOf(doc)) {
    const id = idOf(cell)
    if (id) existing.set(id, cell)
  }

  const cells = mirrorCells.map((mc) => {
    const survivor = existing.get(mc.id)
    return survivor ? { ...survivor, source: splitSource(mc.source) } : newCell(mc, native)
  })

  return { ...doc, cells }
}

/** Match jupyter's on-disk shape: single-space indent, trailing newline. */
export function serializeNotebook(doc: NotebookDoc): string {
  return `${JSON.stringify(doc, null, 1)}\n`
}

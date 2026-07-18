/**
 * Pure notebook-mirror format logic - generation, parsing, validation, and
 * mirror path mapping. The .py mirror is the LLM-friendly edit surface for
 * .ipynb notebooks: agents edit the mirror, the sync engine propagates to the
 * notebook JSON. Ported from CellIQ with Switchboard branding.
 *
 * No fs / electron / path imports - unit testable in isolation and safe to
 * consume from any process.
 */

/** Mirrors live in a tree that shadows the repo layout - trivially invertible,
 *  no filename encoding (a `__` scheme is lossy for names containing `__`). */
export const MIRROR_DIR = '.switchboard/notebooks'

/** Repo-relative mirror path for a repo-relative notebook path. */
export function mirrorRelPathFor(notebookRelPath: string): string {
  return `${MIRROR_DIR}/${notebookRelPath.replace(/\.ipynb$/, '.py')}`
}

/** Inverse of mirrorRelPathFor. Null when the path is not a mirror. */
export function notebookRelPathFor(mirrorRelPath: string): string | null {
  if (!isMirrorRelPath(mirrorRelPath)) return null
  return mirrorRelPath.slice(MIRROR_DIR.length + 1).replace(/\.py$/, '.ipynb')
}

export function isMirrorRelPath(relPath: string): boolean {
  return relPath.startsWith(`${MIRROR_DIR}/`) && relPath.endsWith('.py')
}

export interface MirrorCell {
  id: string
  cellType: 'code' | 'markdown' | 'raw'
  source: string
}

/**
 * Generate the .py mirror text for a notebook.
 *
 * The header deliberately frames the mirror as the canonical edit surface.
 * CellIQ regression: an earlier "DO NOT EDIT MANUALLY" header made Claude
 * bypass the mirror and edit the .ipynb via NotebookEdit instead.
 */
export function generateMirror(notebookRelPath: string, cells: MirrorCell[]): string {
  const lines: string[] = [
    '# Switchboard Notebook Mirror - EDIT THIS FILE to modify the notebook.',
    `# Source notebook: ${notebookRelPath}`,
    '# This file is the canonical edit surface for AI agents.',
    '# Changes here sync back to the .ipynb automatically. Never edit the .ipynb JSON directly.',
    '',
  ]

  for (const cell of cells) {
    const lang = cell.cellType === 'markdown' ? 'markdown' : 'python'
    lines.push(`# %% [cellbridge_id=${cell.id}] [type=${cell.cellType}] [lang=${lang}]`)
    if (cell.cellType === 'markdown') {
      for (const line of cell.source.split('\n')) lines.push(`# ${line}`)
    } else {
      lines.push(cell.source)
    }
    lines.push('')
  }

  return lines.join('\n')
}

const MARKER_RE = /^# %% \[cellbridge_id=([^\]]+)\](?: \[type=([^\]]+)\])?(?: \[lang=([^\]]+)\])?/

/** Parse a mirror back into cells. Content before the first marker (the header) is ignored. */
export function parseMirror(content: string): MirrorCell[] {
  const cells: MirrorCell[] = []
  let current: MirrorCell | null = null
  let bodyLines: string[] = []

  const flush = (): void => {
    if (!current) return
    current.source = bodyLines.join('\n').replace(/\n$/, '')
    cells.push(current)
  }

  for (const line of content.split('\n')) {
    const marker = line.match(MARKER_RE)
    if (marker) {
      flush()
      current = {
        id: marker[1],
        cellType: (marker[2] as MirrorCell['cellType']) || 'code',
        source: '',
      }
      bodyLines = []
      continue
    }
    if (!current) continue
    bodyLines.push(current.cellType === 'markdown' ? line.replace(/^# ?/, '') : line)
  }
  flush()

  return cells
}

/**
 * Structural validation before a mirror is synced back to the notebook.
 * Returns an error message describing what the agent broke, or null if OK.
 * The total-rewrite guard blocks edits that discard every original cell id,
 * which would sever output/metadata re-attachment for the whole notebook.
 */
export function validateMirror(content: string, originalIds: string[]): string | null {
  const cells = parseMirror(content)

  if (cells.length === 0) {
    return 'Mirror has no cells - the edit may have deleted all content or corrupted the markers'
  }

  const ids = cells.map((c) => c.id)
  const dupe = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dupe) {
    return `Duplicate cellbridge_id "${dupe}" - a cell marker was copied instead of given a new id`
  }

  const originalSet = new Set(originalIds)
  if (originalIds.length > 0 && !cells.some((c) => originalSet.has(c.id))) {
    return 'No original cell ids survived - the file was rewritten without preserving markers'
  }

  return null
}

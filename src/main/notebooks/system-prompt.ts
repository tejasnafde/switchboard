/**
 * System-prompt addendum teaching agents the notebook mirror workflow.
 * Appended per session when the project contains notebooks. Adapted from
 * CellIQ's battle-tested prompt (claude-protocol.ts), compressed for the
 * append seam - the hard enforcement lives in policy.notebookWriteRedirect,
 * this text just saves the agent a denied round trip.
 */

export interface NotebookMirrorPair {
  notebookRelPath: string
  mirrorRelPath: string
}

export function buildNotebookSystemPrompt(pairs: NotebookMirrorPair[]): string {
  if (pairs.length === 0) return ''

  const listing = pairs.map((p) => `- ${p.notebookRelPath} -> ${p.mirrorRelPath}`).join('\n')

  return `## Jupyter notebooks in this workspace

Never edit or write .ipynb files directly (NotebookEdit included) - such writes are denied.
Each notebook has a .py mirror that is the canonical edit surface. Edit the mirror; it syncs
back to the notebook automatically, preserving outputs on untouched cells.

Mirrors for this workspace:
${listing}

Mirror format - each cell starts with a marker line:
# %% [cellbridge_id=<id>] [type=code|markdown] [lang=python|markdown]

Rules:
- Preserve every existing marker and its cellbridge_id exactly. Edit only cell bodies,
  add new cells (new marker with a fresh unique id), delete cells, or reorder whole cells.
- Code cell bodies are raw Python. Markdown cell bodies prefix every line with "# ".
- Read the mirror before editing it.
- To create a new notebook, write a new mirror file at .switchboard/notebooks/<path>.py
  (using the target notebook's relative path) - the .ipynb materializes automatically.
- Reading .ipynb files (for outputs or tracebacks) is fine.`
}

/**
 * Ids and shapes for a turn's tool and changed-file rows. The renderer builds
 * these rows live from `tool.started` / `file.edited`, and the backend mirrors
 * the same rows to SQLite at turn end, so both must agree on the ids: the
 * desktop persists a diff card's accept/reject by the live id.
 */
export const toolRowId = (toolId: string): string => `tool_${toolId}`

export const fileDiffRowId = (fileEditId: string): string => `filediff_${fileEditId}`

/** A tool's input as rendered: adapters send an object or a preformatted string. */
export function toolInputText(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2)
}


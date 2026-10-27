/**
 * The line a composer attachment adds to the prompt: the file's name and the
 * path of its saved copy (or, for a dropped folder, the folder's own path).
 * Every provider gets this line; the agent reads the file with its own tools.
 */

/** Largest file the composer copies into the attachments folder. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export type AttachmentKind = 'file' | 'folder'

export function attachmentPromptLine(kind: AttachmentKind, name: string, path: string): string {
  return kind === 'file'
    ? `[Attached file "${name}" is saved at: ${path}]`
    : `[Attached folder "${name}" is at: ${path}]`
}

const LINE = /^\[Attached (file|folder) "(.*)" is (?:saved )?at: (.+)\]$/

/** The attachment a prompt line names, or null for any other text. */
export function parseAttachmentLine(line: string): { kind: AttachmentKind; name: string; path: string } | null {
  const m = LINE.exec(line.trim())
  return m ? { kind: m[1] as AttachmentKind, name: m[2], path: m[3] } : null
}

export function parseAttachmentLines(text: string): Array<{ kind: AttachmentKind; name: string; path: string }> {
  return text.split('\n').flatMap((line) => parseAttachmentLine(line) ?? [])
}

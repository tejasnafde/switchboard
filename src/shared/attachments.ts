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

/** Pasted text over this many bytes becomes a `pasted-text-N.txt` attachment. */
export const LARGE_PASTE_BYTES = 32 * 1024

/** The next free `pasted-text-N.txt` name, given the labels of the chips already attached. */
export function nextPastedTextName(labels: string[]): string {
  const used = labels.map((label) => Number(/^pasted-text-(\d+)\.txt/.exec(label)?.[1] ?? 0))
  return `pasted-text-${Math.max(0, ...used) + 1}.txt`
}

/** `1,234` for a count on a chip. */
const count = (n: number): string => n.toLocaleString('en-US')

/** The chip label of a saved attachment: `spec.pdf (12 pages)`, `log.txt (2,140 lines)`, or the name. */
export function attachmentLabel(name: string, detail: { pages?: number; lines?: number; entries?: number }): string {
  if (detail.entries !== undefined)
    return `${name}/ (${count(detail.entries)} ${detail.entries === 1 ? 'file' : 'files'})`
  if (detail.pages && detail.pages > 1) return `${name} (${count(detail.pages)} pages)`
  if (detail.lines && detail.lines > 1) return `${name} (${count(detail.lines)} lines)`
  return name
}

/**
 * Phones send a file's bytes over `app:upload-attachment` (`{ name, data }`,
 * base64) and get its saved copy back. A backend without this capability
 * takes images only.
 */
export const ATTACHMENT_UPLOAD_CAPABILITY = 'attachment_upload_v1'

/**
 * Largest file a phone uploads. Its base64 rides in one message, which must
 * fit OkHttp's 16 MiB send queue (Android), the IAP host's 32 MiB line and
 * the 64 MiB WebSocket frame.
 */
export const MAX_UPLOAD_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** A file saved on the backend, ready to go in a turn. */
export interface SentAttachment {
  id: string
  name: string
  path: string
  label: string
}

/**
 * The turn for typed text plus attached files, the same shape the desktop
 * sends: the provider text ends with one `attachmentPromptLine` per file, the
 * display body with one `[[pill:id]]` token per file, drawn as a file chip.
 */
export function attachmentTurn(
  text: string,
  attachments: SentAttachment[],
): { providerText: string; displayBody: string; pillsMeta?: Record<string, { label: string; kind: 'file' }> } {
  if (!attachments.length) return { providerText: text, displayBody: text }
  const join = (tail: string[]) => [text, tail.join('\n')].filter(Boolean).join('\n\n')
  return {
    providerText: join(attachments.map((a) => attachmentPromptLine('file', a.name, a.path))),
    displayBody: join(attachments.map((a) => `[[pill:${a.id}]]`)),
    pillsMeta: Object.fromEntries(attachments.map((a) => [a.id, { label: a.label, kind: 'file' as const }])),
  }
}

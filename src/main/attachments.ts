/**
 * Files attached in the composer. Each is copied to
 * `<userData>/attachments/<uuid>/<name>` and the turn names it by that path
 * (`attachmentPromptLine`), so every provider can read it with its own tools.
 * A Claude turn also carries an attached PDF as a document block
 * (`attachedPdfBlocks`). Copies older than `KEEP_DAYS` are removed at startup.
 */
import { randomUUID } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { basename, join, relative, isAbsolute } from 'path'
import { MAX_ATTACHMENT_BYTES, MAX_UPLOAD_ATTACHMENT_BYTES, parseAttachmentLines } from '@shared/attachments'
import { createMainLogger } from './logger'
import { userDataDir } from './runtime'

const log = createMainLogger('chat:attachments')

const KEEP_DAYS = 30
/**
 * PDF bytes and pages one turn sends as document blocks, together. Claude's
 * limits are 32 MB a request and 100 pages, and the session resends earlier
 * blocks, so a turn keeps well under them.
 */
const MAX_PDF_TURN_BYTES = 10 * 1024 * 1024
const MAX_PDF_TURN_PAGES = 100

export function attachmentsDir(): string {
  return join(userDataDir(), 'attachments')
}

export interface SavedAttachment {
  path: string
  size: number
  /** Page count of a PDF, when it can be read. */
  pages?: number
}

/** ponytail: counts `/Type /Page` objects, which misses PDFs with compressed object streams. */
export function pdfPageCount(bytes: Buffer): number | undefined {
  const pages = bytes.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0
  return pages > 0 ? pages : undefined
}

/** Copy a dropped or picked file (by path) or pasted bytes into the attachments folder. */
export async function saveAttachment(input: {
  name: string
  sourcePath?: string
  bytes?: Uint8Array
}): Promise<SavedAttachment> {
  const source = input.sourcePath ? await stat(input.sourcePath) : null
  if (source?.isDirectory()) throw new Error(`${input.name} is a folder`)
  const size = source ? source.size : (input.bytes?.byteLength ?? 0)
  if (size > MAX_ATTACHMENT_BYTES) throw new Error(`${input.name} is over the attachment limit`)
  const dir = join(attachmentsDir(), randomUUID())
  await mkdir(dir, { recursive: true })
  const path = join(dir, basename(input.name) || 'attachment')
  if (input.sourcePath) await copyFile(input.sourcePath, path)
  else await writeFile(path, input.bytes ?? new Uint8Array())
  const pages = path.toLowerCase().endsWith('.pdf') ? pdfPageCount(await readFile(path)) : undefined
  return { path, size, ...(pages ? { pages } : {}) }
}

/** Save a file a phone sent as base64. Only bytes: a phone never names a path on this machine. */
export async function uploadAttachment(input: { name: string; data: string }): Promise<SavedAttachment> {
  if (typeof input?.name !== 'string' || typeof input.data !== 'string') throw new Error('Invalid attachment')
  // base64 is 4 characters for every 3 bytes; check before decoding.
  if ((input.data.length * 3) / 4 > MAX_UPLOAD_ATTACHMENT_BYTES + 2)
    throw new Error(`${input.name} is over the ${MAX_UPLOAD_ATTACHMENT_BYTES / (1024 * 1024)} MB upload limit`)
  return saveAttachment({ name: input.name, bytes: Buffer.from(input.data, 'base64') })
}

/** Number of entries directly inside a dropped folder, or null when it is not a readable folder. */
export async function folderEntryCount(path: string): Promise<number | null> {
  try {
    return (await readdir(path)).length
  } catch (err) {
    log.warn('dropped folder not readable', err)
    return null
  }
}

/** Remove copies older than `KEEP_DAYS`. */
export async function pruneAttachments(now = Date.now()): Promise<void> {
  const root = attachmentsDir()
  const entries = await readdir(root).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') log.warn('could not list attachments', err)
    return [] as string[]
  })
  for (const entry of entries) {
    const dir = join(root, entry)
    try {
      if (now - (await stat(dir)).mtimeMs > KEEP_DAYS * 86_400_000) await rm(dir, { recursive: true, force: true })
    } catch (err) {
      log.warn('could not prune attachment', { entry, err })
    }
  }
}

function insideAttachments(path: string): boolean {
  const rel = relative(attachmentsDir(), path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

export interface PdfDocumentBlock {
  type: 'document'
  source: { type: 'base64'; media_type: 'application/pdf'; data: string }
  title: string
}

/**
 * A document block for each attached PDF the message names, when it is a copy
 * in the attachments folder, its page count is known, and it fits what is left
 * of the turn's PDF budget. Other PDFs stay as the path line only.
 * Synchronous, so two turns sent back to back reach the agent in order.
 */
export function attachedPdfBlocks(message: string): PdfDocumentBlock[] {
  const blocks: PdfDocumentBlock[] = []
  let bytesLeft = MAX_PDF_TURN_BYTES
  let pagesLeft = MAX_PDF_TURN_PAGES
  for (const { name, path } of parseAttachmentLines(message)) {
    if (!path.toLowerCase().endsWith('.pdf') || !insideAttachments(path)) continue
    try {
      if (statSync(path).size > bytesLeft) continue
      const bytes = readFileSync(path)
      const pages = pdfPageCount(bytes)
      if (pages === undefined || pages > pagesLeft) continue
      bytesLeft -= bytes.byteLength
      pagesLeft -= pages
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
        title: name,
      })
    } catch (err) {
      log.warn('attached PDF not readable, sending its path only', err)
    }
  }
  return blocks
}

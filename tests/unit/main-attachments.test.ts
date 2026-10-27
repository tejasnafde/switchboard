/**
 * Composer attachments on disk: a copy under the attachments folder, a PDF
 * document block only for a copy there, and the startup prune.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  attachedPdfBlocks,
  attachmentsDir,
  folderEntryCount,
  pruneAttachments,
  saveAttachment,
} from '../../src/main/attachments'
import { attachmentPromptLine } from '../../src/shared/attachments'

const pdf = (pages: number): Buffer =>
  Buffer.from(
    `%PDF-1.4\n${'1 0 obj << /Type /Page >> endobj\n'.repeat(pages)}2 0 obj << /Type /Pages >> endobj\n`,
    'latin1',
  )

const dirs: string[] = []
afterEach(() => {
  rmSync(attachmentsDir(), { recursive: true, force: true })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('composer attachments', () => {
  it('copies a file by path or bytes and counts PDF pages', async () => {
    const src = mkdtempSync(join(tmpdir(), 'sb-attach-src-'))
    dirs.push(src)
    writeFileSync(join(src, 'spec.pdf'), pdf(3))
    const byPath = await saveAttachment({ name: 'spec.pdf', sourcePath: join(src, 'spec.pdf') })
    expect(byPath.path.startsWith(attachmentsDir())).toBe(true)
    expect(byPath.pages).toBe(3)
    const byBytes = await saveAttachment({ name: '../escape.txt', bytes: new TextEncoder().encode('hi') })
    expect(byBytes).toMatchObject({ size: 2 })
    expect(byBytes.path.startsWith(attachmentsDir())).toBe(true)
    expect(await folderEntryCount(src)).toBe(1)
    expect(await folderEntryCount(join(src, 'missing'))).toBeNull()
  })

  it('sends a document block only for a PDF copy in the attachments folder', async () => {
    const saved = await saveAttachment({ name: 'spec.pdf', bytes: pdf(2) })
    const outside = mkdtempSync(join(tmpdir(), 'sb-attach-out-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.pdf'), pdf(1))
    const message = [
      'Read these',
      attachmentPromptLine('file', 'spec.pdf', saved.path),
      attachmentPromptLine('file', 'secret.pdf', join(outside, 'secret.pdf')),
    ].join('\n')
    const blocks = attachedPdfBlocks(message)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'document', title: 'spec.pdf', source: { media_type: 'application/pdf' } })
  })

  it('removes copies older than 30 days at startup', async () => {
    const old = await saveAttachment({ name: 'old.txt', bytes: new Uint8Array([1]) })
    const fresh = await saveAttachment({ name: 'new.txt', bytes: new Uint8Array([1]) })
    const oldDir = join(old.path, '..')
    const longAgo = new Date(Date.now() - 31 * 86_400_000)
    utimesSync(oldDir, longAgo, longAgo)
    await pruneAttachments()
    expect(existsSync(old.path)).toBe(false)
    expect(existsSync(fresh.path)).toBe(true)
  })
})

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
  uploadAttachment,
} from '../../src/main/attachments'
import {
  attachmentPromptLine,
  attachmentTurn,
  MAX_UPLOAD_ATTACHMENT_BYTES,
  nextPastedTextName,
} from '../../src/shared/attachments'

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

  it("keeps all of a turn's PDFs within one budget and skips a PDF with no readable page count", async () => {
    const big = (pages: number): Buffer => Buffer.concat([pdf(pages), Buffer.alloc(6 * 1024 * 1024)])
    const first = await saveAttachment({ name: 'a.pdf', bytes: big(2) })
    const second = await saveAttachment({ name: 'b.pdf', bytes: big(2) })
    const unknown = await saveAttachment({ name: 'c.pdf', bytes: Buffer.from('%PDF-1.7 compressed') })
    const message = [first, second, unknown]
      .map((saved, i) => attachmentPromptLine('file', `${'abc'[i]}.pdf`, saved.path))
      .join('\n')
    expect(attachedPdfBlocks(message).map((block) => block.title)).toEqual(['a.pdf'])
  })

  it('refuses a folder given as a file', async () => {
    const src = mkdtempSync(join(tmpdir(), 'sb-attach-dir-'))
    dirs.push(src)
    await expect(saveAttachment({ name: 'shots', sourcePath: src })).rejects.toThrow('is a folder')
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

describe('phone attachments', () => {
  it('saves uploaded base64 bytes and refuses one over the upload limit before decoding', async () => {
    const saved = await uploadAttachment({ name: 'log.txt', data: Buffer.from('hello').toString('base64') })
    expect(saved.path.startsWith(attachmentsDir())).toBe(true)
    expect(saved.size).toBe(5)
    const big = 'A'.repeat(Math.ceil((MAX_UPLOAD_ATTACHMENT_BYTES * 4) / 3) + 8)
    await expect(uploadAttachment({ name: 'big.bin', data: big })).rejects.toThrow('big.bin is over the 25 MB')
    await expect(uploadAttachment({ name: 'x', sourcePath: '/etc/hosts' } as never)).rejects.toThrow('Invalid')
  })

  it('builds the same turn the desktop sends: lines for the agent, tokens for the bubble', () => {
    const turn = attachmentTurn('look', [
      { id: 'a1', name: 'spec.pdf', path: '/s/spec.pdf', label: 'spec.pdf (3 pages)' },
    ])
    expect(turn.providerText).toBe(`look\n\n${attachmentPromptLine('file', 'spec.pdf', '/s/spec.pdf')}`)
    expect(turn.displayBody).toBe('look\n\n[[pill:a1]]')
    expect(turn.pillsMeta).toEqual({ a1: { label: 'spec.pdf (3 pages)', kind: 'file' } })
    expect(attachmentTurn('hi', [])).toEqual({ providerText: 'hi', displayBody: 'hi' })
    expect(attachmentTurn('', [{ id: 'b', name: 'n', path: '/p', label: 'n' }]).displayBody).toBe('[[pill:b]]')
  })

  it('numbers pasted text after the highest one attached', () => {
    expect(nextPastedTextName([])).toBe('pasted-text-1.txt')
    expect(nextPastedTextName(['pasted-text-2.txt (900 lines)', 'spec.pdf'])).toBe('pasted-text-3.txt')
  })
})

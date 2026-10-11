/**
 * `files:read-html` serves an HTML preview of a chat on another backend: only
 * .html files inside the repo, only up to the preview cap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerFilesHandlers } from '../../src/main/ipc/files'
import { FilesChannels } from '../../src/shared/ipc-channels'
import { PREVIEW_MAX_BYTES } from '../../src/shared/html-preview'

type Handler = (...args: unknown[]) => Promise<unknown>

describe('files:read-html', () => {
  let root: string
  let readHtml: Handler

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-read-html-'))
    writeFileSync(join(root, 'page.html'), '<p>ok</p>')
    writeFileSync(join(root, 'notes.txt'), 'private')
    const handlers = new Map<string, Handler>()
    registerFilesHandlers({ handle: (ch, fn) => handlers.set(ch, fn as Handler), on: () => {}, emit: () => {} })
    readHtml = handlers.get(FilesChannels.READ_HTML)!
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns the text of an .html file in the repo', async () => {
    expect(await readHtml(root, 'page.html')).toEqual({ ok: true, html: '<p>ok</p>', bytes: 9 })
  })

  it('refuses other kinds, escapes, missing and oversized files', async () => {
    expect(await readHtml(root, 'notes.txt')).toEqual({ ok: false, error: 'not-html' })
    expect(await readHtml(root, '../outside.html')).toEqual({ ok: false, error: 'failed' })
    expect(await readHtml(root, 'gone.html')).toEqual({ ok: false, error: 'not-found' })
    writeFileSync(join(root, 'big.html'), Buffer.alloc(PREVIEW_MAX_BYTES + 1, 'a'))
    expect(await readHtml(root, 'big.html')).toMatchObject({ ok: false, error: 'too-large' })
  })
})

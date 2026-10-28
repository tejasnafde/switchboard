import { describe, expect, it } from 'vitest'
import { LARGE_PASTE_BYTES, MAX_UPLOAD_ATTACHMENT_BYTES } from '../../src/shared/attachments'
import {
  base64Bytes,
  FILES_NEED_UPDATE,
  fileTooLarge,
  largePaste,
  refusalLine,
  reinsertPaste,
  routePickedFile,
  sentAttachments,
  uploadsRunning,
  utf8Base64,
  utf8Bytes,
} from '../../apps/mobile/src/lib/file-attachments'
import { buildTurn } from '../../apps/mobile/src/lib/turn-submit'

const MB = 1024 * 1024
const limitMb = Math.ceil(MAX_UPLOAD_ATTACHMENT_BYTES / MB)

describe('routePickedFile', () => {
  it('sends PNG, JPEG, WebP and GIF through the image path, by type or by extension', () => {
    expect(routePickedFile({ name: 'a.png', mimeType: 'image/png' }, true)).toEqual({
      kind: 'image',
      sourceType: 'image/png',
    })
    expect(routePickedFile({ name: 'b.JPG', mimeType: null }, false)).toEqual({
      kind: 'image',
      sourceType: 'image/jpeg',
    })
    expect(routePickedFile({ name: 'c.webp', mimeType: 'application/octet-stream' }, true).kind).toBe('image')
    expect(routePickedFile({ name: 'd.gif', mimeType: 'image/gif' }, true)).toEqual({
      kind: 'image',
      sourceType: 'image/gif',
    })
  })

  it('re-encodes a HEIC as a photo', () => {
    expect(routePickedFile({ name: 'IMG_1.HEIC', mimeType: 'image/heic' }, true)).toEqual({
      kind: 'image',
      sourceType: 'image/jpeg',
    })
    expect(routePickedFile({ name: 'IMG_2.heif' }, false)).toEqual({ kind: 'image', sourceType: 'image/jpeg' })
  })

  it('refuses other image formats with the desktop copy', () => {
    expect(routePickedFile({ name: 'scan.tiff', mimeType: 'image/tiff' }, true)).toEqual({
      kind: 'refused',
      reason: 'TIFF images are not supported. Use PNG, JPEG, WebP, GIF or HEIC.',
    })
  })

  it('uploads any other file, an SVG included', () => {
    expect(routePickedFile({ name: 'spec.pdf', mimeType: 'application/pdf', size: 1000 }, true)).toEqual({
      kind: 'file',
    })
    expect(routePickedFile({ name: 'logo.svg', mimeType: 'image/svg+xml' }, true)).toEqual({ kind: 'file' })
  })

  it('refuses a file when the backend takes images only', () => {
    expect(routePickedFile({ name: 'spec.pdf', mimeType: 'application/pdf' }, false)).toEqual({
      kind: 'refused',
      reason: FILES_NEED_UPDATE,
    })
  })

  it('refuses a file over the upload limit, naming the limit', () => {
    const route = routePickedFile({ name: 'big.zip', size: MAX_UPLOAD_ATTACHMENT_BYTES + 1 }, true)
    expect(route).toEqual({
      kind: 'refused',
      reason: `${limitMb + 1} MB is over the ${limitMb} MB file limit.`,
    })
    expect(routePickedFile({ name: 'ok.zip', size: MAX_UPLOAD_ATTACHMENT_BYTES }, true)).toEqual({ kind: 'file' })
  })
})

describe('refusals and sizes', () => {
  it('names the file and the reason on one line', () => {
    expect(refusalLine('big.zip', 'It is too big.')).toBe('big.zip was not attached: It is too big.')
  })

  it('reads the decoded size of base64', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100]) {
      expect(base64Bytes(Buffer.alloc(n, 7).toString('base64'))).toBe(n)
    }
    expect(fileTooLarge(MAX_UPLOAD_ATTACHMENT_BYTES)).toBeNull()
    expect(fileTooLarge(MAX_UPLOAD_ATTACHMENT_BYTES + 1)).toContain(`${limitMb} MB file limit`)
  })

  it('encodes text as UTF-8 base64, multi-byte characters included', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'héllo wörld', '日本語', 'emoji \u{1F600} end', 'line\nbreak']) {
      expect(utf8Base64(text)).toBe(Buffer.from(text, 'utf8').toString('base64'))
      expect(utf8Bytes(text)).toBe(Buffer.byteLength(text, 'utf8'))
    }
  })
})

describe('largePaste', () => {
  const big = 'x'.repeat(LARGE_PASTE_BYTES + 1)

  it('ignores typing and a paste at the limit', () => {
    expect(largePaste('hell', 'hello')).toBeNull()
    expect(largePaste('', 'x'.repeat(LARGE_PASTE_BYTES))).toBeNull()
  })

  it('takes out a paste over the limit, wherever the caret was', () => {
    expect(largePaste('', big)).toEqual({ inserted: big, at: 0, kept: '' })
    expect(largePaste('ab', `a${big}b`)).toEqual({ inserted: big, at: 1, kept: 'ab' })
    expect(largePaste('see: ', `see: ${big}`)).toEqual({ inserted: big, at: 5, kept: 'see: ' })
  })

  it('counts UTF-8 bytes, not characters', () => {
    const accents = 'é'.repeat(LARGE_PASTE_BYTES / 2 + 1)
    expect(largePaste('', accents)?.inserted).toBe(accents)
  })

  it('counts the growth, so replacing a large selection is not a paste', () => {
    expect(largePaste(big, `${'y'.repeat(LARGE_PASTE_BYTES + 1)}`)).toBeNull()
  })

  it('does not split a surrogate pair', () => {
    const prev = '\u{1F600}'
    const next = `\u{1F600}${big}`
    const paste = largePaste(prev, next)
    expect(paste?.kept).toBe(prev)
    expect(paste?.inserted).toBe(big)
  })

  it('puts a failed paste back where it was', () => {
    expect(reinsertPaste('ab', 1, 'XYZ')).toBe('aXYZb')
    expect(reinsertPaste('a', 5, 'XYZ')).toBe('aXYZ')
  })
})

describe('file chips', () => {
  const ready = { id: 'file-a', name: 'a.pdf', label: 'a.pdf (3 pages)', path: '/x/a.pdf' }
  const uploading = { id: 'file-b', name: 'b.txt', label: 'b.txt' }

  it('sends only uploaded files, and counts the uploads still running', () => {
    expect(sentAttachments([ready, uploading])).toEqual([
      { id: 'file-a', name: 'a.pdf', path: '/x/a.pdf', label: 'a.pdf (3 pages)' },
    ])
    expect(uploadsRunning([ready, uploading])).toBe(1)
  })

  it('carries the files on the queued turn, and none when there are none', () => {
    const base = { connectionId: 'c', threadId: 't', text: 'hi' }
    expect(buildTurn({ ...base, attachments: sentAttachments([ready]) }).queued.attachments).toHaveLength(1)
    expect(buildTurn({ ...base, attachments: [] }).queued).not.toHaveProperty('attachments')
  })
})

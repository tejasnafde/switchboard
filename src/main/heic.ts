/**
 * HEIC/HEIF (iPhone photos) to JPEG for the desktop composer: Chromium cannot
 * decode them. Uses macOS `sips`; other platforms refuse, and the composer
 * then names the image as unreadable when it sends.
 */
import { execFile } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const run = promisify(execFile)

export async function convertHeicToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  if (process.platform !== 'darwin') throw new Error('HEIC conversion needs macOS')
  const dir = await mkdtemp(join(tmpdir(), 'sb-heic-'))
  try {
    const source = join(dir, 'source.heic')
    const target = join(dir, 'target.jpg')
    await writeFile(source, bytes)
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', source, '--out', target])
    return new Uint8Array(await readFile(target))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

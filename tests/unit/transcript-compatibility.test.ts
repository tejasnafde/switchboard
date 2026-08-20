import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  compareJsonlTranscripts,
  synchronizeCompatibleTranscript,
} from '../../src/main/provider/transcript-compatibility'

const roots: string[] = []

async function fixture(source: string, target?: string): Promise<{ sourcePath: string; targetPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sb-transcript-compat-'))
  roots.push(root)
  const sourcePath = join(root, 'source.jsonl')
  const targetPath = join(root, 'target.jsonl')
  await writeFile(sourcePath, source)
  if (target !== undefined) await writeFile(targetPath, target)
  return { sourcePath, targetPath }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('compareJsonlTranscripts', () => {
  const first = '{"type":"user","text":"one"}\n'
  const second = '{"type":"assistant","text":"two"}\n'
  const third = '{"type":"user","text":"three"}\n'

  it('classifies a missing target without inventing target evidence', async () => {
    const paths = await fixture(first)

    const result = await compareJsonlTranscripts(paths.sourcePath, paths.targetPath)

    expect(result.kind).toBe('target-missing')
    expect(result.source?.recordCount).toBe(1)
    expect(result.target).toBeNull()
  })

  it('classifies byte-identical complete records as equal', async () => {
    const paths = await fixture(first + second, first + second)

    const result = await compareJsonlTranscripts(paths.sourcePath, paths.targetPath)

    expect(result.kind).toBe('equal')
    expect(result.source?.digest).toBe(result.target?.digest)
  })

  it('classifies an older target as a strict prefix of the source', async () => {
    const paths = await fixture(first + second, first)

    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({
      kind: 'target-prefix',
      source: { recordCount: 2 },
      target: { recordCount: 1 },
    })
  })

  it('classifies a more complete target as a strict superset of the source', async () => {
    const paths = await fixture(first, first + second)

    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({
      kind: 'source-prefix',
      source: { recordCount: 1 },
      target: { recordCount: 2 },
    })
  })

  it('classifies two independently extended copies as divergent', async () => {
    const paths = await fixture(first + second, first + third)

    const result = await compareJsonlTranscripts(paths.sourcePath, paths.targetPath)

    expect(result.kind).toBe('divergent')
    expect(result.firstDifferentRecord).toBe(1)
  })

  it('treats malformed JSON as unreadable instead of choosing by size', async () => {
    const paths = await fixture(first + 'not-json\n', first)

    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({
      kind: 'unreadable',
      side: 'source',
      reason: expect.stringMatching(/record 2/i),
    })
  })

  it('treats a non-newline-terminated tail as unreadable', async () => {
    const paths = await fixture(first + '{"type":"assistant"}', first)

    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({
      kind: 'unreadable',
      side: 'source',
      reason: expect.stringMatching(/incomplete trailing record/i),
    })
  })

  it('treats an unreadable target as evidence that must not be overwritten', async () => {
    const paths = await fixture(first, '{"type":"user"}')

    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({
      kind: 'unreadable',
      side: 'target',
    })
  })
})

describe('synchronizeCompatibleTranscript', () => {
  const first = '{"type":"user","text":"one"}\n'
  const second = '{"type":"assistant","text":"two"}\n'
  const third = '{"type":"user","text":"three"}\n'

  it('atomically creates a missing target and keeps the source', async () => {
    const paths = await fixture(first + second)

    const result = await synchronizeCompatibleTranscript(paths.sourcePath, paths.targetPath)

    expect(result).toMatchObject({ ok: true, copied: true, compatibility: 'target-missing' })
    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({ kind: 'equal' })
  })

  it('advances a strict target prefix', async () => {
    const paths = await fixture(first + second, first)

    await expect(synchronizeCompatibleTranscript(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({
      ok: true,
      copied: true,
      compatibility: 'target-prefix',
    })
    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({ kind: 'equal' })
  })

  it('uses a target superset without overwriting it', async () => {
    const paths = await fixture(first, first + second)

    await expect(synchronizeCompatibleTranscript(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({
      ok: true,
      copied: false,
      compatibility: 'source-prefix',
    })
    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({ kind: 'source-prefix' })
  })

  it('preserves both sides when records diverge', async () => {
    const paths = await fixture(first + second, first + third)

    await expect(synchronizeCompatibleTranscript(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({
      ok: false,
      reason: 'context-conflict',
    })
    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({ kind: 'divergent' })
  })

  it('aborts when the target changes after comparison instead of overwriting it', async () => {
    const paths = await fixture(first + second, first)

    const result = await synchronizeCompatibleTranscript(paths.sourcePath, paths.targetPath, {
      beforeReplace: () => writeFile(paths.targetPath, first + third),
    })

    expect(result).toMatchObject({ ok: false, reason: 'concurrent-modification' })
    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({ kind: 'divergent' })
  })
})

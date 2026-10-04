import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, stat, utimes, rename } from 'node:fs/promises'
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

  it('compares again when only the stopping source appends a late record', async () => {
    const paths = await fixture(first, '')
    await writeFile(paths.targetPath, '')
    let calls = 0

    const result = await synchronizeCompatibleTranscript(paths.sourcePath, paths.targetPath, {
      settle: async () => {},
      beforeReplace: async () => {
        if (calls++ === 0) await writeFile(paths.sourcePath, first + second)
      },
    })

    expect(result).toMatchObject({ ok: true, copied: true })
    expect(calls).toBe(2)
    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({ kind: 'equal' })
  })

  it('gives up after a bounded number of attempts when the source keeps changing', async () => {
    const paths = await fixture(first, '')
    let source = first
    let calls = 0

    const result = await synchronizeCompatibleTranscript(paths.sourcePath, paths.targetPath, {
      settle: async () => {},
      beforeReplace: async () => {
        calls++
        source += third
        await writeFile(paths.sourcePath, source)
      },
    })

    expect(result).toMatchObject({ ok: false, reason: 'concurrent-modification' })
    expect(calls).toBe(3)
  })

  it('aborts a retry when the target changed while the source settled', async () => {
    const paths = await fixture(first, '')
    let calls = 0

    const result = await synchronizeCompatibleTranscript(paths.sourcePath, paths.targetPath, {
      beforeReplace: async () => {
        if (calls++ === 0) await writeFile(paths.sourcePath, first + second)
      },
      settle: () => writeFile(paths.targetPath, first),
    })

    expect(result).toMatchObject({ ok: false, reason: 'concurrent-modification' })
    expect(calls).toBe(1)
    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({ kind: 'target-prefix' })
  })
})


describe('validated transcript evidence cache', () => {
  it('does not parse unchanged transcripts again', async () => {
    const paths = await fixture('{"text":"one"}\n', '{"text":"one"}\n')
    await compareJsonlTranscripts(paths.sourcePath, paths.targetPath)
    const parse = vi.spyOn(JSON, 'parse')
    try {
      await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({ kind: 'equal' })
      expect(parse).not.toHaveBeenCalled()
    } finally { parse.mockRestore() }
  })

  it.each(['append', 'truncate', 'rewrite', 'replace', 'delete'] as const)('invalidates on %s, even with restored mtime', async (change) => {
    const first = '{"text":"one"}\n'
    const paths = await fixture(first, first)
    await compareJsonlTranscripts(paths.sourcePath, paths.targetPath)
    const before = await stat(paths.targetPath)
    if (change === 'append') await writeFile(paths.targetPath, first + '{"text":"two"}\n')
    if (change === 'truncate') await writeFile(paths.targetPath, '')
    if (change === 'rewrite') await writeFile(paths.targetPath, '{"text":"two"}\n')
    if (change === 'replace') {
      await writeFile(paths.targetPath + '.new', '{"text":"two"}\n')
      await rename(paths.targetPath + '.new', paths.targetPath)
    }
    if (change === 'delete') await rm(paths.targetPath)
    else await utimes(paths.targetPath, before.atime, before.mtime)
    const expected = change === 'append' ? 'source-prefix' : change === 'truncate' ? 'target-prefix' : change === 'delete' ? 'target-missing' : 'divergent'
    await expect(compareJsonlTranscripts(paths.sourcePath, paths.targetPath)).resolves.toMatchObject({ kind: expected })
  })
})

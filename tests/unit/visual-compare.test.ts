import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkBaseline, comparePng, flattenOverBackdrop } from '../../e2e/lib/visual-compare.mjs'

function solid(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) png.data.set(rgba, i)
  return PNG.sync.write(png)
}

function paint(buffer: Buffer, pixels: number, rgba: [number, number, number, number]): Buffer {
  const png = PNG.sync.read(buffer)
  for (let i = 0; i < pixels; i++) png.data.set(rgba, i * 4)
  return PNG.sync.write(png)
}

describe('comparePng', () => {
  const base = solid(100, 100, [20, 20, 20, 255])

  it('accepts channel noise within the tolerance', () => {
    expect(comparePng(base, solid(100, 100, [32, 20, 20, 255])).ok).toBe(true)
  })

  it('fails once the changed-pixel ratio exceeds the limit and paints a diff', () => {
    const actual = paint(base, 60, [255, 255, 255, 255])
    const result = comparePng(base, actual)
    expect(result.ok).toBe(false)
    expect(result.ratio).toBeCloseTo(0.006)
    const diff = PNG.sync.read(result.diff as Buffer)
    expect([...diff.data.subarray(0, 4)]).toEqual([255, 0, 0, 255])
    expect(diff.data[60 * 4]).not.toBe(255)
  })

  it('tolerates a change under the ratio limit', () => {
    expect(comparePng(base, paint(base, 40, [255, 255, 255, 255])).ok).toBe(true)
  })

  it('reports a size change without a diff image', () => {
    const result = comparePng(base, solid(100, 101, [20, 20, 20, 255]))
    expect(result).toMatchObject({ ok: false, diff: null })
    expect(result.reason).toContain('100x101')
  })
})

describe('flattenOverBackdrop', () => {
  it('leaves opaque pixels alone and shows the backdrop through transparent ones', () => {
    const opaque = PNG.sync.read(flattenOverBackdrop(solid(4, 1, [10, 200, 30, 255])))
    expect([...opaque.data.subarray(0, 4)]).toEqual([10, 200, 30, 255])
    const clear = PNG.sync.read(flattenOverBackdrop(solid(4, 1, [255, 255, 255, 0])))
    const left = [...clear.data.subarray(0, 3)]
    const right = [...clear.data.subarray(12, 15)]
    expect(left).not.toEqual(right)
    expect(clear.data[3]).toBe(255)
  })

  it('separates a translucent surface from the same colour made opaque', () => {
    const translucent = flattenOverBackdrop(solid(4, 4, [30, 30, 30, 90]))
    const opaque = flattenOverBackdrop(solid(4, 4, [30, 30, 30, 255]))
    expect(comparePng(opaque, translucent).ok).toBe(false)
  })
})

describe('checkBaseline', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sb-visual-compare-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the baseline in update mode, then passes against it', () => {
    const shot = solid(10, 10, [1, 2, 3, 255])
    const paths = { snapshotDir: join(dir, 'snap'), artifactDir: join(dir, 'art') }
    expect(checkBaseline({ name: 'chat-dark-darwin', actual: shot, update: true, ...paths })).toBeNull()
    expect(readFileSync(join(dir, 'snap', 'chat-dark-darwin.png'))).toEqual(shot)
    expect(checkBaseline({ name: 'chat-dark-darwin', actual: shot, update: false, ...paths })).toBeNull()
    expect(existsSync(join(dir, 'art', 'chat-dark-darwin-diff.png'))).toBe(false)
  })

  it('writes the actual capture and the diff for a mismatch', () => {
    const paths = { snapshotDir: dir, artifactDir: join(dir, 'art') }
    writeFileSync(join(dir, 'sidebar-light-darwin.png'), solid(10, 10, [0, 0, 0, 255]))
    const error = checkBaseline({ name: 'sidebar-light-darwin', actual: solid(10, 10, [255, 255, 255, 255]), update: false, ...paths })
    expect(error).toMatch(/^sidebar-light-darwin: 100\.00% of pixels changed/)
    expect(existsSync(join(dir, 'art', 'sidebar-light-darwin-actual.png'))).toBe(true)
    expect(existsSync(join(dir, 'art', 'sidebar-light-darwin-diff.png'))).toBe(true)
  })

  it('names the update flag when a baseline is missing', () => {
    const error = checkBaseline({ name: 'kanban-translucent-darwin', actual: solid(2, 2, [0, 0, 0, 255]), update: false, snapshotDir: dir, artifactDir: join(dir, 'art') })
    expect(error).toContain('SB_UPDATE_SNAPSHOTS=1')
  })
})

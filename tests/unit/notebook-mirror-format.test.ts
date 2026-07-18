import { describe, it, expect } from 'vitest'
import {
  generateMirror,
  parseMirror,
  validateMirror,
  mirrorRelPathFor,
  notebookRelPathFor,
  isMirrorRelPath,
  type MirrorCell,
} from '../../src/main/notebooks/mirror-format'

/**
 * Notebook mirror format - the LLM-friendly .py representation of an .ipynb.
 * Ported from CellIQ (mirror-format.ts) with Switchboard branding.
 */

const code = (id: string, source: string): MirrorCell => ({ id, cellType: 'code', source })
const md = (id: string, source: string): MirrorCell => ({ id, cellType: 'markdown', source })

describe('generateMirror', () => {
  it('frames the header as the canonical edit surface (EDIT THIS FILE regression)', () => {
    // CellIQ regression: an earlier "DO NOT EDIT MANUALLY" header made Claude
    // bypass the mirror and reach for NotebookEdit on the raw .ipynb.
    const out = generateMirror('analysis.ipynb', [code('a', 'x = 1')])
    expect(out).toContain('EDIT THIS FILE')
    expect(out).not.toContain('DO NOT EDIT MANUALLY')
    expect(out).toContain('analysis.ipynb')
  })

  it('emits a marker line with id, type and lang per cell', () => {
    const out = generateMirror('nb.ipynb', [code('abc123', 'x = 1')])
    expect(out).toContain('# %% [cellbridge_id=abc123] [type=code] [lang=python]')
  })

  it('emits code cell source raw', () => {
    const src = 'def f(x):\n    return x * 2  # comment with # hash'
    const out = generateMirror('nb.ipynb', [code('a', src)])
    expect(out).toContain(src)
  })

  it('prefixes every markdown line with "# " and tags lang=markdown', () => {
    const out = generateMirror('nb.ipynb', [md('m1', '# Title\nbody text')])
    expect(out).toContain('# %% [cellbridge_id=m1] [type=markdown] [lang=markdown]')
    expect(out).toContain('# # Title\n# body text')
  })

  it('produces only the header for an empty notebook', () => {
    const out = generateMirror('nb.ipynb', [])
    expect(out).toContain('EDIT THIS FILE')
    expect(out).not.toContain('# %%')
  })
})

describe('parseMirror', () => {
  const roundtrip = (cells: MirrorCell[]): MirrorCell[] => parseMirror(generateMirror('nb.ipynb', cells))

  it('roundtrips code cells including hash comments and multiline source', () => {
    const cells = [
      code('a', 'import pandas as pd\ndf = pd.read_csv("x.csv")  # load'),
      code('b', 'def f(x):\n\n    return x'),
    ]
    expect(roundtrip(cells)).toEqual(cells)
  })

  it('roundtrips markdown cells, including lines that are themselves headings', () => {
    const cells = [md('m', '# Heading\n\nsome *body* text')]
    expect(roundtrip(cells)).toEqual(cells)
  })

  it('roundtrips empty cells and preserves cell order', () => {
    const cells = [code('a', ''), md('m', ''), code('b', 'x = 1')]
    expect(roundtrip(cells)).toEqual(cells)
  })

  it('defaults cellType to code when the type tag is missing', () => {
    const parsed = parseMirror('# %% [cellbridge_id=z]\nx = 1\n')
    expect(parsed).toEqual([{ id: 'z', cellType: 'code', source: 'x = 1' }])
  })

  it('ignores content before the first marker (the header)', () => {
    const parsed = parseMirror(generateMirror('nb.ipynb', [code('a', 'x = 1')]))
    expect(parsed).toHaveLength(1)
  })
})

describe('validateMirror', () => {
  const mirror = (cells: MirrorCell[]): string => generateMirror('nb.ipynb', cells)

  it('accepts an edit that preserves ids and adds new cells', () => {
    const content = mirror([code('a', 'x = 2'), code('new-cell', 'y = 3')])
    expect(validateMirror(content, ['a', 'b'])).toBeNull()
  })

  it('rejects a mirror with no cells (agent deleted everything)', () => {
    expect(validateMirror('# header only\n', ['a'])).toMatch(/no cells/i)
  })

  it('rejects duplicate cell ids', () => {
    const content = mirror([code('a', 'x'), code('a', 'y')])
    expect(validateMirror(content, ['a'])).toMatch(/duplicate/i)
  })

  it('rejects a total rewrite where no original id survives', () => {
    const content = mirror([code('fresh1', 'x'), code('fresh2', 'y')])
    expect(validateMirror(content, ['a', 'b'])).toMatch(/no original cell ids survived/i)
  })

  it('allows a total rewrite when the notebook was empty to begin with', () => {
    const content = mirror([code('fresh1', 'x')])
    expect(validateMirror(content, [])).toBeNull()
  })
})

describe('mirror path mapping', () => {
  it('maps a notebook rel path into .switchboard/notebooks preserving the tree', () => {
    expect(mirrorRelPathFor('analysis.ipynb')).toBe('.switchboard/notebooks/analysis.py')
    expect(mirrorRelPathFor('reports/q3/final_v2.ipynb')).toBe('.switchboard/notebooks/reports/q3/final_v2.py')
  })

  it('inverts a mirror rel path back to the notebook rel path', () => {
    expect(notebookRelPathFor('.switchboard/notebooks/analysis.py')).toBe('analysis.ipynb')
    expect(notebookRelPathFor('.switchboard/notebooks/reports/q3/final_v2.py')).toBe('reports/q3/final_v2.ipynb')
  })

  it('recognizes mirror paths and rejects non-mirror paths', () => {
    expect(isMirrorRelPath('.switchboard/notebooks/a.py')).toBe(true)
    expect(isMirrorRelPath('.switchboard/notebooks/x/y.py')).toBe(true)
    expect(isMirrorRelPath('src/a.py')).toBe(false)
    expect(isMirrorRelPath('.switchboard/notebooks/a.txt')).toBe(false)
    expect(notebookRelPathFor('src/a.py')).toBeNull()
  })
})

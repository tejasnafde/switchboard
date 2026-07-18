import { describe, it, expect } from 'vitest'
import { ensureCellIds, mirrorCellsOf, applyMirror, serializeNotebook } from '../../src/main/notebooks/notebook-doc'

/**
 * nbformat JSON handling for the notebook mirror sync. Fixes ported-from-CellIQ
 * bugs: prefer nbformat 4.5 native cell ids, preserve full cell metadata,
 * re-attach outputs from the live document.
 */

const nb = (cells: unknown[], minor = 5): Record<string, unknown> => ({
  cells,
  metadata: { kernelspec: { name: 'python3' } },
  nbformat: 4,
  nbformat_minor: minor,
})

describe('ensureCellIds', () => {
  it('uses the native nbformat 4.5 cell id when present', () => {
    const doc = nb([{ id: 'native-id', cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null }])
    const { doc: out, changed } = ensureCellIds(doc)
    expect(mirrorCellsOf(out)[0].id).toBe('native-id')
    expect(changed).toBe(false)
  })

  it('falls back to metadata.cellbridge_id when there is no native id (nbformat 4.4)', () => {
    const doc = nb([{ cell_type: 'code', source: ['x = 1'], metadata: { cellbridge_id: 'legacy-id' }, outputs: [], execution_count: null }], 4)
    const { doc: out, changed } = ensureCellIds(doc)
    expect(mirrorCellsOf(out)[0].id).toBe('legacy-id')
    expect(changed).toBe(false)
  })

  it('assigns a fresh native id on 4.5+ documents missing one, marking the doc changed', () => {
    const doc = nb([{ cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null }])
    const { doc: out, changed } = ensureCellIds(doc)
    const cell = (out.cells as Array<Record<string, unknown>>)[0]
    expect(typeof cell.id).toBe('string')
    expect((cell.id as string).length).toBeGreaterThan(0)
    expect(changed).toBe(true)
  })

  it('assigns metadata.cellbridge_id on pre-4.5 documents missing any id', () => {
    const doc = nb([{ cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null }], 4)
    const { doc: out, changed } = ensureCellIds(doc)
    const cell = (out.cells as Array<Record<string, unknown>>)[0]
    expect(cell.id).toBeUndefined()
    expect((cell.metadata as Record<string, unknown>).cellbridge_id).toBeTruthy()
    expect(changed).toBe(true)
  })

  it('does not mutate the input document', () => {
    const doc = nb([{ cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null }])
    ensureCellIds(doc)
    expect((doc.cells as Array<Record<string, unknown>>)[0].id).toBeUndefined()
  })
})

describe('mirrorCellsOf', () => {
  it('joins nbformat array sources into a single string', () => {
    const doc = nb([{ id: 'a', cell_type: 'code', source: ['x = 1\n', 'y = 2'], metadata: {}, outputs: [], execution_count: null }])
    expect(mirrorCellsOf(doc)[0].source).toBe('x = 1\ny = 2')
  })

  it('passes string sources through and defaults cell type to code', () => {
    const doc = nb([{ id: 'a', source: 'x = 1', metadata: {} }])
    expect(mirrorCellsOf(doc)[0]).toEqual({ id: 'a', cellType: 'code', source: 'x = 1' })
  })
})

describe('applyMirror', () => {
  const baseDoc = (): Record<string, unknown> =>
    nb([
      {
        id: 'a',
        cell_type: 'code',
        source: ['x = 1'],
        metadata: { tags: ['keep-me'], collapsed: true },
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
        execution_count: 3,
      },
      { id: 'm', cell_type: 'markdown', source: ['# Title'], metadata: { editable: false } },
      { id: 'b', cell_type: 'code', source: ['y = 2'], metadata: {}, outputs: [], execution_count: null },
    ])

  it('replaces source but preserves outputs, execution_count and FULL metadata on surviving cells', () => {
    const out = applyMirror(baseDoc(), [
      { id: 'a', cellType: 'code', source: 'x = 42' },
      { id: 'm', cellType: 'markdown', source: '# Title' },
      { id: 'b', cellType: 'code', source: 'y = 2' },
    ])
    const cells = out.cells as Array<Record<string, unknown>>
    expect(cells[0].source).toEqual(['x = 42'])
    expect(cells[0].outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: ['1\n'] }])
    expect(cells[0].execution_count).toBe(3)
    expect(cells[0].metadata).toEqual({ tags: ['keep-me'], collapsed: true })
    expect(cells[1].metadata).toEqual({ editable: false })
  })

  it('reorders cells to match the mirror order', () => {
    const out = applyMirror(baseDoc(), [
      { id: 'b', cellType: 'code', source: 'y = 2' },
      { id: 'a', cellType: 'code', source: 'x = 1' },
    ])
    const ids = (out.cells as Array<Record<string, unknown>>).map((c) => c.id)
    expect(ids).toEqual(['b', 'a'])
  })

  it('drops cells deleted from the mirror', () => {
    const out = applyMirror(baseDoc(), [{ id: 'a', cellType: 'code', source: 'x = 1' }])
    expect(out.cells as unknown[]).toHaveLength(1)
  })

  it('creates new code cells with empty outputs and a persisted id', () => {
    const out = applyMirror(baseDoc(), [
      { id: 'a', cellType: 'code', source: 'x = 1' },
      { id: 'fresh', cellType: 'code', source: 'z = 3' },
    ])
    const cell = (out.cells as Array<Record<string, unknown>>)[1]
    expect(cell.id).toBe('fresh')
    expect(cell.cell_type).toBe('code')
    expect(cell.outputs).toEqual([])
    expect(cell.execution_count).toBeNull()
  })

  it('creates new markdown cells WITHOUT outputs/execution_count keys (nbformat validity)', () => {
    const out = applyMirror(baseDoc(), [
      { id: 'a', cellType: 'code', source: 'x = 1' },
      { id: 'note', cellType: 'markdown', source: 'hello' },
    ])
    const cell = (out.cells as Array<Record<string, unknown>>)[1]
    expect(cell.cell_type).toBe('markdown')
    expect('outputs' in cell).toBe(false)
    expect('execution_count' in cell).toBe(false)
  })

  it('uses metadata.cellbridge_id for new cells on pre-4.5 documents', () => {
    const doc = nb([{ cell_type: 'code', source: ['x'], metadata: { cellbridge_id: 'a' }, outputs: [], execution_count: null }], 4)
    const out = applyMirror(doc, [
      { id: 'a', cellType: 'code', source: 'x' },
      { id: 'fresh', cellType: 'code', source: 'z' },
    ])
    const cell = (out.cells as Array<Record<string, unknown>>)[1]
    expect(cell.id).toBeUndefined()
    expect((cell.metadata as Record<string, unknown>).cellbridge_id).toBe('fresh')
  })
})

describe('serializeNotebook / source round-trip', () => {
  it('splits multiline source into nbformat line arrays with trailing newlines', () => {
    const out = applyMirror(nb([{ id: 'a', cell_type: 'code', source: [''], metadata: {}, outputs: [], execution_count: null }]), [
      { id: 'a', cellType: 'code', source: 'x = 1\ny = 2' },
    ])
    expect((out.cells as Array<Record<string, unknown>>)[0].source).toEqual(['x = 1\n', 'y = 2'])
  })

  it('serializes with a trailing newline and jupyter-style single-space indent', () => {
    const text = serializeNotebook(nb([]))
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n "cells": []')
    expect(JSON.parse(text)).toEqual(nb([]))
  })
})

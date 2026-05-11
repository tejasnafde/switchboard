/**
 * Pure routing layer: given a file path, decide which definition source
 * to ask. LSP-backed languages (.ts, .tsx, .js, .jsx, .mjs, .cjs, .py)
 * try LSP first; everything else hits the tree-sitter symbol index.
 * Falls back to tree-sitter on LSP failure.
 *
 * The actual providers are dependency-injected so we can stub them and
 * test the routing logic in isolation.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  resolveDefinition,
  type DefinitionSources,
  type ResolvedDefinition,
} from '../../src/renderer/services/definitionProvider'

const sampleLoc: ResolvedDefinition = { path: '/r/a.ts', line: 5, ch: 0 }

function makeSources(over: Partial<DefinitionSources>): DefinitionSources {
  return {
    lsp: vi.fn().mockResolvedValue([]),
    treeSitter: vi.fn().mockReturnValue([]),
    ...over,
  }
}

describe('resolveDefinition — routing', () => {
  it('routes TypeScript files to LSP first', async () => {
    const sources = makeSources({ lsp: vi.fn().mockResolvedValue([sampleLoc]) })
    const out = await resolveDefinition({
      path: '/r/a.ts',
      symbol: 'foo',
      position: { line: 0, character: 5 },
      sources,
    })
    expect(out).toEqual([sampleLoc])
    expect(sources.lsp).toHaveBeenCalledOnce()
    expect(sources.treeSitter).not.toHaveBeenCalled()
  })

  it('routes Python files to LSP first', async () => {
    const sources = makeSources({ lsp: vi.fn().mockResolvedValue([sampleLoc]) })
    await resolveDefinition({
      path: '/r/a.py',
      symbol: 'foo',
      position: { line: 0, character: 5 },
      sources,
    })
    expect(sources.lsp).toHaveBeenCalledOnce()
  })

  it('routes Rust / Go directly to tree-sitter (no LSP)', async () => {
    const sources = makeSources({ treeSitter: vi.fn().mockReturnValue([sampleLoc]) })
    const out = await resolveDefinition({
      path: '/r/a.rs',
      symbol: 'foo',
      position: { line: 0, character: 5 },
      sources,
    })
    expect(out).toEqual([sampleLoc])
    expect(sources.lsp).not.toHaveBeenCalled()
    expect(sources.treeSitter).toHaveBeenCalledOnce()
  })

  it('falls back to tree-sitter when LSP returns no results', async () => {
    const sources = makeSources({
      lsp: vi.fn().mockResolvedValue([]),
      treeSitter: vi.fn().mockReturnValue([sampleLoc]),
    })
    const out = await resolveDefinition({
      path: '/r/a.ts',
      symbol: 'foo',
      position: { line: 0, character: 5 },
      sources,
    })
    expect(out).toEqual([sampleLoc])
    expect(sources.lsp).toHaveBeenCalled()
    expect(sources.treeSitter).toHaveBeenCalled()
  })

  it('falls back to tree-sitter when LSP rejects (server unavailable)', async () => {
    const sources = makeSources({
      lsp: vi.fn().mockRejectedValue(new Error('lsp down')),
      treeSitter: vi.fn().mockReturnValue([sampleLoc]),
    })
    const out = await resolveDefinition({
      path: '/r/a.ts',
      symbol: 'foo',
      position: { line: 0, character: 5 },
      sources,
    })
    expect(out).toEqual([sampleLoc])
  })
})

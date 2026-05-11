/**
 * In-memory project-wide symbol index used by the tree-sitter
 * definition provider. Storage is two coupled maps keyed by file:
 *   - bySymbol: Map<symbol, Definition[]>  (lookup by name)
 *   - byFile:   Map<path, Definition[]>    (per-file outline + cleanup)
 *
 * The actual tree-sitter parse step that *populates* the index lives
 * in `parse.ts` (lazy WASM init) — we keep storage and parsing separate
 * so the storage layer is pure and testable without WASM.
 *
 * Re-index semantics: addDefinitions for an existing path replaces all
 * prior entries for that file. Mirrors how tree-sitter's incremental
 * model treats a file save — one parse run yields the full set of
 * top-level defs for that file.
 */
export type SymbolKind = 'function' | 'class' | 'method' | 'variable' | 'type' | 'interface'

export interface SymbolRef {
  name: string
  kind: SymbolKind
  line: number
  ch: number
}

export interface Definition extends SymbolRef {
  path: string
}

const bySymbol = new Map<string, Definition[]>()
const byFile = new Map<string, Definition[]>()

export function addDefinitions(path: string, refs: ReadonlyArray<SymbolRef>): void {
  removeFile(path) // replace prior set
  const defs: Definition[] = refs.map((r) => ({ ...r, path }))
  byFile.set(path, defs)
  for (const d of defs) {
    const existing = bySymbol.get(d.name)
    if (existing) existing.push(d)
    else bySymbol.set(d.name, [d])
  }
}

export function removeFile(path: string): void {
  const old = byFile.get(path)
  if (!old) return
  for (const d of old) {
    const list = bySymbol.get(d.name)
    if (!list) continue
    const next = list.filter((x) => x.path !== path)
    if (next.length === 0) bySymbol.delete(d.name)
    else bySymbol.set(d.name, next)
  }
  byFile.delete(path)
}

export function findDefinitions(symbol: string): Definition[] {
  return bySymbol.get(symbol)?.slice() ?? []
}

export function outline(path: string): Definition[] {
  const defs = byFile.get(path) ?? []
  return defs.slice().sort((a, b) => a.line - b.line || a.ch - b.ch)
}

export function resetSymbolIndex(): void {
  bySymbol.clear()
  byFile.clear()
}

/**
 * Routes "go to definition" lookups between LSP and tree-sitter. The
 * choice is driven by file extension: TS/JS/Python files hit LSP
 * first (full type-aware fidelity), other languages fall straight
 * through to tree-sitter (which is symbol-name-based, ~80% accurate).
 *
 * Resilience: LSP rejection or empty result → tree-sitter fallback.
 * That way a not-yet-warm LSP server, or a query in a part of the file
 * the LSP can't resolve (e.g. inside a string literal), still gets the
 * user *somewhere* useful instead of a silent dead end.
 *
 * The two sources are passed in by the caller (DI) so the routing is
 * pure-testable without spinning up real LSPs or tree-sitter WASM.
 */
import { findDefinitions } from './symbolIndex'

export interface ResolvedDefinition {
  path: string
  line: number
  ch: number
}

export interface DefinitionSources {
  /** LSP textDocument/definition. Caller knows how to project the result. */
  lsp: (args: {
    path: string
    symbol: string
    position: { line: number; character: number }
  }) => Promise<ResolvedDefinition[]>
  /** Tree-sitter symbol-index lookup, synchronous. */
  treeSitter: (args: { symbol: string }) => ResolvedDefinition[]
}

export interface ResolveArgs {
  path: string
  symbol: string
  position: { line: number; character: number }
  sources: DefinitionSources
}

const LSP_BACKED_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i

export async function resolveDefinition(args: ResolveArgs): Promise<ResolvedDefinition[]> {
  if (LSP_BACKED_RE.test(args.path)) {
    try {
      const results = await args.sources.lsp({
        path: args.path,
        symbol: args.symbol,
        position: args.position,
      })
      if (results.length > 0) return results
    } catch {
      /* fall through to tree-sitter */
    }
  }
  return args.sources.treeSitter({ symbol: args.symbol })
}

/**
 * Default tree-sitter source: queries the renderer-side symbol index
 * directly. The pure-tested routing layer is invoked through this when
 * components don't supply their own.
 */
export const defaultTreeSitterSource: DefinitionSources['treeSitter'] = ({ symbol }) =>
  findDefinitions(symbol).map((d) => ({ path: d.path, line: d.line, ch: d.ch }))

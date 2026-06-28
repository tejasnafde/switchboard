/**
 * IPC bridge for the LSP subsystem. Each handler:
 *   1. Resolves the LSP language for the file (returns null silently
 *      for unsupported languages — caller falls back to tree-sitter).
 *   2. Forwards to the per-workspace server via `lsp/manager.ts`.
 *   3. Returns a discriminated `{ ok, ... } | { ok: false, error }`.
 *
 * The renderer-side façade (`renderer/services/lspClient.ts`) owns
 * document lifecycle (didOpen on tab-open, debounced didChange, didClose
 * on tab-close).
 */
import type { BackendHost } from '../backend/host'
import { pathToFileURL } from 'node:url'
import { LspChannels } from '@shared/ipc-channels'
import {
  languageForPath,
  lspNotify,
  lspRequest,
  type LspLanguage,
} from '../lsp/manager'
import { createMainLogger } from '../logger'

const log = createMainLogger('ipc:lsp')

interface OpenArgs {
  workspaceRoot: string
  absPath: string
  text: string
  version: number
  languageId: string
}

interface ChangeArgs {
  workspaceRoot: string
  absPath: string
  text: string
  version: number
}

interface CloseArgs {
  workspaceRoot: string
  absPath: string
}

interface QueryArgs {
  workspaceRoot: string
  absPath: string
  position: { line: number; character: number }
}

function resolveLang(absPath: string): LspLanguage | null {
  return languageForPath(absPath)
}

export function registerLspHandlers(host: BackendHost): void {
  host.handle(LspChannels.OPEN, async (args: OpenArgs) => {
    const lang = resolveLang(args.absPath)
    if (!lang) return { ok: true, supported: false }
    try {
      lspNotify(lang, args.workspaceRoot, 'textDocument/didOpen', {
        textDocument: {
          uri: pathToFileURL(args.absPath).toString(),
          languageId: args.languageId,
          version: args.version,
          text: args.text,
        },
      })
      return { ok: true, supported: true }
    } catch (err) {
      log.warn(`lsp:open failed: ${(err as Error).message}`)
      return { ok: false, error: (err as Error).message }
    }
  })

  host.handle(LspChannels.CHANGE, async (args: ChangeArgs) => {
    const lang = resolveLang(args.absPath)
    if (!lang) return { ok: true, supported: false }
    try {
      lspNotify(lang, args.workspaceRoot, 'textDocument/didChange', {
        textDocument: {
          uri: pathToFileURL(args.absPath).toString(),
          version: args.version,
        },
        contentChanges: [{ text: args.text }],
      })
      return { ok: true, supported: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  host.handle(LspChannels.CLOSE, async (args: CloseArgs) => {
    const lang = resolveLang(args.absPath)
    if (!lang) return { ok: true, supported: false }
    try {
      lspNotify(lang, args.workspaceRoot, 'textDocument/didClose', {
        textDocument: { uri: pathToFileURL(args.absPath).toString() },
      })
      return { ok: true, supported: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  host.handle(LspChannels.DEFINITION, async (args: QueryArgs) => {
    const lang = resolveLang(args.absPath)
    if (!lang) return { ok: true, supported: false, locations: [] }
    try {
      const result = await lspRequest(lang, args.workspaceRoot, 'textDocument/definition', {
        textDocument: { uri: pathToFileURL(args.absPath).toString() },
        position: args.position,
      })
      // LSP definition can be Location | Location[] | null
      const locations = result === null || result === undefined
        ? []
        : Array.isArray(result) ? result : [result]
      return { ok: true, supported: true, locations }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  host.handle(LspChannels.REFERENCES, async (args: QueryArgs) => {
    const lang = resolveLang(args.absPath)
    if (!lang) return { ok: true, supported: false, locations: [] }
    try {
      const result = await lspRequest(lang, args.workspaceRoot, 'textDocument/references', {
        textDocument: { uri: pathToFileURL(args.absPath).toString() },
        position: args.position,
        context: { includeDeclaration: true },
      })
      const locations = Array.isArray(result) ? result : []
      return { ok: true, supported: true, locations }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  host.handle(LspChannels.HOVER, async (args: QueryArgs) => {
    const lang = resolveLang(args.absPath)
    if (!lang) return { ok: true, supported: false, hover: null }
    try {
      const hover = await lspRequest(lang, args.workspaceRoot, 'textDocument/hover', {
        textDocument: { uri: pathToFileURL(args.absPath).toString() },
        position: args.position,
      })
      return { ok: true, supported: true, hover }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  host.handle(LspChannels.DOCUMENT_SYMBOLS, async (args: { workspaceRoot: string; absPath: string }) => {
    const lang = resolveLang(args.absPath)
    if (!lang) return { ok: true, supported: false, symbols: [] }
    try {
      const symbols = await lspRequest(lang, args.workspaceRoot, 'textDocument/documentSymbol', {
        textDocument: { uri: pathToFileURL(args.absPath).toString() },
      })
      return { ok: true, supported: true, symbols: Array.isArray(symbols) ? symbols : [] }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}

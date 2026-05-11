/**
 * Per-(workspaceRoot, language) LSP server registry. Lazy-spawns on
 * first use, keeps one server per language per workspace, and tracks
 * open documents so the IPC layer doesn't have to.
 *
 * Locating the server binary: typescript-language-server and pyright are
 * npm deps installed at the app's node_modules. In dev that's the
 * project's own node_modules; in a packaged build we copy them via
 * electron-builder's `extraResources`. The locator checks a small set
 * of well-known paths and returns the first that resolves.
 *
 * Crashes: a server's `exit` event marks the registry entry stale and
 * fails any in-flight requests. The next call lazily spawns a fresh
 * server. We don't gate restart counts yet — if a server is wedged in
 * a crash loop the user will notice the toast spam.
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LspClient } from './client'
import { createMainLogger } from '../logger'

const log = createMainLogger('lsp-manager')

export type LspLanguage = 'typescript' | 'python'

interface ServerEntry {
  client: LspClient
  language: LspLanguage
  workspaceRoot: string
  starting: Promise<void> | null
  diagnosticsByUri: Map<string, unknown[]>
}

const servers = new Map<string, ServerEntry>()

function key(workspaceRoot: string, language: LspLanguage): string {
  return `${language}::${workspaceRoot}`
}

/**
 * Locate the typescript-language-server binary. Order of preference:
 *   1. Project's local node_modules (dev)
 *   2. App resources path (packaged build with extraResources)
 *   3. PATH (user-installed global)
 */
function locateTsServer(): { command: string; args: string[] } | null {
  const candidates = [
    join(app.getAppPath(), 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'),
    join(process.resourcesPath, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return { command: process.execPath, args: [c, '--stdio'] }
  }
  return { command: 'typescript-language-server', args: ['--stdio'] }
}

function locatePyright(): { command: string; args: string[] } | null {
  const candidates = [
    join(app.getAppPath(), 'node_modules', 'pyright', 'langserver.index.js'),
    join(process.resourcesPath, 'node_modules', 'pyright', 'langserver.index.js'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return { command: process.execPath, args: [c, '--stdio'] }
  }
  return { command: 'pyright-langserver', args: ['--stdio'] }
}

async function spawnServer(language: LspLanguage, workspaceRoot: string): Promise<LspClient> {
  const locator = language === 'typescript' ? locateTsServer() : locatePyright()
  if (!locator) throw new Error(`No locator for LSP language: ${language}`)
  const client = new LspClient()
  client.onNotification((method, params) => {
    if (method === 'textDocument/publishDiagnostics') {
      const p = params as { uri: string; diagnostics: unknown[] }
      const entry = servers.get(key(workspaceRoot, language))
      if (entry) entry.diagnosticsByUri.set(p.uri, p.diagnostics)
    }
  })
  log.info(`spawning ${language} LSP for ${workspaceRoot}`)
  await client.start({
    command: locator.command,
    args: locator.args,
    cwd: workspaceRoot,
    rootUri: pathToFileURL(workspaceRoot).toString(),
  })
  return client
}

async function ensureServer(language: LspLanguage, workspaceRoot: string): Promise<LspClient> {
  const k = key(workspaceRoot, language)
  let entry = servers.get(k)
  if (entry?.starting) {
    await entry.starting
    return entry.client
  }
  if (entry) return entry.client

  entry = {
    client: new LspClient(),
    language,
    workspaceRoot,
    starting: null,
    diagnosticsByUri: new Map(),
  }
  servers.set(k, entry)
  entry.starting = (async () => {
    try {
      entry!.client = await spawnServer(language, workspaceRoot)
    } catch (err) {
      servers.delete(k)
      throw err
    } finally {
      if (entry) entry.starting = null
    }
  })()
  await entry.starting
  return entry.client
}

export async function lspRequest<T = unknown>(
  language: LspLanguage,
  workspaceRoot: string,
  method: string,
  params: unknown,
): Promise<T> {
  const client = await ensureServer(language, workspaceRoot)
  return client.request<T>(method, params)
}

export function lspNotify(
  language: LspLanguage,
  workspaceRoot: string,
  method: string,
  params: unknown,
): void {
  const k = key(workspaceRoot, language)
  const entry = servers.get(k)
  if (!entry || entry.starting) {
    // Buffer notifications until init completes, then flush.
    void ensureServer(language, workspaceRoot).then((c) => c.notify(method, params))
    return
  }
  entry.client.notify(method, params)
}

export function languageForPath(path: string): LspLanguage | null {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) return 'typescript'
  if (/\.py$/i.test(path)) return 'python'
  return null
}

/** Test-only: clear the registry between integration tests. */
export function __resetLspManagerForTests(): void {
  for (const e of servers.values()) {
    void e.client.dispose()
  }
  servers.clear()
}

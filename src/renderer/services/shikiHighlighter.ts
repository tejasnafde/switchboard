/**
 * Module-level singleton for Shiki — same pattern as `terminal-registry.ts`.
 *
 * Why: Shiki cold-start (WASM init + grammar load) is 50–200 ms. Mounting
 * a fresh FileViewerPane with a per-instance highlighter means every file
 * click pays that cost. With a singleton, the renderer pays it once per
 * session and every viewer mount reuses the same highlighter.
 *
 * Concurrency: first call starts the in-flight Promise; subsequent calls
 * before resolution receive the same Promise. After resolution, all calls
 * resolve to the cached instance.
 *
 * Languages are loaded eagerly for the bundle we ship; per-language lazy
 * loading is a possible future optimization but the perf budget passes
 * without it for the languages we care about (ts/tsx/py/rs/go/json/md).
 */
import type { Highlighter } from 'shiki'

type HighlighterFactory = () => Promise<Highlighter>

const DEFAULT_LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'python',
  'rust',
  'go',
  'bash',
  'json',
  'yaml',
  'markdown',
  'css',
  'html',
]

const DEFAULT_THEMES = ['github-dark', 'github-light']

let cached: Highlighter | null = null
let pending: Promise<Highlighter> | null = null

let factory: HighlighterFactory = async () => {
  // Lazy import so test stubs can pre-empt before shiki loads.
  const shiki = await import('shiki')
  return shiki.createHighlighter({
    themes: DEFAULT_THEMES,
    langs: DEFAULT_LANGS,
  })
}

export async function getHighlighter(): Promise<Highlighter> {
  if (cached) return cached
  if (!pending) {
    pending = factory().then((h) => {
      cached = h
      return h
    })
  }
  return pending
}

/* ─── Test seams ─── */

export function __setShikiFactoryForTests(f: HighlighterFactory): void {
  factory = f
}

export function __resetShikiSingletonForTests(): void {
  cached = null
  pending = null
  factory = async () => {
    const shiki = await import('shiki')
    return shiki.createHighlighter({ themes: DEFAULT_THEMES, langs: DEFAULT_LANGS })
  }
}

/**
 * Path → CM6 language pack mapping. Two layers:
 *
 *   - `languageIdForPath(path)`: pure ext lookup, returns a stable id
 *     ('typescript' | 'python' | ...) or null. Unit-tested.
 *   - `loadLanguageExtension(id)`: dynamic import of the corresponding
 *     `@codemirror/lang-*` package, returning a CM6 `Extension`. Lazy so
 *     the editor's cold path is just the cores; per-language wasm/grammar
 *     loads on first open of that file type.
 */
import type { Extension } from '@codemirror/state'

export type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'json'
  | 'yaml'
  | 'markdown'
  | 'css'
  | 'html'

const EXT_TO_LANG: Readonly<Record<string, LanguageId>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  scss: 'css',
  html: 'html',
  htm: 'html',
}

export function languageIdForPath(path: string): LanguageId | null {
  if (!path) return null
  // Walk back to the last `.` after the last separator. Avoids matching
  // a `.` in a parent dir name (e.g. `~/.config/foo.txt`).
  const sepIdx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const filename = sepIdx >= 0 ? path.slice(sepIdx + 1) : path
  const dotIdx = filename.lastIndexOf('.')
  if (dotIdx <= 0) return null
  const ext = filename.slice(dotIdx + 1).toLowerCase()
  return EXT_TO_LANG[ext] ?? null
}

/**
 * Returns a CM6 LanguageSupport extension for the given language, or
 * undefined for plaintext / unsupported. Dynamic-imports the lang pack
 * on first call per language; subsequent calls hit the import cache.
 *
 * The TS pack handles tsx via a config flag; the JS pack handles jsx.
 */
export async function loadLanguageExtension(id: LanguageId | null): Promise<Extension | undefined> {
  if (!id) return undefined
  switch (id) {
    case 'typescript': {
      const m = await import('@codemirror/lang-javascript')
      return m.javascript({ typescript: true, jsx: true })
    }
    case 'javascript': {
      const m = await import('@codemirror/lang-javascript')
      return m.javascript({ jsx: true })
    }
    case 'python':   return (await import('@codemirror/lang-python')).python()
    case 'rust':     return (await import('@codemirror/lang-rust')).rust()
    case 'go':       return (await import('@codemirror/lang-go')).go()
    case 'json':     return (await import('@codemirror/lang-json')).json()
    case 'yaml':     return (await import('@codemirror/lang-yaml')).yaml()
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown()
    case 'css':      return (await import('@codemirror/lang-css')).css()
    case 'html':     return (await import('@codemirror/lang-html')).html()
  }
}

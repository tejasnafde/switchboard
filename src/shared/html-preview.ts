/**
 * HTML preview rules shared by the desktop main process (the sandboxed preview
 * session) and the renderer (file chips, the preview pane). Pure: no fs, no
 * Electron.
 */

/** Custom scheme the preview session serves documents and their assets from. */
export const PREVIEW_SCHEME = 'sb-preview'

/** Session partition of the one preview webview. Not `persist:`, so nothing
 *  the page stores (localStorage, cookies, cache) outlives the app. */
export const PREVIEW_PARTITION = 'sb-html-preview'

/** Largest document the preview loads, local or read through a remote backend. */
export const PREVIEW_MAX_BYTES = 5 * 1024 * 1024

export function isHtmlPreviewPath(path: string): boolean {
  return /\.html?$/i.test(path.trim())
}

/** `design/pricing.html` -> `{ name: 'pricing.html', dir: 'design/' }`. */
export function splitPreviewPath(path: string): { name: string; dir: string } {
  const normalized = path.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  if (slash < 0) return { name: normalized, dir: '' }
  return { name: normalized.slice(slash + 1), dir: normalized.slice(0, slash + 1) }
}

export function formatPreviewBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** URL of a preview document: `sb-preview://<token>/<encoded file name>`. */
export function previewDocumentUrl(token: string, fileName: string): string {
  return `${PREVIEW_SCHEME}://${token}/${encodeURIComponent(fileName)}`
}

export type PreviewRequestVerdict = 'allow' | 'block'

/**
 * Network policy of the preview session. Only the current document's own
 * origin (`sb-preview://<token>`) and inline data (`data:`, `blob:`,
 * `about:blank`) pass; every http(s), ws(s), file and stale-token request is
 * blocked.
 */
export function previewRequestVerdict(url: string, currentToken: string | null): PreviewRequestVerdict {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'block'
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return 'allow'
  if (url === 'about:blank') return 'allow'
  if (parsed.protocol === `${PREVIEW_SCHEME}:`) {
    return currentToken !== null && parsed.hostname === currentToken.toLowerCase() ? 'allow' : 'block'
  }
  return 'block'
}

/**
 * Top-level navigation policy: the page may reload itself (or move within its
 * own hash), never leave the file.
 */
export function previewNavigationAllowed(url: string, documentUrl: string | null): boolean {
  if (!documentUrl) return false
  const strip = (u: string): string => u.split('#')[0]
  return strip(url) === strip(documentUrl)
}

/**
 * The path inside the document folder a preview URL asks for, or null when it
 * is not a relative path below the folder (`..`, absolute, backslash or NUL
 * tricks). The caller still realpaths the result to catch symlinks.
 */
export function previewAssetRelativePath(pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const parts = decoded.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0 || parts.some((part) => part === '..')) return null
  return parts.join('/')
}

/** A blocked request as the toolbar and console show it: host and path, no scheme. */
export function blockedRequestLabel(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol.startsWith('ws')) {
      const label = `${parsed.host}${parsed.pathname}${parsed.search}`
      return label.length > 120 ? `${label.slice(0, 117)}...` : label
    }
    return url.length > 120 ? `${url.slice(0, 117)}...` : url
  } catch {
    return url.slice(0, 120)
  }
}

export type PreviewOpenRequest =
  /** A file on this desktop: served with the files in its folder. */
  | { kind: 'file'; filePath: string }
  /** A document read through a remote backend: served alone, never by path. */
  | { kind: 'content'; fileName: string; html: string }

export type PreviewOpenResult =
  | { ok: true; url: string; token: string; bytes: number }
  | { ok: false; error: 'not-found' | 'too-large' | 'not-html' | 'failed'; bytes?: number; message?: string }

/** Pushed from main on `PreviewChannels.EVENT`. */
export type PreviewEvent =
  | { type: 'changed'; token: string }
  | { type: 'missing'; token: string }
  | { type: 'blocked'; token: string; url: string }

export type PreviewTheme = 'app' | 'light' | 'dark'

/** Fixed page widths of the width menu; null fits the pane. */
export const PREVIEW_WIDTHS: ReadonlyArray<{ width: number | null; label: string; hint?: string }> = [
  { width: null, label: 'Fit pane' },
  { width: 390, label: '390', hint: 'Phone' },
  { width: 768, label: '768', hint: 'Tablet' },
  { width: 1280, label: '1280', hint: 'Desktop' },
]

/** The page's `prefers-color-scheme` for a toolbar theme choice. */
export function resolvePreviewColorScheme(theme: PreviewTheme, appTheme: string): 'light' | 'dark' {
  if (theme !== 'app') return theme
  return appTheme === 'light' ? 'light' : 'dark'
}

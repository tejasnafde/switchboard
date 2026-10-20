/**
 * Inline live pages: a fenced ```html-live block in an agent message that the
 * desktop runs in the HTML preview's sandbox, inside the message.
 *
 *   ```html-live title="p95 latency, Mon to Wed"
 *   <script src="/_sb/chart.js"></script>
 *   <canvas id="c"></canvas>
 *   <script>...data inline, no fetch...</script>
 *   ```
 *
 * Pure rules shared by main (serving and the cap), the desktop renderer (the
 * frame) and the phones (which never run the page: they show the still image
 * the desktop stored under `htmlLiveImageKey`). No fs, no Electron, no DOM.
 */

export const HTML_LIVE_FENCE = 'html-live'

/** Largest block that runs. Libraries are loaded from /_sb/, not pasted. */
export const HTML_LIVE_MAX_BYTES = 128 * 1024
export const HTML_LIVE_MIN_HEIGHT = 120
export const HTML_LIVE_MAX_HEIGHT = 480
/** "Show all" still stops here, so a page that grows forever cannot. */
export const HTML_LIVE_EXPANDED_MAX_HEIGHT = 4000
/** Running frames per window; the rest pause as a still image (RAM policy). */
export const HTML_LIVE_MAX_RUNNING = 2
/** Quiet time (no layout change) after load before the still image is taken. */
export const HTML_LIVE_QUIET_MS = 1000
/** Largest still image a backend stores, as a data URL. */
export const HTML_LIVE_MAX_IMAGE_CHARS = 4 * 1024 * 1024
/** The size reporter logs this prefix and the page height. */
export const HTML_LIVE_HEIGHT_MARKER = '__sb_live_height__:'
/** Backend capability: `HtmlLiveChannels.LOAD` / `UPDATE` / `OPEN_ON_DESKTOP`. */
export const HTML_LIVE_CAPABILITY = 'html_live_images_v1'

/** Document path inside the page's origin. */
export const HTML_LIVE_DOCUMENT_NAME = 'index.html'
/** Path prefix of the bundled libraries. */
export const HTML_LIVE_LIBRARY_PREFIX = '/_sb/'

/** The libraries a page may load, by path below /_sb/. */
export const HTML_LIVE_LIBRARIES: ReadonlyArray<{ path: string; label: string }> = [
  { path: 'chart.js', label: 'Chart.js' },
  { path: 'd3.js', label: 'D3' },
  { path: 'three.js', label: 'Three.js' },
  { path: 'three/addons/controls/OrbitControls.js', label: 'Three.js' },
  { path: 'mermaid.js', label: 'Mermaid' },
]

const LIBRARY_PATHS = new Set(HTML_LIVE_LIBRARIES.map((lib) => lib.path))

export function isHtmlLiveLibrary(path: string): boolean {
  return LIBRARY_PATHS.has(path)
}

/** `html-live title="Chart"` -> `{ title: 'Chart' }`; null when the info string is another language. */
export function parseHtmlLiveInfo(info: string): { title: string | null } | null {
  const trimmed = info.trim()
  const word = trimmed.split(/\s+/)[0]?.toLowerCase()
  if (word !== HTML_LIVE_FENCE) return null
  const match = /\btitle=(?:"([^"]*)"|'([^']*)')/.exec(trimmed)
  const title = (match?.[1] ?? match?.[2] ?? '').trim().slice(0, 120)
  return { title: title || null }
}

/** Every /_sb/ path the page names, plus the `three` import map names, in order, once each. */
export function htmlLiveLibraryRefs(source: string): string[] {
  const refs: string[] = []
  const add = (path: string): void => {
    if (!refs.includes(path)) refs.push(path)
  }
  for (const m of source.matchAll(/\/_sb\/([A-Za-z0-9._/-]*)/g)) add(m[1])
  for (const m of source.matchAll(/\bfrom\s*['"](three(?:\/addons\/[A-Za-z0-9._/-]+)?)['"]/g)) {
    add(m[1] === 'three' ? 'three.js' : m[1])
  }
  return refs
}

export type HtmlLiveVerdict =
  | { ok: true; libraries: string[] }
  | { ok: false; reason: 'too-large'; bytes: number }
  | { ok: false; reason: 'unknown-library'; names: string[] }

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Whether a block runs: the cap, then the library list. `libraries` are header labels. */
export function htmlLiveVerdict(source: string): HtmlLiveVerdict {
  const bytes = utf8Bytes(source)
  if (bytes > HTML_LIVE_MAX_BYTES) return { ok: false, reason: 'too-large', bytes }
  const refs = htmlLiveLibraryRefs(source)
  const unknown = refs.filter((path) => !LIBRARY_PATHS.has(path))
  if (unknown.length > 0) return { ok: false, reason: 'unknown-library', names: unknown }
  const labels: string[] = []
  for (const path of refs) {
    const label = HTML_LIVE_LIBRARIES.find((lib) => lib.path === path)!.label
    if (!labels.includes(label)) labels.push(label)
  }
  return { ok: true, libraries: labels }
}

/** The message a rejected block shows instead of running. */
export function htmlLiveRejection(verdict: Exclude<HtmlLiveVerdict, { ok: true }>): string {
  if (verdict.reason === 'too-large') {
    const kb = Math.ceil(verdict.bytes / 1024)
    return `This page was not run: it is ${kb} KB and inline pages are capped at ${HTML_LIVE_MAX_BYTES / 1024} KB. Ask the agent to write it as a file instead; files open in the preview pane up to 5 MB.`
  }
  const names = verdict.names.map((name) => `/_sb/${name}`).join(', ')
  const known = HTML_LIVE_LIBRARIES.map((lib) => `/_sb/${lib.path}`).join(', ')
  return `This page was not run: it loads ${names}, which the app does not ship. The libraries are ${known}.`
}

/** Under a blocked list: points at the bundled copy when a blocked URL names a library. */
export function htmlLiveBlockedHint(blocked: readonly string[]): string {
  const lower = blocked.map((url) => url.toLowerCase())
  const lib = HTML_LIVE_LIBRARIES.find(
    (l) => !l.path.includes('/') && lower.some((u) => u.includes(l.path.slice(0, -3))),
  )
  return lib
    ? `No network here. ${lib.label} is bundled as /_sb/${lib.path}; data must be inline.`
    : 'No network here. Data must be inline.'
}

/** Frame height for a reported content height. */
export function htmlLiveFrameHeight(contentHeight: number, expanded: boolean): number {
  const height = Number.isFinite(contentHeight) ? Math.ceil(contentHeight) : 0
  const max = expanded ? HTML_LIVE_EXPANDED_MAX_HEIGHT : HTML_LIVE_MAX_HEIGHT
  return Math.min(max, Math.max(HTML_LIVE_MIN_HEIGHT, height))
}

/** The page is taller than the folded frame, so "Show all" is offered. */
export function htmlLiveFolds(contentHeight: number): boolean {
  return contentHeight > HTML_LIVE_MAX_HEIGHT
}

/** The height a log line from the size reporter carries, or null. */
export function htmlLiveHeightFromConsole(message: string): number | null {
  if (!message.startsWith(HTML_LIVE_HEIGHT_MARKER)) return null
  const n = Number(message.slice(HTML_LIVE_HEIGHT_MARKER.length))
  return Number.isFinite(n) && n >= 0 ? n : null
}

export interface HtmlLiveFrameClaim {
  id: string
  /** In view, not shown in the pane, not rejected. */
  wants: boolean
  /** When it last came into view or the user pressed Run; the newest win. */
  since: number
}

/**
 * Which frames run: of those that want to, the `limit` most recent. A frame
 * scrolled to or started with Run displaces the one that has run longest.
 */
export function pickRunningFrames(frames: readonly HtmlLiveFrameClaim[], limit = HTML_LIVE_MAX_RUNNING): Set<string> {
  return new Set(
    frames
      .filter((frame) => frame.wants)
      .sort((a, b) => b.since - a.since || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((frame) => frame.id),
  )
}

/** Theme the page gets as --sb-* variables and `data-sb-theme`. */
export interface HtmlLiveTheme {
  scheme: 'light' | 'dark'
  bg: string
  surface: string
  text: string
  muted: string
  border: string
  accent: string
  success: string
  warning: string
  error: string
  font: string
  mono: string
}

const THEME_VARS: ReadonlyArray<[keyof HtmlLiveTheme, string]> = [
  ['bg', '--sb-bg'],
  ['surface', '--sb-surface'],
  ['text', '--sb-text'],
  ['muted', '--sb-muted'],
  ['border', '--sb-border'],
  ['accent', '--sb-accent'],
  ['success', '--sb-success'],
  ['warning', '--sb-warning'],
  ['error', '--sb-error'],
  ['font', '--sb-font'],
  ['mono', '--sb-mono'],
]

/** A CSS value that cannot close the style block or the declaration. */
function safeCssValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v && v.length <= 200 && !/[<>;{}\\]/.test(v) ? v : null
}

const SIZE_REPORTER = `(() => {
  let last = -1
  const post = () => {
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height)
    if (h !== last) { last = h; console.info('${HTML_LIVE_HEIGHT_MARKER}' + h) }
  }
  addEventListener('DOMContentLoaded', post)
  addEventListener('load', () => { post(); new ResizeObserver(post).observe(document.documentElement) })
})()`

const IMPORT_MAP = JSON.stringify({ imports: { three: '/_sb/three.js', 'three/addons/': '/_sb/three/addons/' } })

/** What the frame injects at the top of `<head>`: theme, import map, size reporter. */
export function htmlLiveHead(theme: HtmlLiveTheme): string {
  const scheme = theme.scheme === 'light' ? 'light' : 'dark'
  const vars = THEME_VARS.map(([key, name]) => {
    const value = safeCssValue(theme[key])
    return value ? `${name}:${value};` : ''
  }).join('')
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>:root{${vars}color-scheme:${scheme}}html,body{margin:0;background:var(--sb-bg);color:var(--sb-text);font:13px/1.45 var(--sb-font,sans-serif)}body{padding:10px}</style>`,
    `<script type="importmap">${IMPORT_MAP}</script>`,
    `<script>document.documentElement.dataset.sbTheme='${scheme}';${SIZE_REPORTER}</script>`,
  ].join('')
}

/**
 * The document a frame loads. A fragment is wrapped in a page; a full
 * document gets the same head pieces first in its `<head>` (the import map
 * must come before any module script).
 */
export function htmlLiveDocument(source: string, theme: HtmlLiveTheme): string {
  const head = htmlLiveHead(theme)
  const scheme = theme.scheme === 'light' ? 'light' : 'dark'
  const headTag = /<head\b[^>]*>/i.exec(source)
  if (headTag) {
    const at = headTag.index + headTag[0].length
    return source.slice(0, at) + head + source.slice(at)
  }
  const htmlTag = /<html\b[^>]*>/i.exec(source)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return `${source.slice(0, at)}<head>${head}</head>${source.slice(at)}`
  }
  return `<!doctype html><html data-sb-theme="${scheme}"><head>${head}</head><body>${source}</body></html>`
}

/** `p95 latency, Mon to Wed` -> `p95-latency-mon-to-wed.html`. */
export function htmlLiveFileName(title: string | null, taken: (name: string) => boolean = () => false): string {
  const slug =
    (title ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'live-page'
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${slug}.html` : `${slug}-${n}.html`
    if (!taken(name)) return name
  }
  return `${slug}-${Date.now()}.html`
}

/** Key a still image is stored under: hex SHA-256 of the block source's UTF-8. */
export function isHtmlLiveImageKey(key: unknown): key is string {
  return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key)
}

/** A still image a backend accepts: a PNG or JPEG data URL under the cap. */
export function isHtmlLiveImage(url: unknown): url is string {
  return (
    typeof url === 'string' &&
    url.length <= HTML_LIVE_MAX_IMAGE_CHARS &&
    /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(url)
  )
}

/** A Save as file path: relative to the chat's folder, an .html file, no `..`. */
export function isHtmlLiveSavedPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length <= 300 &&
    /\.html?$/i.test(path) &&
    !/^[\\/]|^[A-Za-z]:|[\\\0]/.test(path) &&
    !path.split('/').includes('..')
  )
}

/** `HtmlLiveChannels.LOAD` answer. */
export interface HtmlLiveState {
  image: string | null
  /** Where Save as file wrote the page, relative to the chat's folder. */
  savedPath: string | null
}

/** Open on desktop requests one paired phone may send per window; the desktop's own are not counted. */
export const HTML_LIVE_OPEN_LIMIT = 6
export const HTML_LIVE_OPEN_WINDOW_MS = 60_000

/** `OPEN_ON_DESKTOP` answer the phone shows when it asked too often. */
export function htmlLiveOpenLimitMessage(waitS: number): string {
  return `Too many open requests. Try again in ${waitS} seconds.`
}

/** `HtmlLiveChannels.OPEN_ON_DESKTOP` payload and the `OPEN_REQUEST` event. */
export interface HtmlLiveOpenRequest {
  conversationId: string
  source: string
  title: string | null
}

export function isHtmlLiveOpenRequest(value: unknown): value is HtmlLiveOpenRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.conversationId === 'string' &&
    v.conversationId.length > 0 &&
    v.conversationId.length <= 200 &&
    typeof v.source === 'string' &&
    utf8Bytes(v.source) <= HTML_LIVE_MAX_BYTES &&
    (v.title === null || (typeof v.title === 'string' && v.title.length <= 120))
  )
}

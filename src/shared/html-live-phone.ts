/**
 * Live pages on the phones: the rules both apps share for running a
 * ```html-live block from the message text in a locked-down WebView. Android
 * serves the document and the libraries from a per-page
 * `https://<token>.sb-live.invalid/` origin; iOS loads one HTML string with an
 * opaque origin, so its libraries come in as `data:` URLs. Either way the page
 * is untrusted: the CSP, the WebView settings and the native callbacks are the
 * sandbox. Pure: no DOM, no platform code. The Android port is held equal by
 * `tests/fixtures/html-live-phone-document.json`.
 */

import {
  HTML_LIVE_HEIGHT_MARKER,
  HTML_LIVE_LIBRARIES,
  htmlLiveHead,
  htmlLiveLibraryRefs,
  htmlLiveVerdict,
  type HtmlLiveTheme,
  type HtmlLiveVerdict,
} from './html-live'

/** Feature flag on both phones; off by default until a device probe passes. */
export const PHONE_HTML_LIVE_FLAG = 'phone_html_live_run'

/**
 * The phone CSP. On Android `'self'` is the page's own origin; on iOS the
 * origin is opaque, so `'self'` matches nothing. `navigate-to` is ignored by
 * current engines and stays as a marker: navigation is stopped natively.
 */
export const PHONE_LIVE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  'worker-src blob:',
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  'child-src blob:',
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
].join('; ')

/** Host suffix of a page's origin on Android. `.invalid` never resolves (RFC 2606). */
export const PHONE_LIVE_HOST_SUFFIX = '.sb-live.invalid'

/** A blocked URL the guard reports on the console (Android reads the console). */
export const HTML_LIVE_BLOCKED_MARKER = '__sb_live_blocked__:'

/** Libraries the phones do not ship: a page that names one shows its still image. */
export const PHONE_LIVE_DESKTOP_ONLY = new Set(['mermaid.js'])

/** Libraries that are ES modules, reached through the import map. The rest are classic scripts. */
const MODULE_LIBRARIES = new Set(['three.js', 'three/addons/controls/OrbitControls.js'])

/** Shown instead of running a page that loads a library the phones do not ship. */
export const PHONE_LIVE_DESKTOP_ONLY_NOTE =
  'Diagrams in live pages run on your Mac. Use a mermaid block to draw it here.'

/** Below this much RAM a phone does not run a page until the user presses Run. */
export const PHONE_LIVE_AUTO_RUN_MIN_RAM_BYTES = 3 * 1024 * 1024 * 1024
/** Part of the page that must be on screen before it runs. */
export const PHONE_LIVE_MIN_VISIBLE = 0.5
/** The list must be still this long before a page in it starts. */
export const PHONE_LIVE_STILL_MS = 300
/** No height report within this long after load stops the page. */
export const PHONE_LIVE_WATCHDOG_MS = 8000
/** A key that crashed this many times in one app run cannot run again. */
export const PHONE_LIVE_MAX_CRASHES = 2
/** Lines (Android console) or messages (iOS) per second the app reads; the rest are dropped. */
export const PHONE_LIVE_MAX_MESSAGES_PER_S = 100
/** Error lines and blocked URLs the app keeps for a page. */
export const PHONE_LIVE_MAX_REPORTS = 20
/** Largest iOS message the app reads. */
export const PHONE_LIVE_MAX_MESSAGE_CHARS = 1024

export type HtmlLivePhoneVerdict =
  | HtmlLiveVerdict
  | { ok: false; reason: 'open' }
  | { ok: false; reason: 'desktop-only'; names: string[] }

/**
 * Whether a phone runs a block: only a closed fence (a block still streaming
 * never runs), then the desktop's cap and library list, then the libraries
 * the phones ship.
 */
export function htmlLivePhoneVerdict(source: string, closed: boolean): HtmlLivePhoneVerdict {
  if (!closed) return { ok: false, reason: 'open' }
  const verdict = htmlLiveVerdict(source)
  if (!verdict.ok) return verdict
  const names = htmlLiveLibraryRefs(source).filter((path) => PHONE_LIVE_DESKTOP_ONLY.has(path))
  return names.length > 0 ? { ok: false, reason: 'desktop-only', names } : verdict
}

/**
 * Runs before any page code. Best effort: WebRTC is not covered by CSP, so it
 * is removed here (a page can still take a clean copy from an about:blank
 * iframe; that rest risk is accepted). With the iOS bridge present, height,
 * errors and blocked URLs go out as `{t,v}` JSON and nothing else does; on
 * Android they stay on the console. At most 50 console lines a second leave
 * the page either way.
 */
export const PHONE_LIVE_GUARD = `(() => {
  const off = function () { throw new Error('WebRTC is off in live pages') }
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
    try { Object.defineProperty(window, name, { value: off, writable: false, configurable: false }) } catch (e) {}
  }
  try { Object.defineProperty(window, 'Notification', { value: undefined, writable: false, configurable: false }) } catch (e) {}
  try {
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'register', { value: () => Promise.reject(new Error('off')), writable: false, configurable: false })
    }
  } catch (e) {}
  const bridge = window.ReactNativeWebView
  const H = '${HTML_LIVE_HEIGHT_MARKER}', B = '${HTML_LIVE_BLOCKED_MARKER}'
  let second = 0, sent = 0
  const allow = () => {
    const now = Math.floor(Date.now() / 1000)
    if (now !== second) { second = now; sent = 0 }
    return ++sent <= 50
  }
  const post = (t, v) => { if (allow()) bridge.postMessage(JSON.stringify({ t, v: typeof v === 'string' ? v.slice(0, 300) : v })) }
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console)
    console[level] = (...args) => {
      if (!bridge) { if (allow()) original(...args); return }
      const text = args.map((a) => String(a)).join(' ')
      if (text.startsWith(H)) post('h', Number(text.slice(H.length)))
      else if (text.startsWith(B)) post('b', text.slice(B.length))
      else if (level === 'error') post('e', text)
    }
  }
  addEventListener('securitypolicyviolation', (e) => console.warn(B + e.blockedURI))
  if (bridge) {
    addEventListener('error', (e) => post('e', String(e.message)))
    addEventListener('unhandledrejection', (e) => post('e', String(e.reason)))
  }
})()`

/**
 * The document a phone loads. Our bytes always come first: the CSP meta, the
 * guard, the libraries (iOS), the theme, the import map and the size
 * reporter, then the page with any leading doctype removed. The parser merges
 * a full document's own `<html>`, `<head>` and `<body>` into ours, so no page
 * byte runs before the CSP. `libraryUrl` (iOS) gives a `data:` URL for each
 * named library: classic ones load as scripts here, modules through the import
 * map. Without it (Android) the page loads them from its own origin.
 */
export function htmlLivePhoneDocument(
  source: string,
  theme: HtmlLiveTheme,
  libraryUrl?: (path: string) => string,
): string {
  const scheme = theme.scheme === 'light' ? 'light' : 'dark'
  let libraries = ''
  let imports: Record<string, string> | undefined
  if (libraryUrl) {
    imports = {}
    for (const path of htmlLiveLibraryRefs(source)) {
      if (!HTML_LIVE_LIBRARIES.some((lib) => lib.path === path) || PHONE_LIVE_DESKTOP_ONLY.has(path)) continue
      if (!MODULE_LIBRARIES.has(path)) libraries += `<script src="${libraryUrl(path)}"></script>`
      else imports[path === 'three.js' ? 'three' : path] = libraryUrl(path)
    }
  }
  const page = source.replace(/^﻿?\s*<!doctype[^>]*>/i, '')
  return (
    `<!doctype html><html data-sb-theme="${scheme}"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${PHONE_LIVE_CSP}">` +
    `<script>${PHONE_LIVE_GUARD}</script>` +
    libraries +
    htmlLiveHead(theme, imports) +
    '<style>body{overflow-x:auto}</style>' +
    `</head><body>${page}</body></html>`
  )
}

/** What a page reports back: a content height, an error line or a blocked URL. */
export type PhoneLiveReport = { t: 'h'; v: number } | { t: 'e'; v: string } | { t: 'b'; v: string }

/**
 * One iOS bridge message. Untrusted: any frame of the page can post, so only
 * the three shapes under the size cap are read.
 */
export function parsePhoneLiveMessage(data: unknown): PhoneLiveReport | null {
  if (typeof data !== 'string' || data.length > PHONE_LIVE_MAX_MESSAGE_CHARS) return null
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { t, v } = value as Record<string, unknown>
  if (t === 'h') return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? { t, v } : null
  if (t === 'e' || t === 'b') return typeof v === 'string' ? { t, v } : null
  return null
}

/** One Android console line, read the way the guard writes it. */
export function parsePhoneLiveConsole(message: string, isError: boolean): PhoneLiveReport | null {
  if (message.startsWith(HTML_LIVE_HEIGHT_MARKER)) {
    const v = Number(message.slice(HTML_LIVE_HEIGHT_MARKER.length))
    return Number.isFinite(v) && v >= 0 ? { t: 'h', v } : null
  }
  if (message.startsWith(HTML_LIVE_BLOCKED_MARKER)) return { t: 'b', v: message.slice(HTML_LIVE_BLOCKED_MARKER.length) }
  return isError ? { t: 'e', v: message.slice(0, 300) } : null
}

/** A per-second gate: true for at most `limit` calls in each wall-clock second. */
export function phoneLiveRateGate(limit = PHONE_LIVE_MAX_MESSAGES_PER_S): (nowMs: number) => boolean {
  let second = -1
  let count = 0
  return (nowMs) => {
    const s = Math.floor(nowMs / 1000)
    if (s !== second) {
      second = s
      count = 0
    }
    return ++count <= limit
  }
}

export interface PhoneLiveCandidate {
  key: string
  /** Part of the frame on screen, 0 to 1. */
  visible: number
  /** The user pressed Run (or Run again) on it. */
  runPressed: boolean
  /** Shown in the full-screen view. */
  fullScreen: boolean
}

export interface PhoneLiveConditions {
  /** How long the list has been still. */
  listStillMs: number
  /** Under `PHONE_LIVE_AUTO_RUN_MIN_RAM_BYTES` or a low-RAM device. */
  lowRam: boolean
  /** Crashes this app run, by key. */
  crashes: ReadonlyMap<string, number>
}

/**
 * The one page a phone runs, or null. The full-screen view takes the slot.
 * Otherwise the most visible frame runs once the list is still, unless it
 * needs Run: on a low-RAM phone, and after a crash (no auto-retry). A key that
 * crashed twice never runs again this app run.
 */
export function phoneLiveRunning(candidates: readonly PhoneLiveCandidate[], when: PhoneLiveConditions): string | null {
  const allowed = candidates.filter((c) => (when.crashes.get(c.key) ?? 0) < PHONE_LIVE_MAX_CRASHES)
  const full = allowed.find((c) => c.fullScreen)
  if (full) return full.key
  if (when.listStillMs < PHONE_LIVE_STILL_MS) return null
  let best: PhoneLiveCandidate | null = null
  for (const c of allowed) {
    if (c.visible < PHONE_LIVE_MIN_VISIBLE) continue
    if (!c.runPressed && (when.lowRam || (when.crashes.get(c.key) ?? 0) > 0)) continue
    if (!best || c.visible > best.visible) best = c
  }
  return best?.key ?? null
}

/** Whether a phone's memory is enough to run pages without a tap on Run. */
export function phoneLiveLowRam(totalBytes: number, systemLowRam = false): boolean {
  return systemLowRam || totalBytes < PHONE_LIVE_AUTO_RUN_MIN_RAM_BYTES
}

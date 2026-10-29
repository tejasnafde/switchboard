/**
 * Draws the agent's `preview_visual` blocks (main/mcp/visual-preview-tool.ts)
 * one at a time and answers main with the image. Nothing shows and nothing is
 * stored. Every kind runs as a hidden live page, the way an ```html-live still
 * image is taken (HtmlLiveFrame's hidden mode): the inline document of the
 * preview sandbox, at the chat column's block width, in the current theme. A
 * chart or diagram is drawn to SVG here first and placed in a page.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CHART_SERIES_COLORS } from '@shared/chart-colors'
import { parseChartSpec, renderChart, type ChartPalette } from '@shared/chat-visuals'
import {
  HTML_LIVE_MAX_BYTES,
  HTML_LIVE_QUIET_MS,
  htmlLiveFrameHeight,
  htmlLiveHeightFromConsole,
  type HtmlLiveTheme,
} from '@shared/html-live'
import { PREVIEW_PARTITION, blockedRequestLabel } from '@shared/html-preview'
import type { VisualPreviewRequest, VisualPreviewResult } from '@shared/visual-preview'
import { createRendererLogger } from '../../../logger'
import { cspBlockedUrl, previewConsoleLine } from '../../../services/html-preview-console'
import { htmlLiveTheme } from '../../../services/html-live-theme'
import { diagramTheme } from '../../../services/diagram-theme'
import { renderDiagram } from './diagram-render'

const log = createRendererLogger('chat:visual-preview')

/** Under main's 20 s, so a stuck page answers with its own error. */
const JOB_MAX_MS = 15_000
const BLOCK_WIDTH = 640
const SVG_STYLE = '<style>svg{display:block;margin:0 auto;max-width:100%;height:auto;max-height:460px}</style>'

type GuestWebview = HTMLElement & { getWebContentsId?: () => number }
interface Job {
  id: string
  request: VisualPreviewRequest
}

/** The width a block gets in this chat's column, or the full block when the chat is not on screen. */
function blockWidth(request: VisualPreviewRequest): number {
  for (const id of [request.threadId, request.chatId]) {
    const panel = document.querySelector<HTMLElement>(`[data-chat-panel][data-session-id="${CSS.escape(id)}"]`)
    // ponytail: a message row pads 16 px and an assistant bubble 14 px on each side.
    if (panel?.clientWidth) return Math.max(240, Math.min(BLOCK_WIDTH, panel.clientWidth - 60))
  }
  return BLOCK_WIDTH
}

/**
 * A capture has no window vibrancy behind it, so the translucent theme's
 * near-clear background would come out light under white text. It takes the
 * solid colours that theme uses in full screen (global.css, data-fullscreen).
 */
function previewTheme(): HtmlLiveTheme {
  const theme = htmlLiveTheme()
  return document.documentElement.classList.contains('theme-translucent')
    ? { ...theme, bg: '#111111', surface: '#1a1a1a' }
    : theme
}

function resolveVar(value: string): string {
  const name = /^var\((--[^)]+)\)$/.exec(value)?.[1]
  return name ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : value
}

/** The page source for a block: an html-live block as is, a chart or diagram as its SVG. */
async function pageSource(
  request: VisualPreviewRequest,
): Promise<{ ok: true; source: string } | { ok: false; error: string }> {
  if (request.kind === 'html-live') return { ok: true, source: request.source }
  if (request.kind === 'chart') {
    const parsed = parseChartSpec(request.source)
    if (!parsed.ok) return { ok: false, error: `The chart could not be drawn: ${parsed.error}` }
    const palette: ChartPalette = {
      text: resolveVar('var(--text-primary)'),
      muted: resolveVar('var(--text-secondary)'),
      grid: resolveVar('var(--border)'),
      font: resolveVar('var(--font-sans)'),
      series: CHART_SERIES_COLORS.map(resolveVar),
    }
    return { ok: true, source: SVG_STYLE + renderChart(parsed.spec, palette, 620) }
  }
  const drawn = await renderDiagram(request.source, diagramTheme())
  return drawn.ok
    ? { ok: true, source: SVG_STYLE + drawn.svg }
    : { ok: false, error: `The diagram could not be drawn: ${drawn.error}` }
}

export function VisualPreviewHost() {
  const queue = useRef<Job[]>([])
  const running = useRef<Job | null>(null)
  const [job, setJob] = useState<Job | null>(null)

  const next = useCallback(() => {
    running.current = queue.current.shift() ?? null
    setJob(running.current)
  }, [])

  useEffect(() => {
    const offRequest = window.api.preview.onVisualPreviewRequest((id, request) => {
      queue.current.push({ id, request })
      if (!running.current) next()
    })
    // Main gave up on it (timeout or the agent cancelled): drop it, or end it if it is drawing.
    const offCancel = window.api.preview.onVisualPreviewCancel((id) => {
      queue.current = queue.current.filter((j) => j.id !== id)
      if (running.current?.id === id) next()
    })
    return () => {
      offRequest()
      offCancel()
    }
  }, [next])

  const finish = useCallback(
    (done: Job, result: VisualPreviewResult) => {
      if (running.current?.id !== done.id) return
      window.api.preview
        .answerVisualPreview(done.id, result)
        .catch((err: unknown) => log.warn('preview answer failed', err))
      next()
    },
    [next],
  )

  return job ? <PreviewJob key={job.id} job={job} onDone={finish} /> : null
}

function PreviewJob({ job, onDone }: { job: Job; onDone: (job: Job, result: VisualPreviewResult) => void }) {
  const [doc, setDoc] = useState<{ url: string; token: string; width: number } | null>(null)
  const [contentHeight, setContentHeight] = useState(0)
  const errors = useRef<string[]>([])
  const blocked = useRef<string[]>([])
  const addBlocked = useCallback((url: string) => {
    const label = blockedRequestLabel(url)
    if (!blocked.current.includes(label) && blocked.current.length < 50) blocked.current.push(label)
  }, [])
  const webviewRef = useRef<GuestWebview | null>(null)
  const heightRef = useRef(0)
  heightRef.current = contentHeight
  const doneRef = useRef(false)
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loaded = useRef(false)

  const done = useCallback(
    (result: VisualPreviewResult) => {
      if (doneRef.current) return
      doneRef.current = true
      if (quietTimer.current) clearTimeout(quietTimer.current)
      onDone(job, result)
    },
    [job, onDone],
  )

  useEffect(() => {
    let token: string | null = null
    let current = true
    const cap = setTimeout(
      () => done({ ok: false, error: `The page did not settle in ${JOB_MAX_MS / 1000} s.` }),
      JOB_MAX_MS,
    )
    void (async () => {
      const page = await pageSource(job.request)
      if (!page.ok) return done({ ok: false, error: page.error, parse: true })
      const width = blockWidth(job.request)
      const opened = await window.api.preview.openInline({ source: page.source, theme: previewTheme() })
      if (!opened.ok)
        return done({
          ok: false,
          error:
            opened.message ??
            (opened.error === 'too-large'
              ? `The drawn page is ${Math.ceil((opened.bytes ?? 0) / 1024)} KB, over the ${HTML_LIVE_MAX_BYTES / 1024} KB a live page holds.`
              : 'The page could not be opened.'),
        })
      if (!current) {
        void window.api.preview.closeInline(opened.token).catch((err: unknown) => log.warn('inline close failed', err))
        return
      }
      token = opened.token
      setDoc({ url: opened.url, token: opened.token, width })
    })().catch((err: unknown) => {
      log.warn('preview failed', err)
      done({ ok: false, error: 'The preview could not be drawn.' })
    })
    const off = window.api.preview.onEvent((event) => {
      if (event.type !== 'blocked' || event.token !== token) return
      addBlocked(event.url)
    })
    return () => {
      current = false
      clearTimeout(cap)
      off()
      if (token)
        void window.api.preview.closeInline(token).catch((err: unknown) => log.warn('inline close failed', err))
    }
  }, [job, done, addBlocked])

  const capture = useCallback(async () => {
    const wcId = webviewRef.current?.getWebContentsId?.()
    if (wcId === undefined || !doc) return done({ ok: false, error: 'The page could not be captured.' })
    const image = await window.api.preview.captureInline(wcId)
    if (!image) return done({ ok: false, error: 'The page could not be captured.' })
    done({
      ok: true,
      image,
      contentHeight: heightRef.current,
      frameHeight: htmlLiveFrameHeight(heightRef.current, false),
      width: doc.width,
      errors: errors.current,
      blocked: blocked.current,
    })
  }, [doc, done])
  const captureRef = useRef(capture)
  captureRef.current = capture

  const armQuiet = useCallback(() => {
    if (quietTimer.current) clearTimeout(quietTimer.current)
    if (!loaded.current) return
    quietTimer.current = setTimeout(() => {
      captureRef.current().catch((err: unknown) => {
        log.warn('preview capture failed', err)
        done({ ok: false, error: 'The page could not be captured.' })
      })
    }, HTML_LIVE_QUIET_MS)
  }, [done])

  const setWebviewRef = useCallback(
    (el: HTMLElement | null) => {
      webviewRef.current = el as GuestWebview | null
      if (!el) return
      el.addEventListener('did-stop-loading', () => {
        loaded.current = true
        armQuiet()
      })
      el.addEventListener('console-message', (event) => {
        const e = event as unknown as { level: number | string; message: string; line: number }
        const height = htmlLiveHeightFromConsole(e.message)
        if (height !== null) {
          setContentHeight(height)
          armQuiet()
          return
        }
        if (e.level !== 3 && e.level !== 'error') return
        const csp = cspBlockedUrl(e.message)
        if (csp) {
          addBlocked(csp.url)
          return
        }
        const line = previewConsoleLine(e.message, e.line)
        if (!errors.current.includes(line) && errors.current.length < 20) errors.current.push(line)
      })
    },
    [armQuiet, addBlocked],
  )

  if (!doc) return null
  return createPortal(
    // Out of sight and out of the layout: fixed, transparent, behind the app and inert.
    <div
      aria-hidden="true"
      inert
      data-visual-preview=""
      style={{ position: 'fixed', top: 0, left: 0, width: doc.width, opacity: 0, zIndex: -1, pointerEvents: 'none' }}
    >
      <webview
        ref={setWebviewRef}
        src={doc.url}
        partition={PREVIEW_PARTITION}
        webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no"
        style={{ display: 'flex', width: '100%', border: 0, height: htmlLiveFrameHeight(contentHeight, false) }}
      />
    </div>,
    document.body,
  )
}

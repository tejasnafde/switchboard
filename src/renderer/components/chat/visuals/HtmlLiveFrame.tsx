/**
 * An ```html-live block in a chat message: the page runs in a <webview> in the
 * HTML preview's sandbox (main/preview/: partition, no Node, no popups, no
 * navigation, network cancelled except the page's own token and /_sb/), sized
 * to its content between 120 and 480 px.
 *
 * It runs only once the block has closed and scrolled into view, and at most
 * HTML_LIVE_MAX_RUNNING frames run per window (services/html-live-frames.ts);
 * the others pause as their still image with Run. After the page is quiet for
 * HTML_LIVE_QUIET_MS the frame is captured and the image stored with the
 * chat's backend, which is what phones show. A frame with no image that is
 * not in view takes it hidden when a running slot is free: the page renders
 * out of sight at the block's width, is captured once quiet and closes
 * (services/html-live-still-scheduler.ts). Open in pane moves the page to
 * the preview pane, so one copy runs; Save as file there turns this block into
 * the normal HTML file card.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  HTML_LIVE_QUIET_MS,
  htmlLiveBlockedHint,
  htmlLiveFileName,
  htmlLiveFolds,
  htmlLiveFrameHeight,
  htmlLiveHeightFromConsole,
  htmlLiveRejection,
  htmlLiveStillHeight,
  htmlLiveVerdict,
} from '@shared/html-live'
import { PREVIEW_PARTITION, blockedRequestLabel, formatPreviewBytes } from '@shared/html-preview'
import { FilesChannels } from '@shared/ipc-channels'
import { useAgentStore } from '../../../stores/agent-store'
import { useDraftStore } from '../../../stores/draft-store'
import { useLayoutStore } from '../../../stores/layout-store'
import {
  claimFrame,
  finishHiddenStill,
  rememberImage,
  rememberSavedPath,
  releaseFrame,
  runFrame,
  setFrameStillRequest,
  setFrameWants,
  useFrameHiddenStill,
  useFrameRunning,
  useLivePageMemory,
} from '../../../services/html-live-frames'
import { hiddenStillKey } from '../../../services/html-live-still-scheduler'
import { htmlLiveKey, htmlLiveTheme } from '../../../services/html-live-theme'
import {
  cspBlockedUrl,
  liveBlockedForAgent,
  previewConsoleLine,
  previewErrorsForAgent,
} from '../../../services/html-preview-console'
import { HtmlFileCard } from '../HtmlFileCard'
import { VisualMenu } from './VisualMenu'
import { asPng, copyPngToClipboard, visualMenuItems } from './visual-image'
import { saveLivePage } from '../../../services/html-live-save'
import { PreviewIcon } from '../../preview/preview-icons'
import { createRendererLogger } from '../../../logger'
import { cn } from '../../../lib/utils'

const log = createRendererLogger('chat:html-live')

const headerButton =
  'rounded-[5px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[7px] py-[1px] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
const actionButton =
  'rounded-[5px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[9px] py-[3px] text-[11.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
/** The light theme's --warning is too faint for text (2.9:1 on white). */
const warningText = 'text-[var(--warning)] [.theme-light_&]:text-[#a16207]'
const WRITING_TAIL_LINES = 8
/** A hidden capture of a page that never goes quiet is taken this long after it opens. */
const HIDDEN_STILL_MAX_MS = 8000
const HIDDEN_CAPTURE_MAX_MS = 5000
const HIDDEN_STILL_FALLBACK_WIDTH = 640
/** Page keys whose still image this window already sent to a backend. */
const storedKeys = new Set<string>()

type GuestWebview = HTMLElement & { getWebContentsId?: () => number }
type Doc = { url: string; token: string }
type LiveMode = 'running' | 'hidden'

function subscribeThemeClass(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

function useThemeClass(): string {
  return useSyncExternalStore(subscribeThemeClass, () => document.documentElement.className)
}

function useKey(source: string): string | null {
  const [state, setState] = useState<{ source: string; key: string } | null>(null)
  useEffect(() => {
    let current = true
    htmlLiveKey(source).then(
      (key) => {
        if (current) setState({ source, key })
      },
      (err: unknown) => log.warn('live page key failed', err),
    )
    return () => {
      current = false
    }
  }, [source])
  return state?.source === source ? state.key : null
}

/** Whether the block is in view: `null` until the first observation. */
function useInView(): [React.RefObject<HTMLDivElement | null>, boolean | null] {
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState<boolean | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, inView]
}

/**
 * Whether Save as file's path is a file in this chat's folder now. The path is
 * stored by page hash, so the same page in another chat, or a deleted file,
 * must fall back to running the page rather than to a card for nothing.
 */
function useSavedFileExists(root: string | null, machineId: string | null, path: string | null): boolean {
  const [found, setFound] = useState<string | null>(null)
  const probe = root && path ? `${machineId ?? ''}\n${root}\n${path}` : null
  useEffect(() => {
    if (!root || !path || !probe) return
    let current = true
    type Resolved = { exists: boolean }
    const request: Promise<Resolved> = machineId
      ? window.api.routing.invokeOn<Resolved>(machineId, FilesChannels.RESOLVE, root, path)
      : window.api.files.resolve(root, path)
    request.then(
      (res) => {
        if (current && res?.exists) setFound(probe)
      },
      (err: unknown) => log.debug('saved live page resolve failed', err),
    )
    return () => {
      current = false
    }
  }, [root, machineId, path, probe])
  return probe !== null && found === probe
}

function WritingCard({ source, title }: { source: string; title: string | null }) {
  const bytes = new TextEncoder().encode(source).length
  const tail = source.split('\n').slice(-WRITING_TAIL_LINES).join('\n')
  return (
    <div
      data-html-live="writing"
      className="my-[10px] w-[640px] max-w-full overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--bg-secondary)]"
    >
      <div className="flex items-center gap-[8px] border-b border-[var(--border)] px-[10px] py-[6px] text-[12px]">
        <span className="flex-1 truncate font-[500] text-[var(--text-primary)]">{title ?? 'Live page'}</span>
        <span className="text-[11px] text-[var(--text-muted)]">Writing · {formatPreviewBytes(bytes)}</span>
      </div>
      <pre className="m-0 overflow-hidden p-[10px] font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-secondary)]">
        ...{'\n'}
        {tail}
      </pre>
    </div>
  )
}

export function HtmlLiveFrame({
  source,
  title,
  closed,
  sessionId,
}: {
  source: string
  title: string | null
  closed: boolean
  sessionId?: string
}) {
  if (!closed) return <WritingCard source={source} title={title} />
  return <LiveFrame source={source} title={title} sessionId={sessionId} />
}

function LiveFrame({ source, title, sessionId }: { source: string; title: string | null; sessionId?: string }) {
  const id = useId()
  const verdict = useMemo(() => htmlLiveVerdict(source), [source])
  const key = useKey(source)
  const root = useAgentStore((s) => {
    const session = s.sessions.find((x) => x.id === sessionId)
    return session?.worktreePath ?? session?.projectPath ?? null
  })
  const machineId = useAgentStore((s) => {
    const m = s.sessions.find((x) => x.id === sessionId)?.machineId
    return m && m !== 'local' ? m : null
  })
  const memory = useLivePageMemory(key)
  const saved = useSavedFileExists(root, machineId, memory.savedPath) ? memory.savedPath : null
  const inPane = useLayoutStore(
    (s) => key !== null && s.rightPaneMode === 'preview' && s.htmlPreview?.live?.key === key,
  )
  const [ref, inView] = useInView()
  const themeClass = useThemeClass()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [loading, setLoading] = useState(true)
  const [contentHeight, setContentHeight] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [blocked, setBlocked] = useState<string[]>([])
  const [openError, setOpenError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  // A count, not a flag: each copy restarts the timer.
  const [copied, setCopied] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [backendHasImage, setBackendHasImage] = useState(false)
  // The key whose backend state has loaded: a hidden capture waits for it.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [hiddenWidth, setHiddenWidth] = useState(0)
  const webviewRef = useRef<GuestWebview | null>(null)
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The frame height the still image was taken at: a new height takes a new one,
  // so the paused box (the running height) always matches its image.
  const capturedHeightRef = useRef<number | null>(null)
  const frameHeightRef = useRef(0)
  // Only the newest capture may replace the image or store it.
  const captureSeqRef = useRef(0)
  // The image this frame took and the box height it was taken at, so a pause
  // before the next capture shows the image in its own box.
  const [capturedBox, setCapturedBox] = useState<{ image: string; height: number } | null>(null)
  const tokenRef = useRef<string | null>(null)

  const label = title ?? 'Live page'
  const libraries = verdict.ok ? (verdict.libraries.length ? verdict.libraries.join(', ') : 'no libraries') : ''
  const loadingLabel = verdict.ok && verdict.libraries.length ? `Loading ${verdict.libraries.join(', ')}` : 'Loading'

  useEffect(() => {
    claimFrame(id)
    return () => releaseFrame(id)
  }, [id])
  useEffect(() => {
    setFrameWants(id, inView === true && !inPane && verdict.ok && !saved)
  }, [id, inView, inPane, verdict.ok, saved])
  const running = useFrameRunning(id) && verdict.ok && !inPane && !saved
  const stillKey = hiddenStillKey({
    key,
    loadedKey,
    hasImage: memory.image !== null,
    allowed: verdict.ok,
    inPane,
    // Any saved path, before its file check answers: a saved page never runs hidden.
    saved: memory.savedPath !== null,
    inView,
    running,
  })
  useEffect(() => {
    setFrameStillRequest(id, stillKey)
  }, [id, stillKey])
  const hiddenStill = useFrameHiddenStill(id) && stillKey !== null
  const mode: LiveMode | null = running ? 'running' : hiddenStill ? 'hidden' : null
  const modeRef = useRef(mode)
  modeRef.current = mode
  const keyRef = useRef(key)
  keyRef.current = key
  // A hidden capture runs once per page key, whether or not it got an image.
  const endHiddenStill = useCallback(() => {
    if (keyRef.current) finishHiddenStill(id, keyRef.current)
  }, [id])
  // The hidden page renders at the width the block has in the chat column
  // (its full 640 px when the block is not laid out, as in a hidden panel).
  useLayoutEffect(() => {
    if (hiddenStill) setHiddenWidth(ref.current?.clientWidth || HIDDEN_STILL_FALLBACK_WIDTH)
  }, [hiddenStill, ref])

  // What the chat's backend already holds: a still image, or the saved file.
  useEffect(() => {
    if (!key) return
    let current = true
    window.api.htmlLive.load(machineId, key).then(
      (state) => {
        if (!current) return
        if (state.image) {
          setBackendHasImage(true)
          rememberImage(key, state.image)
        }
        if (state.savedPath) rememberSavedPath(key, state.savedPath)
        setLoadedKey(key)
      },
      (err: unknown) => log.debug('live page state load failed', err),
    )
    return () => {
      current = false
    }
  }, [key, machineId])

  // Running or hidden: open the page's document in the preview session; reopened on a theme change.
  useEffect(() => {
    if (!mode) return
    let current = true
    let token: string | null = null
    let hiddenCap: ReturnType<typeof setTimeout> | null = null
    setLoading(true)
    setOpenError(null)
    capturedHeightRef.current = null
    loadedRef.current = false
    window.api.preview.openInline({ source, theme: htmlLiveTheme() }).then(
      (result) => {
        if (!result.ok) {
          if (!current) return
          setOpenError(result.message ?? 'The page could not be opened.')
          if (mode === 'hidden') endHiddenStill()
          return
        }
        token = result.token
        if (!current) {
          void window.api.preview.closeInline(token).catch((err: unknown) => log.warn('inline close failed', err))
          return
        }
        tokenRef.current = token
        setDoc({ url: result.url, token: result.token })
        if (mode === 'hidden')
          hiddenCap = setTimeout(() => {
            if (quietTimer.current) clearTimeout(quietTimer.current)
            if (!loadedRef.current) return endHiddenStill()
            captureRef.current().catch((err: unknown) => log.warn('hidden live page capture failed', err))
          }, HIDDEN_STILL_MAX_MS)
      },
      (err: unknown) => {
        log.warn('inline open failed', err)
        if (!current) return
        setOpenError('The page could not be opened.')
        if (mode === 'hidden') endHiddenStill()
      },
    )
    return () => {
      if (hiddenCap) clearTimeout(hiddenCap)
      current = false
      tokenRef.current = null
      setDoc(null)
      if (quietTimer.current) clearTimeout(quietTimer.current)
      if (token)
        void window.api.preview.closeInline(token).catch((err: unknown) => log.warn('inline close failed', err))
    }
  }, [mode, source, themeClass, endHiddenStill])

  // The error and blocked lists outlive a pause and a rerun of the same page,
  // so a swap between the page and its still image keeps the frame's size.
  useEffect(() => {
    setErrors([])
    setBlocked([])
  }, [source, themeClass])

  // Another page must not inherit the old page's height for its still image box.
  useEffect(() => {
    setContentHeight(0)
    setExpanded(false)
  }, [source])

  const addBlocked = useCallback((url: string) => {
    const blockedLabel = blockedRequestLabel(url)
    setBlocked((prev) => (prev.includes(blockedLabel) || prev.length >= 50 ? prev : [...prev, blockedLabel]))
  }, [])

  useEffect(() => {
    return window.api.preview.onEvent((event) => {
      if (event.type === 'blocked' && event.token === tokenRef.current) addBlocked(event.url)
    })
  }, [addBlocked])

  const capture = useCallback(async () => {
    const wcId = webviewRef.current?.getWebContentsId?.()
    const frameHeight = frameHeightRef.current
    if (wcId === undefined || !key || capturedHeightRef.current === frameHeight) return
    capturedHeightRef.current = frameHeight
    const seq = ++captureSeqRef.current
    const image = await window.api.preview.captureInline(wcId)
    if (!image || seq !== captureSeqRef.current) return
    rememberImage(key, image)
    setCapturedBox({ image, height: frameHeight })
    if (backendHasImage || storedKeys.has(key)) return
    storedKeys.add(key)
    const stored = await window.api.htmlLive.update(machineId, key, { image })
    if (!stored.ok) log.warn('live page image was not stored', { bytes: image.length })
  }, [key, machineId, backendHasImage])
  const captureLive = useCallback(async () => {
    if (modeRef.current !== 'hidden') return capture()
    // A capture that never answers must not hold the hidden render's slot.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        capture(),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, HIDDEN_CAPTURE_MAX_MS))),
      ])
    } finally {
      clearTimeout(timer)
      endHiddenStill()
    }
  }, [capture, endHiddenStill])

  const captureRef = useRef(captureLive)
  captureRef.current = captureLive
  const loadedRef = useRef(false)
  const armQuiet = useCallback(() => {
    if (quietTimer.current) clearTimeout(quietTimer.current)
    if (!loadedRef.current) return
    quietTimer.current = setTimeout(() => {
      captureRef.current().catch((err: unknown) => log.warn('live page capture failed', err))
    }, HTML_LIVE_QUIET_MS)
  }, [])
  useLayoutEffect(() => {
    frameHeightRef.current = htmlLiveFrameHeight(contentHeight, expanded)
  }, [contentHeight, expanded])
  // Show all grows the frame with no new content height: take the still image again.
  useEffect(() => {
    if (expanded) armQuiet()
  }, [expanded, armQuiet])

  const setWebviewRef = useCallback(
    (el: HTMLElement | null) => {
      webviewRef.current = el as GuestWebview | null
      if (!el) return
      loadedRef.current = false
      el.addEventListener('did-stop-loading', () => {
        loadedRef.current = true
        setLoading(false)
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
          if (!csp.duplicate) addBlocked(csp.url)
          return
        }
        const line = previewConsoleLine(e.message, e.line)
        setErrors((prev) => (prev.includes(line) || prev.length >= 20 ? prev : [...prev, line]))
      })
    },
    [addBlocked, armQuiet],
  )

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(0), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 2500)
    return () => window.clearTimeout(timer)
  }, [notice])

  const copySource = () => {
    navigator.clipboard.writeText(source).then(
      () => setNotice('Copied source'),
      (err: unknown) => {
        log.warn('live page copy failed', err)
        setNotice('Could not copy')
      },
    )
  }
  /** The running page as drawn now, else its still image. */
  const pagePng = async (): Promise<string> => {
    let wcId: number | undefined
    try {
      wcId = running ? webviewRef.current?.getWebContentsId?.() : undefined
    } catch (err) {
      // Throws until the guest is attached: the still image stands in.
      log.debug('live page not attached yet', err)
    }
    const still = (wcId === undefined ? null : await window.api.preview.captureInline(wcId)) ?? memory.image
    if (!still) throw new Error('This page has no image yet.')
    return asPng(still)
  }
  const copyImage = () => {
    pagePng()
      .then(copyPngToClipboard)
      .then(
        () => setCopied((n) => n + 1),
        (err: unknown) => {
          log.warn('live page image copy failed', err)
          setNotice('Could not copy image')
        },
      )
  }
  const saveImage = () => {
    const name = htmlLiveFileName(title).replace(/\.html$/, '.png')
    pagePng()
      .then((dataUrl) => window.api.app.saveImage({ suggestedFilename: name, dataUrl }))
      .then(
        (result) => {
          if (result.ok) setNotice(`Saved ${result.path.split(/[\\/]/).pop()}`)
          else if (!('canceled' in result)) {
            log.warn('live page image save failed', result.error)
            setNotice('Could not save')
          }
        },
        (err: unknown) => {
          log.warn('live page image save failed', err)
          setNotice('Could not save')
        },
      )
  }
  const saveAsFile = () => {
    if (!key || !root) return
    const target = { path: htmlLiveFileName(title), root, machineId, sessionId: sessionId ?? null }
    saveLivePage({ ...target, live: { key, source, title } }).then(
      (result) => {
        if (result.ok) return
        log.warn('live page save as file failed', result.error)
        setNotice('Could not save')
      },
      (err: unknown) => {
        log.warn('live page save as file failed', err)
        setNotice('Could not save')
      },
    )
  }
  const openInPane = () => {
    if (!key) return
    useLayoutStore.getState().openHtmlPreview({
      path: htmlLiveFileName(title),
      root: root ?? '',
      machineId,
      sessionId: sessionId ?? null,
      live: { key, source, title },
    })
  }
  const sendToAgent = () => {
    if (!sessionId) return
    const text =
      errors.length > 0
        ? previewErrorsForAgent(`the live page "${label}"`, errors)
        : liveBlockedForAgent(label, blocked)
    useDraftStore.getState().appendDraft(sessionId, text)
  }

  if (saved && sessionId) return <HtmlFileCard path={saved} sessionId={sessionId} />

  const height = htmlLiveFrameHeight(contentHeight, expanded)
  // Shown under the page and under its still image alike, so a swap keeps the frame's size.
  const foldBar = !expanded && htmlLiveFolds(contentHeight) && (
    <button
      type="button"
      className="block w-full appearance-none border-0 border-t border-solid border-[var(--border)] bg-transparent py-[5px] text-center text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      onClick={() => {
        setExpanded(true)
        if (!running) runFrame(id)
      }}
    >
      Show all · {Math.ceil(contentHeight)} px
    </button>
  )
  const image = memory.image
  const boxHeight = htmlLiveStillHeight(contentHeight, expanded)
  const stillHeight = boxHeight !== null && image && capturedBox?.image === image ? capturedBox.height : boxHeight
  const state = !verdict.ok
    ? 'rejected'
    : showSource
      ? 'source'
      : inPane
        ? 'in-pane'
        : running
          ? loading
            ? 'loading'
            : 'running'
          : 'paused'

  return (
    <div
      ref={ref}
      data-html-live={state}
      className="my-[10px] w-[640px] max-w-full overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--bg-secondary)]"
    >
      <div className="flex items-center gap-[8px] border-b border-[var(--border)] px-[10px] py-[6px] text-[12px]">
        {notice ? (
          <span className="min-w-0 truncate text-[var(--text-muted)]" aria-live="polite">
            {notice}
          </span>
        ) : (
          <span className="min-w-0 truncate font-[500] text-[var(--text-primary)]">{label}</span>
        )}
        <span className="flex-1 truncate text-[11px] text-[var(--text-muted)]">{libraries}</span>
        {errors.length > 0 && (
          <span className="whitespace-nowrap text-[11px] text-[var(--error)]">
            {errors.length === 1 ? '1 error' : `${errors.length} errors`}
          </span>
        )}
        {blocked.length > 0 && (
          <span className={cn('whitespace-nowrap text-[11px]', warningText)}>{blocked.length} blocked</span>
        )}
        <button
          type="button"
          className={headerButton}
          aria-pressed={showSource}
          onClick={() => setShowSource((s) => !s)}
        >
          Source
        </button>
        {verdict.ok && (
          <>
            <button
              type="button"
              className={headerButton}
              aria-live="polite"
              onClick={copyImage}
              disabled={!running && !image}
            >
              {copied ? 'Copied' : 'Copy image'}
            </button>
            {!inPane && (
              <button type="button" className={headerButton} onClick={openInPane} disabled={!key}>
                Open in pane
              </button>
            )}
            <VisualMenu
              className={headerButton}
              items={visualMenuItems('html-live', {
                saveImage: running || image ? saveImage : undefined,
                copyText: copySource,
                saveAsFile: key && root ? saveAsFile : undefined,
              })}
            />
          </>
        )}
      </div>

      {!verdict.ok && (
        <div role="alert" className="px-[10px] pt-[8px] pb-[10px] text-[12px] text-[var(--error)]">
          {htmlLiveRejection(verdict)}
        </div>
      )}

      {showSource && (
        <pre className="m-0 max-h-[480px] overflow-auto p-[10px] font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-primary)]">
          {source}
        </pre>
      )}
      {/* Source hides a running page rather than stopping it. */}
      {running ? (
        <div className={cn('relative', showSource && 'hidden')}>
          {doc ? (
            <webview
              ref={setWebviewRef}
              src={doc.url}
              partition={PREVIEW_PARTITION}
              webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no"
              className="flex w-full border-0 bg-[var(--bg-secondary)]"
              style={{ height }}
            />
          ) : (
            <div style={{ height }} />
          )}
          {loading && !openError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-[8px] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-muted)]">
              {loadingLabel}
              <span className="h-[3px] w-[160px] overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                <span className="block h-full w-[40%] bg-[var(--accent)]" />
              </span>
            </div>
          )}
          {openError && (
            <div
              role="alert"
              className="absolute inset-0 bg-[var(--bg-secondary)] p-[10px] text-[12px] text-[var(--error)]"
            >
              {openError}
            </div>
          )}
          {foldBar}
        </div>
      ) : showSource ? null : inPane ? (
        <div className="flex items-center gap-[10px] p-[10px] text-[12px] text-[var(--text-secondary)]">
          {image && (
            <img
              src={image}
              alt=""
              className="h-[48px] w-[96px] rounded-[4px] border border-[var(--border)] object-cover"
            />
          )}
          <span className="flex-1">Running in the pane. It stops here so only one copy runs.</span>
          <span className="inline-flex items-center gap-[5px] text-[var(--text-muted)]">
            <PreviewIcon name="check" className="size-[12px] text-[var(--success)]" />
            In pane
          </span>
        </div>
      ) : (
        verdict.ok && (
          <>
            <div
              className="relative flex min-h-[120px] items-center justify-center overflow-hidden"
              style={stillHeight === null ? undefined : { height: stillHeight }}
            >
              {image ? (
                <img
                  src={image}
                  alt={`${label}, still image`}
                  className={cn(
                    'block w-full',
                    stillHeight === null ? 'max-h-[480px] object-cover object-top' : 'absolute top-0 left-0',
                  )}
                />
              ) : (
                <span className="text-[12px] text-[var(--text-muted)]">Paused</span>
              )}
              <button
                type="button"
                className="absolute inline-flex items-center gap-[6px] rounded-[6px] border border-[var(--border-strong)] bg-[var(--bg-tertiary)] px-[10px] py-[4px] text-[12px] text-[var(--text-primary)] shadow-sm hover:bg-[var(--bg-hover)]"
                onClick={() => runFrame(id)}
              >
                Run
              </button>
            </div>
            {foldBar}
          </>
        )
      )}

      {hiddenStill &&
        doc &&
        createPortal(
          // Out of sight and out of the layout: fixed, transparent, behind the app and inert.
          <div
            aria-hidden="true"
            inert
            data-html-live-hidden=""
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              width: hiddenWidth,
              opacity: 0,
              zIndex: -1,
              pointerEvents: 'none',
            }}
          >
            <webview
              ref={setWebviewRef}
              src={doc.url}
              partition={PREVIEW_PARTITION}
              webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no"
              className="flex w-full border-0 bg-[var(--bg-secondary)]"
              style={{ height }}
            />
          </div>,
          document.body,
        )}

      {!showSource && !inPane && verdict.ok && (errors.length > 0 || blocked.length > 0) && (
        <div className="border-t border-[var(--border)] px-[10px] py-[7px] font-[family-name:var(--font-mono)] text-[11px] leading-[1.7]">
          {errors.map((line, i) => (
            <div key={`e${i}`} className="text-[var(--error)]">
              {line}
            </div>
          ))}
          {blocked.map((url) => (
            <div key={url} className={warningText}>
              {url}
            </div>
          ))}
          <div className="mt-[5px] flex items-center gap-[6px] font-[family-name:var(--font-sans)]">
            {errors.length === 0 && (
              <small className="flex-1 text-[11.5px] text-[var(--text-muted)]">{htmlLiveBlockedHint(blocked)}</small>
            )}
            {sessionId && (
              <button type="button" className={actionButton} onClick={sendToAgent}>
                Send to agent
              </button>
            )}
            {errors.length > 0 && (
              <button type="button" className={actionButton} onClick={() => setShowSource(true)}>
                Show source
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

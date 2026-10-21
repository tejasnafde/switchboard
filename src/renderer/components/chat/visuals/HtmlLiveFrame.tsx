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
 * chat's backend, which is what phones show. Open in pane moves the page to
 * the preview pane, so one copy runs; Save as file there turns this block into
 * the normal HTML file card.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
  rememberImage,
  rememberSavedPath,
  releaseFrame,
  runFrame,
  setFrameWants,
  useFrameRunning,
  useLivePageMemory,
} from '../../../services/html-live-frames'
import { htmlLiveKey, htmlLiveTheme } from '../../../services/html-live-theme'
import {
  cspBlockedUrl,
  liveBlockedForAgent,
  previewConsoleLine,
  previewErrorsForAgent,
} from '../../../services/html-preview-console'
import { HtmlFileCard } from '../HtmlFileCard'
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
/** Page keys whose still image this window already sent to a backend. */
const storedKeys = new Set<string>()

type GuestWebview = HTMLElement & { getWebContentsId?: () => number }
type Doc = { url: string; token: string }

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

function useInView(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)
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
  const [copied, setCopied] = useState(false)
  const [backendHasImage, setBackendHasImage] = useState(false)
  const webviewRef = useRef<GuestWebview | null>(null)
  const quietTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const capturedRef = useRef(false)
  const tokenRef = useRef<string | null>(null)

  const label = title ?? 'Live page'
  const libraries = verdict.ok ? (verdict.libraries.length ? verdict.libraries.join(', ') : 'no libraries') : ''
  const loadingLabel = verdict.ok && verdict.libraries.length ? `Loading ${verdict.libraries.join(', ')}` : 'Loading'

  useEffect(() => {
    claimFrame(id)
    return () => releaseFrame(id)
  }, [id])
  useEffect(() => {
    setFrameWants(id, inView && !inPane && verdict.ok && !saved)
  }, [id, inView, inPane, verdict.ok, saved])
  const running = useFrameRunning(id) && verdict.ok && !inPane && !saved

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
      },
      (err: unknown) => log.debug('live page state load failed', err),
    )
    return () => {
      current = false
    }
  }, [key, machineId])

  // Running: open the page's document in the preview session; reopened on a theme change.
  useEffect(() => {
    if (!running) return
    let current = true
    let token: string | null = null
    setLoading(true)
    setOpenError(null)
    capturedRef.current = false
    window.api.preview.openInline({ source, theme: htmlLiveTheme() }).then(
      (result) => {
        if (!result.ok) {
          if (current) setOpenError(result.message ?? 'The page could not be opened.')
          return
        }
        token = result.token
        if (!current) {
          void window.api.preview.closeInline(token).catch((err: unknown) => log.warn('inline close failed', err))
          return
        }
        tokenRef.current = token
        setDoc({ url: result.url, token: result.token })
      },
      (err: unknown) => {
        log.warn('inline open failed', err)
        if (current) setOpenError('The page could not be opened.')
      },
    )
    return () => {
      current = false
      tokenRef.current = null
      setDoc(null)
      if (quietTimer.current) clearTimeout(quietTimer.current)
      if (token)
        void window.api.preview.closeInline(token).catch((err: unknown) => log.warn('inline close failed', err))
    }
  }, [running, source, themeClass])

  // The error and blocked lists outlive a pause and a rerun of the same page,
  // so a swap between the page and its still image keeps the frame's size.
  useEffect(() => {
    setErrors([])
    setBlocked([])
  }, [source, themeClass])

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
    if (wcId === undefined || !key || capturedRef.current) return
    capturedRef.current = true
    const image = await window.api.preview.captureInline(wcId)
    if (!image) return
    rememberImage(key, image)
    if (backendHasImage || storedKeys.has(key)) return
    storedKeys.add(key)
    const stored = await window.api.htmlLive.update(machineId, key, { image })
    if (!stored.ok) log.warn('live page image was not stored', { bytes: image.length })
  }, [key, machineId, backendHasImage])

  const captureRef = useRef(capture)
  captureRef.current = capture
  const loadedRef = useRef(false)
  const armQuiet = useCallback(() => {
    if (quietTimer.current) clearTimeout(quietTimer.current)
    if (!loadedRef.current) return
    quietTimer.current = setTimeout(() => {
      captureRef.current().catch((err: unknown) => log.warn('live page capture failed', err))
    }, HTML_LIVE_QUIET_MS)
  }, [])

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
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copySource = () => {
    navigator.clipboard.writeText(source).then(
      () => setCopied(true),
      (err: unknown) => log.warn('live page copy failed', err),
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
  const stillHeight = htmlLiveStillHeight(contentHeight, expanded)
  // Shown under the page and under its still image alike, so a swap keeps the frame's size.
  const foldBar = !expanded && htmlLiveFolds(contentHeight) && (
    <button
      type="button"
      className="block w-full border-t border-[var(--border)] py-[5px] text-center text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      onClick={() => {
        setExpanded(true)
        if (!running) runFrame(id)
      }}
    >
      Show all · {Math.ceil(contentHeight)} px
    </button>
  )
  const image = memory.image
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
        <span className="min-w-0 truncate font-[500] text-[var(--text-primary)]">{label}</span>
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
            <button type="button" className={headerButton} aria-live="polite" onClick={copySource}>
              {copied ? 'Copied' : 'Copy source'}
            </button>
            {!inPane && (
              <button type="button" className={headerButton} onClick={openInPane} disabled={!key}>
                Open in pane
              </button>
            )}
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

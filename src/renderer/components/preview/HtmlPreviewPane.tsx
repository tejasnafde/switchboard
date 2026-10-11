/**
 * HTML preview pane: an agent-written .html file in a sandboxed <webview>,
 * shown under rightPaneMode === 'preview'. Main (main/preview/) enforces the
 * sandbox: its own partition, no Node, no popups, no navigation off the file,
 * and no network beyond the file and the files in its folder.
 *
 * RAM policy, as the IDE pane: one webview ever, reused for every file. Hidden
 * for the IDE's idle time (or closed), the webview unmounts, which releases
 * the guest renderer, and main stops watching the folder.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PREVIEW_MAX_BYTES,
  PREVIEW_PARTITION,
  PREVIEW_WIDTHS,
  blockedRequestLabel,
  formatPreviewBytes,
  resolvePreviewColorScheme,
  type PreviewOpenResult,
  type PreviewTheme,
} from '@shared/html-preview'
import { useLayoutStore, type HtmlPreviewTarget } from '../../stores/layout-store'
import { useThemeStore } from '../../stores/theme-store'
import { useDraftStore } from '../../stores/draft-store'
import { htmlPreviewAbsolutePath, htmlPreviewDisplay, loadHtmlPreview } from '../../services/html-preview-open'
import { cspBlockedUrl, previewConsoleLine, previewErrorsForAgent } from '../../services/html-preview-console'
import { Button } from '../ui/button'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '../ui/menu'
import { PreviewIcon, type PreviewIconName } from './preview-icons'
import { createRendererLogger } from '../../logger'
import { cn } from '../../lib/utils'

const log = createRendererLogger('preview:pane')

/** Same idle rule and setting as the embedded IDE. */
const DEFAULT_IDLE_MINUTES = 5
const IDLE_TTL_SETTING = 'ide.idleTtlMinutes'
const NOTICE_DISMISSED_KEY = 'preview.sandboxNoticeDismissed'
/** Below this pane width the toolbar folds theme and browser into the menu. */
const COMPACT_WIDTH = 380
const UPDATED_FLASH_MS = 2000
/** Classes of the fixed page widths in PREVIEW_WIDTHS (static, so Tailwind sees them). */
const WIDTH_CLASS: Record<number, string> = {
  390: 'mx-auto w-[390px] flex-none',
  768: 'mx-auto w-[768px] flex-none',
  1280: 'mx-auto w-[1280px] flex-none',
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; token: string }
  | { kind: 'error'; error: Exclude<PreviewOpenResult, { ok: true }>['error']; bytes?: number; message?: string }

type GuestWebview = HTMLElement & {
  loadURL?: (url: string) => Promise<void>
  getWebContentsId?: () => number
}

function appColorScheme(theme: string): string {
  if (theme !== 'system') return theme
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function ToolbarButton({
  icon,
  label,
  onClick,
  className,
}: {
  icon: PreviewIconName
  label: string
  onClick?: () => void
  className?: string
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'size-[20px] rounded-[4px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
        className,
      )}
    >
      <PreviewIcon name={icon} />
    </Button>
  )
}

function ErrorState({
  icon,
  title,
  detail,
  children,
}: {
  icon: PreviewIconName
  title: string
  detail: string
  children: React.ReactNode
}) {
  return (
    <div
      role="alert"
      className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-[6px] bg-[var(--bg-primary)] p-[24px] text-center text-[13px]"
    >
      <PreviewIcon name={icon} className="mb-[4px] size-[20px] text-[var(--text-muted)]" />
      <div className="font-[500] text-[var(--text-primary)]">{title}</div>
      <div className="max-w-[260px] text-[12px] text-[var(--text-secondary)]">{detail}</div>
      <div className="mt-[8px] flex gap-[6px]">{children}</div>
    </div>
  )
}

export function HtmlPreviewPane(): React.ReactElement {
  const target = useLayoutStore((s) => s.htmlPreview)
  const visible = useLayoutStore((s) => s.rightPaneMode === 'preview')
  const appTheme = useThemeStore((s) => s.theme)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [idled, setIdled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [updated, setUpdated] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [blocked, setBlocked] = useState<string[]>([])
  const [consoleHidden, setConsoleHidden] = useState(false)
  const [pageTheme, setPageTheme] = useState<PreviewTheme>('app')
  const [pageWidth, setPageWidth] = useState<number | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [compact, setCompact] = useState(false)
  const [noticeDismissed, setNoticeDismissed] = useState(() => localStorage.getItem(NOTICE_DISMISSED_KEY) === 'true')
  const [idleMs, setIdleMs] = useState(DEFAULT_IDLE_MINUTES * 60 * 1000)
  const webviewRef = useRef<GuestWebview | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  // Every load bumps the ticket; a late answer for an older load is dropped.
  const ticketRef = useRef(0)
  const tokenRef = useRef<string | null>(null)
  const targetRef = useRef<HtmlPreviewTarget | null>(target)
  targetRef.current = target
  // Blocked requests arrive from main (the request filter) and from the page's
  // console (CSP reports); both land in one deduplicated list.
  const addBlockedRef = useRef((url: string) => {
    const label = blockedRequestLabel(url)
    setBlocked((prev) => (prev.includes(label) || prev.length >= 50 ? prev : [...prev, label]))
  })

  const active = target !== null && !idled
  const colorScheme = resolvePreviewColorScheme(pageTheme, appColorScheme(appTheme))

  useEffect(() => {
    const load = () =>
      window.api.settings.get(IDLE_TTL_SETTING).then(
        (v) => {
          const n = v ? parseFloat(v) : NaN
          setIdleMs((Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MINUTES) * 60 * 1000)
        },
        (err: unknown) => log.warn('idle setting read failed', err),
      )
    void load()
    const onChanged = () => void load()
    window.addEventListener('sb-ide-settings-changed', onChanged)
    return () => window.removeEventListener('sb-ide-settings-changed', onChanged)
  }, [])

  useEffect(() => {
    const el = paneRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < COMPACT_WIDTH))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const load = useCallback(async (next: HtmlPreviewTarget, reason: 'open' | 'change') => {
    const ticket = ++ticketRef.current
    setBusy(true)
    if (reason === 'open') setState({ kind: 'loading' })
    let result: PreviewOpenResult
    try {
      result = await loadHtmlPreview(next)
    } catch (err) {
      log.warn('preview load failed', err)
      result = { ok: false, error: 'failed', message: err instanceof Error ? err.message : String(err) }
    }
    if (ticket !== ticketRef.current) return
    if (!result.ok) {
      tokenRef.current = null
      setBusy(false)
      setState({ kind: 'error', error: result.error, bytes: result.bytes, message: result.message })
      return
    }
    tokenRef.current = result.token
    setErrors([])
    setBlocked([])
    setConsoleHidden(false)
    setState({ kind: 'ready', url: result.url, token: result.token })
    if (reason === 'change') setUpdated(true)
  }, [])

  // Open (or re-open) whenever the target changes or the pane wakes from idle.
  useEffect(() => {
    if (!target || idled) return
    void load(target, 'open')
  }, [target, idled, load])

  // Closed: drop the document now rather than at the idle timeout.
  useEffect(() => {
    // Nothing to drop before the first open.
    if (target || ticketRef.current === 0) return
    ticketRef.current++
    tokenRef.current = null
    window.api.preview.close().catch((err: unknown) => log.warn('preview close failed', err))
  }, [target])

  // Idle: hidden long enough -> unmount the webview and stop the folder watch.
  useEffect(() => {
    if (visible) {
      setIdled(false)
      return
    }
    if (!target) return
    const timer = setTimeout(() => {
      log.info('preview idle shutdown after hidden timeout')
      ticketRef.current++
      tokenRef.current = null
      setIdled(true)
      window.api.preview.close().catch((err: unknown) => log.warn('preview close failed', err))
    }, idleMs)
    return () => clearTimeout(timer)
  }, [visible, target, idleMs])

  useEffect(() => {
    if (!updated) return
    const timer = setTimeout(() => setUpdated(false), UPDATED_FLASH_MS)
    return () => clearTimeout(timer)
  }, [updated])

  useEffect(() => {
    return window.api.preview.onEvent((event) => {
      if (event.token !== tokenRef.current) return
      const current = targetRef.current
      if (event.type === 'blocked') {
        addBlockedRef.current(event.url)
      } else if (event.type === 'missing') {
        setBusy(false)
        setState({ kind: 'error', error: 'not-found' })
      } else if (current) {
        // Changed on disk (or back after a delete): load the new version.
        void load(current, 'change')
      }
    })
  }, [load])

  const applyColorScheme = useCallback(() => {
    const id = webviewRef.current?.getWebContentsId?.()
    if (id === undefined) return
    window.api.preview
      .setColorScheme(id, colorScheme)
      .catch((err: unknown) => log.warn('preview color scheme failed', err))
  }, [colorScheme])

  useEffect(() => {
    if (state.kind === 'ready') applyColorScheme()
  }, [applyColorScheme, state.kind])

  // Navigate the one webview with loadURL; the guest must be attached first.
  const readyUrl = state.kind === 'ready' ? state.url : null
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv?.loadURL || !readyUrl || !active) return
    let done = false
    const navigate = () => {
      if (done) return
      try {
        done = true
        void wv.loadURL!(readyUrl).catch((err: unknown) => log.debug('preview navigate ended', err))
      } catch (err) {
        done = false
        log.debug('preview navigate deferred until dom-ready', err)
      }
    }
    wv.addEventListener('dom-ready', navigate)
    navigate()
    return () => wv.removeEventListener('dom-ready', navigate)
  }, [readyUrl, active])

  const applyColorSchemeRef = useRef(applyColorScheme)
  applyColorSchemeRef.current = applyColorScheme
  const setWebviewRef = useCallback(
    (el: HTMLElement | null) => {
      webviewRef.current = el as GuestWebview | null
      if (!el) return
      el.addEventListener('did-start-loading', () => setBusy(true))
      el.addEventListener('did-stop-loading', () => setBusy(false))
      el.addEventListener('dom-ready', () => applyColorSchemeRef.current())
      el.addEventListener('console-message', (event) => {
        const e = event as unknown as { level: number; message: string; line: number }
        if (e.level < 3) return
        const csp = cspBlockedUrl(e.message)
        if (csp) {
          if (!csp.duplicate) addBlockedRef.current(csp.url)
          return
        }
        const line = previewConsoleLine(e.message, e.line)
        setErrors((prev) => (prev.length >= 20 ? prev : [...prev, line]))
      })
    },
    // The listeners read the latest scheme through a ref.
    [],
  )

  const close = () => useLayoutStore.getState().closeHtmlPreview()
  const reload = () => {
    if (target) void load(target, 'open')
  }
  const openInBrowser = () => {
    if (!target || target.machineId) return
    window.api.preview
      .openExternal(htmlPreviewAbsolutePath(target))
      .catch((err: unknown) => log.warn('preview open in browser failed', err))
  }
  const openInEditor = () => {
    if (target) useLayoutStore.getState().openInViewer(target.path, null, target.sessionId)
  }
  const copyPath = () => {
    if (!target) return
    const text = target.machineId ? target.path : htmlPreviewAbsolutePath(target)
    navigator.clipboard.writeText(text).catch((err: unknown) => log.warn('preview copy path failed', err))
  }
  const sendErrorsToAgent = () => {
    if (!target?.sessionId) return
    const { dir, name } = htmlPreviewDisplay(target)
    useDraftStore.getState().appendDraft(target.sessionId, previewErrorsForAgent(`${dir}${name}`, errors))
  }
  const dismissNotice = () => {
    localStorage.setItem(NOTICE_DISMISSED_KEY, 'true')
    setNoticeDismissed(true)
  }

  const display = target ? htmlPreviewDisplay(target) : { name: '', dir: '' }
  const local = target !== null && target.machineId === null
  const failed = state.kind === 'error'
  const flipTheme = () => setPageTheme(colorScheme === 'dark' ? 'light' : 'dark')

  return (
    <div
      ref={paneRef}
      data-html-preview-pane
      data-loading={busy || state.kind === 'loading' ? 'true' : undefined}
      className="relative flex min-w-0 flex-1 flex-col bg-[var(--bg-primary)]"
    >
      <div className="flex h-[28px] min-w-0 shrink-0 items-center gap-[4px] border-b border-[var(--border)] bg-[var(--bg-secondary)] pr-[6px] pl-[10px] text-[11.5px]">
        <span
          className={cn(
            'min-w-0 truncate',
            failed && state.error === 'not-found' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]',
          )}
          title={target?.path}
        >
          {display.name}
        </span>
        {!compact && display.dir && (
          <span className="ml-[2px] whitespace-nowrap text-[var(--text-muted)]">{display.dir}</span>
        )}
        {!failed && errors.length > 0 && (
          <span className="ml-[8px] whitespace-nowrap text-[var(--error)]">
            {errors.length === 1 ? '1 error' : `${errors.length} errors`}
          </span>
        )}
        {!failed && blocked.length > 0 && (
          <span className="ml-[8px] whitespace-nowrap text-[var(--warning)]">{blocked.length} blocked</span>
        )}
        {!failed && updated && errors.length === 0 && blocked.length === 0 && (
          <span className="ml-[8px] whitespace-nowrap text-[var(--text-muted)]">Updated</span>
        )}
        <span className="flex-1" />
        {compact && !failed && (
          <ToolbarButton icon="shield" label="Sandboxed. No network, no access to the app or your files." />
        )}
        {!compact && !failed && (
          <ToolbarButton
            icon={colorScheme === 'dark' ? 'moon' : 'sun'}
            label={colorScheme === 'dark' ? 'Page theme: dark. Click for light' : 'Page theme: light. Click for dark'}
            onClick={flipTheme}
          />
        )}
        <ToolbarButton
          icon="reload"
          label="Reload"
          onClick={reload}
          className={busy && state.kind === 'ready' ? 'text-[var(--accent)]' : undefined}
        />
        {!compact && !failed && local && (
          <ToolbarButton icon="external" label="Open in browser" onClick={openInBrowser} />
        )}
        {!failed && (
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="More"
                title="More"
                className={cn(
                  'size-[20px] rounded-[4px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                  menuOpen && 'bg-[var(--bg-hover)] text-[var(--text-primary)]',
                )}
              >
                <PreviewIcon name="dots" />
              </Button>
            </MenuTrigger>
            <MenuContent className="w-[196px]" onCloseAutoFocus={(event) => event.preventDefault()}>
              <MenuLabel>Page theme</MenuLabel>
              {(['app', 'light', 'dark'] as const).map((theme) => (
                <MenuItem
                  key={theme}
                  checked={pageTheme === theme}
                  onClick={() => {
                    setPageTheme(theme)
                    setMenuOpen(false)
                  }}
                >
                  {theme === 'app' ? 'Match app' : theme === 'light' ? 'Light' : 'Dark'}
                </MenuItem>
              ))}
              <MenuSeparator />
              {local && (
                <MenuItem
                  onClick={() => {
                    openInBrowser()
                    setMenuOpen(false)
                  }}
                >
                  Open in browser
                </MenuItem>
              )}
              <MenuItem
                onClick={() => {
                  openInEditor()
                  setMenuOpen(false)
                }}
              >
                Open in editor
              </MenuItem>
              <MenuItem
                onClick={() => {
                  copyPath()
                  setMenuOpen(false)
                }}
              >
                Copy path
              </MenuItem>
              <MenuSeparator />
              <MenuLabel>Width</MenuLabel>
              {PREVIEW_WIDTHS.map((option) => (
                <MenuItem
                  key={option.label}
                  checked={pageWidth === option.width}
                  hint={option.hint}
                  onClick={() => {
                    setPageWidth(option.width)
                    setMenuOpen(false)
                  }}
                >
                  {option.label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        <span className="mx-[3px] h-[12px] w-px bg-[var(--border-strong)]" />
        <ToolbarButton icon="close" label="Close preview" onClick={close} />
      </div>

      {!compact && !failed && !noticeDismissed && (
        <div className="flex h-[26px] shrink-0 items-center gap-[7px] border-b border-[var(--border)] bg-[var(--bg-surface)] px-[10px] text-[11.5px] text-[var(--text-secondary)]">
          <PreviewIcon name="shield" className="size-[12px] text-[var(--text-muted)]" />
          Sandboxed. No network, no access to the app or your files.
          <ToolbarButton
            icon="close"
            label="Hide this notice"
            onClick={dismissNotice}
            className="ml-auto text-[var(--text-muted)]"
          />
        </div>
      )}

      <div
        className={cn(
          'relative flex min-h-0 flex-1',
          pageWidth ? 'overflow-x-auto overflow-y-hidden' : 'overflow-hidden',
        )}
      >
        {busy && !failed && (
          <div className="absolute top-0 left-0 z-[2] h-[2px] w-[62%] bg-[var(--accent)]" aria-hidden="true" />
        )}
        {failed && state.error === 'not-found' && (
          <ErrorState
            icon="off"
            title="File not found"
            detail={`${display.dir}${display.name} was moved or deleted.${local ? ' The preview reloads if it comes back.' : ''}`}
          >
            <Button variant="outline" size="sm" onClick={reload}>
              Retry
            </Button>
            <Button variant="ghost" size="sm" onClick={close}>
              Close
            </Button>
          </ErrorState>
        )}
        {failed && state.error === 'too-large' && (
          <ErrorState
            icon="alert"
            title="Too large to preview"
            detail={`${display.name}${state.bytes ? ` is ${formatPreviewBytes(state.bytes)}` : ' is too large'}. The preview loads files up to ${formatPreviewBytes(PREVIEW_MAX_BYTES)}.`}
          >
            {local && (
              <Button variant="outline" size="sm" onClick={openInBrowser}>
                Open in browser
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={close}>
              Close
            </Button>
          </ErrorState>
        )}
        {failed && (state.error === 'failed' || state.error === 'not-html') && (
          <ErrorState
            icon="alert"
            title="Could not load the preview"
            detail={
              state.error === 'not-html' ? 'Only .html files open in the preview.' : (state.message ?? 'Try again.')
            }
          >
            <Button variant="outline" size="sm" onClick={reload}>
              Retry
            </Button>
            <Button variant="ghost" size="sm" onClick={close}>
              Close
            </Button>
          </ErrorState>
        )}
        {/* Painted app-dark so the guest never flashes white while loading.
            No allowpopups; main hardens the preferences and the session. */}
        {active && (
          <webview
            ref={setWebviewRef}
            src="about:blank"
            partition={PREVIEW_PARTITION}
            webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no"
            className={cn('h-full border-0 bg-[var(--bg-primary)]', WIDTH_CLASS[pageWidth ?? 0] ?? 'min-w-0 flex-1')}
          />
        )}
      </div>

      {!failed && !consoleHidden && (errors.length > 0 || blocked.length > 0) && (
        <div className="max-h-[40%] shrink-0 overflow-auto border-t border-[var(--border)] bg-[var(--bg-secondary)] px-[10px] py-[7px] font-[family-name:var(--font-mono)] text-[11px] leading-[1.7] text-[var(--text-secondary)]">
          {errors.map((line, i) => (
            <div key={`e${i}`} className="text-[var(--error)]">
              {line}
            </div>
          ))}
          {blocked.map((label) => (
            <div key={label} className="text-[var(--warning)]">
              {label}
            </div>
          ))}
          <div className="mt-[5px] flex items-center gap-[6px] font-[family-name:var(--font-sans)]">
            {errors.length > 0 && target?.sessionId && (
              <Button variant="outline" size="sm" className="h-[26px] px-[9px]" onClick={sendErrorsToAgent}>
                Send to agent
              </Button>
            )}
            {blocked.length > 0 && errors.length === 0 && (
              <small className="text-[11.5px] text-[var(--text-muted)]">
                No network in the sandbox. Ask the agent to inline these, or open in your browser.
              </small>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-[26px] px-[9px] text-[var(--text-secondary)]"
              onClick={() => setConsoleHidden(true)}
            >
              Hide
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

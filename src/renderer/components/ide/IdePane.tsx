/**
 * Embedded IDE pane: the real VS Code workbench (code-server) in a single
 * reused <webview>. Replaces the CodeMirror Files pane under
 * rightPaneMode === 'files'. Design: docs/plans/2026-07-10-embedded-ide-design.md.
 *
 * RAM policy (P0): one webview ever - switching projects navigates it to the
 * new ?folder=. Hidden for 15 minutes -> kill the server and blank the webview
 * (about:blank releases the guest renderer); cold respawn is ~0.35s.
 */
import { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../../stores/agent-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useThemeStore } from '../../stores/theme-store'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('ide:pane')

/** Idle shutdown default (minutes); user-tunable via Settings → General. */
const DEFAULT_IDLE_MINUTES = 5
const IDLE_TTL_SETTING = 'ide.idleTtlMinutes'
/** Recycle the single code-server after it has served this many distinct
 *  folders, reclaiming the per-folder extension hosts it accumulates.
 *  ponytail: fixed cap; make it a setting only if 5 turns out wrong. */
const RECYCLE_AFTER_FOLDERS = 5

type PaneState =
  | { kind: 'idle' }
  | { kind: 'booting'; label: string }
  | { kind: 'ready'; port: number }
  | { kind: 'error'; message: string }

export function IdePane(): React.ReactElement {
  const folder = useAgentStore((s) => {
    const session = s.sessions.find((x) => x.id === s.activeSessionId)
    return session?.worktreePath ?? session?.projectPath ?? null
  })
  const visible = useLayoutStore((s) => s.rightPaneMode === 'files')
  const [state, setState] = useState<PaneState>({ kind: 'idle' })
  const [retryNonce, setRetryNonce] = useState(0)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const webviewRef = useRef<HTMLElement>(null)
  // Last URL we explicitly navigated the webview to, so we don't reload the
  // same folder on every render.
  const lastNavRef = useRef<string | null>(null)
  // Distinct folders the current server has served; drives the recycle cap.
  const servedRef = useRef<Set<string>>(new Set())
  // True while we're intentionally restarting the server (recycle), so the
  // 'stopped' status push from that stop() isn't mistaken for a crash.
  const recyclingRef = useRef(false)

  // Idle shutdown TTL (ms), read from settings. Re-read when the user saves
  // settings so it applies without a restart.
  const [idleMs, setIdleMs] = useState(DEFAULT_IDLE_MINUTES * 60 * 1000)
  useEffect(() => {
    const load = () =>
      window.api.settings.get(IDLE_TTL_SETTING).then((v) => {
        const n = v ? parseFloat(v) : NaN
        setIdleMs((Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MINUTES) * 60 * 1000)
      })
    void load()
    const onChanged = () => void load()
    window.addEventListener('sb-ide-settings-changed', onChanged)
    return () => window.removeEventListener('sb-ide-settings-changed', onChanged)
  }, [])

  // The folder the webview actually points at. Changing `?folder=` fully
  // reloads the workbench (new extension host per folder - code-server keeps
  // the old ones around, so churn = CPU/RAM pileup). So debounce it and only
  // advance while the pane is visible: fast chat-hopping collapses into a
  // single navigation, and hopping with the IDE hidden doesn't churn at all.
  const [navFolder, setNavFolder] = useState<string | null>(folder)
  useEffect(() => {
    if (!visible) return
    if (folder === navFolder) return
    const t = setTimeout(() => setNavFolder(folder), 500)
    return () => clearTimeout(t)
  }, [visible, folder, navFolder])

  // Focus follows the pane: when the workbench is shown and ready, move focus
  // INTO the webview so VS Code owns the keyboard - cmd+p (quick open), cmd+b
  // (sidebar), and typing all land in the editor instead of the app. Leaving
  // to the terminal refocuses the app (App.tsx), so cmd+b toggles the
  // Switchboard sidebar there.
  useEffect(() => {
    if (visible && state.kind === 'ready') webviewRef.current?.focus()
  }, [visible, state.kind])

  // Reflect main-pushed status: download progress while ENSURE is in flight,
  // and crash-after-ready (server died under a live webview - without this
  // the pane keeps pointing at a dead port with no retry affordance).
  useEffect(() => {
    return window.api.ide.onStatus(({ status, pct }) => {
      if (status === 'downloading') {
        const suffix = pct !== undefined ? ` ${pct}%` : ''
        setState({ kind: 'booting', label: `Downloading VS Code workbench (one-time)…${suffix}` })
      } else if (status === 'stopped') {
        // Intentional recycle restart, not a crash - swallow the one 'stopped'.
        if (recyclingRef.current) {
          recyclingRef.current = false
          return
        }
        setState((prev) =>
          prev.kind === 'ready' ? { kind: 'error', message: 'IDE server stopped unexpectedly.' } : prev
        )
      }
    })
  }, [])

  // Theme coupling: the workbench follows the app theme. Written into
  // code-server's settings.json, which its file watcher applies live.
  const theme = useThemeStore((s) => s.theme)
  useEffect(() => {
    if (state.kind === 'ready') void window.api.ide.setTheme(theme)
  }, [theme, state.kind])

  // Boot / re-point the workbench. Runs even while HIDDEN (prewarm): the
  // server spawns and the webview loads the workbench in the background, so
  // the first cmd+shift+E shows an already-booted editor instead of a
  // multi-second boot. Prewarm never downloads the binary - a cold install
  // stays idle until the pane is explicitly opened. The 15-min idle shutdown
  // reclaims an unused prewarm.
  useEffect(() => {
    if (!navFolder) return
    let cancelled = false
    void (async () => {
      // Recycle: cap how many distinct folders one server accumulates. Past
      // the cap, kill it (clearing every per-folder extension host) and let
      // the ensure below respawn fresh - a ~2s relaunch, worth it vs pileup.
      servedRef.current.add(navFolder)
      if (servedRef.current.size > RECYCLE_AFTER_FOLDERS) {
        log.info('ide recycle: served folder cap reached, restarting server')
        recyclingRef.current = true
        await window.api.ide.stop()
        servedRef.current = new Set([navFolder])
        if (cancelled) {
          recyclingRef.current = false
          return
        }
      }
      if (visible) {
        setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'booting', label: 'Starting IDE…' }))
      }
      const res = await window.api.ide.ensure(navFolder, {
        theme: useThemeStore.getState().theme,
        skipDownload: !visible,
      })
      if (cancelled) return
      if (res.ok) {
        setState({ kind: 'ready', port: res.port })
      } else if (res.error === 'binary-not-installed' && !visible) {
        // Prewarm on a cold install: silently stay idle.
      } else {
        log.warn('ide ensure failed', res.error)
        setState({ kind: 'error', message: res.error })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [visible, navFolder, retryNonce])

  // Idle shutdown: hidden long enough -> reclaim the server + guest renderer.
  useEffect(() => {
    if (visible) {
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = null
      return
    }
    idleTimer.current = setTimeout(() => {
      log.info('ide idle shutdown after hidden timeout')
      void window.api.ide.stop()
      servedRef.current = new Set()
      setState({ kind: 'idle' })
    }, idleMs)
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = null
    }
  }, [visible, idleMs])

  const src =
    state.kind === 'ready' && navFolder
      ? `http://127.0.0.1:${state.port}/?folder=${encodeURIComponent(navFolder)}`
      : 'about:blank'

  // Drive navigation via loadURL rather than the React `src` attribute:
  // Electron's <webview> reliably navigates on first load but NOT when the
  // attribute later changes to a same-origin, query-only different URL (the
  // ?folder= switch), which is exactly the chat-switch case. dom-ready tells
  // us the guest is attached (loadURL throws before that).
  useEffect(() => {
    const wv = webviewRef.current as (HTMLElement & {
      loadURL?: (url: string) => Promise<void>
    }) | null
    if (!wv?.loadURL) return
    let cancelled = false
    const navigate = () => {
      if (cancelled || lastNavRef.current === src) return
      lastNavRef.current = src
      try {
        void wv.loadURL!(src).catch((err) => log.warn('ide webview navigate failed', err))
      } catch (err) {
        // loadURL throws synchronously if the guest isn't attached yet; clear
        // the marker so the dom-ready firing below retries.
        lastNavRef.current = null
        log.warn('ide webview navigate deferred until dom-ready', err)
      }
    }
    // If the guest is already attached, go now; otherwise wait for dom-ready.
    wv.addEventListener('dom-ready', navigate)
    navigate()
    return () => {
      cancelled = true
      wv.removeEventListener('dom-ready', navigate)
    }
  }, [src])

  return (
    <div data-ide-pane style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
      {state.kind !== 'ready' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontSize: 12,
            opacity: 0.75,
            zIndex: 1,
          }}
        >
          {!folder ? (
            <span>Open a session to browse its project</span>
          ) : state.kind === 'error' ? (
            <>
              <span style={{ color: 'var(--color-error, #e5534b)', maxWidth: 360, textAlign: 'center' }}>
                {state.message}
              </span>
              <button onClick={() => setRetryNonce((n) => n + 1)}>Retry</button>
            </>
          ) : (
            <span>{state.kind === 'booting' ? state.label : 'IDE stopped'}</span>
          )}
        </div>
      )}
      {/* Painted app-dark so the guest never flashes white while loading.
          allowpopups lets window.open reach the main-process handler that
          routes extension OAuth logins to the system browser. */}
      {/* src is a static bootstrap only; real navigation is driven by loadURL
          above (Electron webview won't re-navigate on attribute change). */}
      <webview ref={webviewRef} src="about:blank" partition="persist:ide" allowpopups style={{ flex: 1, border: 'none', background: 'var(--bg-primary)' }} />
    </div>
  )
}

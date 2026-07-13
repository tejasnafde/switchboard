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

const IDLE_SHUTDOWN_MS = 15 * 60 * 1000

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
    if (!folder) return
    let cancelled = false
    if (visible) {
      setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'booting', label: 'Starting IDE…' }))
    }
    void window.api.ide
      .ensure(folder, { theme: useThemeStore.getState().theme, skipDownload: !visible })
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          setState({ kind: 'ready', port: res.port })
        } else if (res.error === 'binary-not-installed' && !visible) {
          // Prewarm on a cold install: silently stay idle.
        } else {
          log.warn('ide ensure failed', res.error)
          setState({ kind: 'error', message: res.error })
        }
      })
    return () => {
      cancelled = true
    }
  }, [visible, folder, retryNonce])

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
      setState({ kind: 'idle' })
    }, IDLE_SHUTDOWN_MS)
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current)
      idleTimer.current = null
    }
  }, [visible])

  const src =
    state.kind === 'ready' && folder
      ? `http://127.0.0.1:${state.port}/?folder=${encodeURIComponent(folder)}`
      : 'about:blank'

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
      {/* Painted app-dark so the guest never flashes white while loading. */}
      <webview ref={webviewRef} src={src} partition="persist:ide" style={{ flex: 1, border: 'none', background: 'var(--bg-primary)' }} />
    </div>
  )
}

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'

export interface TerminalInstance {
  terminal: Terminal
  fitAddon: FitAddon
  searchAddon: SearchAddon
  container: HTMLDivElement | null
  ptyId: string
  opened: boolean
  cleanupFns: (() => void)[]
}

const registry = new Map<string, TerminalInstance>()

/**
 * Per-pane timestamp of the last PTY output byte. Used by the dirty-pane
 * check on `applyTemplate` — if a pane has produced output recently the
 * user is about to kill something live (dev server, REPL, ssh session)
 * and we should confirm before tearing it down.
 *
 * Lives outside the registry because it's incremented on a hot path
 * (every output chunk) and we don't want to mutate the TerminalInstance
 * struct repeatedly.
 */
const lastOutputAt = new Map<string, number>()

const RECENT_OUTPUT_WINDOW_MS = 30_000

/**
 * Returns the labels of panes that have produced PTY output in the last
 * 30 seconds. Used by `applyTemplate` to confirm before tearing down a
 * session's panes.
 */
export function getRecentOutputPaneLabels(
  paneIds: string[],
  panes: Record<string, { label?: string }>,
): string[] {
  const cutoff = Date.now() - RECENT_OUTPUT_WINDOW_MS
  const out: string[] = []
  for (const id of paneIds) {
    const ts = lastOutputAt.get(id) ?? 0
    if (ts >= cutoff) {
      out.push(panes[id]?.label || id)
    }
  }
  return out
}

/**
 * Read-only access to a registered terminal instance (e.g. to call
 * `instance.terminal.getSelection()` for the ⌘L context bridge).
 * Returns undefined when no instance with that id is registered.
 */
export function getTerminalInstance(id: string): TerminalInstance | undefined {
  return registry.get(id)
}

function getXtermTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const get = (v: string) => style.getPropertyValue(v).trim() || undefined
  const isLight = document.documentElement.className.includes('theme-light')

  const bg = get('--terminal-bg') || '#0d1117'
  const fg = get('--terminal-fg') || '#e6edf3'

  if (isLight) {
    return {
      background: bg, foreground: fg,
      cursor: get('--terminal-cursor') || '#2563eb',
      cursorAccent: bg,
      selectionBackground: 'rgba(37, 99, 235, 0.15)',
      black: '#1a1d21', red: '#d32f2f', green: '#2e7d32', yellow: '#f57f17',
      blue: '#1565c0', magenta: '#7b1fa2', cyan: '#00838f', white: '#9ca3af',
      brightBlack: '#5a6270', brightRed: '#ef5350', brightGreen: '#43a047',
      brightYellow: '#fdd835', brightBlue: '#42a5f5', brightMagenta: '#ab47bc',
      brightCyan: '#26c6da', brightWhite: '#1a1d21',
    }
  }

  return {
    background: bg, foreground: fg,
    cursor: get('--terminal-cursor') || '#58a6ff',
    cursorAccent: bg,
    selectionBackground: 'rgba(88, 166, 255, 0.25)',
    black: '#0d1117', red: '#f85149', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#8b949e',
    brightBlack: '#484f58', brightRed: '#ff7b72', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d364', brightWhite: '#e6edf3',
  }
}

export function getOrCreateTerminal(id: string, cwd?: string, initialCommand?: string, waitFor?: string): TerminalInstance {
  const existing = registry.get(id)
  if (existing) return existing

  const terminal = new Terminal({
    fontSize: 13,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
    theme: getXtermTheme(),
    allowTransparency: true,
    macOptionClickForcesSelection: true,
    // SearchAddon's decoration overlays (match highlights + active-match
    // border) live behind xterm's "proposed API" flag. Without this the
    // SearchAddon constructor throws on first decoration call and findNext
    // returns false silently — looks like ⌘F can't find anything.
    allowProposedApi: true,
  })

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)

  const searchAddon = new SearchAddon()
  terminal.loadAddon(searchAddon)

  const cleanupFns: (() => void)[] = []

  // Wire PTY I/O. We also stamp `lastOutputAt` on every output chunk
  // so the dirty-pane check on template-switch knows which panes are
  // "live". Cheap — a single Map.set per chunk.
  const removeOutput = window.api.terminal.onOutput((ptyId, data) => {
    if (ptyId === id) {
      terminal.write(data)
      lastOutputAt.set(id, Date.now())
    }
  })
  cleanupFns.push(removeOutput)

  terminal.onData((data) => window.api.terminal.write(id, data))
  terminal.onResize(({ cols, rows }) => window.api.terminal.resize({ id, cols, rows }))

  // Send data directly to PTY (bypass xterm processing)
  const sendToPty = (data: string) => window.api.terminal.write(id, data)

  // macOS keyboard shortcuts
  // Use xterm's onData path (same as normal keystrokes) to ensure
  // the shell receives and interprets sequences correctly
  terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== 'keydown') return true

    // Cmd combos — use Home/End sequences (not Ctrl+A/E which can echo as ^A/^E)
    if (e.metaKey && !e.altKey && !e.ctrlKey) {
      if (e.key === 'Backspace') {
        sendToPty('\x15') // Ctrl+U: kill whole line
        return false
      }
      if (e.key === 'ArrowLeft') {
        sendToPty('\x1bOH') // Home key (xterm application mode)
        return false
      }
      if (e.key === 'ArrowRight') {
        sendToPty('\x1bOF') // End key (xterm application mode)
        return false
      }
      if (e.key === 'k' || e.key === 'K') {
        sendToPty('\x0c') // Ctrl+L: clear screen
        terminal.clear()
        return false
      }
    }

    // Option combos
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === 'Backspace') {
        sendToPty('\x17') // Ctrl+W: backward kill word
        return false
      }
      if (e.key === 'ArrowLeft') {
        sendToPty('\x1b[1;3D') // Matches bindkey in .zshrc
        return false
      }
      if (e.key === 'ArrowRight') {
        sendToPty('\x1b[1;3C') // Matches bindkey in .zshrc
        return false
      }
    }

    // All other keys — let xterm handle natively
    return true
  })

  const instance: TerminalInstance = {
    terminal,
    fitAddon,
    searchAddon,
    container: null,
    ptyId: id,
    opened: false,
    cleanupFns,
  }

  registry.set(id, instance)

  // Create PTY in main process
  window.api.terminal.create({ id, cols: 80, rows: 24, cwd, initialCommand, waitFor })

  return instance
}

export function attachToContainer(id: string, container: HTMLDivElement): void {
  const inst = registry.get(id)
  if (!inst) return

  if (!inst.opened) {
    inst.terminal.open(container)
    inst.opened = true
    inst.container = container
    requestAnimationFrame(() => inst.fitAddon.fit())
  } else if (inst.container !== container) {
    // Re-attach to a different container (shouldn't happen in normal flow)
    container.appendChild(inst.terminal.element!)
    inst.container = container
    requestAnimationFrame(() => inst.fitAddon.fit())
  }
}

export function fitTerminal(id: string): void {
  const inst = registry.get(id)
  if (!inst || !inst.opened) return

  // Only fit if container has dimensions (not hidden)
  const el = inst.container
  if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
    inst.fitAddon.fit()
  }
}

export function fitAllTerminals(): void {
  for (const [id] of registry) {
    fitTerminal(id)
  }
}

export function destroyTerminal(id: string): void {
  const inst = registry.get(id)
  if (!inst) return

  for (const fn of inst.cleanupFns) fn()
  inst.terminal.dispose()
  window.api.terminal.kill(id)
  registry.delete(id)
  lastOutputAt.delete(id)
}

export function updateAllTerminalThemes(): void {
  const theme = getXtermTheme()
  for (const [, inst] of registry) {
    inst.terminal.options.allowTransparency = true
    inst.terminal.options.theme = theme
    // Force canvas re-render for transparency changes
    inst.terminal.refresh(0, inst.terminal.rows - 1)
  }
}

export function hasTerminal(id: string): boolean {
  return registry.has(id)
}

export function focusTerminal(id: string): void {
  const inst = registry.get(id)
  if (!inst || !inst.opened) return
  inst.terminal.focus()
}

export function searchTerminal(id: string, query: string): boolean {
  const inst = registry.get(id)
  if (!inst) return false
  return inst.searchAddon.findNext(query, { regex: false, caseSensitive: false })
}

const SEARCH_OPTS = {
  regex: false,
  caseSensitive: false,
  decorations: {
    matchBackground: 'rgba(255, 200, 80, 0.35)',
    matchBorder: 'rgba(255, 200, 80, 0.8)',
    matchOverviewRuler: '#ffc850',
    activeMatchBackground: 'rgba(255, 200, 80, 0.7)',
    activeMatchBorder: '#ffc850',
    activeMatchColorOverviewRuler: '#ffc850',
  },
} as const

export function searchTerminalNext(id: string, query: string): boolean {
  const inst = registry.get(id)
  if (!inst) return false
  return inst.searchAddon.findNext(query, SEARCH_OPTS)
}

export function searchTerminalPrev(id: string, query: string): boolean {
  const inst = registry.get(id)
  if (!inst) return false
  return inst.searchAddon.findPrevious(query, SEARCH_OPTS)
}

export function clearTerminalSearch(id: string): void {
  const inst = registry.get(id)
  if (!inst) return
  inst.searchAddon.clearDecorations()
}

/**
 * Subscribe to xterm SearchAddon's match-count events. Returns an
 * unsubscribe fn. Used by the in-pane search bar to render `1/12`.
 * `resultIndex === -1` when there's no active match (empty query or
 * no hits); the bar should display `0` in that case.
 */
export function onTerminalSearchResults(
  id: string,
  cb: (info: { resultIndex: number; resultCount: number }) => void,
): () => void {
  const inst = registry.get(id)
  if (!inst) return () => {}
  const disp = inst.searchAddon.onDidChangeResults(cb)
  return () => disp.dispose()
}

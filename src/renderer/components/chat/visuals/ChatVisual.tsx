/**
 * A ```mermaid or ```chart block drawn in a chat message, or at full size in
 * the right pane (variant 'pane'). Header: Source (raw text), Copy (SVG for a
 * diagram, tab-separated data for a chart) and Open in pane / Close.
 *
 * Diagrams render only once scrolled into view, and each result is cached by
 * theme and source, so re-renders and streaming never redraw one.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type RefObject } from 'react'
import {
  chartDataText,
  parseChartSpec,
  renderChart,
  type ChartPalette,
  type VisualKind,
} from '@shared/chat-visuals'
import { createRendererLogger } from '../../../logger'
import { useLayoutStore } from '../../../stores/layout-store'
import { renderDiagram, type DiagramResult, type DiagramTheme } from './diagram-render'

const log = createRendererLogger('chat:visual')

const CHART_PALETTE: ChartPalette = {
  text: 'var(--text-primary)',
  muted: 'var(--text-secondary)',
  grid: 'var(--border)',
  font: 'var(--font-sans)',
  series: ['var(--accent)', 'var(--success)', 'var(--warning)', '#a371f7', '#39c5cf', '#db61a2', 'var(--error)', 'var(--text-muted)'],
}

const CACHE_LIMIT = 64
const diagramCache = new Map<string, Promise<DiagramResult>>()

function cachedDiagram(source: string, themeKey: string): Promise<DiagramResult> {
  const key = `${themeKey}\n${source}`
  let hit = diagramCache.get(key)
  if (!hit) {
    hit = renderDiagram(source, diagramTheme())
    diagramCache.set(key, hit)
    if (diagramCache.size > CACHE_LIMIT) diagramCache.delete(diagramCache.keys().next().value as string)
  }
  return hit
}

function diagramTheme(): DiagramTheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string): string => css.getPropertyValue(name).trim()
  return {
    dark: !document.documentElement.classList.contains('theme-light'),
    surface: v('--bg-tertiary'),
    text: v('--text-primary'),
    line: v('--text-secondary'),
    border: v('--text-muted'),
    font: v('--font-sans'),
  }
}

function subscribeThemeClass(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

/** The theme class on <html>: diagrams redraw (from cache when seen before) when it changes. */
function useThemeClass(): string {
  return useSyncExternalStore(subscribeThemeClass, () => document.documentElement.className)
}

function useInView(enabled: boolean): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(!enabled)
  useEffect(() => {
    const el = ref.current
    if (seen || !el) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true)
    }, { rootMargin: '200px' })
    observer.observe(el)
    return () => observer.disconnect()
  }, [seen])
  return [ref, seen]
}

type Drawn = { status: 'pending' } | { status: 'ok'; markup: string; copyText: string } | { status: 'error'; error: string }

function useDrawn(kind: VisualKind, source: string, visible: boolean): Drawn {
  const themeKey = useThemeClass()
  const chart = useMemo((): Drawn | null => {
    if (kind !== 'chart') return null
    const parsed = parseChartSpec(source)
    return parsed.ok
      ? { status: 'ok', markup: renderChart(parsed.spec, CHART_PALETTE, 620), copyText: chartDataText(parsed.spec) }
      : { status: 'error', error: parsed.error }
  }, [kind, source])
  const [diagram, setDiagram] = useState<{ key: string; drawn: Drawn } | null>(null)
  const key = `${themeKey}\n${source}`

  useEffect(() => {
    if (kind !== 'mermaid' || !visible) return
    let current = true
    cachedDiagram(source, themeKey).then((result) => {
      if (!current) return
      if (!result.ok) log.debug('diagram did not draw', { bytes: new TextEncoder().encode(source).length })
      setDiagram({ key, drawn: result.ok ? { status: 'ok', markup: result.svg, copyText: result.svg } : { status: 'error', error: result.error } })
    }, (error: unknown) => {
      log.warn('diagram render failed', error)
      if (current) setDiagram({ key, drawn: { status: 'error', error: 'The diagram could not be drawn.' } })
    })
    return () => { current = false }
  }, [kind, source, themeKey, visible, key])

  if (chart) return chart
  return diagram?.key === key ? diagram.drawn : { status: 'pending' }
}

/** Belt and braces: the sanitizer already removes links. */
function blockNavigation(event: MouseEvent): void {
  if ((event.target as Element).closest?.('a')) event.preventDefault()
}

const headerButton = 'rounded-[5px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[7px] py-[1px] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'

export function ChatVisual({ kind, source, variant = 'inline' }: {
  kind: VisualKind
  source: string
  variant?: 'inline' | 'pane'
}) {
  const pane = variant === 'pane'
  const [ref, visible] = useInView(!pane)
  const drawn = useDrawn(kind, source, visible)
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const noun = kind === 'mermaid' ? 'Diagram' : 'Chart'

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = (): void => {
    if (drawn.status !== 'ok') return
    navigator.clipboard.writeText(drawn.copyText).then(() => setCopied(true), (error: unknown) => {
      log.warn('visual copy failed', error)
    })
  }

  const sourceView = showSource || drawn.status === 'error'
  const markup = drawn.status === 'ok' ? drawn.markup : ''
  // A new object would make React rewrite the SVG on every render.
  const innerHtml = useMemo(() => ({ __html: markup }), [markup])
  return (
    <div
      ref={ref}
      data-chat-visual={kind}
      className={pane
        ? 'flex h-full w-full flex-col overflow-hidden bg-[var(--bg-primary)]'
        : 'my-[10px] w-[640px] max-w-full overflow-hidden rounded-[8px] border border-[var(--border)] bg-[var(--bg-secondary)]'}
    >
      <div className="flex items-center gap-[8px] border-b border-[var(--border)] px-[10px] py-[6px] text-[12px] text-[var(--text-secondary)]">
        <span className="flex-1">{noun}</span>
        {drawn.status === 'ok' && (
          <>
            <button type="button" className={headerButton} aria-pressed={showSource} onClick={() => setShowSource((s) => !s)}>Source</button>
            <button type="button" className={headerButton} aria-live="polite" onClick={copy}>
              {copied ? 'Copied' : kind === 'mermaid' ? 'Copy SVG' : 'Copy data'}
            </button>
          </>
        )}
        {pane
          ? <button type="button" className={headerButton} onClick={() => useLayoutStore.getState().closePaneVisual()}>Close</button>
          : <button type="button" className={headerButton} onClick={() => useLayoutStore.getState().openPaneVisual({ kind, source })}>Open in pane</button>}
      </div>
      {drawn.status === 'error' && (
        <div role="alert" className="whitespace-pre-wrap px-[10px] pt-[8px] text-[12px] text-[var(--error)]">
          {kind === 'mermaid' ? 'This diagram could not be drawn: ' : 'This chart could not be drawn: '}{drawn.error}
        </div>
      )}
      {sourceView ? (
        <pre className="m-0 overflow-auto p-[10px] font-[family-name:var(--font-mono)] text-[12px] text-[var(--text-primary)]">{source}</pre>
      ) : drawn.status === 'pending' ? (
        <div className="p-[10px] text-[12px] text-[var(--text-muted)]">Drawing {noun.toLowerCase()}...</div>
      ) : (
        <div
          className={pane
            ? 'flex-1 overflow-auto p-[16px] [&_svg]:h-auto [&_svg]:max-w-none'
            : 'max-h-[480px] overflow-auto p-[10px] [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-h-[460px]'}
          onClick={blockNavigation}
          dangerouslySetInnerHTML={innerHtml}
        />
      )}
    </div>
  )
}

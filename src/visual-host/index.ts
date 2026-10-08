/**
 * The page the phones load in a WebView to draw a chat diagram or chart:
 * scripts/build-visual-host.mjs bundles this with Mermaid into one HTML file
 * with no network access (its CSP allows nothing outside the page).
 *
 * The app sends one request as a message, never as markup:
 *   { kind: 'mermaid' | 'chart', source: string, theme: VisualHostTheme }
 * and the page answers with one JSON string:
 *   { type: 'drawn', height: number, svg: string } | { type: 'error', error: string }
 *
 * Android's WebView passes a MessagePort with the request and the answer goes
 * back on it; the Expo app's WebView answers through window.ReactNativeWebView.
 */
import { MAX_VISUAL_SOURCE_CHARS, parseChartSpec, renderChart } from '../shared/chat-visuals'
import { renderDiagram } from '../renderer/components/chat/visuals/diagram-render'

interface VisualHostTheme {
  dark: boolean
  background: string
  surface: string
  text: string
  muted: string
  line: string
  border: string
  font: string
  series: string[]
}

interface VisualHostRequest {
  kind: 'mermaid' | 'chart'
  source: string
  theme: VisualHostTheme
}

const COLOR = /^[#(),.%\w\s-]{1,64}$/

function color(value: unknown): string {
  if (typeof value !== 'string' || !COLOR.test(value)) throw new Error('bad theme colour')
  return value
}

function parseRequest(data: unknown): VisualHostRequest {
  const raw = JSON.parse(typeof data === 'string' ? data : '') as Record<string, unknown>
  const theme = raw.theme as Record<string, unknown>
  if (raw.kind !== 'mermaid' && raw.kind !== 'chart') throw new Error('bad kind')
  if (typeof raw.source !== 'string' || raw.source.length > MAX_VISUAL_SOURCE_CHARS) throw new Error('bad source')
  if (!Array.isArray(theme?.series) || theme.series.length === 0 || theme.series.length > 8) throw new Error('bad theme')
  return {
    kind: raw.kind,
    source: raw.source,
    theme: {
      dark: theme.dark === true,
      background: color(theme.background),
      surface: color(theme.surface),
      text: color(theme.text),
      muted: color(theme.muted),
      line: color(theme.line),
      border: color(theme.border),
      font: color(theme.font),
      series: theme.series.map(color),
    },
  }
}

async function draw(request: VisualHostRequest): Promise<string> {
  const { theme } = request
  document.body.style.background = theme.background
  document.body.style.color = theme.text
  if (request.kind === 'chart') {
    const parsed = parseChartSpec(request.source)
    if (!parsed.ok) throw new Error(parsed.error)
    // The page is as wide as the WebView; #root has 8px padding.
    return renderChart(parsed.spec, { text: theme.text, muted: theme.muted, grid: theme.border, font: theme.font, series: theme.series }, window.innerWidth - 16)
  }
  const result = await renderDiagram(request.source, theme)
  if (!result.ok) throw new Error(result.error)
  return result.svg
}

let handled = false

async function onMessage(event: MessageEvent): Promise<void> {
  // One request per page: a second one (from anything) is ignored.
  if (handled) return
  handled = true
  const port = event.ports?.[0]
  const reply = (answer: object): void => {
    const text = JSON.stringify(answer)
    if (port) port.postMessage(text)
    else (window as unknown as { ReactNativeWebView?: { postMessage(m: string): void } }).ReactNativeWebView?.postMessage(text)
  }
  try {
    const markup = await draw(parseRequest(event.data))
    const root = document.getElementById('root') as HTMLElement
    root.innerHTML = markup
    await new Promise((resolve) => requestAnimationFrame(resolve))
    reply({ type: 'drawn', height: Math.ceil(root.getBoundingClientRect().height), svg: markup })
  } catch (error) {
    reply({ type: 'error', error: error instanceof Error ? error.message.slice(0, 400) : 'The visual could not be drawn.' })
  }
}

window.addEventListener('message', (event) => { void onMessage(event) })
// react-native-webview delivers to document on Android.
document.addEventListener('message', (event) => { void onMessage(event as MessageEvent) })

/**
 * Draws a ```mermaid block to a sanitized SVG string. DOM only, no React and
 * no Electron: the phones' bundled visual host (src/visual-host) runs this same
 * file inside their WebViews.
 *
 * The source is untrusted message text. Mermaid runs with securityLevel
 * 'strict' (labels are escaped, click handlers are off), and its output goes
 * through DOMPurify: no script, no event handler, no link, no reference to
 * anything outside the SVG itself survives.
 */
import DOMPurify from 'dompurify'

export interface DiagramTheme {
  dark: boolean
  /** Node fill. */
  surface: string
  text: string
  line: string
  border: string
  font: string
}

export type DiagramResult = { ok: true; svg: string } | { ok: false; error: string }

/** A reference inside the SVG (url(#arrow), href="#id") is the only one allowed. */
const LOCAL_URL = /^url\(\s*['"]?#/i
const ANY_URL = /url\([^)]*\)/gi

function stripExternalUrls(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '(')
    .replace(ANY_URL, (match) => (LOCAL_URL.test(match) ? match : 'none'))
}

let hooksInstalled = false

function installHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) node.textContent = stripExternalUrls(node.textContent)
  })
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName
    if ((name === 'href' || name === 'xlink:href') && !data.attrValue.trim().startsWith('#')) {
      data.keepAttr = false
    } else if (/url\(/i.test(data.attrValue)) {
      data.attrValue = stripExternalUrls(data.attrValue)
    }
  })
}

export function sanitizeDiagramSvg(svg: string): string {
  installHooks()
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    // <a> goes but its text stays: a diagram link never navigates the app.
    // Labels are SVG text (htmlLabels off), so no HTML island is needed.
    FORBID_TAGS: ['a', 'foreignObject', 'image'],
  })
}

let queue: Promise<unknown> = Promise.resolve()
let renderSeq = 0

/** Mermaid keeps global config, so renders run one at a time. */
export function renderDiagram(source: string, theme: DiagramTheme): Promise<DiagramResult> {
  const run = queue.then(() => renderNow(source, theme))
  queue = run.catch(() => undefined)
  return run
}

async function renderNow(source: string, theme: DiagramTheme): Promise<DiagramResult> {
  const id = `sb-diagram-${++renderSeq}`
  try {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // An init directive or front matter in the message cannot change these:
      // themeCSS is raw CSS, and the rest would undo the settings below.
      secure: [
        'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering',
        'dompurifyConfig', 'htmlLabels', 'flowchart', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'darkMode',
      ],
      suppressErrorRendering: true,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: 'base',
      darkMode: theme.dark,
      fontFamily: theme.font,
      themeVariables: {
        darkMode: theme.dark,
        fontFamily: theme.font,
        fontSize: '13px',
        background: theme.surface,
        primaryColor: theme.surface,
        primaryTextColor: theme.text,
        primaryBorderColor: theme.border,
        secondaryColor: theme.surface,
        tertiaryColor: theme.surface,
        lineColor: theme.line,
        textColor: theme.text,
      },
    })
    const { svg } = await mermaid.render(id, source)
    return { ok: true, svg: sanitizeDiagramSvg(svg) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message.split('\n').slice(0, 4).join('\n').slice(0, 400) || 'The diagram could not be drawn.' }
  } finally {
    // Mermaid measures text in a scratch node and can leave it behind on a parse error.
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

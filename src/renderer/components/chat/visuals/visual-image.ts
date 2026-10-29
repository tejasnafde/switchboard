/**
 * Save image and Copy image for chat visuals: the drawn box as a 2x PNG on
 * the theme's opaque card surface.
 *
 * The chart and diagram SVGs paint with theme variables, which an SVG drawn
 * as an image cannot read, so every `var(--x)` is replaced by its value first.
 */
import { fnv1a64Hex } from '@shared/fnv64'
import type { VisualKind } from '@shared/chat-visuals'
import type { VisualMenuItem } from './VisualMenu'

const VAR_REF = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g

/** Replaces each `var(--name[, fallback])` with `read(name)`, or the fallback when that is empty. */
export function inlineCssVars(markup: string, read: (name: string) => string): string {
  let out = markup
  // A value can itself hold a var(); three passes cover the theme's nesting.
  for (let pass = 0; pass < 3 && out.includes('var('); pass++) {
    out = out.replace(
      VAR_REF,
      (whole, name: string, fallback?: string) => read(name).trim() || fallback?.trim() || whole,
    )
  }
  return out
}

/** `chart-1a2b3c4d` or `diagram-1a2b3c4d`: the same block always gets the same name. */
export function visualFileStem(kind: VisualKind, source: string): string {
  return `${kind === 'mermaid' ? 'diagram' : 'chart'}-${fnv1a64Hex(source).slice(0, 8)}`
}

const COPY_TEXT = {
  chart: { label: 'Copy data', hint: 'TSV' },
  mermaid: { label: 'Copy SVG', hint: 'SVG' },
  'html-live': { label: 'Copy source', hint: 'HTML' },
} as const

/** A visual's dots menu, in order. An action left out (no image yet, no folder to save into) is not listed. */
export function visualMenuItems(
  kind: VisualKind | 'html-live',
  actions: { saveImage?: () => void; copyText: () => void; saveAsFile?: () => void },
): VisualMenuItem[] {
  const items: VisualMenuItem[] = []
  if (actions.saveImage) items.push({ label: 'Save image', hint: 'PNG, 2x', onSelect: actions.saveImage })
  items.push({ ...COPY_TEXT[kind], onSelect: actions.copyText })
  if (actions.saveAsFile) items.push({ label: 'Save as file', hint: '.html', onSelect: actions.saveAsFile })
  return items
}

export interface PngLayout {
  width: number
  height: number
  x: number
  y: number
  svgWidth: number
  svgHeight: number
}

/**
 * The image keeps the box's width (or the SVG's, when wider) and padding. The SVG keeps its drawn width
 * and takes its full height from the viewBox, so a diagram cut off by the
 * card's max height is saved whole.
 */
export function pngLayout(
  box: { width: number; padTop: number; padBottom: number; padRight: number },
  svg: { left: number; width: number },
  viewBox: { width: number; height: number } | null,
  drawnHeight: number,
): PngLayout {
  const svgHeight = viewBox && viewBox.width > 0 ? (svg.width * viewBox.height) / viewBox.width : drawnHeight
  return {
    // A diagram wider than the pane scrolls sideways there; the image holds all of it.
    width: Math.round(Math.max(box.width, svg.left + svg.width + box.padRight)),
    height: Math.round(box.padTop + svgHeight + box.padBottom),
    x: svg.left,
    y: box.padTop,
    svgWidth: svg.width,
    svgHeight,
  }
}

function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name)
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The image could not be drawn.'))
    img.src = url
  })
}

/** `img` drawn at `at` on a `width` x `height` canvas filled with `background`, `scale` times over, as a PNG data URL. */
function drawPng(
  img: HTMLImageElement,
  size: { width: number; height: number },
  at: { x: number; y: number; width: number; height: number },
  scale: number,
  background: string,
): string {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(size.width * scale)
  canvas.height = Math.round(size.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas to draw on.')
  ctx.scale(scale, scale)
  ctx.fillStyle = background
  ctx.fillRect(0, 0, size.width, size.height)
  ctx.drawImage(img, at.x, at.y, at.width, at.height)
  return canvas.toDataURL('image/png')
}

/** A PNG data URL as is; any other image (a tall live page's still is a JPEG) redrawn as a PNG. */
export async function asPng(dataUrl: string): Promise<string> {
  if (dataUrl.startsWith('data:image/png')) return dataUrl
  const img = await loadImage(dataUrl)
  const size = { width: img.naturalWidth, height: img.naturalHeight }
  return drawPng(img, size, { x: 0, y: 0, ...size }, 1, readVar('--bg-secondary').trim())
}

/** The drawn box (an element holding one `<svg>`) as a PNG data URL. */
export async function svgBoxToPng(box: HTMLElement, scale = 2): Promise<string> {
  const svg = box.querySelector('svg')
  if (!svg) throw new Error('Nothing is drawn yet.')
  const style = getComputedStyle(box)
  const boxRect = box.getBoundingClientRect()
  const svgRect = svg.getBoundingClientRect()
  const vb = svg.viewBox?.baseVal
  const layout = pngLayout(
    {
      width: boxRect.width,
      padTop: parseFloat(style.paddingTop) || 0,
      padBottom: parseFloat(style.paddingBottom) || 0,
      padRight: parseFloat(style.paddingRight) || 0,
    },
    { left: svgRect.left - boxRect.left + box.scrollLeft, width: svgRect.width },
    vb && vb.width > 0 ? { width: vb.width, height: vb.height } : null,
    svgRect.height,
  )
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(layout.svgWidth))
  clone.setAttribute('height', String(layout.svgHeight))
  clone.style.maxWidth = ''
  clone.style.maxHeight = ''
  const markup = inlineCssVars(new XMLSerializer().serializeToString(clone), readVar)
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
  try {
    const img = await loadImage(url)
    const at = { x: layout.x, y: layout.y, width: layout.svgWidth, height: layout.svgHeight }
    return drawPng(img, layout, at, scale, readVar('--bg-secondary').trim())
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function copyPngToClipboard(dataUrl: string): Promise<void> {
  const blob = await (await fetch(dataUrl)).blob()
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

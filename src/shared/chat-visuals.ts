/**
 * Diagrams and charts an agent writes into a chat message.
 *
 * Two fenced block kinds are drawn instead of shown as code:
 *
 * - ```mermaid: a Mermaid diagram, drawn by the bundled Mermaid library.
 * - ```chart: a small JSON chart spec (CHART_SPEC_VERSION), drawn by
 *   renderChart below. Every client validates it with parseChartSpec; Android
 *   ports the validator and runs tests/fixtures/chart-spec-cases.json.
 *
 * Chart spec, version 1 (unknown keys are refused, so a typo is reported):
 *
 *   {
 *     "version": 1,                  optional, only 1 is accepted
 *     "type": "bar" | "line" | "table",
 *     "title": "chat.open in ms",    optional, at most 120 chars
 *     "labels": ["long", "short"],   1 to 50 labels, each at most 60 chars
 *     "series": [                    1 to 8 series
 *       { "name": "before", "values": [3800, 1100] }   one finite number per label
 *     ],
 *     "xTitle": "chat", "yTitle": "ms"   optional axis titles, at most 60 chars
 *   }
 *
 * Message text is untrusted: renderChart escapes every string it writes, and
 * only numbers it formatted itself reach an attribute.
 */

export type VisualKind = 'mermaid' | 'chart'

export const CHART_SPEC_VERSION = 1
/** Larger blocks stay plain code: a chat bubble is not a place for them. */
export const MAX_VISUAL_SOURCE_CHARS = 20_000
/** A message with more visual blocks than this draws the first ones only. */
export const MAX_VISUALS_PER_MESSAGE = 12

const MAX_LABELS = 50
const MAX_SERIES = 8
const MAX_LABEL_CHARS = 60
const MAX_TITLE_CHARS = 120

export interface ChartSeries {
  name: string
  values: number[]
}

export interface ChartSpec {
  version: 1
  type: 'bar' | 'line' | 'table'
  title?: string
  labels: string[]
  series: ChartSeries[]
  xTitle?: string
  yTitle?: string
}

export type ChartParse = { ok: true; spec: ChartSpec } | { ok: false; error: string }

export type MessageSegment =
  | { kind: 'markdown'; text: string }
  | { kind: VisualKind; source: string }

/** The fence info string's first word, when it names a visual kind. */
export function visualKindOfInfo(info: string): VisualKind | null {
  const word = info.trim().split(/\s+/)[0]?.toLowerCase()
  return word === 'mermaid' || word === 'chart' ? word : null
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * Splits a message into markdown and visual blocks. Only a top-level fence
 * (at most three spaces of indent, not inside another fence) that is CLOSED
 * becomes a visual, so a block still streaming stays code until its fence
 * closes. Oversized blocks and blocks past MAX_VISUALS_PER_MESSAGE stay code.
 * Returns one markdown segment when there is nothing to draw.
 */
export function splitVisualBlocks(markdown: string): MessageSegment[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const segments: MessageSegment[] = []
  let textStart = 0
  let visuals = 0
  let i = 0
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i])
    // A backtick fence's info string may not contain a backtick (CommonMark).
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) {
      i++
      continue
    }
    const fence = open[1]
    let close = i + 1
    while (close < lines.length && !closesFence(lines[close], fence)) close++
    if (close >= lines.length) break // unclosed: the rest is one code block
    const kind = visualKindOfInfo(open[2])
    const source = lines.slice(i + 1, close).join('\n')
    if (kind && visuals < MAX_VISUALS_PER_MESSAGE && source.trim() !== '' && source.length <= MAX_VISUAL_SOURCE_CHARS) {
      pushMarkdown(segments, lines.slice(textStart, i).join('\n'))
      segments.push({ kind, source })
      visuals++
      textStart = close + 1
    }
    i = close + 1
  }
  if (segments.length === 0) return [{ kind: 'markdown', text: markdown }]
  pushMarkdown(segments, lines.slice(textStart).join('\n'))
  return segments
}

function closesFence(line: string, fence: string): boolean {
  const m = /^ {0,3}([`~]+)[ \t]*$/.exec(line)
  return !!m && m[1].length >= fence.length && [...m[1]].every((c) => c === fence[0])
}

function pushMarkdown(segments: MessageSegment[], text: string): void {
  if (text.trim() !== '') segments.push({ kind: 'markdown', text })
}

// ── chart spec ──────────────────────────────────────────────────────────────

const SPEC_KEYS = new Set(['version', 'type', 'title', 'labels', 'series', 'xTitle', 'yTitle'])
const SERIES_KEYS = new Set(['name', 'values'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalText(obj: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`"${key}" must be a string`)
  if (value.length > max) throw new Error(`"${key}" is longer than ${max} characters`)
  return value
}

function text(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  if (value.length > max) throw new Error(`${path} is longer than ${max} characters`)
  return value
}

function unknownKey(obj: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(obj).find((key) => !allowed.has(key))
}

/** Parses and strictly validates a ```chart block. Never throws. */
export function parseChartSpec(source: string): ChartParse {
  if (source.length > MAX_VISUAL_SOURCE_CHARS) {
    return { ok: false, error: `The chart is longer than ${MAX_VISUAL_SOURCE_CHARS} characters.` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return { ok: false, error: 'The chart is not valid JSON.' }
  }
  try {
    return { ok: true, spec: validate(raw) }
  } catch (error) {
    return { ok: false, error: `${(error as Error).message}.` }
  }
}

function validate(raw: unknown): ChartSpec {
  if (!isRecord(raw)) throw new Error('The chart must be a JSON object')
  const extra = unknownKey(raw, SPEC_KEYS)
  if (extra !== undefined) throw new Error(`Unknown key "${extra}"`)
  if (raw.version !== undefined && raw.version !== CHART_SPEC_VERSION) {
    throw new Error(`Unsupported version; use ${CHART_SPEC_VERSION}`)
  }
  const type = raw.type
  if (type !== 'bar' && type !== 'line' && type !== 'table') {
    throw new Error('"type" must be "bar", "line" or "table"')
  }
  if (!Array.isArray(raw.labels) || raw.labels.length === 0 || raw.labels.length > MAX_LABELS) {
    throw new Error(`"labels" must be a list of 1 to ${MAX_LABELS} strings`)
  }
  const labels = raw.labels.map((label, i) => text(label, `labels[${i}]`, MAX_LABEL_CHARS))
  if (!Array.isArray(raw.series) || raw.series.length === 0 || raw.series.length > MAX_SERIES) {
    throw new Error(`"series" must be a list of 1 to ${MAX_SERIES} series`)
  }
  const series = raw.series.map((entry, s): ChartSeries => {
    if (!isRecord(entry)) throw new Error(`series[${s}] must be an object`)
    const extraKey = unknownKey(entry, SERIES_KEYS)
    if (extraKey !== undefined) throw new Error(`Unknown key "${extraKey}" in series[${s}]`)
    const name = text(entry.name, `series[${s}].name`, MAX_LABEL_CHARS)
    if (!Array.isArray(entry.values) || entry.values.length !== labels.length) {
      throw new Error(`series[${s}].values must have one number per label (${labels.length})`)
    }
    const values = entry.values.map((value, v) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`series[${s}].values[${v}] must be a finite number`)
      }
      return value
    })
    return { name, values }
  })
  const spec: ChartSpec = { version: CHART_SPEC_VERSION, type, labels, series }
  const title = optionalText(raw, 'title', MAX_TITLE_CHARS)
  const xTitle = optionalText(raw, 'xTitle', MAX_LABEL_CHARS)
  const yTitle = optionalText(raw, 'yTitle', MAX_LABEL_CHARS)
  if (title !== undefined) spec.title = title
  if (xTitle !== undefined) spec.xTitle = xTitle
  if (yTitle !== undefined) spec.yTitle = yTitle
  return spec
}

/** The chart's data as tab-separated rows, for Copy (pastes into a spreadsheet). */
export function chartDataText(spec: ChartSpec): string {
  const cell = (value: string): string => value.replace(/[\t\r\n]+/g, ' ')
  const header = [cell(spec.xTitle ?? ''), ...spec.series.map((s) => cell(s.name))].join('\t')
  const rows = spec.labels.map((label, i) => [cell(label), ...spec.series.map((s) => String(s.values[i]))].join('\t'))
  return [header, ...rows].join('\n')
}

// ── chart drawing ───────────────────────────────────────────────────────────

/** CSS colours. The desktop passes var(--...) so a theme change needs no redraw. */
export interface ChartPalette {
  text: string
  muted: string
  grid: string
  font: string
  series: string[]
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Rounded ticks covering [min, max], always including 0. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min)
  const hi = Math.max(0, max)
  if (lo === hi) return [0, 1]
  const rough = (hi - lo) / count
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude
  const ticks: number[] = []
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 1e-9; t += step) {
    ticks.push(Number(t.toPrecision(12)))
  }
  if (ticks[ticks.length - 1] < hi) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)))
  return ticks
}

export function formatChartNumber(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${Number((value / 1e9).toPrecision(3))}B`
  if (abs >= 1e6) return `${Number((value / 1e6).toPrecision(3))}M`
  if (abs >= 1e4) return `${Number((value / 1e3).toPrecision(3))}k`
  return String(Number(value.toPrecision(4)))
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

const H = 260

/**
 * Draws a validated spec: an SVG for bar and line, an HTML table for table.
 * Self-contained markup; every string from the spec is escaped. `width` is
 * the drawing's own width: pass the space it gets so its text is not scaled.
 */
export function renderChart(spec: ChartSpec, palette: ChartPalette, width = 560): string {
  if (spec.type === 'table') return renderTable(spec, palette)
  const W = Math.round(Math.min(1600, Math.max(240, width)))
  const color = (i: number): string => palette.series[i % palette.series.length]
  const values = spec.series.flatMap((s) => s.values)
  const ticks = niceTicks(Math.min(...values), Math.max(...values))
  const lo = ticks[0]
  const hi = ticks[ticks.length - 1]
  const left = spec.yTitle ? 64 : 48
  const top = 28
  const right = W - 12
  const bottom = H - (spec.xTitle ? 44 : 28)
  const y = (v: number): number => bottom - ((v - lo) / (hi - lo)) * (bottom - top)
  const band = (right - left) / spec.labels.length
  const n = (v: number): string => v.toFixed(1)
  const parts: string[] = []
  const style = `font-family:${palette.font};font-size:11px`

  for (const t of ticks) {
    parts.push(`<line x1="${left}" x2="${right}" y1="${n(y(t))}" y2="${n(y(t))}" style="stroke:${palette.grid}"/>`)
    parts.push(`<text x="${left - 6}" y="${n(y(t) + 4)}" text-anchor="end" style="fill:${palette.muted}">${escapeXml(formatChartNumber(t))}</text>`)
  }
  const labelChars = Math.max(3, Math.floor(band / 6.5))
  const labelEvery = Math.max(1, Math.ceil(28 / band))
  spec.labels.forEach((label, i) => {
    if (i % labelEvery !== 0) return
    parts.push(`<text x="${n(left + band * (i + 0.5))}" y="${bottom + 16}" text-anchor="middle" style="fill:${palette.text}"><title>${escapeXml(label)}</title>${escapeXml(truncate(label, labelChars * labelEvery))}</text>`)
  })

  if (spec.type === 'bar') {
    const groupWidth = band * 0.7
    const barWidth = groupWidth / spec.series.length
    spec.series.forEach((series, s) => {
      series.values.forEach((value, i) => {
        const x = left + band * i + (band - groupWidth) / 2 + barWidth * s
        const y0 = y(Math.max(0, value))
        const height = Math.abs(y(value) - y(0))
        parts.push(`<rect x="${n(x)}" y="${n(y0)}" width="${n(Math.max(1, barWidth - 2))}" height="${n(height)}" style="fill:${color(s)}"><title>${escapeXml(`${series.name}, ${spec.labels[i]}: ${series.values[i]}`)}</title></rect>`)
      })
    })
  } else {
    spec.series.forEach((series, s) => {
      const points = series.values.map((value, i) => `${n(left + band * (i + 0.5))},${n(y(value))}`)
      parts.push(`<polyline points="${points.join(' ')}" style="fill:none;stroke:${color(s)};stroke-width:2"/>`)
      series.values.forEach((value, i) => {
        parts.push(`<circle cx="${n(left + band * (i + 0.5))}" cy="${n(y(value))}" r="3" style="fill:${color(s)}"><title>${escapeXml(`${series.name}, ${spec.labels[i]}: ${value}`)}</title></circle>`)
      })
    })
  }

  // Legend, right-aligned along the top. Widths are estimates: SVG has no text measuring.
  let lx = right
  for (let s = spec.series.length - 1; s >= 0; s--) {
    const name = truncate(spec.series[s].name, 20)
    lx -= name.length * 6 + 22
    parts.push(`<rect x="${lx}" y="8" width="8" height="8" style="fill:${color(s)}"/>`)
    parts.push(`<text x="${lx + 12}" y="16" style="fill:${palette.muted};font-size:10px">${escapeXml(name)}</text>`)
  }
  if (spec.xTitle) {
    parts.push(`<text x="${n((left + right) / 2)}" y="${H - 8}" text-anchor="middle" style="fill:${palette.muted}">${escapeXml(spec.xTitle)}</text>`)
  }
  if (spec.yTitle) {
    parts.push(`<text transform="translate(14 ${n((top + bottom) / 2)}) rotate(-90)" text-anchor="middle" style="fill:${palette.muted}">${escapeXml(spec.yTitle)}</text>`)
  }
  const label = escapeXml(spec.title ?? `${spec.type} chart`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${label}" style="${style}">${parts.join('')}</svg>`
}

function renderTable(spec: ChartSpec, palette: ChartPalette): string {
  const cell = 'padding:4px 10px;border-bottom:1px solid'
  const head = [`<th style="${cell} ${palette.grid};text-align:left;color:${palette.muted}">${escapeXml(spec.xTitle ?? '')}</th>`]
  for (const s of spec.series) head.push(`<th style="${cell} ${palette.grid};text-align:right;color:${palette.muted}">${escapeXml(s.name)}</th>`)
  const rows = spec.labels.map((label, i) => {
    const cells = spec.series.map((s) => `<td style="${cell} ${palette.grid};text-align:right;font-variant-numeric:tabular-nums">${escapeXml(String(s.values[i]))}</td>`)
    return `<tr><td style="${cell} ${palette.grid}">${escapeXml(label)}</td>${cells.join('')}</tr>`
  })
  return `<table style="border-collapse:collapse;font-family:${palette.font};font-size:12px;color:${palette.text}"><thead><tr>${head.join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
}

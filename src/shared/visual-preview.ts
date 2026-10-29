/**
 * `preview_visual`: the agent sends one ```mermaid, ```chart or ```html-live
 * block and gets back the image the desktop would draw, before it posts the
 * block. The pure rules: the flag, argument parsing, the caps and the reply.
 */
import { MAX_VISUAL_SOURCE_CHARS, parseChartSpec, visualKindOfInfo } from './chat-visuals'
import { HTML_LIVE_FENCE, htmlLiveRejection, htmlLiveVerdict } from './html-live'
import type { SettingReader } from './limit-resume'

/**
 * Staged flag `agent_visual_preview`. Off until it has run in real chats.
 * `SB_AGENT_VISUAL_PREVIEW=1` in Switchboard's own env, or the labs setting,
 * turns it on.
 */
export const AGENT_VISUAL_PREVIEW_ENABLED = false
export const AGENT_VISUAL_PREVIEW_LABS_SETTING = 'labs.agent_visual_preview'

export function agentVisualPreviewEnabled(env: NodeJS.ProcessEnv, getSetting: SettingReader): boolean {
  return (
    AGENT_VISUAL_PREVIEW_ENABLED ||
    env.SB_AGENT_VISUAL_PREVIEW === '1' ||
    getSetting(AGENT_VISUAL_PREVIEW_LABS_SETTING) === 'true'
  )
}

export const VISUAL_PREVIEW_TOOL = 'preview_visual'
/** Previews per chat per turn; a turn's end gives them back. */
export const VISUAL_PREVIEW_MAX_PER_TURN = 5
/** The whole render, from the request to the image. */
export const VISUAL_PREVIEW_TIMEOUT_MS = 20_000

export type VisualPreviewKind = 'mermaid' | 'chart' | 'html-live'

export interface VisualPreviewRequest {
  /** The chat as the registry and the renderer know it, and its root id. */
  threadId: string
  chatId: string
  kind: VisualPreviewKind
  source: string
}

export type VisualPreviewResult =
  | {
      ok: true
      /** A PNG (or JPEG, past the image cap) data URL of the block as the chat shows it. */
      image: string
      /** The page's full content height in CSS px; the image stops at the folded frame. */
      contentHeight: number
      frameHeight: number
      width: number
      errors: string[]
      blocked: string[]
    }
  /** `parse`: the block itself is wrong (the chart or diagram error). Anything else: the render failed. */
  | { ok: false; error: string; parse?: boolean }

export const VISUAL_PREVIEW_INSTRUCTIONS = [
  `${VISUAL_PREVIEW_TOOL} draws a block the way this chat would and returns the image, the content height and any`,
  'console, chart or diagram errors. Before you post a complex ```html-live page (scripts, a library, a layout you',
  'have not checked), pass it to preview_visual once, fix what it shows, then post it. Do not preview a simple block,',
  `and do not call it more than ${VISUAL_PREVIEW_MAX_PER_TURN} times in a turn. Nothing it draws is shown to the user.`,
].join(' ')

const KINDS: readonly VisualPreviewKind[] = ['mermaid', 'chart', HTML_LIVE_FENCE]
const FENCE = /^\s*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n?[ ]{0,3}\1[`~]*\s*$/

function kindOfInfo(info: string): VisualPreviewKind | null {
  const word = info.trim().split(/\s+/)[0]?.toLowerCase()
  return word === HTML_LIVE_FENCE ? HTML_LIVE_FENCE : visualKindOfInfo(info)
}

/**
 * `{ block }` (one whole fence) or `{ body, kind }`. Checks the caps the chat
 * applies, and a chart's spec, before anything renders.
 */
export function parseVisualPreviewArgs(
  args: Record<string, unknown>,
): { ok: true; kind: VisualPreviewKind; source: string } | { ok: false; error: string; parse?: boolean } {
  let kind: VisualPreviewKind | null
  let source: string
  if (typeof args.block === 'string') {
    const m = FENCE.exec(args.block)
    if (!m) return { ok: false, error: 'block must be one fenced block: ```mermaid, ```chart or ```html-live.' }
    kind = kindOfInfo(m[2])
    source = m[3]
    if (!kind) return { ok: false, error: `The fence must be one of ${KINDS.join(', ')}.` }
  } else if (typeof args.body === 'string') {
    kind = KINDS.includes(args.kind as VisualPreviewKind) ? (args.kind as VisualPreviewKind) : null
    source = args.body
    if (!kind) return { ok: false, error: `With body, kind must be one of ${KINDS.join(', ')}.` }
  } else {
    return { ok: false, error: 'Pass block (one fenced block) or body with kind.' }
  }
  if (!source.trim()) return { ok: false, error: 'The block is empty.' }
  if (kind === HTML_LIVE_FENCE) {
    const verdict = htmlLiveVerdict(source)
    if (!verdict.ok) return { ok: false, error: htmlLiveRejection(verdict).replace('This page', 'The page') }
    return { ok: true, kind, source }
  }
  if (source.length > MAX_VISUAL_SOURCE_CHARS)
    return {
      ok: false,
      error: `The block is ${source.length} characters; the chat draws ${kind} blocks up to ${MAX_VISUAL_SOURCE_CHARS}.`,
    }
  if (kind === 'chart') {
    const parsed = parseChartSpec(source)
    if (!parsed.ok) return { ok: false, error: `The chart could not be drawn: ${parsed.error}`, parse: true }
  }
  return { ok: true, kind, source }
}

/** What the agent reads next to the image. */
export function visualPreviewSummary(result: Extract<VisualPreviewResult, { ok: true }>): string {
  const lines = [
    `Drawn at ${result.width} px wide. Content height ${Math.ceil(result.contentHeight)} px; the image is the ${result.frameHeight} px the chat shows${result.contentHeight > result.frameHeight ? ', so the rest folds behind Show all' : ''}.`,
  ]
  lines.push(result.errors.length ? `Console errors:\n${result.errors.join('\n')}` : 'No console errors.')
  if (result.blocked.length)
    lines.push(`Blocked requests (there is no network, put the data inline):\n${result.blocked.join('\n')}`)
  return lines.join('\n')
}

/**
 * `preview_visual` on the Switchboard MCP server (flag `agent_visual_preview`).
 *
 * The desktop renders the block in a hidden frame of the live page sandbox
 * (`main/preview/visual-preview-host.ts`, which sets the renderer here) and
 * answers the image; nothing is posted or stored. A backend with no desktop
 * window process (the headless server) never sets a renderer, so the tool is
 * not offered there at all.
 */
import {
  VISUAL_PREVIEW_MAX_PER_TURN,
  VISUAL_PREVIEW_TIMEOUT_MS,
  VISUAL_PREVIEW_TOOL,
  parseVisualPreviewArgs,
  visualPreviewSummary,
  type VisualPreviewRequest,
  type VisualPreviewResult,
} from '@shared/visual-preview'
import { createMainLogger } from '../logger'
import { toolText, type McpTool, type McpToolResult } from './mcp-session'

const log = createMainLogger('mcp:visual-preview')

export type VisualPreviewRenderer = (request: VisualPreviewRequest, signal: AbortSignal) => Promise<VisualPreviewResult>

let renderer: VisualPreviewRenderer | null = null

/** Set once by the desktop; the headless server leaves it null. */
export function setVisualPreviewRenderer(next: VisualPreviewRenderer | null): void {
  renderer = next
}

export function visualPreviewRenderer(): VisualPreviewRenderer | null {
  return renderer
}

/** Previews per chat in the running turn. The registry resets a chat when its turn ends. */
export class VisualPreviewTurnCounter {
  private readonly used = new Map<string, number>()

  take(chatId: string): boolean {
    const n = this.used.get(chatId) ?? 0
    if (n >= VISUAL_PREVIEW_MAX_PER_TURN) return false
    this.used.set(chatId, n + 1)
    return true
  }

  reset(chatId: string): void {
    this.used.delete(chatId)
  }
}

export interface VisualPreviewToolDeps {
  threadId: string
  chatId: () => string
  render: VisualPreviewRenderer
  counter: VisualPreviewTurnCounter
  timeoutMs?: number
}

export function buildVisualPreviewTool(deps: VisualPreviewToolDeps): McpTool {
  return {
    name: VISUAL_PREVIEW_TOOL,
    description:
      'Draw one ```mermaid, ```chart or ```html-live block the way this chat shows it, without posting it. Returns a ' +
      'PNG, the content height and console, chart or diagram errors. Same sandbox and size limits as the posted block. ' +
      'Use it on a complex html-live page before you post it.',
    inputSchema: {
      type: 'object',
      properties: {
        block: { type: 'string', description: 'One whole fenced block, fences included.' },
        body: { type: 'string', description: 'The block body without fences; needs kind.' },
        kind: { type: 'string', enum: ['mermaid', 'chart', 'html-live'] },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Preview a visual', readOnlyHint: true, openWorldHint: false },
    async call(args, ctx): Promise<McpToolResult> {
      const parsed = parseVisualPreviewArgs(args)
      if (!parsed.ok) return toolText(parsed.error, true)
      const chatId = deps.chatId()
      if (!deps.counter.take(chatId))
        return toolText('Preview limit reached for this turn. Post the block, or preview again in a later turn.', true)
      const controller = new AbortController()
      const onAbort = (): void => controller.abort()
      ctx.signal.addEventListener('abort', onAbort)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeoutMs = deps.timeoutMs ?? VISUAL_PREVIEW_TIMEOUT_MS
      try {
        const result = await Promise.race([
          deps.render({ threadId: deps.threadId, chatId, kind: parsed.kind, source: parsed.source }, controller.signal),
          new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs))),
        ])
        if (!result) {
          log.warn('preview timed out', { kind: parsed.kind, bytes: parsed.source.length })
          return toolText(
            `The preview did not finish in ${timeoutMs / 1000} s. Simplify the block and try again.`,
            true,
          )
        }
        if (!result.ok) return toolText(result.error, true)
        const comma = result.image.indexOf(',')
        const mimeType = /^data:([^;,]+)/.exec(result.image)?.[1] ?? 'image/png'
        return {
          content: [
            { type: 'image', data: result.image.slice(comma + 1), mimeType },
            { type: 'text', text: visualPreviewSummary(result) },
          ],
        }
      } finally {
        clearTimeout(timer)
        controller.abort()
        ctx.signal.removeEventListener('abort', onAbort)
      }
    },
  }
}

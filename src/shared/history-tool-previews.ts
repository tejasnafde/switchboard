import type { ChatMessage, ToolCall } from './types'

export const HISTORY_TOOL_PREVIEWS_CAPABILITY = 'history_tool_previews_v1'

/** A tool call whose input and output fit these limits travels in full. */
export const TOOL_INPUT_PREVIEW_CHARS = 2_000
export const TOOL_OUTPUT_PREVIEW_CHARS = 2_000
/** Each string inside a JSON input keeps this much, so the collapsed row
 *  (a command, a file path) still reads the same. */
const INPUT_STRING_PREVIEW_CHARS = 200

const cut = (text: string, chars: number) => text.length > chars ? `${text.slice(0, chars)}…` : text

function previewValue(value: unknown): unknown {
  if (typeof value === 'string') return cut(value, INPUT_STRING_PREVIEW_CHARS)
  if (Array.isArray(value)) return value.map(previewValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, previewValue(inner)]))
  }
  return value
}

function previewInput(input: string): string {
  if (input.length <= TOOL_INPUT_PREVIEW_CHARS) return input
  const parsed = parseJson(input)
  const short = parsed === undefined ? undefined : JSON.stringify(previewValue(parsed))
  // Not JSON, or still long once its strings are cut: cut the text itself.
  return short !== undefined && short.length <= TOOL_INPUT_PREVIEW_CHARS ? short : cut(input, TOOL_INPUT_PREVIEW_CHARS)
}

/** Plain-text inputs are expected (not every tool sends JSON), so a miss is not logged. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The call itself when it is small; else a short copy marked `preview`. */
export function toolCallPreview(call: ToolCall): ToolCall {
  const longInput = call.input.length > TOOL_INPUT_PREVIEW_CHARS
  const longOutput = (call.output?.length ?? 0) > TOOL_OUTPUT_PREVIEW_CHARS
  if (!longInput && !longOutput) return call
  return {
    ...call,
    input: previewInput(call.input),
    ...(call.output === undefined ? {} : { output: cut(call.output, TOOL_OUTPUT_PREVIEW_CHARS) }),
    preview: true,
  }
}

/** Swap long tool calls for previews; `app:load-tool-call` serves them in full. */
export function toolCallsByPreview(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.toolCalls?.length) return message
    const toolCalls = message.toolCalls.map(toolCallPreview)
    return toolCalls.every((call, index) => call === message.toolCalls![index]) ? message : { ...message, toolCalls }
  })
}

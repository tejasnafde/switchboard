/** Windowed history shortens long tool calls only when asked, and serves them back whole. */
import { describe, expect, it, vi } from 'vitest'
import { TOOL_INPUT_PREVIEW_CHARS, TOOL_OUTPUT_PREVIEW_CHARS, toolCallPreview, toolCallsByPreview } from '../../src/shared/history-tool-previews'
import { summarizeTool } from '../../src/shared/tool-summary'
import { holdsWholeHistory } from '../../src/renderer/services/history-window'
import type { ChatMessage, ToolCall } from '../../src/shared/types'

const bash: ToolCall = { id: 't1', name: 'Bash', input: JSON.stringify({ command: 'npm test', description: 'run' }), output: 'x'.repeat(50_000) }
const write: ToolCall = { id: 't2', name: 'Write', input: JSON.stringify({ file_path: 'src/a.ts', content: 'y'.repeat(20_000) }), output: 'ok' }
const small: ToolCall = { id: 't3', name: 'Read', input: JSON.stringify({ file_path: 'src/b.ts' }), output: 'short' }
const history: ChatMessage[] = [
  { id: 'a1', role: 'assistant', content: '', timestamp: 1, toolCalls: [bash, write, small] },
  { id: 'a2', role: 'assistant', content: 'done', timestamp: 2 },
]

const memo = vi.hoisted(() => ({ messages: undefined as ChatMessage[] | undefined, loads: 0 }))
vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end: () => {} }) }))
vi.mock('../../src/main/db/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/db/database')>()),
  getConversationById: (id: string) => id === 'gone' ? undefined : ({ id, project_path: '/repo', agent_type: 'claude-code', title: 'Chat', status_line: 'x' }),
  resolveRootThreadId: () => 'root',
  getSessionLayout: () => null,
  getConversationForkMetadata: () => null,
}))
vi.mock('../../src/main/conversations/history', () => ({
  loadConversationHistory: async () => {
    memo.loads += 1
    return { messages: history, diskMessageCount: 2, databaseMessageCount: 0, familyIds: ['c1'] }
  },
  mergedHistoryMessages: () => memo.messages,
}))

const { registerAppHandlers } = await import('../../src/main/ipc/app')
const { AppChannels } = await import('../../src/shared/ipc-channels')

function handlers() {
  const map = new Map<string, (...args: unknown[]) => Promise<any>>()
  registerAppHandlers({ handle: (c: string, h: (...args: unknown[]) => Promise<any>) => map.set(c, h), emit: () => {} } as never, {})
  return map
}

describe('toolCallPreview', () => {
  it('keeps a small call as it is', () => {
    expect(toolCallPreview(small)).toBe(small)
  })

  it('shortens a long output and keeps the collapsed row the same', () => {
    const preview = toolCallPreview(bash)
    expect(preview).toMatchObject({ id: 't1', name: 'Bash', input: bash.input, preview: true })
    expect(preview.output!.length).toBe(TOOL_OUTPUT_PREVIEW_CHARS + 1)
    expect(summarizeTool('Bash', JSON.parse(preview.input))).toEqual(summarizeTool('Bash', JSON.parse(bash.input)))
  })

  it('shortens the strings of a long JSON input and keeps it JSON', () => {
    const preview = toolCallPreview(write)
    const input = JSON.parse(preview.input)
    expect(input.file_path).toBe('src/a.ts')
    expect(input.content.length).toBeLessThan(300)
    expect(preview.output).toBe('ok')
  })

  it('cuts a long input that is not JSON', () => {
    const preview = toolCallPreview({ id: 't4', name: 'x', input: 'z'.repeat(10_000) })
    expect(preview.input.length).toBe(TOOL_INPUT_PREVIEW_CHARS + 1)
    expect(preview.output).toBeUndefined()
  })

  it('leaves messages without long calls untouched', () => {
    const out = toolCallsByPreview(history)
    expect(out[1]).toBe(history[1])
    expect(out[0].toolCalls![2]).toBe(small)
  })
})

describe('load-session-by-id tool previews', () => {
  it('sends whole calls to a client that does not ask (phones, older desktops)', async () => {
    const resp = await handlers().get(AppChannels.LOAD_SESSION_BY_ID)!('c1', { window: true, limit: 200 })
    expect(resp.messages[0].toolCalls[0]).toEqual(bash)
  })

  it('sends previews when asked and serves the whole call from the memo', async () => {
    const map = handlers()
    const resp = await map.get(AppChannels.LOAD_SESSION_BY_ID)!('c1', { window: true, limit: 200, toolPreviews: true })
    expect(resp.messages[0].toolCalls[0].preview).toBe(true)
    expect(JSON.stringify(resp).length).toBeLessThan(10_000)
    memo.messages = history
    const before = memo.loads
    expect(await map.get(AppChannels.LOAD_TOOL_CALL)!('c1', 'a1', 't2')).toEqual({ toolCall: write })
    expect(memo.loads).toBe(before)
  })

  it('reads the history when the memo misses, and misses cleanly', async () => {
    memo.messages = undefined
    const map = handlers()
    const before = memo.loads
    expect(await map.get(AppChannels.LOAD_TOOL_CALL)!('c1', 'a1', 't1')).toEqual({ toolCall: bash })
    expect(memo.loads).toBe(before + 1)
    expect(await map.get(AppChannels.LOAD_TOOL_CALL)!('c1', 'a1', 'nope')).toEqual({ toolCall: null })
    expect(await map.get(AppChannels.LOAD_TOOL_CALL)!('gone', 'a1', 't1')).toEqual({ toolCall: null })
  })
})

describe('holdsWholeHistory', () => {
  it('is false while a tool call is a preview, so an export reloads it', () => {
    expect(holdsWholeHistory({ messages: history })).toBe(true)
    expect(holdsWholeHistory({ messages: toolCallsByPreview(history) })).toBe(false)
  })
})

describe('load-tool-call for a call still running', () => {
  it('reads the history instead of trusting a memo copy without output', async () => {
    const running: ToolCall = { id: 't9', name: 'Write', input: write.input }
    memo.messages = [{ id: 'a9', role: 'assistant', content: '', timestamp: 9, toolCalls: [running] }]
    const before = memo.loads
    await handlers().get(AppChannels.LOAD_TOOL_CALL)!('c1', 'a9', 't9')
    expect(memo.loads).toBe(before + 1)
  })
})

/**
 * Reopening a thread keeps a finished turn's tool row and its changed-file
 * group. The renderer builds both live and never saved them, so a reload
 * rebuilt the turn from the provider transcript plus the SQLite mirror:
 * Claude's transcript keeps its tool_use lines, Codex's parser drops every
 * tool call, and nothing kept the file cards at all. The registry now mirrors
 * both rows, and the merge must fold a mirrored tool row into the transcript
 * copy of the same call instead of showing it twice.
 *
 * The fixtures are redacted copies of real transcripts: a Claude Code session
 * JSONL and a Codex rollout file, same line shapes, values replaced.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JsonlParser, type JsonlSource } from '../../src/main/agent/jsonl-parser'
import { mergeConversationMessages } from '../../src/main/agent/dedupe-messages'
import { projectTurnPresentation } from '../../src/renderer/components/chat/turnPresentation'
import { groupIntoTurns } from '../../src/renderer/components/chat/MessageList'
import { fileDiffRowId, toolRowId } from '../../src/shared/turn-activity'
import type { ChatMessage, ToolCall } from '../../src/shared/types'

const at = (iso: string) => Date.parse(`2026-09-24T10:00:${iso}Z`)

function parseFixture(name: string, source: JsonlSource): ChatMessage[] {
  const out: ChatMessage[] = []
  const parser = new JsonlParser((m) => out.push(m), source)
  parser.feed(readFileSync(join(__dirname, '../fixtures/reopen-tool-rows', name), 'utf8'))
  parser.flush()
  return out
}

/** What the registry mirrors for one turn, keyed the way the live stream is. */
function mirrorRows(tools: ToolCall[], toolAt: number[]): ChatMessage[] {
  return [
    { id: 'live_user', role: 'user', content: 'fix the state check', timestamp: at('00.005') },
    { id: 'live_text_1', role: 'assistant', content: 'Moving the state check ahead of the token exchange.', timestamp: at('03.100') },
    ...tools.map((call, i): ChatMessage => ({
      id: toolRowId(call.id), role: 'assistant', content: '', timestamp: toolAt[i], toolCalls: [call],
    })),
    { id: 'live_text_2', role: 'assistant', content: 'Done. Review the diff below.', timestamp: at('07.100') },
    {
      id: fileDiffRowId('ab12cd34-1:src/api/auth.ts'), role: 'assistant', content: '', timestamp: at('07.300'),
      fileDiff: {
        fileEditId: 'ab12cd34-1:src/api/auth.ts', repoRoot: '/work/acme', relPath: 'src/api/auth.ts',
        changeKind: 'modify', oldContent: 'a\n', newContent: 'b\n', status: 'accepted',
      },
    },
  ]
}

/** The assistant turn as the chat renders it. */
function renderedTurn(messages: ChatMessage[]): string[] {
  const assistant = groupIntoTurns(messages).find((turn) => turn[0].role === 'assistant') ?? []
  return projectTurnPresentation(assistant).map((item) =>
    item.kind === 'message' ? `text:${item.message.content.split(' ')[0]}`
      : item.kind === 'activity' ? `tools:${item.toolCount}`
        : `files:${item.messages.length}`)
}

describe('reopening a Claude chat', () => {
  const disk = parseFixture('claude-session.jsonl', 'claude-code')
  const edit: ToolCall = { id: 'toolu_01Redacted', name: 'Edit', input: '{}', output: 'The file has been updated.' }

  it('the transcript alone keeps the tool call but not the changed files', () => {
    expect(renderedTurn(mergeConversationMessages(disk, []))).toEqual(['text:Moving', 'tools:1', 'text:Done.'])
  })

  it('shows one tool row, with its output, and the changed files', () => {
    const merged = mergeConversationMessages(disk, mirrorRows([edit], [at('04.050')]))
    expect(renderedTurn(merged)).toEqual(['text:Moving', 'tools:1', 'text:Done.', 'files:1'])
    const calls = merged.flatMap((m) => m.toolCalls ?? [])
    expect(calls).toEqual([expect.objectContaining({ id: 'toolu_01Redacted', output: 'The file has been updated.' })])
    expect(merged.find((m) => m.fileDiff)?.fileDiff?.status).toBe('accepted')
  })

  it('does not write the output into the cached transcript messages', () => {
    mergeConversationMessages(disk, mirrorRows([edit], [at('04.050')]))
    expect(disk.flatMap((m) => m.toolCalls ?? [])[0].output).toBeUndefined()
  })
})

describe('reopening a Codex chat', () => {
  const disk = parseFixture('codex-rollout.jsonl', 'codex')
  const calls: ToolCall[] = [
    { id: 'item_exec', name: 'Bash', input: '{}', output: 'Script completed' },
    { id: 'item_wait', name: 'wait', input: '{}', output: 'ok' },
  ]

  it('the rollout alone yields no tool rows: its parser reads messages only', () => {
    expect(disk.some((m) => m.toolCalls?.length)).toBe(false)
    expect(renderedTurn(mergeConversationMessages(disk, []))).toEqual(['text:Moving', 'text:Done.'])
  })

  it('shows the mirrored tool rows between the texts, then the changed files', () => {
    const merged = mergeConversationMessages(disk, mirrorRows(calls, [at('04.000'), at('05.000')]))
    expect(renderedTurn(merged)).toEqual(['text:Moving', 'tools:2', 'text:Done.', 'files:1'])
  })
})

describe('mirrored activity rows in the merge', () => {
  it('never pairs two different empty-content rows that are close in time', () => {
    const diskTool: ChatMessage = {
      id: 'uuid-1', role: 'assistant', content: '', timestamp: 1000,
      toolCalls: [{ id: 'toolu_a', name: 'Read', input: '{}' }],
    }
    const mirrored: ChatMessage[] = [
      { id: toolRowId('toolu_b'), role: 'assistant', content: '', timestamp: 1500, toolCalls: [{ id: 'toolu_b', name: 'Bash', input: '{}' }] },
      {
        id: fileDiffRowId('x-1:a.ts'), role: 'assistant', content: '', timestamp: 1600,
        fileDiff: { fileEditId: 'x-1:a.ts', repoRoot: '/r', relPath: 'a.ts', changeKind: 'add', oldContent: '', newContent: 'a', status: 'pending' },
      },
    ]
    const merged = mergeConversationMessages([diskTool], mirrored)
    expect(merged.map((m) => m.id)).toEqual(['uuid-1', toolRowId('toolu_b'), fileDiffRowId('x-1:a.ts')])
  })
})

import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatLoadTiming } from '../../src/shared/perf-chat'
import type { ChatMessage } from '../../src/shared/types'
import { JsonlParser } from '../../src/main/agent/jsonl-parser'
import { mergeConversationMessages } from '../../src/main/agent/dedupe-messages'
import { listSubagentTranscripts, loadSubagentSteps } from '../../src/main/agent/subagent-transcripts'
import { groupSubagentEntries } from '../../src/shared/subagent-steps'
import { splitSyntheticUserText } from '../../src/shared/synthetic-message'

const root = mkdtempSync(join(tmpdir(), 'sb-subagent-transcripts-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const line = (record: object) => JSON.stringify(record)
const timing = (): ChatLoadTiming => ({
  readMs: 0,
  parseMs: 0,
  diskMs: 0,
  dbMs: 0,
  mergeMs: 0,
  enrichMs: 0,
  diskBytes: 0,
  diskLines: 0,
  cacheHits: 0,
  prefixSkips: 0,
})

function parse(lines: object[]): ChatMessage[] {
  const out: ChatMessage[] = []
  const parser = new JsonlParser((m) => out.push(m))
  parser.feed(lines.map(line).join('\n') + '\n')
  return out
}

const agentUse = {
  type: 'assistant',
  uuid: 'p1',
  timestamp: '2026-10-12T10:00:00.000Z',
  message: {
    content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Audit deps' } }],
  },
}
const agentResult = {
  type: 'user',
  uuid: 'p2',
  timestamp: '2026-10-12T10:06:02.000Z',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_agent',
        content: [
          { type: 'text', text: 'All clear.' },
          { type: 'text', text: 'agentId: a1 (use SendMessage)' },
        ],
      },
    ],
  },
}

describe('JsonlParser tool results', () => {
  it("keeps an Agent call's report and marks a failed call, without other outputs", () => {
    const messages = parse([
      agentUse,
      {
        type: 'assistant',
        uuid: 'p3',
        message: { content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'false' } }] },
      },
      {
        type: 'user',
        uuid: 'p4',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'Exit code 1', is_error: true }],
        },
      },
      agentResult,
    ])
    const calls = messages.flatMap((m) => m.toolCalls ?? [])
    expect(calls.find((c) => c.id === 'toolu_agent')).toMatchObject({
      output: 'All clear.\nagentId: a1 (use SendMessage)',
    })
    expect(calls.find((c) => c.id === 'toolu_bash')).toEqual({
      id: 'toolu_bash',
      name: 'Bash',
      input: '{\n  "command": "false"\n}',
      isError: true,
    })
  })
})

describe('subagent transcripts', () => {
  const project = join(root, 'projects', '-repo')
  const session = join(project, 'sess.jsonl')
  const subagents = join(project, 'sess', 'subagents')
  mkdirSync(subagents, { recursive: true })
  writeFileSync(session, [agentUse, agentResult].map(line).join('\n') + '\n')
  writeFileSync(join(subagents, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'toolu_agent', spawnDepth: 1 }))
  writeFileSync(join(subagents, 'agent-broken.meta.json'), '{')
  writeFileSync(
    join(subagents, 'agent-a1.jsonl'),
    [
      { type: 'user', uuid: 's1', isSidechain: true, message: { role: 'user', content: 'Audit the deps please' } },
      {
        type: 'assistant',
        uuid: 's2',
        isSidechain: true,
        timestamp: '2026-10-12T10:01:00.000Z',
        message: { content: [{ type: 'text', text: 'Looking at the lockfile.' }] },
      },
      {
        type: 'assistant',
        uuid: 's3',
        isSidechain: true,
        timestamp: '2026-10-12T10:02:00.000Z',
        message: { content: [{ type: 'tool_use', id: 'toolu_sub_bash', name: 'Bash', input: { command: 'npm ls' } }] },
      },
      {
        type: 'user',
        uuid: 's4',
        isSidechain: true,
        timestamp: '2026-10-12T10:03:00.000Z',
        message: {
          content:
            '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_sub_bash</tool-use-id>\n<status>completed</status>\n<summary>Background command "npm ls" completed (exit code 0)</summary>\n</task-notification>',
        },
      },
    ]
      .map(line)
      .join('\n') + '\n',
  )

  it('lists transcripts by the Agent call their meta names, skipping an unreadable meta', async () => {
    expect(await listSubagentTranscripts(session)).toEqual([
      { toolUseId: 'toolu_agent', path: join(subagents, 'agent-a1.jsonl') },
    ])
    expect(await listSubagentTranscripts(join(project, 'none.jsonl'))).toEqual([])
  })

  it('loads tool calls stamped with the Agent call and notices, never the prompt or prose', async () => {
    const sources: unknown[] = []
    const steps = await loadSubagentSteps([join(project, 'missing.jsonl'), session], timing(), sources)
    expect(sources).toHaveLength(1)
    expect(steps.map((m) => m.id)).toEqual(['s3', 's4'])
    expect(steps[0].toolCalls?.[0].parentToolCallId).toBe('toolu_agent')
    expect(splitSyntheticUserText(steps[1].content)?.parts[0]).toMatchObject({ toolUseId: 'toolu_sub_bash' })
  })

  it('groups a reloaded chat the way a live one groups', async () => {
    const disk = [...parse([agentUse, agentResult]), ...(await loadSubagentSteps([session], timing(), []))]
    const history = mergeConversationMessages(disk, [])
    const grouping = groupSubagentEntries(history, (m) => ({
      toolCalls: m.toolCalls,
      noticeToolUseId: splitSyntheticUserText(m.content)?.parts.find((p) => p.kind === 'task-notification')?.toolUseId,
    }))
    expect(grouping.topLevel.map((m) => m.id)).toEqual(['p1'])
    expect(grouping.stepsByAgent.get('toolu_agent')?.map((m) => m.id)).toEqual(['s3', 's4'])
  })

  it("takes a mirrored row's error flag and Agent call onto the transcript's call", () => {
    const disk = parse([
      {
        type: 'assistant',
        uuid: 'x1',
        timestamp: '2026-10-12T10:00:00.000Z',
        message: { content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} }] },
      },
    ])
    const mirrored: ChatMessage = {
      id: 'tool_t:toolu_b',
      role: 'assistant',
      content: '',
      timestamp: disk[0].timestamp,
      toolCalls: [{ id: 'toolu_b', name: 'Bash', input: '{}', output: 'boom', isError: true, parentToolCallId: 'A' }],
    }
    expect(mergeConversationMessages(disk, [mirrored])[0].toolCalls?.[0]).toMatchObject({
      output: 'boom',
      isError: true,
      parentToolCallId: 'A',
    })
  })
})

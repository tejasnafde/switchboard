import { createMigratedDb } from './helpers/test-db'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertHubChild, insertHubWake } from '../../src/main/db/database'
import { parseReadChildArgs, readChild, readChildWindow } from '../../src/main/hub/hub-read'
import type { ChatMessage } from '../../src/shared/types'

const msg = (i: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  content: `message ${i}`,
  timestamp: 1_700_000_000_000 + i,
  ...extra,
})

const history = (n: number) => Array.from({ length: n }, (_, i) => msg(i))

describe('readChildWindow', () => {
  it('returns the newest messages by default', () => {
    const w = readChildWindow(history(50), {})
    expect(w.messages.map((m) => m.id)).toEqual(Array.from({ length: 20 }, (_, i) => `m${30 + i}`))
    expect(w.nextOffset).toBeNull()
  })

  it('starts at a pointer: a message id or a tool call id', () => {
    const all = history(50)
    all[10] = msg(10, { toolCalls: [{ id: 'call_x', name: 'mcp__switchboard__report_to_hub', input: '{}' }] })
    expect(readChildWindow(all, { at: 'call_x', limit: 5 })).toMatchObject({ start: 10, nextOffset: 15 })
    expect(readChildWindow(all, { at: 'm40' }).start).toBe(40)
  })

  it('falls back to the newest messages when the pointer is not found', () => {
    expect(readChildWindow(history(50), { at: 'nope' })).toMatchObject({ start: 30, pointerFound: false })
  })

  it('pages by absolute offset and caps the limit at 200', () => {
    expect(readChildWindow(history(500), { offset: 100, limit: 1000 })).toMatchObject({ start: 100, nextOffset: 300 })
  })

  it('searches the whole history, text and tool calls', () => {
    const all = history(50)
    all[3] = msg(3, { toolCalls: [{ id: 't', name: 'Bash', input: 'npm run Deploy', output: 'ok' }] })
    const w = readChildWindow(all, { query: 'deploy' })
    expect(w.messages.map((m) => m.id)).toEqual(['m3'])
    expect(w.total).toBe(1)
  })
})

describe('parseReadChildArgs', () => {
  it('refuses bad input', () => {
    expect(parseReadChildArgs({})).toMatch(/childId/)
    expect(parseReadChildArgs({ childId: 'c', limit: -1 })).toMatch(/limit/)
    expect(parseReadChildArgs({ childId: 'c', offset: 1.5 })).toMatch(/offset/)
    expect(parseReadChildArgs({ childId: ' c ', at: 'x' })).toEqual({ childId: 'c', at: 'x' })
  })
})

describe('readChild', () => {
  beforeEach(() => {
    createMigratedDb()
    insertHubChild({
      childId: 'agent_child',
      parentId: 'agent_parent',
      batchId: 'b1',
      ordinal: 0,
      title: 'Fix login',
      brief: 'Do it',
      location: 'worktree',
      grantedMode: 'sandbox',
      depsMode: 'none',
    })
  })

  const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text

  it('refuses a chat that is not its own child', async () => {
    const r = await readChild({ parentId: 'agent_other', load: async () => history(3) }, { childId: 'agent_child' })
    expect(r.isError).toBe(true)
  })

  it('returns a report_to_hub call whole and clips other tool output', async () => {
    const report = 'R'.repeat(10_000)
    const all = [
      msg(0, {
        toolCalls: [
          { id: 'call_r', name: 'mcp__switchboard__report_to_hub', input: JSON.stringify({ report }) },
          { id: 'call_b', name: 'Bash', input: 'ls', output: 'x'.repeat(10_000) },
        ],
      }),
    ]
    const r = await readChild(
      { parentId: 'agent_parent', load: async () => all },
      { childId: 'agent_child', at: 'call_r' },
    )
    const body = JSON.parse(text(r))
    expect(body.messages[0].tools[0].input).toContain(report)
    expect(body.messages[0].tools[1].output.length).toBeLessThan(3000)
  })

  it('reports a failed load as an error, not a gone transcript', async () => {
    const r = await readChild(
      {
        parentId: 'agent_parent',
        load: async () => {
          throw new Error('disk')
        },
      },
      { childId: 'agent_child' },
    )
    expect(r.isError).toBe(true)
    expect(text(r)).not.toContain('gone')
  })

  it('reads the stored rows when the pointer file is gone', async () => {
    insertHubWake({
      id: 'w1',
      parentId: 'agent_parent',
      childId: 'agent_child',
      kind: 'report',
      summary: 'Login fixed.',
      pointer: { childId: 'agent_child', at: 1, transcriptPath: '/gone/session.jsonl' },
    })
    const r = await readChild(
      { parentId: 'agent_parent', load: async () => history(3), exists: () => false },
      { childId: 'agent_child' },
    )
    expect(JSON.parse(text(r)).total).toBe(3)
  })

  it('says the transcript is gone and gives the summary', async () => {
    insertHubWake({
      id: 'w1',
      parentId: 'agent_parent',
      childId: 'agent_child',
      kind: 'report',
      summary: 'Login fixed.',
      pointer: { childId: 'agent_child', at: 1, transcriptPath: '/gone/session.jsonl' },
    })
    const r = await readChild(
      { parentId: 'agent_parent', load: async () => [], exists: () => false },
      { childId: 'agent_child' },
    )
    expect(text(r)).toBe(
      'The transcript of Fix login is gone (/gone/session.jsonl). Only its summary is left: Login fixed.',
    )
  })
})

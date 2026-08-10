/**
 * The two tools the Claude model calls to reach a sibling session.
 *
 * The handlers are tested apart from the SDK because their contract with the
 * MODEL is the whole product here: an id it can pass back verbatim, and a
 * refusal it can read and adapt to instead of retrying blindly. A thrown MCP
 * error would reach the model as a stack, so every failure has to come back as
 * tool output.
 */
import { describe, it, expect } from 'vitest'
import {
  createPeerToolHandlers,
  PEER_LIST_TOOL,
  PEER_LIST_TOOL_DESCRIPTION,
  PEER_LIST_TOOL_NAME,
  PEER_SEND_TOOL,
  PEER_SEND_TOOL_DESCRIPTION,
  PEER_SEND_TOOL_NAME,
  PEER_TOOL_SERVER_NAME,
  type PeerSessionSummary,
  type PeerToolHost,
} from '../../src/main/provider/peer-tools'
import type { PeerMessageInput } from '../../src/shared/peer-messaging'

const sibling: PeerSessionSummary = {
  sessionId: 'agent_1712',
  title: 'API refactor',
  folder: '/repo/api',
  provider: 'codex',
  midTurn: false,
}

function fakeHost(over: Partial<PeerToolHost> = {}) {
  const delivered: PeerMessageInput[] = []
  const host: PeerToolHost = {
    listPeerSessions: () => [sibling],
    deliverPeerMessage: async (input) => {
      delivered.push(input)
      return { id: 'pm_0123456789abcdef' }
    },
    ...over,
  }
  return { host, delivered }
}

const text = (result: { content: Array<{ text: string }> }) =>
  result.content.map((c) => c.text).join('\n')

describe('peer tool identity', () => {
  it('names the tools as the model and canUseTool see them', () => {
    expect(PEER_LIST_TOOL).toBe(`mcp__${PEER_TOOL_SERVER_NAME}__${PEER_LIST_TOOL_NAME}`)
    expect(PEER_SEND_TOOL).toBe(`mcp__${PEER_TOOL_SERVER_NAME}__${PEER_SEND_TOOL_NAME}`)
    expect(PEER_LIST_TOOL_NAME).toBe('list_agent_sessions')
    expect(PEER_SEND_TOOL_NAME).toBe('send_agent_message')
  })

  // The descriptions ARE the documentation the model reads every turn, so the
  // four things it gets wrong without them are asserted rather than trusted.
  it('tells the model what the send tool is not for', () => {
    expect(PEER_SEND_TOOL_DESCRIPTION).toMatch(/delegate/i)
    expect(PEER_SEND_TOOL_DESCRIPTION).toMatch(/approve/i)
    expect(PEER_SEND_TOOL_DESCRIPTION).toMatch(/self-contained|standalone/i)
    expect(PEER_SEND_TOOL_DESCRIPTION).toMatch(/cannot see your/i)
  })

  it('points the list tool at the send tool', () => {
    expect(PEER_LIST_TOOL_DESCRIPTION).toContain(PEER_SEND_TOOL_NAME)
  })
})

describe('list_agent_sessions', () => {
  it('reports every field the model needs to pick a target', async () => {
    const { host } = fakeHost()
    const out = await createPeerToolHandlers(host, 'sender').listSessions()
    const body = text(out)
    expect(out.isError).toBeFalsy()
    expect(body).toContain('agent_1712')
    expect(body).toContain('API refactor')
    expect(body).toContain('/repo/api')
    expect(body).toContain('codex')
  })

  it('asks the host for the sessions other than its own', async () => {
    let askedFor = ''
    const { host } = fakeHost({
      listPeerSessions: (fromThreadId) => {
        askedFor = fromThreadId
        return []
      },
    })
    await createPeerToolHandlers(host, 'sender').listSessions()
    expect(askedFor).toBe('sender')
  })

  // An empty list is an answer, not a failure - the model should stop looking
  // for a target rather than treat this as a broken tool and retry.
  it('says so plainly when nothing else is open', async () => {
    const { host } = fakeHost({ listPeerSessions: () => [] })
    const out = await createPeerToolHandlers(host, 'sender').listSessions()
    expect(out.isError).toBeFalsy()
    expect(text(out)).toMatch(/no other/i)
  })

  it('marks a session that is mid-turn', async () => {
    const { host } = fakeHost({ listPeerSessions: () => [{ ...sibling, midTurn: true }] })
    expect(text(await createPeerToolHandlers(host, 'sender').listSessions())).toContain('midTurn')
  })
})

describe('send_agent_message', () => {
  it('delivers through the host as an agent-initiated send', async () => {
    const { host, delivered } = fakeHost()
    const out = await createPeerToolHandlers(host, 'sender').sendMessage({
      sessionId: 'agent_1712',
      message: 'the auth migration landed on main',
    })

    expect(out.isError).toBeFalsy()
    expect(delivered).toEqual([{
      fromThreadId: 'sender',
      targetThreadId: 'agent_1712',
      text: 'the auth migration landed on main',
      initiator: 'agent',
    }])
  })

  // The model has to be told the peer answers elsewhere, or it waits for a
  // reply that is never coming and burns the turn.
  it('confirms delivery and says no reply comes back', async () => {
    const { host } = fakeHost()
    const out = await createPeerToolHandlers(host, 'sender').sendMessage({
      sessionId: 'agent_1712',
      message: 'ready',
    })
    expect(text(out)).toMatch(/delivered/i)
    expect(text(out)).toMatch(/own transcript|no reply|nothing comes back/i)
  })

  it('returns a refusal as tool output, not as a throw', async () => {
    const { host } = fakeHost({
      deliverPeerMessage: async () => {
        throw new Error('"API refactor" is mid-turn and cannot take a message yet.')
      },
    })
    const out = await createPeerToolHandlers(host, 'sender').sendMessage({
      sessionId: 'agent_1712',
      message: 'ready',
    })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain('mid-turn')
  })

  it('refuses an empty message without spending a send', async () => {
    const { host, delivered } = fakeHost()
    const out = await createPeerToolHandlers(host, 'sender').sendMessage({
      sessionId: 'agent_1712',
      message: '   ',
    })
    expect(out.isError).toBe(true)
    expect(delivered).toHaveLength(0)
  })

  it('refuses a missing target without spending a send', async () => {
    const { host, delivered } = fakeHost()
    const out = await createPeerToolHandlers(host, 'sender').sendMessage({
      sessionId: '',
      message: 'ready',
    })
    expect(out.isError).toBe(true)
    expect(text(out)).toContain(PEER_LIST_TOOL_NAME)
    expect(delivered).toHaveLength(0)
  })
})

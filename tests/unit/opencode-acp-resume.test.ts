/**
 * OpenCode resume: a chat (or a native fork) goes on in the ACP session its
 * typed segment records, when the agent advertises session/resume, and
 * reports the session it ended up in so the registry records it.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  capabilities: {} as Record<string, unknown>,
  resumeFails: false,
  segment: null as null | { provider_session_id: string; provider_instance_id: string | null },
  calls: [] as string[],
}))

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.kill = vi.fn()
    return child
  }),
}))

// The version gate has its own tests; it must not run a real binary here.
vi.mock('../../src/main/provider/adapters/opencode/version', () => ({ assertSupportedOpencode: async () => {} }))

vi.mock('../../src/main/provider/adapters/opencode/env', () => ({
  findOpencodePath: () => '/usr/local/bin/opencode',
  buildOpencodeEnv: (overlay: Record<string, string>) => ({ ...overlay }),
}))

vi.mock('../../src/main/db/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/db/database')>()),
  resolveResumeSegment: () => state.segment,
}))

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentclientprotocol/sdk')>()
  class FakeConnection {
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: state.capabilities }
    }
    async resumeSession(params: { sessionId: string }) {
      state.calls.push(`resume:${params.sessionId}`)
      if (state.resumeFails) throw new Error('Internal error: OpenCode service failure')
      return {}
    }
    async newSession() {
      state.calls.push('new')
      return { sessionId: 'ses_new' }
    }
    async setSessionMode() {
      return {}
    }
  }
  return { ...actual, ClientSideConnection: FakeConnection, ndJsonStream: () => ({}) }
})

async function start(instanceId: string | null = 'oc') {
  const { OpencodeAcpAdapter } = await import('../../src/main/provider/adapters/opencode-acp-adapter')
  const onEvent = vi.fn()
  await new OpencodeAcpAdapter().startSession(
    {
      threadId: 'fork-1',
      provider: 'opencode',
      cwd: '/tmp/project',
      runtimeMode: 'sandbox',
      instanceId: instanceId ?? undefined,
    },
    onEvent,
  )
  return onEvent.mock.calls.map(([event]) => event)
}

beforeEach(() => {
  state.capabilities = { sessionCapabilities: { resume: {} } }
  state.resumeFails = false
  state.segment = { provider_session_id: 'ses_forked', provider_instance_id: 'oc' }
  state.calls = []
})

describe('OpenCode session resume', () => {
  it('resumes the recorded session and reports it', async () => {
    const events = await start()
    expect(state.calls).toEqual(['resume:ses_forked'])
    expect(events).toContainEqual({ type: 'session', threadId: 'fork-1', sessionId: 'ses_forked' })
  })

  it('starts a new session when the agent cannot resume', async () => {
    state.capabilities = {}
    const events = await start()
    expect(state.calls).toEqual(['new'])
    expect(events).toContainEqual({ type: 'session', threadId: 'fork-1', sessionId: 'ses_new' })
  })

  it('never resumes a session recorded under another instance', async () => {
    state.segment = { provider_session_id: 'ses_other', provider_instance_id: 'other' }
    await start()
    expect(state.calls).toEqual(['new'])
  })

  it('never resumes an instance-bound session when no instance was resolved', async () => {
    await start(null)
    expect(state.calls).toEqual(['new'])
  })

  it('says so and starts a new session when resume fails', async () => {
    state.resumeFails = true
    const events = await start()
    expect(state.calls).toEqual(['resume:ses_forked', 'new'])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Could not resume OpenCode session ses_forked'),
      }),
    )
    expect(events).toContainEqual({ type: 'session', threadId: 'fork-1', sessionId: 'ses_new' })
  })
})

/**
 * OpenCode 2.x (behind the `opencode_v2_acp` flag) through the one ACP
 * adapter: `acp` with no `--cwd`, and a `provider/model/variant` pick split
 * across the `model` and `effort` config options. The fake agent answers in
 * the shapes a live 2.0.29 sent (model options without variants; an `effort`
 * option per model, gone for a model with none; an unknown effort refused).
 * A 1.x binary keeps its command line and its model ids whole.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { RuntimeEvent } from '../../src/main/provider/types'

const VARIANTS: Record<string, string[]> = { 'anthropic/sonnet': ['high', 'max', 'default'], 'opencode/big-pickle': [] }

const state = vi.hoisted(() => ({
  generation: 2 as 1 | 2,
  withEffort: true,
  spawns: [] as string[][],
  calls: [] as string[],
  model: 'anthropic/sonnet',
  effort: 'default',
}))

vi.mock('cross-spawn', () => ({
  default: vi.fn((_bin: string, args: string[]) => {
    state.spawns.push(args)
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.kill = vi.fn()
    return child
  }),
}))

vi.mock('../../src/main/provider/adapters/opencode/version', () => ({
  assertSupportedOpencode: async () => state.generation,
}))

vi.mock('../../src/main/provider/adapters/opencode/env', () => ({
  findOpencodePath: () => '/usr/local/bin/opencode',
  buildOpencodeEnv: (overlay: Record<string, string>) => ({ ...overlay }),
}))

vi.mock('../../src/main/db/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/db/database')>()),
  resolveResumeSegment: () => null,
}))

function configOptions(): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: state.model,
      options: Object.keys(VARIANTS).map((value) => ({ value, name: value })),
    },
  ]
  const levels = VARIANTS[state.model] ?? []
  if (state.withEffort && levels.length > 0) {
    options.push({
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: state.effort,
      options: levels.map((value) => ({ value, name: value })),
    })
  }
  return options
}

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentclientprotocol/sdk')>()
  class FakeConnection {
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: {} }
    }
    async newSession() {
      return { sessionId: 'ses_1', configOptions: configOptions() }
    }
    async setSessionMode() {
      return {}
    }
    async setSessionConfigOption(params: { configId: string; value: string }) {
      state.calls.push(`${params.configId}=${params.value}`)
      if (params.configId === 'model') {
        // A different model starts at its base level; reselecting one keeps it.
        if (params.value !== state.model) state.effort = 'default'
        state.model = params.value
      } else if (!(VARIANTS[state.model] ?? []).includes(params.value)) {
        throw new Error(`Invalid params: effort not found: ${params.value}`)
      } else {
        state.effort = params.value
      }
      return { configOptions: configOptions() }
    }
    async request(method: string) {
      state.calls.push(method)
      return {}
    }
  }
  return { ...actual, ClientSideConnection: FakeConnection, ndJsonStream: () => ({}) }
})

async function start(model?: string) {
  const { OpencodeAcpAdapter } = await import('../../src/main/provider/adapters/opencode-acp-adapter')
  const events: RuntimeEvent[] = []
  const adapter = new OpencodeAcpAdapter()
  await adapter.startSession(
    { threadId: 't1', provider: 'opencode', cwd: '/tmp/project', runtimeMode: 'sandbox', model },
    (event) => events.push(event),
  )
  return { adapter, events }
}

function variantEvents(events: RuntimeEvent[]) {
  return events.filter((e) => e.type === 'model.variants')
}

// The adapter's first import is slow on a loaded machine; take it out of the first test's time.
beforeAll(async () => {
  await import('../../src/main/provider/adapters/opencode-acp-adapter')
}, 60_000)

beforeEach(() => {
  state.generation = 2
  state.withEffort = true
  state.spawns = []
  state.calls = []
  state.model = 'anthropic/sonnet'
  state.effort = 'default'
})

describe('OpenCode 2.x over ACP', () => {
  it('spawns acp with no --cwd', async () => {
    await start()
    expect(state.spawns).toEqual([['acp']])
  })

  it('splits a variant pick into the model and effort options', async () => {
    const { events } = await start('anthropic/sonnet/high')
    expect(state.calls).toEqual(['model=anthropic/sonnet', 'effort=high'])
    expect(variantEvents(events).at(-1)).toEqual({
      type: 'model.variants',
      threadId: 't1',
      modelId: 'anthropic/sonnet',
      availableVariants: ['high', 'max'],
      currentVariant: 'high',
    })
  })

  it('reports the starting model variants when no model is pushed', async () => {
    const { events } = await start()
    expect(state.calls).toEqual([])
    expect(variantEvents(events)).toEqual([
      expect.objectContaining({ modelId: 'anthropic/sonnet', availableVariants: ['high', 'max'], currentVariant: '' }),
    ])
  })

  it('clears the variants for a model with none, and never sets effort on it', async () => {
    const { adapter, events } = await start('anthropic/sonnet/max')
    await adapter.setModel('t1', 'opencode/big-pickle')
    expect(state.calls).toEqual(['model=anthropic/sonnet', 'effort=max', 'model=opencode/big-pickle'])
    expect(variantEvents(events).at(-1)).toEqual(
      expect.objectContaining({ modelId: 'opencode/big-pickle', availableVariants: [], currentVariant: '' }),
    )
  })

  it('goes back to the base level when the pick names no variant', async () => {
    const { adapter, events } = await start('anthropic/sonnet/high')
    state.calls = []
    await adapter.setModel('t1', 'anthropic/sonnet')
    expect(state.calls).toEqual(['model=anthropic/sonnet', 'effort=default'])
    expect(variantEvents(events).at(-1)).toEqual(expect.objectContaining({ currentVariant: '' }))
  })

  it('does not set a variant the model does not offer', async () => {
    const { adapter } = await start('anthropic/sonnet')
    state.calls = []
    await adapter.setModel('t1', 'anthropic/sonnet/ultra')
    expect(state.calls).toEqual(['model=anthropic/sonnet'])
  })
})

describe('model picks one at a time', () => {
  it('sends only the latest of picks made together, and reports only its variants', async () => {
    const { adapter, events } = await start()
    state.calls = []
    const before = variantEvents(events).length
    await Promise.all([
      adapter.setModel('t1', 'anthropic/sonnet/high'),
      adapter.setModel('t1', 'anthropic/sonnet/max'),
      adapter.setModel('t1', 'opencode/big-pickle'),
    ])
    expect(state.calls).toEqual(['model=opencode/big-pickle'])
    expect(variantEvents(events).slice(before)).toEqual([
      expect.objectContaining({ modelId: 'opencode/big-pickle', availableVariants: [] }),
    ])
  })

  it('runs a pick made while another is in flight after it, never before', async () => {
    const { adapter } = await start()
    state.calls = []
    const first = adapter.setModel('t1', 'anthropic/sonnet/high')
    await Promise.resolve()
    await Promise.resolve()
    const second = adapter.setModel('t1', 'opencode/big-pickle')
    await Promise.all([first, second])
    expect(state.calls.at(-1)).toBe('model=opencode/big-pickle')
    expect(state.model).toBe('opencode/big-pickle')
  })
})

describe('OpenCode 1.x over the same adapter', () => {
  beforeEach(() => {
    state.generation = 1
    state.withEffort = false
  })

  it('keeps --cwd and sends a model id whole, with no variants event', async () => {
    const { events } = await start('anthropic/sonnet/high')
    expect(state.spawns).toEqual([['acp', '--cwd', '/tmp/project']])
    expect(state.calls).toEqual(['model=anthropic/sonnet/high'])
    expect(variantEvents(events)).toEqual([])
  })
})

describe('session config helpers', () => {
  it('splits only an id the catalog does not list whole', async () => {
    const { splitConfigModelId } = await import('../../src/main/provider/adapters/acp/session-config')
    const catalog = ['anthropic/sonnet', 'openrouter/meta/llama']
    expect(splitConfigModelId('anthropic/sonnet/high', catalog)).toEqual({ model: 'anthropic/sonnet', variant: 'high' })
    expect(splitConfigModelId('openrouter/meta/llama', catalog)).toEqual({
      model: 'openrouter/meta/llama',
      variant: '',
    })
    expect(splitConfigModelId('other/model/high', catalog)).toEqual({ model: 'other/model/high', variant: '' })
  })

  it('reads the effort option by id or by category, and maps default to the base model', async () => {
    const { effortFromConfigOptions, configEffortVariants } =
      await import('../../src/main/provider/adapters/acp/session-config')
    state.model = 'anthropic/sonnet'
    const effort = effortFromConfigOptions(configOptions())
    expect(effort).toEqual({ configId: 'effort', current: 'default', values: ['high', 'max', 'default'] })
    expect(effortFromConfigOptions(configOptions(), 'missing')).toBeNull()
    expect(configEffortVariants(effort!)).toEqual({ available: ['high', 'max'], current: '' })
  })

  it('drops only a child session text chunk', async () => {
    const { isChildSessionText } = await import('../../src/main/provider/adapters/acp/acp-adapter')
    const child = { 'opencode/child-session': { id: 'ses_child', parentID: 'ses_1', depth: 1 } }
    const text = { type: 'text' as const, text: 'x' }
    expect(isChildSessionText({ sessionUpdate: 'agent_message_chunk', content: text, _meta: child })).toBe(true)
    expect(isChildSessionText({ sessionUpdate: 'agent_thought_chunk', content: text, _meta: child })).toBe(true)
    expect(isChildSessionText({ sessionUpdate: 'agent_message_chunk', content: text })).toBe(false)
    expect(
      isChildSessionText({ sessionUpdate: 'tool_call', toolCallId: 'ses_child:call_1', title: 'shell', _meta: child }),
    ).toBe(false)
  })
})

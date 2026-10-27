/**
 * The registry shrinks every image to MAX_IMAGE_LONG_SIDE before the adapter
 * gets it, on the typed submit and on the legacy send, whatever the client.
 */
import { describe, expect, it, vi } from 'vitest'
import './helpers/registry-session-mocks'
import { PNG } from 'pngjs'

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string) => ({
    id: 'work',
    agentType,
    displayName: 'Work',
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  getProviderInstanceFull: () => null,
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  deleteUserMessage: () => true,
  getConversationById: (id: string) => ({ id }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  setConversationRuntimeMode: () => {},
  getConversationModel: () => null,
  getConversationReasoningEffort: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: () => null,
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { UserTurnSubmissionV1 } from '../../src/shared/provider-events'
import type { AtomicUserTurnContext } from '../../src/main/provider/durable-turn-acceptance'

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(): void {}
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    return (await this.handlers.get(channel)!(...args)) as T
  }
}

class ImageAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  sent: Array<Array<{ url: string }> | undefined> = []
  async startSession(opts: SessionStartOpts): Promise<ProviderSession> {
    return {
      threadId: opts.threadId,
      provider: 'claude',
      status: 'idle',
      runtimeMode: 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  async sendTurn(_threadId: string, _message: string, _mode?: unknown, images?: Array<{ url: string }>): Promise<void> {
    this.sent.push(images)
  }
  async setRuntimeMode(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

const passThroughSubmission = {
  async submit(input: UserTurnSubmissionV1, context: AtomicUserTurnContext) {
    await context.prepare()
    await context.dispatch(context.finalize ? await context.finalize(input) : input)
    return {
      status: 'accepted' as const,
      accepted: true as const,
      duplicate: false,
      state: 'completed' as const,
      acceptedAt: 1,
    }
  },
}

function widePng(): string {
  const image = new PNG({ width: 2048, height: 512 })
  image.data.fill(90)
  return `data:image/png;base64,${PNG.sync.write(image).toString('base64')}`
}

const sentWidth = (url: string) => PNG.sync.read(Buffer.from(url.split(',')[1], 'base64')).width

async function setup() {
  const host = new FakeHost()
  const adapter = new ImageAdapter()
  const registry = new ProviderRegistry(host, new Map([['claude', adapter]]), undefined, passThroughSubmission)
  registry.registerIpcHandlers()
  await host.invoke(ProviderChannels.START_SESSION, { threadId: 't1', provider: 'claude', cwd: '/tmp' })
  return { host, adapter }
}

describe('provider image limit in the registry', () => {
  it('shrinks a 2048 px image on the typed submit (phones, desktop)', async () => {
    const t = await setup()
    await t.host.invoke(ProviderChannels.SUBMIT_USER_TURN, {
      version: 1,
      threadId: 't1',
      origin: 'phone-1',
      providerText: 'look',
      images: [{ url: widePng(), mimeType: 'image/png' }],
    })
    expect(sentWidth(t.adapter.sent[0]![0].url)).toBe(2000)
  })

  it('shrinks a 2048 px image on the legacy send (older phone builds)', async () => {
    const t = await setup()
    await t.host.invoke(ProviderChannels.SEND_TURN, 't1', 'look', undefined, [
      { url: widePng(), mimeType: 'image/png' },
    ])
    expect(sentWidth(t.adapter.sent[0]![0].url)).toBe(2000)
  })
  it('rejects a turn with a GIF over the limit before the adapter sees it', async () => {
    const t = await setup()
    const gif = Buffer.alloc(13)
    gif.write('GIF89a')
    gif.writeUInt16LE(2048, 6)
    gif.writeUInt16LE(10, 8)
    await expect(
      t.host.invoke(ProviderChannels.SUBMIT_USER_TURN, {
        version: 1,
        threadId: 't1',
        origin: 'phone-2',
        providerText: 'look',
        images: [{ url: `data:image/gif;base64,${gif.toString('base64')}`, name: 'party.gif' }],
      }),
    ).rejects.toThrow('party.gif is 2048 px on its long side')
    expect(t.adapter.sent).toEqual([])
  })
})

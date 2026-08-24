import { describe, expect, it, vi } from 'vitest'
import { WorktreeCreationChannels } from '../../src/shared/ipc-channels'
import type { Transport } from '../../src/shared/transport'
import type {
  WorktreeCreationActionRequest,
  WorktreeCreationProgressEvent,
  WorktreeCreationRequest,
  WorktreeCreationSnapshot,
} from '../../src/shared/worktree-creation'
import { SwitchboardClient } from '../../apps/mobile/src/lib/api'
import {
  createNewSessionCreationCoordinator,
  newSessionCreationActions,
  type MobileNewSessionIntent,
} from '../../apps/mobile/src/lib/newSessionCreation'
import {
  createMobileNewSessionCreationStorage,
  type AsyncKeyValueStorage,
  type PersistedMobileNewSessionCreation,
} from '../../apps/mobile/src/lib/newSessionCreationStorage'

const intent: MobileNewSessionIntent = {
  connectionId: 'connection-1',
  machineId: 'connection-1',
  projectPath: '/repo',
  projectName: 'Switchboard',
  checkout: {
    kind: 'worktree',
    baseRef: 'main',
    branchSeed: 'mobile-worktree',
    setupPolicy: 'skip',
  },
  conversation: { id: 'mobile-thread-1', agentType: 'claude-code' },
  provider: { kind: 'claude', runtimeMode: 'sandbox' },
  firstMessage: 'Keep this exact prompt.',
}

function snapshot(overrides: Partial<WorktreeCreationSnapshot> = {}): WorktreeCreationSnapshot {
  return {
    creationId: 'creation-mobile-1',
    revision: 2,
    phase: 'materializing',
    status: 'pending',
    projectPath: '/canonical/repo',
    worktreePath: '/canonical/repo/.switchboard/worktrees/mobile-worktree',
    branch: 'sb/mobile-worktree',
    baseRef: 'main',
    owner: {
      kind: 'conversation',
      conversationId: 'mobile-thread-1',
      agentType: 'claude-code',
    },
    purpose: 'new-chat',
    provenance: {
      surface: 'react-native',
      machineId: 'connection-1',
      requestedAt: 1_000,
    },
    warnings: [],
    recoveryActions: [],
    updatedAt: 1_001,
    ...overrides,
  }
}

function readySnapshot(): WorktreeCreationSnapshot {
  return snapshot({
    revision: 6,
    phase: 'ready',
    status: 'ready',
    worktreeId: 'worktree-mobile-1',
    startupReceipt: {
      status: 'succeeded',
      terminalIds: [],
      providerThreadId: 'mobile-thread-1',
      initialPromptOrigin: 'worktree-creation:creation-mobile-1',
    },
  })
}

function worktreeRequest(): WorktreeCreationRequest {
  return {
    schemaVersion: 1,
    creationId: 'creation-mobile-1',
    repository: { projectPath: '/repo', machineId: 'connection-1' },
    checkout: {
      baseRef: 'main',
      branch: { namespace: 'sb', seed: 'mobile-worktree' },
      location: 'managed-in-repo',
    },
    owner: {
      kind: 'conversation',
      conversationId: 'mobile-thread-1',
      agentType: 'claude-code',
    },
    purpose: 'new-chat',
    setup: { policy: 'skip' },
    launch: {
      initialAgent: {
        provider: 'claude-code',
        runtimeMode: 'sandbox',
        prompt: 'Keep this exact prompt.',
      },
    },
    provenance: {
      surface: 'react-native',
      machineId: 'connection-1',
      requestedAt: 1_000,
    },
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const storage: AsyncKeyValueStorage = {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key)
    }),
  }
  return { values, storage }
}

describe('mobile worktree creation transport', () => {
  it('uses typed create/get/act channels and receives correlated progress', async () => {
    const invoke = vi.fn().mockResolvedValue(snapshot())
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const transport: Transport = {
      invoke,
      send: vi.fn(),
      on: vi.fn((channel, handler) => {
        listeners.set(channel, handler as (...args: unknown[]) => void)
        return () => listeners.delete(channel)
      }),
    }
    const client = new SwitchboardClient(transport)
    const request = { creationId: 'creation-mobile-1' } as WorktreeCreationRequest
    const key = { creationId: 'creation-mobile-1', machineId: 'connection-1' }
    const action: WorktreeCreationActionRequest = {
      ...key,
      expectedRevision: 2,
      action: 'retry',
    }

    await client.createWorktreeCreation(request)
    await client.getWorktreeCreation(key)
    await client.actOnWorktreeCreation(action)
    const progress = vi.fn()
    const unsubscribe = client.onWorktreeCreationProgress(progress)
    const event: WorktreeCreationProgressEvent = {
      creationId: 'creation-mobile-1',
      revision: 3,
      phase: 'configuring',
      status: 'pending',
      timestamp: 1_002,
      recoveryActions: [],
    }
    listeners.get(WorktreeCreationChannels.PROGRESS)?.(event)
    unsubscribe()

    expect(invoke).toHaveBeenNthCalledWith(1, WorktreeCreationChannels.CREATE, request)
    expect(invoke).toHaveBeenNthCalledWith(2, WorktreeCreationChannels.GET, key)
    expect(invoke).toHaveBeenNthCalledWith(3, WorktreeCreationChannels.ACT, action)
    expect(progress).toHaveBeenCalledWith(event)
    expect(listeners.has(WorktreeCreationChannels.PROGRESS)).toBe(false)
  })
})

describe('mobile worktree creation durable storage', () => {
  it('round-trips the complete intent, request, and last authoritative snapshot', async () => {
    const memory = memoryStorage()
    const storage = createMobileNewSessionCreationStorage(memory.storage)
    const record: PersistedMobileNewSessionCreation = {
      version: 1,
      submissionPhase: 'submitted',
      intent,
      request: worktreeRequest(),
      snapshot: snapshot(),
    }

    await storage.save(record)

    expect(await storage.load(intent.connectionId, intent.projectPath)).toEqual(record)
    await storage.remove(intent.connectionId, intent.projectPath)
    expect(await storage.load(intent.connectionId, intent.projectPath)).toBeNull()
  })

  it('removes malformed records instead of inventing a retry identity', async () => {
    const memory = memoryStorage()
    const storage = createMobileNewSessionCreationStorage(memory.storage)
    await memory.storage.setItem(storage.key(intent.connectionId, intent.projectPath), '{bad json')

    await expect(storage.load(intent.connectionId, intent.projectPath)).resolves.toBeNull()
    expect(memory.storage.removeItem).toHaveBeenCalledWith(
      storage.key(intent.connectionId, intent.projectPath),
    )
  })

  it('loads legacy records without a submission phase as conservatively submitted', async () => {
    const memory = memoryStorage()
    const storage = createMobileNewSessionCreationStorage(memory.storage)
    const legacyRecord = {
      version: 1,
      intent,
      request: worktreeRequest(),
      snapshot: snapshot(),
    }
    await memory.storage.setItem(
      storage.key(intent.connectionId, intent.projectPath),
      JSON.stringify(legacyRecord),
    )

    await expect(storage.load(intent.connectionId, intent.projectPath)).resolves.toMatchObject({
      ...legacyRecord,
      submissionPhase: 'submitted',
    })
  })
})

describe('mobile durable worktree new-session coordinator', () => {
  function harness(options: {
    create?: () => Promise<WorktreeCreationSnapshot>
    get?: () => Promise<WorktreeCreationSnapshot>
    saveRejects?: boolean
  } = {}) {
    const events: string[] = []
    let progress: ((event: WorktreeCreationProgressEvent) => void) | undefined
    let saved: PersistedMobileNewSessionCreation | null = null
    const create = vi.fn(async (_request: WorktreeCreationRequest) => {
      events.push('remote:create')
      return options.create ? options.create() : snapshot()
    })
    const get = vi.fn(async () => options.get ? options.get() : snapshot())
    const act = vi.fn(async (_request: WorktreeCreationActionRequest) => readySnapshot())
    const parent = vi.fn(async () => ({
      creationId: 'parent-creation-2',
      threadId: 'mobile-thread-1',
      projectPath: '/canonical/repo',
      title: 'Switchboard',
    }))
    const onReady = vi.fn()
    const storage = {
      save: vi.fn(async (record: PersistedMobileNewSessionCreation) => {
        events.push('storage:save')
        if (options.saveRejects) throw new Error('AsyncStorage is full')
        saved = structuredClone(record)
      }),
      load: vi.fn(async () => saved),
      remove: vi.fn(async () => {
        saved = null
      }),
    }
    const coordinator = createNewSessionCreationCoordinator({
      nextCreationId: vi.fn()
        .mockReturnValueOnce('creation-mobile-1')
        .mockReturnValueOnce('parent-creation-2'),
      now: () => 1_000,
      worktrees: {
        create,
        get,
        act,
        subscribe: (handler) => {
          progress = handler
          return () => {
            progress = undefined
          }
        },
      },
      storage,
      parentCheckout: { create: parent },
      onReady,
    })
    return {
      act,
      coordinator,
      create,
      events,
      get,
      onReady,
      parent,
      progress: (event: WorktreeCreationProgressEvent) => progress?.(event),
      storage,
      stored: () => saved,
    }
  }

  it('durably saves the exact request before remote create and retains it while pending', async () => {
    const h = harness()

    await h.coordinator.begin(intent)

    expect(h.events.slice(0, 3)).toEqual(['storage:save', 'storage:save', 'remote:create'])
    expect(h.stored()).toMatchObject({
      version: 1,
      submissionPhase: 'submitted',
      intent,
      request: {
        creationId: 'creation-mobile-1',
        owner: { kind: 'conversation', conversationId: 'mobile-thread-1' },
        launch: { initialAgent: { prompt: 'Keep this exact prompt.' } },
      },
      snapshot: { status: 'pending' },
    })
    expect(h.coordinator.getState()).toMatchObject({ status: 'pending' })
  })

  it('does not invoke the backend when durable local intent storage rejects', async () => {
    const h = harness({ saveRejects: true })

    await h.coordinator.begin(intent)

    expect(h.create).not.toHaveBeenCalled()
    expect(h.coordinator.getState()).toMatchObject({
      status: 'failed',
      error: 'AsyncStorage is full',
      intent,
    })
  })

  it('restores by querying the same creationId and never blindly recreates it', async () => {
    const h = harness({ get: async () => readySnapshot() })
    await h.coordinator.begin(intent)
    const persisted = h.stored()
    expect(persisted).not.toBeNull()
    h.coordinator.dispose()

    const restored = harness({ get: async () => readySnapshot() })
    restored.storage.load.mockResolvedValue(persisted)
    await restored.coordinator.restore(intent.connectionId, intent.projectPath)

    expect(restored.get).toHaveBeenCalledWith({
      creationId: 'creation-mobile-1',
      machineId: 'connection-1',
    })
    expect(restored.create).not.toHaveBeenCalled()
    expect(restored.onReady).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/canonical/repo',
      worktreePath: '/canonical/repo/.switchboard/worktrees/mobile-worktree',
      worktreeId: 'worktree-mobile-1',
    }))
  })

  it('submits the exact saved request after restoring a prepared pre-dispatch record', async () => {
    const record: PersistedMobileNewSessionCreation = {
      version: 1,
      submissionPhase: 'prepared',
      intent,
      request: worktreeRequest(),
    }
    const restored = harness({ create: async () => readySnapshot() })
    restored.storage.load.mockResolvedValue(record)

    await restored.coordinator.restore(intent.connectionId, intent.projectPath)

    expect(restored.get).not.toHaveBeenCalled()
    expect(restored.create).toHaveBeenCalledOnce()
    expect(restored.create).toHaveBeenCalledWith(worktreeRequest())
    expect(restored.onReady).toHaveBeenCalledOnce()
  })

  it('recreates the exact saved request after a submitted operation is absent remotely', async () => {
    const record: PersistedMobileNewSessionCreation = {
      version: 1,
      submissionPhase: 'submitted',
      intent,
      request: worktreeRequest(),
    }
    const restored = harness({
      create: async () => readySnapshot(),
      get: async () => {
        throw new Error('Unknown worktree creation creation-mobile-1.')
      },
    })
    restored.storage.load.mockResolvedValue(record)

    await restored.coordinator.restore(intent.connectionId, intent.projectPath)

    expect(restored.get).toHaveBeenCalledWith({
      creationId: 'creation-mobile-1',
      machineId: 'connection-1',
    })
    expect(restored.create).toHaveBeenCalledOnce()
    expect(restored.create).toHaveBeenCalledWith(worktreeRequest())
    expect(restored.onReady).toHaveBeenCalledOnce()
  })

  it('keeps a missing GET handler as an unsupported-backend failure on restore', async () => {
    const record: PersistedMobileNewSessionCreation = {
      version: 1,
      submissionPhase: 'submitted',
      intent,
      request: worktreeRequest(),
    }
    const restored = harness({
      get: async () => {
        throw new Error('no handler: worktree-creation:get')
      },
    })
    restored.storage.load.mockResolvedValue(record)

    await restored.coordinator.restore(intent.connectionId, intent.projectPath)

    expect(restored.create).not.toHaveBeenCalled()
    expect(restored.coordinator.getState()).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/backend.*worktree creation/i),
      intent,
    })
  })

  it('keeps an accepted snapshot durable when the screen unmounts before acknowledgement', async () => {
    let resolveCreate!: (value: WorktreeCreationSnapshot) => void
    const h = harness({
      create: () => new Promise((resolve) => {
        resolveCreate = resolve
      }),
    })

    const submitting = h.coordinator.begin(intent)
    await vi.waitFor(() => expect(h.create).toHaveBeenCalledOnce())
    h.coordinator.dispose()
    resolveCreate(readySnapshot())
    await submitting

    expect(h.onReady).not.toHaveBeenCalled()
    expect(h.stored()?.snapshot).toMatchObject({ status: 'ready', revision: 6 })

    const restored = harness({ get: async () => readySnapshot() })
    restored.storage.load.mockResolvedValue(h.stored())
    await restored.coordinator.restore(intent.connectionId, intent.projectPath)
    expect(restored.onReady).toHaveBeenCalledOnce()
  })

  it('reconciles a correlated progress event through get before navigating', async () => {
    const h = harness({ get: async () => readySnapshot() })
    await h.coordinator.begin(intent)

    h.progress({
      creationId: 'other-creation',
      revision: 4,
      phase: 'ready',
      status: 'ready',
      timestamp: 1_004,
      recoveryActions: [],
    })
    h.progress({
      creationId: 'creation-mobile-1',
      revision: 5,
      phase: 'provisioning',
      status: 'pending',
      timestamp: 1_005,
      recoveryActions: [],
    })

    await vi.waitFor(() => expect(h.onReady).toHaveBeenCalledOnce())
    expect(h.get).toHaveBeenCalledOnce()
    expect(h.storage.remove).toHaveBeenCalledWith('connection-1', '/repo')
  })

  it('uses revision-checked act for a failed retry and explicit parent fallback', async () => {
    const failed = snapshot({
      revision: 4,
      status: 'failed',
      error: {
        code: 'materialize_failed',
        phase: 'materializing',
        message: 'Branch already exists.',
        retryable: true,
      },
      recoveryActions: ['retry', 'start_in_project'],
    })
    const h = harness({ create: async () => failed })
    await h.coordinator.begin(intent)

    expect(newSessionCreationActions(h.coordinator.getState())).toMatchObject({
      canRetry: true,
      canStartInProject: true,
      progressLabel: 'Worktree creation failed',
    })
    await h.coordinator.retry()
    expect(h.act).toHaveBeenNthCalledWith(1, {
      creationId: 'creation-mobile-1',
      machineId: 'connection-1',
      expectedRevision: 4,
      action: 'retry',
    })
    expect(h.create).toHaveBeenCalledOnce()

    const fallback = harness({ create: async () => failed })
    await fallback.coordinator.begin(intent)
    await fallback.coordinator.startInProject()
    expect(fallback.act).not.toHaveBeenCalled()
    expect(fallback.parent).toHaveBeenCalledWith(expect.objectContaining({
      creationId: 'parent-creation-2',
      projectPath: '/repo',
    }))
    expect(fallback.onReady).toHaveBeenCalledOnce()
    expect(fallback.onReady).toHaveBeenCalledWith(expect.objectContaining({
      creationId: 'parent-creation-2',
      projectPath: '/canonical/repo',
    }))
    expect(fallback.onReady.mock.calls[0][0]).not.toHaveProperty('worktreePath')
  })

  it('resolves an inherited setup decision with a revision-checked action', async () => {
    const waiting = snapshot({
      revision: 3,
      phase: 'awaiting_setup_decision',
      recoveryActions: ['choose_setup_run', 'choose_setup_skip'],
    })
    const h = harness({ create: async () => waiting })
    await h.coordinator.begin(intent)

    expect(newSessionCreationActions(h.coordinator.getState())).toMatchObject({
      canChooseSetupRun: true,
      canChooseSetupSkip: true,
    })
    await h.coordinator.chooseSetup('choose_setup_skip')

    expect(h.act).toHaveBeenCalledWith({
      creationId: 'creation-mobile-1',
      machineId: 'connection-1',
      expectedRevision: 3,
      action: 'choose_setup_skip',
    })
    expect(h.onReady).toHaveBeenCalledOnce()
  })

  it('classifies a missing worktree handler as definite compatibility failure', async () => {
    const h = harness({
      create: async () => {
        throw new Error('no handler: worktree-creation:create')
      },
    })

    await h.coordinator.begin(intent)

    expect(h.coordinator.getState()).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/backend.*worktree creation/i),
    })
    expect(newSessionCreationActions(h.coordinator.getState()).canStartInProject).toBe(true)
    expect(h.stored()?.request.creationId).toBe('creation-mobile-1')

    await h.coordinator.startInProject()

    expect(h.act).not.toHaveBeenCalled()
    expect(h.parent).toHaveBeenCalledWith(expect.objectContaining({
      creationId: 'parent-creation-2',
      projectPath: '/repo',
    }))
    expect(h.onReady).toHaveBeenCalledWith(expect.objectContaining({
      creationId: 'parent-creation-2',
      projectPath: '/canonical/repo',
    }))
  })

  it.each([
    ['validation', new Error('Base ref is empty or unsafe.')],
    ['owner conflict', new Error('The conversation owner is already linked.')],
    ['authorization', new Error('Remote worktree setup requires the terminal device scope; choose skip setup.')],
  ])('classifies a deterministic %s rejection as failed and stops reconnect resubmission', async (_kind, rejection) => {
    const h = harness({
      create: async () => { throw rejection },
    })

    await h.coordinator.begin(intent)

    expect(h.coordinator.getState()).toMatchObject({
      status: 'failed',
      error: rejection.message,
      intent,
    })
    expect(newSessionCreationActions(h.coordinator.getState())).toMatchObject({
      canRetry: false,
      canStartInProject: true,
    })

    await h.coordinator.reconcileAfterReconnect()

    expect(h.get).not.toHaveBeenCalled()
    expect(h.create).toHaveBeenCalledOnce()
    expect(h.stored()?.request.creationId).toBe('creation-mobile-1')
  })

  it('stops a missing-get create loop when the create verdict is deterministic', async () => {
    const record: PersistedMobileNewSessionCreation = {
      version: 1,
      submissionPhase: 'submitted',
      intent,
      request: worktreeRequest(),
    }
    const restored = harness({
      create: async () => {
        throw new Error('Remote worktree setup requires the terminal device scope; choose skip setup.')
      },
      get: async () => {
        throw new Error('Unknown worktree creation creation-mobile-1.')
      },
    })
    restored.storage.load.mockResolvedValue(record)

    await restored.coordinator.restore(intent.connectionId, intent.projectPath)
    await restored.coordinator.reconcileAfterReconnect()

    expect(restored.get).toHaveBeenCalledOnce()
    expect(restored.create).toHaveBeenCalledOnce()
    expect(restored.coordinator.getState()).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/terminal device scope/i),
    })
    expect(newSessionCreationActions(restored.coordinator.getState()).canStartInProject).toBe(true)
  })
})

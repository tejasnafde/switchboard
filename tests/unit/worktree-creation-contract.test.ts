import { describe, expect, it } from 'vitest'
import {
  canonicalizeWorktreeCreationIdentity,
  canonicalizeWorktreeCreationRequest,
  parseWorktreeCreationRequest,
  type WorktreeCreationRequest,
} from '../../src/shared/worktree-creation'

function conversationRequest(): WorktreeCreationRequest {
  return {
    schemaVersion: 1,
    creationId: 'create_01HZY7WP8E4M5D4K7R2S0N9Q1A',
    repository: {
      projectPath: '/Users/example/code/switchboard',
      machineId: 'machine-local',
    },
    checkout: {
      baseRef: 'origin/main',
      branch: { namespace: 'sb', seed: 'atomic worktree creation' },
      location: 'managed-user-data',
      sparseCheckout: {
        mode: 'cone',
        directories: ['src/renderer/', 'src//main', 'src/main'],
        presetId: 'desktop-core',
      },
    },
    owner: {
      kind: 'conversation',
      conversationId: 'conversation-1',
      agentType: 'claude-code',
      title: 'Atomic worktree creation',
    },
    purpose: 'new-chat',
    setup: { policy: 'inherit' },
    launch: {
      launchConfigName: 'Development',
      initialAgent: {
        provider: 'claude-code',
        instanceId: 'claude-work',
        model: 'claude-opus-4-1',
        runtimeMode: 'sandbox',
        prompt: 'Implement the approved plan.',
      },
    },
    lineage: { parentWorktreeId: 'worktree-parent' },
    provenance: {
      surface: 'desktop',
      machineId: 'machine-local',
      requestedAt: 1_787_523_600_000,
    },
  }
}

function expectInvalid(value: unknown, code: string, path?: string): void {
  const parsed = parseWorktreeCreationRequest(value)
  expect(parsed.ok).toBe(false)
  if (parsed.ok) return
  expect(parsed.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code, ...(path ? { path } : {}) }),
  ]))
}

describe('worktree creation request contract', () => {
  it('parses a complete conversation request and normalizes its sparse directories', () => {
    const parsed = parseWorktreeCreationRequest(conversationRequest())

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        creationId: 'create_01HZY7WP8E4M5D4K7R2S0N9Q1A',
        owner: { kind: 'conversation', conversationId: 'conversation-1' },
        purpose: 'new-chat',
        checkout: {
          sparseCheckout: {
            mode: 'cone',
            directories: ['src/main', 'src/renderer'],
            presetId: 'desktop-core',
          },
        },
        launch: {
          initialAgent: {
            provider: 'claude-code',
            prompt: 'Implement the approved plan.',
          },
        },
      },
    })
  })

  it('accepts a new Kanban-card owner carrying the draft needed for atomic creation', () => {
    const request = conversationRequest()
    const parsed = parseWorktreeCreationRequest({
      ...request,
      checkout: {
        ...request.checkout,
        branch: { namespace: 'kanban', seed: 'Fix startup race' },
        location: 'managed-in-repo',
      },
      owner: {
        kind: 'kanban-card',
        cardId: 'card-1',
        create: {
          title: 'Fix startup race',
          description: 'Keep the card recoverable on failure.',
          tags: ['reliability'],
          status: 'backlog',
          runtimeMode: 'sandbox',
        },
      },
      purpose: 'kanban',
      lineage: undefined,
    })

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        owner: {
          kind: 'kanban-card',
          cardId: 'card-1',
          create: { title: 'Fix startup race', status: 'backlog' },
        },
      },
    })
  })

  it('accepts a fork owner without conflating Git ancestry and product lineage', () => {
    const request = conversationRequest()
    const parsed = parseWorktreeCreationRequest({
      ...request,
      checkout: {
        ...request.checkout,
        baseRef: 'feature/source',
        branch: { namespace: 'fork', seed: 'alternate approach' },
        sparseCheckout: undefined,
      },
      owner: {
        kind: 'fork',
        conversationId: 'fork-1',
        parentConversationId: 'conversation-0',
        forkedAtMessageId: 'message-8',
        upToIndex: 8,
        title: 'Alternate approach',
      },
      purpose: 'fork',
      lineage: {
        parentWorktreeId: 'worktree-parent',
        parentConversationId: 'conversation-0',
        sourceMessageId: 'message-8',
      },
    })

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        checkout: { baseRef: 'feature/source' },
        owner: { kind: 'fork', upToIndex: 8 },
        lineage: { parentWorktreeId: 'worktree-parent' },
      },
    })
  })

  it.each([
    ['', 'creationId'],
    ['bad id with spaces', 'creationId'],
    ['-dangerous', 'creationId'],
  ])('rejects unsafe creation identity %j', (creationId, path) => {
    expectInvalid({ ...conversationRequest(), creationId }, 'invalid_value', path)
  })

  it('requires the selected agent type for a conversation owner', () => {
    const request = conversationRequest()
    const { agentType: _agentType, ...owner } = request.owner as Extract<
      WorktreeCreationRequest['owner'],
      { kind: 'conversation' }
    >
    expectInvalid({ ...request, owner }, 'required', 'owner.agentType')
  })

  it.each([
    ['', 'checkout.baseRef'],
    ['-no-option-injection', 'checkout.baseRef'],
    ['main\nother', 'checkout.baseRef'],
  ])('rejects unsafe base ref %j', (baseRef, path) => {
    const request = conversationRequest()
    expectInvalid({
      ...request,
      checkout: { ...request.checkout, baseRef },
    }, 'invalid_git_ref', path)
  })

  it.each([
    ['/absolute', 'absolute'],
    ['../outside', 'traversal'],
    ['src/../../outside', 'traversal'],
    ['', 'empty'],
    ['.', 'dot'],
    ['src\\main', 'backslash'],
  ])('rejects unsafe sparse directory %j (%s)', (directory) => {
    const request = conversationRequest()
    expectInvalid({
      ...request,
      checkout: {
        ...request.checkout,
        sparseCheckout: { mode: 'cone', directories: [directory] },
      },
    }, 'invalid_sparse_path', 'checkout.sparseCheckout.directories[0]')
  })

  it('rejects unsupported sparse modes and an empty normalized directory set', () => {
    const request = conversationRequest()
    expectInvalid({
      ...request,
      checkout: {
        ...request.checkout,
        sparseCheckout: { mode: 'non-cone', directories: ['src'] },
      },
    }, 'invalid_value', 'checkout.sparseCheckout.mode')
    expectInvalid({
      ...request,
      checkout: {
        ...request.checkout,
        sparseCheckout: { mode: 'cone', directories: [] },
      },
    }, 'required', 'checkout.sparseCheckout.directories')
  })

  it.each([
    ['conversation', 'fork'],
    ['kanban-card', 'new-chat'],
    ['fork', 'kanban'],
  ] as const)('rejects %s ownership for %s purpose', (ownerKind, purpose) => {
    const request = conversationRequest()
    const owner = ownerKind === 'conversation'
      ? request.owner
      : ownerKind === 'kanban-card'
        ? { kind: 'kanban-card', cardId: 'card-1' }
        : {
            kind: 'fork',
            conversationId: 'fork-1',
            parentConversationId: 'conversation-1',
            upToIndex: 2,
          }
    expectInvalid({ ...request, owner, purpose }, 'owner_purpose_mismatch', 'owner.kind')
  })

  it('rejects mismatched repository and provenance machine bindings', () => {
    const request = conversationRequest()
    expectInvalid({
      ...request,
      provenance: { ...request.provenance, machineId: 'another-machine' },
    }, 'machine_mismatch', 'provenance.machineId')
  })

  it('canonicalizes equivalent parsed requests identically regardless of object key order', () => {
    const request = conversationRequest()
    const reordered = {
      provenance: request.provenance,
      lineage: request.lineage,
      launch: request.launch,
      setup: request.setup,
      purpose: request.purpose,
      owner: request.owner,
      checkout: request.checkout,
      repository: request.repository,
      creationId: request.creationId,
      schemaVersion: request.schemaVersion,
    }

    const first = parseWorktreeCreationRequest(request)
    const second = parseWorktreeCreationRequest(reordered)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(canonicalizeWorktreeCreationRequest(first.value))
      .toBe(canonicalizeWorktreeCreationRequest(second.value))
  })

  it('keeps request time for audit but excludes it from idempotency identity', () => {
    const first = parseWorktreeCreationRequest(conversationRequest())
    const later = conversationRequest()
    later.provenance.requestedAt += 5_000
    const second = parseWorktreeCreationRequest(later)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(canonicalizeWorktreeCreationRequest(first.value))
      .not.toBe(canonicalizeWorktreeCreationRequest(second.value))
    expect(canonicalizeWorktreeCreationIdentity(first.value))
      .toBe(canonicalizeWorktreeCreationIdentity(second.value))
  })

  it('persists backend terminal authority without changing the client intent identity', () => {
    const provision = parseWorktreeCreationRequest({
      ...conversationRequest(),
      launch: { ...conversationRequest().launch, terminalPolicy: 'provision' },
    })
    const skip = parseWorktreeCreationRequest({
      ...conversationRequest(),
      launch: { ...conversationRequest().launch, terminalPolicy: 'skip' },
    })
    expect(provision.ok).toBe(true)
    expect(skip.ok).toBe(true)
    if (!provision.ok || !skip.ok) return

    expect(canonicalizeWorktreeCreationRequest(provision.value))
      .not.toBe(canonicalizeWorktreeCreationRequest(skip.value))
    expect(canonicalizeWorktreeCreationIdentity(provision.value))
      .toBe(canonicalizeWorktreeCreationIdentity(skip.value))
  })

  it('rejects an unknown persisted terminal policy', () => {
    expectInvalid({
      ...conversationRequest(),
      launch: { ...conversationRequest().launch, terminalPolicy: 'force' },
    }, 'invalid_value', 'launch.terminalPolicy')
  })

  it('changes idempotency identity when a behavior-bearing field changes', () => {
    const first = parseWorktreeCreationRequest(conversationRequest())
    const changed = conversationRequest()
    changed.checkout.baseRef = 'release/next'
    const second = parseWorktreeCreationRequest(changed)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(canonicalizeWorktreeCreationIdentity(first.value))
      .not.toBe(canonicalizeWorktreeCreationIdentity(second.value))
  })
})

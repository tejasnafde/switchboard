import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DefaultProviderForkArtifacts } from '../../src/main/conversations/fork-provider-artifacts'
import type { PreparedForkSnapshot } from '../../src/main/conversations/conversation-fork-coordinator'
import { encodeClaudeProjectPath } from '../../src/main/projects/session-scanner'
import type { ForkConversationRequest } from '../../src/shared/conversation-fork'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'sb-fork-artifact-'))
  temporaryDirectories.push(path)
  return path
}

function request(): ForkConversationRequest {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    sourceConversationId: 'source',
    machineId: 'local',
    anchor: { messageId: 'a2', role: 'assistant', timestamp: 4, contentDigest: 'a'.repeat(64) },
    checkout: { kind: 'shared-checkout' },
    provenance: { surface: 'desktop', requestedAt: 1 },
  }
}

function prepared(overrides: Partial<PreparedForkSnapshot['source']> = {}): PreparedForkSnapshot {
  return {
    version: 1,
    conversationId: 'fork-session',
    source: {
      conversationId: 'source',
      projectPath: '/repo',
      sourceCheckoutPath: '/repo',
      sourceWorktreePath: null,
      sourceWorktreeBranch: null,
      sourceWorktreeId: null,
      machineId: 'local',
      agentType: 'claude-code',
      providerSessionId: 'segment-b',
      providerInstanceId: 'claude-tech-team',
      runtimeMode: 'sandbox',
      model: 'claude-sonnet-5',
      reasoningEffort: null,
      launchConfigName: null,
      title: 'Source',
      ...overrides,
    },
    prefix: [
      { id: 'u1', role: 'user', content: 'one', timestamp: 1 },
      { id: 'a2', role: 'assistant', content: 'two', timestamp: 4 },
    ],
    anchor: {
      messageId: 'a2',
      role: 'assistant',
      timestamp: 4,
      contentDigest: 'a'.repeat(64),
      canonicalIndex: 1,
      canonicalMessageCount: 2,
      resolution: 'exact-id',
      provider: 'claude-code',
      providerSessionId: 'segment-b',
      providerEventId: 'a2',
    },
  }
}

const fragmentA = [
  { type: 'user', uuid: 'u1', sessionId: 'segment-a', cwd: '/old', message: { content: 'one' } },
  { type: 'assistant', uuid: 'a1', sessionId: 'segment-a', cwd: '/old', message: { content: 'first' } },
].map(JSON.stringify).join('\n') + '\n'
const fragmentB = [
  { type: 'summary', leafUuid: 'a1', sessionId: 'segment-b', cwd: '/old', summary: 'compact' },
  { type: 'user', uuid: 'u2', sessionId: 'segment-b', cwd: '/old', message: { content: 'next' } },
  { type: 'assistant', uuid: 'a2', sessionId: 'segment-b', cwd: '/old', message: { content: 'two' } },
  { type: 'user', uuid: 'u3', sessionId: 'segment-b', cwd: '/old', message: { content: 'drop' } },
].map(JSON.stringify).join('\n') + '\n'

describe('provider fork artifacts', () => {
  it('writes a Claude native fork into the committed non-default profile at the target cwd', async () => {
    const profile = await temporaryDirectory()
    const sourceDir = join(profile, 'projects', 'source')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, 'segment-a.jsonl'), fragmentA)
    await writeFile(join(sourceDir, 'segment-b.jsonl'), fragmentB)
    const artifacts = new DefaultProviderForkArtifacts({
      resolveInstance: () => ({ id: 'claude-tech-team', agentType: 'claude-code', oauthDir: profile, enabled: true }),
      listCompatibleSessionIds: () => ['segment-a', 'segment-b'],
    })
    const targetCwd = '/repo/.switchboard/worktrees/fork'

    const result = await artifacts.prepare({ request: request(), prepared: prepared(), targetCwd })
    expect(result).toMatchObject({
      resumeMode: 'native',
      sessionId: 'fork-session',
      pendingHandoffFrom: null,
      nativeResume: { provider: 'claude', sessionId: 'fork-session' },
    })
    if (!result.stage) throw new Error('expected Claude artifact stage')
    await artifacts.publish(result.stage)

    const target = join(profile, 'projects', encodeClaudeProjectPath(targetCwd), 'fork-session.jsonl')
    const lines = (await readFile(target, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((line) => line.uuid ?? line.leafUuid)).toEqual(['u1', 'a1', 'a1', 'u2', 'a2'])
    expect(lines.every((line) => line.sessionId === 'fork-session')).toBe(true)
    expect(lines.every((line) => line.cwd === targetCwd)).toBe(true)
  })

  it('degrades Claude explicitly when the source profile is missing or the anchor is from another provider', async () => {
    const missing = new DefaultProviderForkArtifacts({
      resolveInstance: () => null,
      listCompatibleSessionIds: () => [],
    })
    await expect(missing.prepare({ request: request(), prepared: prepared(), targetCwd: '/repo' }))
      .resolves.toMatchObject({
        resumeMode: 'transcript-handoff',
        pendingHandoffFrom: 'claude-code',
        warnings: [{ code: 'source-profile-missing' }],
      })

    const mixed = prepared()
    mixed.anchor.provider = 'codex'
    await expect(missing.prepare({ request: request(), prepared: mixed, targetCwd: '/repo' }))
      .resolves.toMatchObject({
        resumeMode: 'transcript-handoff',
        warnings: [{ code: 'native-lineage-incompatible' }],
      })
  })

  it('keeps Codex and OpenCode out of provider discovery trees and uses explicit handoff', async () => {
    const auditRoot = await temporaryDirectory()
    const artifacts = new DefaultProviderForkArtifacts({
      resolveInstance: () => null,
      listCompatibleSessionIds: () => [],
    })
    const codex = prepared({ agentType: 'codex', providerInstanceId: 'codex-work' })
    const opencode = prepared({ agentType: 'opencode', providerInstanceId: 'opencode-work' })

    const codexResult = await artifacts.prepare({ request: request(), prepared: codex, targetCwd: auditRoot })
    const opencodeResult = await artifacts.prepare({ request: request(), prepared: opencode, targetCwd: auditRoot })
    expect(codexResult).toMatchObject({ resumeMode: 'transcript-handoff', pendingHandoffFrom: 'codex' })
    expect(opencodeResult).toMatchObject({ resumeMode: 'transcript-handoff', pendingHandoffFrom: 'opencode' })
    expect(codexResult.stage).toBeUndefined()
    expect(opencodeResult.stage).toBeUndefined()
    expect(await readdir(auditRoot)).toEqual([])
  })
})

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assembleClaudeForkAtEvent } from '../agent/jsonl-truncate'
import type { ProviderInstanceRow } from '../db/providerInstances'
import {
  claudeSessionResumePath,
  defaultClaudeDir,
  listClaudeSessionCopies,
} from '../provider/claude-session-migrate'
import type {
  PreparedForkSnapshot,
  PreparedProviderForkArtifact,
  ProviderForkArtifactPort,
  ProviderForkArtifactStage,
} from './conversation-fork-coordinator'

interface ResolvedForkProviderInstance {
  id: string
  agentType: string
  oauthDir: string | null
  enabled: boolean
}

interface ProviderForkArtifactDependencies {
  resolveInstance(id: string): ResolvedForkProviderInstance | ProviderInstanceRow | null
  listCompatibleSessionIds(conversationId: string, providerInstanceId: string): string[]
}

interface ClaudeForkArtifactStage extends ProviderForkArtifactStage {
  id: string
  kind: 'claude-jsonl'
  path: string
  content: string
  created: boolean
}

function handoff(
  prepared: PreparedForkSnapshot,
  code: string,
  message: string,
): PreparedProviderForkArtifact {
  return {
    resumeMode: 'transcript-handoff',
    sessionId: null,
    pendingHandoffFrom: prepared.source.agentType,
    warnings: [{ code, message }],
  }
}

function claudeStage(stage: ProviderForkArtifactStage): ClaudeForkArtifactStage {
  if (stage.kind !== 'claude-jsonl' || typeof stage.path !== 'string' || typeof stage.content !== 'string') {
    throw new Error('Unknown fork provider artifact stage')
  }
  return stage as ClaudeForkArtifactStage
}

export class DefaultProviderForkArtifacts implements ProviderForkArtifactPort {
  constructor(private readonly deps: ProviderForkArtifactDependencies) {}

  async prepare(input: {
    request: Parameters<ProviderForkArtifactPort['prepare']>[0]['request']
    prepared: PreparedForkSnapshot
    targetCwd: string
  }): Promise<PreparedProviderForkArtifact> {
    const { prepared } = input
    if (prepared.source.agentType !== 'claude-code') {
      return handoff(
        prepared,
        'transcript-handoff',
        `${prepared.source.agentType === 'codex' ? 'Codex' : 'OpenCode'} starts with a one-time transcript handoff.`,
      )
    }
    if (prepared.anchor.provider !== 'claude-code') {
      return handoff(
        prepared,
        'native-lineage-incompatible',
        'The selected anchor is outside compatible Claude native lineage.',
      )
    }
    const instanceId = prepared.source.providerInstanceId
    if (!instanceId) {
      return handoff(prepared, 'source-profile-missing', 'The source Claude profile was not recorded.')
    }
    const instance = this.deps.resolveInstance(instanceId)
    if (!instance || instance.agentType !== 'claude-code' || !instance.enabled) {
      return handoff(
        prepared,
        'source-profile-missing',
        `The committed Claude profile ${instanceId} is missing or disabled.`,
      )
    }

    const profileDir = instance.oauthDir ?? defaultClaudeDir()
    const sessionIds = this.deps.listCompatibleSessionIds(
      prepared.source.conversationId,
      instanceId,
    )
    const fragments: string[] = []
    for (const sessionId of sessionIds) {
      const source = listClaudeSessionCopies(profileDir, sessionId)[0]
      if (source) fragments.push(await readFile(source.path, 'utf8'))
    }
    if (fragments.length === 0) {
      return handoff(
        prepared,
        'native-history-missing',
        'Compatible Claude native history could not be found in the committed profile.',
      )
    }
    const providerEventId = prepared.anchor.providerEventId
    if (!providerEventId) {
      return handoff(
        prepared,
        'native-lineage-incompatible',
        'The selected anchor has no durable Claude event provenance.',
      )
    }
    const assembled = assembleClaudeForkAtEvent(fragments, providerEventId, {
      newSessionId: prepared.conversationId,
      newCwd: input.targetCwd,
    })
    if (!assembled.anchorFound) {
      return handoff(
        prepared,
        'native-lineage-incompatible',
        'The selected Claude event is missing or ambiguous in compatible native history.',
      )
    }
    const path = claudeSessionResumePath(profileDir, prepared.conversationId, input.targetCwd)
    return {
      resumeMode: 'native',
      sessionId: prepared.conversationId,
      pendingHandoffFrom: null,
      nativeResume: { provider: 'claude', sessionId: prepared.conversationId },
      warnings: [],
      stage: {
        id: path,
        kind: 'claude-jsonl',
        path,
        content: assembled.newContent,
        created: false,
      },
    }
  }

  async publish(input: ProviderForkArtifactStage): Promise<void> {
    const stage = claudeStage(input)
    await mkdir(dirname(stage.path), { recursive: true })
    try {
      await writeFile(stage.path, stage.content, { encoding: 'utf8', flag: 'wx' })
      stage.created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readFile(stage.path, 'utf8')
      if (existing !== stage.content) throw new Error(`Fork transcript conflict at ${stage.path}`)
    }
  }

  async compensate(input: ProviderForkArtifactStage): Promise<void> {
    const stage = claudeStage(input)
    if (!stage.created) return
    try {
      await unlink(stage.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

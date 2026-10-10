import { isGenericAcpAgent } from '@shared/acp-agents'
import { agentLabel } from '@shared/types'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assembleClaudeForkAtEvent } from '../agent/jsonl-truncate'
import type { ProviderInstanceRow } from '../db/provider-instances'
import { createMainLogger } from '../logger'
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
import {
  findCodexForkTurn,
  isUnsupportedMethodError,
  pickOpencodeForkSession,
  type OpencodeForkSegment,
} from './native-fork'
import { OpencodeUnsupportedVersionError } from '../provider/adapters/opencode/version'
import type { NativeForkRunners } from './native-fork-runners'

const log = createMainLogger('conversations:fork-artifacts')

interface ResolvedForkProviderInstance {
  id: string
  agentType: string
  oauthDir: string | null
  enabled: boolean
}

interface ProviderForkArtifactDependencies {
  resolveInstance(id: string): ResolvedForkProviderInstance | ProviderInstanceRow | null
  listCompatibleSessionIds(conversationId: string, providerInstanceId: string): string[]
  listSegments?(conversationId: string): OpencodeForkSegment[]
  native?: NativeForkRunners
}

interface ClaudeForkArtifactStage extends ProviderForkArtifactStage {
  id: string
  kind: 'claude-jsonl'
  path: string
  content: string
  created: boolean
}

/** A forked Codex rollout, already on disk; undone by deleting it. */
interface CodexForkArtifactStage extends ProviderForkArtifactStage {
  id: string
  kind: 'codex-rollout'
  path: string
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

function codexStage(stage: ProviderForkArtifactStage): CodexForkArtifactStage {
  if (typeof stage.path !== 'string') throw new Error('Unknown fork provider artifact stage')
  return stage as CodexForkArtifactStage
}

export class DefaultProviderForkArtifacts implements ProviderForkArtifactPort {
  constructor(private readonly deps: ProviderForkArtifactDependencies) {}

  async prepare(input: {
    request: Parameters<ProviderForkArtifactPort['prepare']>[0]['request']
    prepared: PreparedForkSnapshot
    targetCwd: string
  }): Promise<PreparedProviderForkArtifact> {
    const { prepared } = input
    if (prepared.source.agentType === 'codex') return this.prepareCodex(prepared, input.targetCwd)
    if (prepared.source.agentType === 'opencode') return this.prepareOpencode(prepared, input.targetCwd)
    if (isGenericAcpAgent(prepared.source.agentType)) {
      return handoff(
        prepared,
        'native-fork-unsupported',
        `${agentLabel(prepared.source.agentType)} chats fork with a transcript handoff; Switchboard does not fork them natively yet.`,
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

  private async prepareCodex(prepared: PreparedForkSnapshot, targetCwd: string): Promise<PreparedProviderForkArtifact> {
    const native = this.deps.native
    const instanceId = prepared.source.providerInstanceId
    const threadId = prepared.anchor.providerSessionId
    const messageId = prepared.anchor.providerEventId
    if (!native) return handoff(prepared, 'transcript-handoff', 'Codex starts with a one-time transcript handoff.')
    if (prepared.anchor.provider !== 'codex' || !threadId || !messageId) {
      return handoff(prepared, 'native-lineage-incompatible', 'The selected message has no Codex thread provenance.')
    }
    if (!instanceId || !this.enabledInstance(instanceId, 'codex')) {
      return handoff(prepared, 'source-profile-missing', 'The source Codex profile is missing or disabled.')
    }
    try {
      const rollout = await native.readCodexRollout(instanceId, threadId)
      if (rollout === null) {
        return handoff(prepared, 'native-history-missing', 'The Codex thread is not in the source profile.')
      }
      const turn = findCodexForkTurn(rollout, messageId, prepared.prefix)
      if (!turn.ok) return handoff(prepared, turn.code, turn.message)
      const forked = await native.forkCodexThread(instanceId, { threadId, lastTurnId: turn.turnId, cwd: targetCwd })
      return {
        resumeMode: 'native',
        sessionId: forked.threadId,
        pendingHandoffFrom: null,
        nativeResume: {
          provider: 'codex',
          sessionId: forked.threadId,
          copiedMessageCount: prepared.prefix.length,
        },
        warnings: [],
        ...(forked.path ? { stage: { id: forked.path, kind: 'codex-rollout', path: forked.path } } : {}),
      }
    } catch (error) {
      return this.nativeFailure(prepared, 'thread/fork', error)
    }
  }

  private async prepareOpencode(prepared: PreparedForkSnapshot, targetCwd: string): Promise<PreparedProviderForkArtifact> {
    const native = this.deps.native
    const instanceId = prepared.source.providerInstanceId
    if (!native || !this.deps.listSegments) {
      return handoff(prepared, 'transcript-handoff', 'OpenCode starts with a one-time transcript handoff.')
    }
    if (targetCwd !== prepared.source.sourceCheckoutPath) {
      // OpenCode scopes a session to its directory, and forking one into a
      // new worktree is unverified.
      return handoff(prepared, 'native-worktree-unsupported', 'OpenCode forks natively only in the same checkout.')
    }
    if (!instanceId || !this.enabledInstance(instanceId, 'opencode')) {
      return handoff(prepared, 'source-profile-missing', 'The source OpenCode profile is missing or disabled.')
    }
    try {
      const picked = pickOpencodeForkSession({
        segments: this.deps.listSegments(prepared.source.conversationId),
        instanceId,
        firstMessageAt: prepared.prefix[0]?.timestamp,
        anchor: prepared.anchor,
      })
      if (!picked.ok) return handoff(prepared, picked.code, picked.message)
      const sessionId = await native.forkOpencodeSession(instanceId, { sessionId: picked.sessionId, cwd: targetCwd })
      // No stage: ACP cannot delete a session, so a fork that fails to commit
      // leaves an unused OpenCode session behind.
      return {
        resumeMode: 'native',
        sessionId,
        pendingHandoffFrom: null,
        nativeResume: { provider: 'opencode', sessionId },
        warnings: [],
      }
    } catch (error) {
      return this.nativeFailure(prepared, 'session/fork', error)
    }
  }

  private enabledInstance(instanceId: string, agentType: string): boolean {
    const instance = this.deps.resolveInstance(instanceId)
    return !!instance && instance.agentType === agentType && instance.enabled
  }

  private nativeFailure(prepared: PreparedForkSnapshot, method: string, error: unknown): PreparedProviderForkArtifact {
    if (error instanceof OpencodeUnsupportedVersionError) {
      // The refusal names the fix; a generic "fork failed" would hide it.
      log.warn(`native ${method} refused an unsupported OpenCode, falling back to a transcript handoff`, {
        conversationId: prepared.source.conversationId,
        version: error.version,
      })
      return handoff(prepared, 'native-fork-unsupported-version', `${error.message} The fork starts with a transcript handoff.`)
    }
    const unsupported = isUnsupportedMethodError(error, method)
    log.warn(`native ${method} failed, falling back to a transcript handoff`, {
      conversationId: prepared.source.conversationId,
      unsupported,
      error: error instanceof Error ? error.message : String(error),
    })
    return unsupported
      ? handoff(prepared, 'native-fork-unsupported', `The installed CLI has no ${method}; the fork starts with a transcript handoff.`)
      : handoff(prepared, 'native-fork-failed', `Native ${method} failed; the fork starts with a transcript handoff.`)
  }

  async publish(input: ProviderForkArtifactStage): Promise<void> {
    if (input.kind === 'codex-rollout') return
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
    const stage = input.kind === 'codex-rollout' ? codexStage(input) : claudeStage(input)
    if (stage.kind === 'claude-jsonl' && !stage.created) return
    try {
      await unlink(stage.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

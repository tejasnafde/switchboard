export type LegacyForkHealth =
  | 'healthy'
  | 'legacy-project-path'
  | 'missing-worktree'
  | 'orphan-worktree'
  | 'ambiguous-anchor'
  | 'unusable-native-artifact'

export interface LegacyForkEvidence {
  conversationId: string | null
  projectPath: string
  parentProjectPath: string | null
  worktreePath: string | null
  worktreeExists: boolean
  anchorMatchCount?: number
  codexArtifactPath?: string | null
}

export interface LegacyForkDiagnostic {
  status: LegacyForkHealth
  safeAutomaticRepair: 'restore-parent-project-path' | null
  detail: string
}

export function classifyLegacyFork(input: LegacyForkEvidence): LegacyForkDiagnostic {
  if (input.codexArtifactPath?.includes('rollout-fork-')) {
    return {
      status: 'unusable-native-artifact',
      safeAutomaticRepair: null,
      detail: `Codex audit artifact is not resumable: ${input.codexArtifactPath}`,
    }
  }
  if ((input.anchorMatchCount ?? 1) !== 1) {
    return {
      status: 'ambiguous-anchor',
      safeAutomaticRepair: null,
      detail: `Legacy anchor resolved to ${input.anchorMatchCount ?? 0} canonical messages.`,
    }
  }
  if (!input.conversationId && input.worktreePath && input.worktreeExists) {
    return {
      status: 'orphan-worktree',
      safeAutomaticRepair: null,
      detail: `Managed worktree has no owning conversation: ${input.worktreePath}`,
    }
  }
  if (input.worktreePath && !input.worktreeExists) {
    return {
      status: 'missing-worktree',
      safeAutomaticRepair: null,
      detail: `Conversation references a missing worktree: ${input.worktreePath}`,
    }
  }
  if (input.worktreePath
    && input.parentProjectPath
    && input.projectPath === input.worktreePath
    && input.parentProjectPath !== input.worktreePath) {
    return {
      status: 'legacy-project-path',
      safeAutomaticRepair: 'restore-parent-project-path',
      detail: `Parent project can be restored unambiguously to ${input.parentProjectPath}.`,
    }
  }
  return { status: 'healthy', safeAutomaticRepair: null, detail: 'Fork invariants are consistent.' }
}

import { describe, expect, it } from 'vitest'
import { projectForkSourceExecution } from '../../src/main/conversations/fork-source'

const source = {
  id: 'source',
  project_path: '/repo',
  agent_type: 'codex',
  session_id: 'native-codex',
  title: 'Source',
  created_at: 1,
  updated_at: 2,
  archived: 0,
  worktree_path: '/managed/source-worktree',
  worktree_branch: 'sb/source',
  worktree_id: 'worktree-source',
  provider_instance_id: 'codex-work',
  runtime_mode: 'accept-edits',
  model: 'gpt-5.1-codex',
  reasoning_effort: 'high',
  launch_config_name: 'Development',
}

describe('fork source execution projection', () => {
  it('freezes owning project identity separately from the source execution checkout', () => {
    expect(projectForkSourceExecution(source, { machineId: 'remote-a' })).toEqual({
      conversationId: 'source',
      projectPath: '/repo',
      sourceCheckoutPath: '/managed/source-worktree',
      sourceWorktreePath: '/managed/source-worktree',
      sourceWorktreeBranch: 'sb/source',
      sourceWorktreeId: 'worktree-source',
      machineId: 'remote-a',
      agentType: 'codex',
      providerSessionId: 'native-codex',
      providerInstanceId: 'codex-work',
      runtimeMode: 'accept-edits',
      model: 'gpt-5.1-codex',
      reasoningEffort: 'high',
      launchConfigName: 'Development',
      title: 'Source',
    })
  })

  it('uses the parent checkout and safe stored defaults without inventing provider identity', () => {
    expect(projectForkSourceExecution({
      ...source,
      worktree_path: null,
      worktree_branch: null,
      worktree_id: null,
      session_id: null,
      provider_instance_id: null,
      runtime_mode: null,
      model: null,
      reasoning_effort: null,
      launch_config_name: null,
    }, { machineId: 'local' })).toMatchObject({
      projectPath: '/repo',
      sourceCheckoutPath: '/repo',
      sourceWorktreePath: null,
      providerSessionId: null,
      providerInstanceId: null,
      runtimeMode: 'sandbox',
      model: null,
      reasoningEffort: null,
      launchConfigName: null,
    })
  })

  it('keeps a non-default Claude profile instead of resolving a default profile', () => {
    expect(projectForkSourceExecution({
      ...source,
      agent_type: 'claude-code',
      provider_instance_id: 'claude-tech-team',
      session_id: 'claude-session',
    }, { machineId: 'remote-a' })).toMatchObject({
      agentType: 'claude-code',
      providerInstanceId: 'claude-tech-team',
      providerSessionId: 'claude-session',
    })
  })

  it('rejects an unsupported persisted provider or runtime mode instead of silently migrating it', () => {
    expect(() => projectForkSourceExecution({ ...source, agent_type: 'mystery' }, { machineId: 'local' }))
      .toThrow('unsupported provider')
    expect(() => projectForkSourceExecution({ ...source, runtime_mode: 'root-everything' }, { machineId: 'local' }))
      .toThrow('unsupported runtime mode')
  })
})

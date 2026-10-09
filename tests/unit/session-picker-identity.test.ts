import { describe, expect, it } from 'vitest'
import { sessionPickerCandidates, sessionPickerIdentity } from '../../src/renderer/components/SessionPickerModal'

describe('dual-chat session picker identity', () => {
  it('describes a local session with provider, project, and status', () => {
    expect(sessionPickerIdentity({
      id: 'a',
      type: 'codex',
      title: 'Query plan',
      status: 'running',
      projectPath: '/repos/warehouse',
    })).toEqual({
      provider: 'Codex',
      title: 'Query plan',
      context: 'warehouse · Local · running',
    })
  })

  it('identifies remote worktree sessions without hiding branch context', () => {
    expect(sessionPickerIdentity({
      id: 'b',
      type: 'claude-code',
      title: 'Review',
      status: 'idle',
      projectPath: '/repos/app',
      worktreePath: '/repos/app/.switchboard/worktrees/fix',
      worktreeBranch: 'fix/dual-chat',
      machineId: 'vm-1',
    }, 'Build VM')).toEqual({
      provider: 'Claude',
      title: 'Review',
      context: 'fix · fix/dual-chat · Build VM · idle',
    })
  })
})

describe('dual-chat session picker candidates', () => {
  it('offers loaded chats only: no terminal, no unsent draft, nothing already shown', () => {
    const sessions = [
      { id: 'draft', type: 'claude', draft: { projectPath: '/p' } },
      { id: 'shown', type: 'claude' },
      { id: 'term', type: 'terminal' },
      { id: 'other', type: 'codex' },
    ]
    expect(sessionPickerCandidates(sessions, ['shown']).map((s) => s.id)).toEqual(['other'])
  })
})

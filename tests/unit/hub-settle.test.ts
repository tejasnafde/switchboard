/**
 * Settle against a real database and real git: which worktrees go, which
 * stay and why, what each child's settle stops, and the conflicts
 * `list_children` reports between children.
 */
import { createMigratedDb } from './helpers/test-db'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hubSettleDetail, hubSettleResult, settleBlockers, settleWorktree } from '../../src/shared/hub'
import {
  addProject,
  armLimitResume,
  createConversation,
  getHubChild,
  insertHubChild,
  isConversationArchived,
  setConversationWorktree,
  updateHubChild,
} from '../../src/main/db/database'
import { configureHubWorktrees, type HubWorktreeService } from '../../src/main/hub/hub-start'
import { childConflicts, HubSettler, type HubSettleHost } from '../../src/main/hub/hub-settle'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' })
}

/** A repository on `main` with a.txt, b.txt and c.txt committed. */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sb-hub-settle-')))
  dirs.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(dir, f), `${f}\n`)
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'base')
  addProject(dir, 'repo')
  return dir
}

function worktree(dir: string, name: string): string {
  const path = join(dir, '.wt', name)
  git(dir, 'worktree', 'add', '-q', path, '-b', `hub/${name}`)
  return path
}

function commit(cwd: string, file: string, text: string): void {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'commit', '-qam', `edit ${file}`)
}

function child(childId: string, ordinal: number, projectPath: string, wt: string | null) {
  createConversation(childId, projectPath, 'claude', `Child ${childId}`)
  if (wt) setConversationWorktree(childId, wt, `hub/${childId}`)
  insertHubChild({
    childId,
    parentId: 'parent',
    batchId: 'b1',
    ordinal,
    title: `Child ${childId}`,
    brief: 'Do it',
    location: wt ? 'worktree' : 'project',
    grantedMode: 'sandbox',
    depsMode: 'none',
    branch: wt ? `hub/${childId}` : null,
  })
  updateHubChild(childId, { phase: 'open' })
}

function fakeHost(facts: Record<string, { running: boolean; cards: number; queued: number }> = {}) {
  const stopped: string[] = []
  const host: HubSettleHost = {
    sessionFacts: (id) => facts[id] ?? { running: false, cards: 0, queued: 0 },
    agentPid: () => null,
    stop: async (id) => {
      stopped.push(id)
    },
    changed: vi.fn(),
    forget: vi.fn(),
  }
  return { host, stopped }
}

function fakeService() {
  const removed: string[] = []
  const service = {
    createWorktreeTransaction: vi.fn(),
    getWorktreeCreation: vi.fn(async () => ({ revision: 3 })),
    actOnWorktreeCreation: vi.fn(async (req: { creationId: string; expectedRevision: number }) => {
      removed.push(`${req.creationId}@${req.expectedRevision}`)
      return { cleanupDisposition: 'removed' }
    }),
  } as unknown as HubWorktreeService
  configureHubWorktrees(service)
  return removed
}

beforeEach(() => {
  createMigratedDb()
})

describe('settle rules', () => {
  const base = { location: 'worktree' as const, worktreePath: '/w', starting: false, sharedWith: 0 }
  it('removes only a clean, merged worktree no other chat works in', () => {
    expect(settleWorktree({ ...base, merged: true, clean: true })).toEqual({ worktree: 'remove' })
    expect(settleWorktree({ ...base, merged: true, clean: false }).worktree).toBe('keep')
    expect(settleWorktree({ ...base, merged: false, clean: true }).worktree).toBe('keep')
    expect(settleWorktree({ ...base, merged: null, clean: true }).worktree).toBe('keep')
    expect(settleWorktree({ ...base, merged: true, clean: true, sharedWith: 1 }).worktree).toBe('keep')
    expect(settleWorktree({ ...base, merged: true, clean: true, starting: true }).worktree).toBe('keep')
    expect(settleWorktree({ ...base, location: 'project', merged: null, clean: null })).toEqual({ worktree: 'none' })
    expect(settleWorktree({ ...base, worktreePath: null, merged: null, clean: null }).worktree).toBe('keep')
  })

  it('names each open thing and what settle does about it', () => {
    expect(settleBlockers({ running: true, starting: false, cards: 2, queued: 1, resumeArmed: true })).toEqual([
      'Working: its turn is stopped.',
      '2 open cards: closed unanswered.',
      '1 queued message: dropped.',
      'Auto-resume armed: cancelled.',
    ])
    expect(settleBlockers({ running: false, starting: false, cards: 0, queued: 0, resumeArmed: false })).toEqual([])
  })

  it('lists removed and kept worktrees in the result', () => {
    expect(
      hubSettleResult([
        { title: 'A', worktree: 'remove' },
        { title: 'B', worktree: 'keep', keepReason: 'it has uncommitted or untracked files' },
        { title: 'C', worktree: 'none' },
      ]),
    ).toBe(
      'Settled 3 children. Branches with commits stay.\nWorktrees removed: A.\n' +
        'Worktrees kept: B (it has uncommitted or untracked files).',
    )
  })
})

describe('HubSettler', () => {
  it('removes the clean merged worktree, keeps one with an untracked file, an unmerged one and a shared one', async () => {
    const dir = repo()
    const merged = worktree(dir, 'merged')
    commit(merged, 'a.txt', 'merged work\n')
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', 'hub/merged')
    const untracked = worktree(dir, 'untracked')
    writeFileSync(join(untracked, 'notes.txt'), 'scratch\n')
    const unmerged = worktree(dir, 'unmerged')
    commit(unmerged, 'b.txt', 'not merged\n')
    const shared = worktree(dir, 'shared')
    child('merged', 0, dir, merged)
    child('untracked', 1, dir, untracked)
    child('unmerged', 2, dir, unmerged)
    child('shared', 3, dir, shared)
    child('inproject', 4, dir, null)
    // A fork of a child works in the child's worktree.
    createConversation('fork1', dir, 'claude', 'Fork')
    setConversationWorktree('fork1', shared, 'hub/shared')
    armLimitResume({
      conversationId: 'unmerged',
      providerInstanceId: 'claude-default',
      limitedTurnId: 't1',
      resetAt: Date.now() + 60_000,
      requestId: 'r1',
    })
    const removed = fakeService()
    const { host, stopped } = fakeHost({ untracked: { running: true, cards: 1, queued: 2 } })
    const settler = new HubSettler(host)

    const view = await settler.plan('parent', dir, true)
    const byId = Object.fromEntries(view.rows.map((r) => [r.childId, r]))
    expect(byId.merged).toMatchObject({ merged: true, clean: true, worktree: 'remove' })
    expect(byId.untracked).toMatchObject({ clean: false, worktree: 'keep' })
    expect(byId.untracked!.blockers).toEqual([
      'Working: its turn is stopped.',
      '1 open card: closed unanswered.',
      '2 queued messages: dropped.',
    ])
    expect(byId.unmerged).toMatchObject({ merged: false, worktree: 'keep' })
    expect(byId.unmerged!.blockers).toEqual(['Auto-resume armed: cancelled.'])
    expect(byId.shared).toMatchObject({ worktree: 'keep', keepReason: 'another chat or card works in it' })
    expect(byId.inproject).toMatchObject({ worktree: 'none' })
    expect(hubSettleDetail(view)).toContain('Then this chat is archived.')

    const result = await settler.run('parent', dir, 'card')
    expect(result.ok).toBe(true)
    expect(stopped.sort()).toEqual(['inproject', 'merged', 'shared', 'unmerged', 'untracked'])
    expect(removed).toEqual(['b1-0@3'])
    for (const id of ['merged', 'untracked', 'unmerged', 'shared', 'inproject']) {
      expect(getHubChild(id)?.phase).toBe('settled')
      expect(isConversationArchived(id)).toBe(true)
    }
    expect(JSON.parse(getHubChild('untracked')!.settleJson!)).toEqual({
      worktree: 'keep',
      keepReason: 'it has uncommitted or untracked files',
    })
    expect(result.text).toContain('Worktrees removed: Child merged.')
    expect(host.changed).toHaveBeenCalledWith('parent')
    // Nothing is left to settle.
    expect((await settler.plan('parent', dir, false)).rows).toEqual([])
  })

  it('keeps a worktree the creation service refuses to remove', async () => {
    const dir = repo()
    child('c1', 0, dir, worktree(dir, 'c1'))
    configureHubWorktrees({
      createWorktreeTransaction: vi.fn(),
      getWorktreeCreation: vi.fn(async () => ({ revision: 1 })),
      actOnWorktreeCreation: vi.fn(async () => ({
        cleanupDisposition: 'removal_refused',
        error: { message: 'dirty' },
      })),
    } as unknown as HubWorktreeService)
    const result = await new HubSettler(fakeHost().host).run('parent', dir, 'auto')
    expect(result.ok && result.rows[0]).toMatchObject({ worktree: 'keep', keepReason: 'dirty' })
  })
})

describe('HubSettler stops', () => {
  it('leaves a child that did not stop open, and settles only the children the card showed', async () => {
    const dir = repo()
    child('ok', 0, dir, null)
    child('stuck', 1, dir, null)
    child('newer', 2, dir, null)
    const { host } = fakeHost()
    host.stop = async (id) => {
      if (id === 'stuck') throw new Error('no')
    }
    const result = await new HubSettler(host).run('parent', dir, 'card', new Set(['ok', 'stuck']))
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Not settled, since they did not stop: Child stuck.')
    expect(getHubChild('ok')?.phase).toBe('settled')
    expect(getHubChild('stuck')?.phase).toBe('open')
    expect(getHubChild('newer')?.phase).toBe('open')
  })
})

describe('childConflicts', () => {
  it('lists two children that change one file, and not a child that changed another', async () => {
    const dir = repo()
    const one = worktree(dir, 'one')
    commit(one, 'c.txt', 'one\n')
    const two = worktree(dir, 'two')
    commit(two, 'c.txt', 'two\n')
    const three = worktree(dir, 'three')
    commit(three, 'a.txt', 'three\n')
    const conflicts = await childConflicts('parent', dir, [
      { childId: 'one', title: 'One', worktree: one },
      { childId: 'two', title: 'Two', worktree: two },
      { childId: 'three', title: 'Three', worktree: three },
    ])
    // git older than 2.38 cannot tell.
    if (conflicts === null) return
    expect(conflicts.get('one')).toEqual([{ with: 'Two', files: ['c.txt'] }])
    expect(conflicts?.get('two')).toEqual([{ with: 'One', files: ['c.txt'] }])
    expect(conflicts?.get('three')).toEqual([])
  })
})

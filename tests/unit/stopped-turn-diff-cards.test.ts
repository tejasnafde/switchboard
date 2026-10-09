/**
 * Stop ends a turn early, but the files the agent changed before it are
 * still changed. Every adapter ends a stopped turn with `turn.completed`
 * (Claude: `claude-adapter-interrupt-turn-end.test.ts`; Codex and OpenCode:
 * their adapter tests), and the registry turns that into one diff card per
 * changed file. Reject stays limited to files this chat's tools wrote.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/main/db/database', () => ({
  threadFamilyIds: (id: string) => [id],
  setConversationStatusLine: () => {},
  saveActivityMessageIfAbsent: () => true,
  recordThreadSession: () => {},
  resolveRootThreadId: (id: string) => id,
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import type { RuntimeEvent, RuntimeFileEditedEvent } from '../../src/shared/provider-events'

const execFileP = promisify(execFile)
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sb-stop-cards-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileP('git', args, { cwd: dir })
  await git('init', '-q')
  await git('config', 'user.email', 't@example.com')
  await git('config', 'user.name', 'T')
  await writeFile(join(dir, 'agent.txt'), 'one\n')
  await writeFile(join(dir, 'user.txt'), 'one\n')
  await git('add', '-A')
  await git('commit', '-qm', 'init')
  return dir
}

type Internals = {
  publish: (e: RuntimeEvent) => void
  checkpoints: { beginTurn: (threadId: string, cwd: string) => Promise<void> }
}

describe.each([
  { provider: 'claude', toolName: 'Write', input: (file: string) => ({ file_path: file, content: 'two\n' }) },
  { provider: 'codex', toolName: 'apply_patch', input: (file: string) => ({ input: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch` }) },
  { provider: 'opencode', toolName: 'write', input: (file: string) => ({ filePath: file, content: 'two\n' }) },
])('diff cards after Stop ($provider)', ({ toolName, input }) => {
  it('sends a card for every file the stopped turn changed, Reject only for the agent\'s', async () => {
    const cwd = await repo()
    const host = { handle: () => {}, emit: () => {}, on: () => {} }
    const registry = new ProviderRegistry(host as never, new Map())
    const internals = registry as unknown as Internals
    const cards: RuntimeFileEditedEvent[] = []
    registry.bus.subscribe((e) => { if (e.type === 'file.edited') cards.push(e) })

    await internals.checkpoints.beginTurn('t1', cwd)
    internals.publish({ type: 'tool.started', threadId: 't1', toolId: 'tool-1', toolName, input: input(join(cwd, 'agent.txt')) } as RuntimeEvent)
    await writeFile(join(cwd, 'agent.txt'), 'two\n')
    internals.publish({ type: 'tool.completed', threadId: 't1', toolId: 'tool-1', output: '' } as RuntimeEvent)
    // Something else in the shared checkout changed during the turn.
    await writeFile(join(cwd, 'user.txt'), 'two\n')

    // The user pressed Stop: the adapter ends the turn with no result.
    internals.publish({ type: 'turn.completed', threadId: 't1' } as RuntimeEvent)
    await vi.waitFor(() => expect(cards).toHaveLength(2))

    const byPath = Object.fromEntries(cards.map((c) => [c.relPath, c]))
    expect(byPath['agent.txt']?.newContent).toBe('two\n')
    expect(byPath['agent.txt']?.noRevert).toBeUndefined()
    expect(byPath['user.txt']?.noRevert).toBe('outside')
  })
})

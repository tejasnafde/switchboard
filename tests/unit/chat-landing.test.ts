import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import {
  buildProjectTargets,
  defaultLandingTarget,
  landingChipLabel,
  landingSendBlock,
  mergeMovedDraft,
  newChatShortcutTarget,
  parseRememberedPick,
  readRememberedPick,
  showMachineNames,
  writeRememberedPick,
  type ProjectTarget,
} from '../../src/renderer/services/chat-landing'

const project = (path: string, ...startedAt: number[]): Project => ({
  path,
  name: path.split('/').pop() ?? path,
  sessions: startedAt.map((at, i) => ({
    id: `${path}-${i}`, source: 'switchboard', title: 't', startedAt: at, messageCount: 1, filePath: '',
  })),
})

const target = (projectPath: string, lastUsedAt = 0, machineId = 'local'): ProjectTarget => ({
  projectPath, machineId, name: projectPath.slice(1), where: machineId === 'local' ? 'local' : `vm ${machineId}`, lastUsedAt,
})

describe('landing project targets', () => {
  it('lists local projects, then connected machines only, with their latest activity', () => {
    const targets = buildProjectTargets([project('/a', 5, 9), project('/b')], {
      remotes: [{ id: 'vm1', name: 'Builder' }, { id: 'vm2', name: 'Offline' }],
      connections: { vm1: 'connected', vm2: 'disconnected' },
      projects: { vm1: [project('/srv/x', 3)], vm2: [project('/srv/y', 99)] },
    })
    expect(targets.map((t) => [t.machineId, t.projectPath, t.where, t.lastUsedAt])).toEqual([
      ['local', '/a', 'local', 9],
      ['local', '/b', 'local', 0],
      ['vm1', '/srv/x', 'Builder', 3],
    ])
  })
})

describe('default landing project', () => {
  const none = () => false
  it('is the most recently used project', () => {
    expect(defaultLandingTarget([target('/a', 1), target('/b', 7), target('/c', 3)], null, none)?.projectPath).toBe('/b')
  })
  it('keeps list order on a tie, so a project with no chats yet falls back to the first', () => {
    expect(defaultLandingTarget([target('/a'), target('/b')], null, none)?.projectPath).toBe('/a')
  })
  it('returns to the last pick while its draft still holds something', () => {
    const targets = [target('/a', 1), target('/b', 7)]
    const remembered = { projectPath: '/a', machineId: 'local' }
    expect(defaultLandingTarget(targets, remembered, () => true)?.projectPath).toBe('/a')
    expect(defaultLandingTarget(targets, remembered, none)?.projectPath).toBe('/b')
  })
  it('ignores a remembered project that is no longer listed', () => {
    const remembered = { projectPath: '/gone', machineId: 'local' }
    expect(defaultLandingTarget([target('/a', 2)], remembered, () => true)?.projectPath).toBe('/a')
  })
  it('tells the same path on two machines apart', () => {
    const remembered = { projectPath: '/a', machineId: 'vm1' }
    const picked = defaultLandingTarget([target('/a', 9), target('/a', 1, 'vm1')], remembered, () => true)
    expect(picked?.machineId).toBe('vm1')
  })
  it('is null with no projects', () => {
    expect(defaultLandingTarget([], null, none)).toBeNull()
  })
})

describe('landing chip and send state', () => {
  it('names the machine only when projects come from more than one', () => {
    const local = [target('/a'), target('/b')]
    expect(showMachineNames(local)).toBe(false)
    expect(showMachineNames([...local, target('/c', 0, 'vm1')])).toBe(true)
    expect(landingChipLabel(target('/a'), false)).toBe('a')
    expect(landingChipLabel(target('/c', 0, 'vm1'), true)).toBe('c · vm vm1')
  })
  it('offers to add a project when there is none', () => {
    expect(landingChipLabel(null, false)).toBe('Add a project')
    expect(landingSendBlock(null, 0)).toBe('Add a project to start a chat')
  })
  it('blocks send until a project is picked, and not after', () => {
    expect(landingSendBlock(null, 2)).toBe('Pick a project to start a chat')
    expect(landingSendBlock(target('/a'), 2)).toBeNull()
  })
})

describe('remembered landing project', () => {
  it('round-trips through storage', () => {
    const map = new Map<string, string>()
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } }
    expect(readRememberedPick(storage)).toBeNull()
    writeRememberedPick(storage, { projectPath: '/a', machineId: 'vm1' })
    expect(readRememberedPick(storage)).toEqual({ projectPath: '/a', machineId: 'vm1' })
  })
  it('treats anything malformed as no pick', () => {
    for (const raw of ['{', 'null', '[]', '{"projectPath":"/a"}', '{"projectPath":1,"machineId":"local"}']) {
      expect(parseRememberedPick(raw)).toBeNull()
    }
  })
})

describe('moving a draft to another project', () => {
  it('carries text, pills and images over to an empty draft', () => {
    expect(mergeMovedDraft(undefined, { text: 'fix [[pill:p1]]', pills: ['p1'], images: ['i1'] }))
      .toEqual({ text: 'fix [[pill:p1]]', pills: ['p1'], images: ['i1'] })
  })
  it('appends after text the target draft already had', () => {
    expect(mergeMovedDraft({ text: 'older', pills: ['p0'], images: [] }, { text: 'newer', pills: ['p1'], images: ['i1'] }))
      .toEqual({ text: 'older\n\nnewer', pills: ['p0', 'p1'], images: ['i1'] })
  })
  it('does not add a blank line when either side has no text', () => {
    expect(mergeMovedDraft({ text: '', pills: [], images: ['i0'] }, { text: 'newer', pills: [], images: [] }).text).toBe('newer')
    expect(mergeMovedDraft({ text: 'older', pills: [], images: [] }, { text: '', pills: [], images: ['i1'] }).text).toBe('older')
  })
})

describe('new chat shortcut', () => {
  it('returns to the landing composer when no chat is open', () => {
    expect(newChatShortcutTarget(null)).toBe('landing')
  })
  it('asks for a project while a chat is open', () => {
    expect(newChatShortcutTarget('agent_1')).toBe('picker')
    expect(newChatShortcutTarget('draft:local:/a')).toBe('picker')
  })
})

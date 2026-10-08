import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types'
import {
  buildProjectTargets,
  defaultLandingTarget,
  landingChipLabel,
  landingSendBlock,
  mergeMovedDraft,
  landingPickFor,
  landingRecentKey,
  landingShortcutHints,
  newChatShortcutAction,
  openLandingProjectPicker,
  parseRememberedPick,
  primaryShowsLanding,
  readRememberedPick,
  recentLandingChats,
  registerLandingProjectPicker,
  showMachineNames,
  writeRememberedPick,
  type ProjectTarget,
} from '../../src/renderer/services/chat-landing'

const project = (path: string, ...startedAt: number[]): Project => ({
  path,
  name: path.split('/').pop() ?? path,
  sessions: startedAt.map((at, i) => ({
    id: `${path}-${i}`,
    source: 'switchboard',
    title: 't',
    startedAt: at,
    messageCount: 1,
    filePath: '',
  })),
})

const target = (projectPath: string, lastUsedAt = 0, machineId = 'local'): ProjectTarget => ({
  projectPath,
  machineId,
  name: projectPath.slice(1),
  where: machineId === 'local' ? 'local' : `vm ${machineId}`,
  lastUsedAt,
})

describe('landing project targets', () => {
  it('lists local projects, then connected machines only, with their latest activity', () => {
    const targets = buildProjectTargets([project('/a', 5, 9), project('/b')], {
      remotes: [
        { id: 'vm1', name: 'Builder' },
        { id: 'vm2', name: 'Offline' },
      ],
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
    expect(defaultLandingTarget([target('/a', 1), target('/b', 7), target('/c', 3)], null, none)?.projectPath).toBe(
      '/b',
    )
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
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v)
      },
    }
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
    expect(mergeMovedDraft(undefined, { text: 'fix [[pill:p1]]', pills: ['p1'], images: ['i1'] })).toEqual({
      text: 'fix [[pill:p1]]',
      pills: ['p1'],
      images: ['i1'],
    })
  })
  it('appends after text the target draft already had', () => {
    expect(
      mergeMovedDraft({ text: 'older', pills: ['p0'], images: [] }, { text: 'newer', pills: ['p1'], images: ['i1'] }),
    ).toEqual({ text: 'older\n\nnewer', pills: ['p0', 'p1'], images: ['i1'] })
  })
  it('does not add a blank line when either side has no text', () => {
    expect(
      mergeMovedDraft({ text: '', pills: [], images: ['i0'] }, { text: 'newer', pills: [], images: [] }).text,
    ).toBe('newer')
    expect(
      mergeMovedDraft({ text: 'older', pills: [], images: [] }, { text: '', pills: [], images: ['i1'] }).text,
    ).toBe('older')
  })
})

describe('new chat shortcut', () => {
  it('opens the project picker while the landing screen shows', () => {
    expect(newChatShortcutAction(null)).toBe('pick-project')
    expect(newChatShortcutAction('draft:local:/a')).toBe('pick-project')
  })
  it('goes back to the landing screen from a chat', () => {
    expect(newChatShortcutAction('agent_1')).toBe('show-landing')
  })
  it('shows the landing screen for an empty slot or a draft only', () => {
    expect(primaryShowsLanding(null)).toBe(true)
    expect(primaryShowsLanding('draft:vm1:/a')).toBe(true)
    expect(primaryShowsLanding('3f2a9c1e-0000-4000-8000-000000000000')).toBe(false)
  })
  it('opens on the focused chat project, else the remembered pick', () => {
    const remembered = { projectPath: '/r', machineId: 'local' }
    expect(landingPickFor({ projectPath: '/a', machineId: 'vm1' }, remembered)).toEqual({
      projectPath: '/a',
      machineId: 'vm1',
    })
    expect(landingPickFor({ projectPath: '/a' }, remembered)).toEqual({ projectPath: '/a', machineId: 'local' })
    expect(landingPickFor(undefined, remembered)).toBe(remembered)
    expect(landingPickFor({}, null)).toBeNull()
  })
  it('reaches the registered project chip, and nothing once it unmounts', () => {
    let opened = 0
    const unregister = registerLandingProjectPicker(() => {
      opened++
    })
    expect(openLandingProjectPicker()).toBe(true)
    unregister()
    expect(openLandingProjectPicker()).toBe(false)
    expect(opened).toBe(1)
  })
  it('keeps a newer registration when an older one unregisters late', () => {
    const older = registerLandingProjectPicker(() => {})
    let newer = 0
    const unregister = registerLandingProjectPicker(() => {
      newer++
    })
    older()
    expect(openLandingProjectPicker()).toBe(true)
    expect(newer).toBe(1)
    unregister()
  })
})

describe('recent chats on the landing screen', () => {
  it('takes the three newest across projects and connected machines', () => {
    const local = [project('/a', 10, 50), project('/b', 40)]
    const chats = recentLandingChats(local, {
      remotes: [
        { id: 'vm1', name: 'gpu' },
        { id: 'vm2', name: 'off' },
      ],
      connections: { vm1: 'connected', vm2: 'disconnected' },
      projects: { vm1: [project('/c', 45)], vm2: [project('/d', 99)] },
    })
    expect(chats.map((c) => [c.session.id, c.machineId, c.projectName])).toEqual([
      ['/a-1', 'local', 'a'],
      ['/c-0', 'vm1', 'c'],
      ['/b-0', 'local', 'b'],
    ])
  })
  it('lists a chat shown under two projects once, and skips terminals', () => {
    const shared = project('/a', 30)
    const twin: Project = {
      ...project('/b'),
      sessions: [...shared.sessions, { ...shared.sessions[0], id: 'term', agentType: 'terminal', startedAt: 99 }],
    }
    const chats = recentLandingChats([shared, twin], { remotes: [], connections: {}, projects: {} })
    expect(chats.map((c) => c.session.id)).toEqual(['/a-0'])
  })
  it('is empty with no chats', () => {
    expect(recentLandingChats([project('/a')], { remotes: [], connections: {}, projects: {} })).toEqual([])
  })
})

describe('recent chat keys', () => {
  const key = (
    k: string,
    mods: Partial<{
      shiftKey: boolean
      metaKey: boolean
      ctrlKey: boolean
      altKey: boolean
      isComposing: boolean
    }> = {},
  ) => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods })

  it('walks the rows with the arrows from an empty composer', () => {
    expect(landingRecentKey(key('ArrowDown'), null, 3, true)).toEqual({ highlight: 0, consume: true })
    expect(landingRecentKey(key('ArrowDown'), 0, 3, true)).toEqual({ highlight: 1, consume: true })
    expect(landingRecentKey(key('ArrowDown'), 2, 3, true)).toEqual({ highlight: 2, consume: true })
    expect(landingRecentKey(key('ArrowUp'), 2, 3, true)).toEqual({ highlight: 1, consume: true })
    expect(landingRecentKey(key('ArrowUp'), null, 3, true)).toEqual({ highlight: 2, consume: true })
  })
  it('goes back to the composer with ArrowUp from the first row', () => {
    expect(landingRecentKey(key('ArrowUp'), 0, 3, true)).toEqual({ highlight: null, consume: true })
  })
  it('opens the highlighted row on Enter, and leaves Enter alone without one', () => {
    expect(landingRecentKey(key('Enter'), 1, 3, true)).toEqual({ highlight: null, open: 1, consume: true })
    expect(landingRecentKey(key('Enter'), null, 3, true)).toEqual({ highlight: null, consume: false })
    expect(landingRecentKey(key('Enter', { shiftKey: true }), 1, 3, true)).toEqual({ highlight: null, consume: false })
  })
  it('drops the highlight on Escape or typing', () => {
    expect(landingRecentKey(key('Escape'), 1, 3, true)).toEqual({ highlight: null, consume: true })
    expect(landingRecentKey(key('Escape'), null, 3, true)).toEqual({ highlight: null, consume: false })
    expect(landingRecentKey(key('a'), 1, 3, true)).toEqual({ highlight: null, consume: false })
    expect(landingRecentKey(key('Backspace'), 1, 3, true)).toEqual({ highlight: null, consume: false })
  })
  it('leaves every key to the composer once it holds text', () => {
    for (const k of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      expect(landingRecentKey(key(k), 1, 3, false)).toEqual({ highlight: null, consume: false })
    }
  })
  it('does nothing without rows', () => {
    expect(landingRecentKey(key('ArrowDown'), null, 0, true)).toEqual({ highlight: null, consume: false })
  })
  it('keeps the highlight through modifiers, shortcuts and IME composition', () => {
    expect(landingRecentKey(key('Shift', { shiftKey: true }), 1, 3, true)).toEqual({ highlight: 1, consume: false })
    expect(landingRecentKey(key('k', { metaKey: true }), 1, 3, true)).toEqual({ highlight: 1, consume: false })
    expect(landingRecentKey(key('ArrowDown', { isComposing: true }), 1, 3, true)).toEqual({
      highlight: 1,
      consume: false,
    })
  })
  it('drops a highlight left past the end after the list shrank', () => {
    expect(landingRecentKey(key('Enter'), 4, 2, true)).toEqual({ highlight: null, consume: false })
  })
})

describe('landing shortcut hints', () => {
  it('reads the live bindings', () => {
    const labels: Record<string, string> = { 'chat.new': '⌘⇧O', 'chat.quick-prompt': '⌃P' }
    expect(landingShortcutHints((id) => labels[id] ?? '')).toEqual([
      { keys: '⌘⇧O', label: 'switch project' },
      { keys: '↑↓', label: 'recent chats' },
      { keys: '⌃P', label: 'quick prompt' },
    ])
  })
  it('leaves out an unbound command', () => {
    expect(landingShortcutHints(() => '').map((h) => h.label)).toEqual(['recent chats'])
  })
})

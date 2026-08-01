/**
 * Mobile slash commands: trigger, filter, and how agent skills merge with the
 * client's own built-ins.
 */
import { describe, it, expect } from 'vitest'
import {
  BUILT_IN_COMMANDS,
  allCommands,
  detectSlash,
  filterCommands,
  skillCommands,
} from '../../apps/mobile/src/lib/slash'
import type { ProviderSkill } from '../../src/shared/types'

const skill = (name: string, over: Partial<ProviderSkill> = {}): ProviderSkill => ({
  name,
  source: 'claude-code',
  ...over,
})

describe('detectSlash', () => {
  it('fires on a slash that opens the draft', () => {
    expect(detectSlash('/')).toBe('')
    expect(detectSlash('/pl')).toBe('pl')
  })

  it('does not fire mid-text, so typing a path does not open the menu', () => {
    expect(detectSlash('see src/main/index.ts')).toBeNull()
    expect(detectSlash('run /help')).toBeNull()
  })

  it('closes once the command is complete', () => {
    // A space means arguments are being typed; the menu has served its purpose.
    expect(detectSlash('/plan ')).toBeNull()
    expect(detectSlash('/deploy staging')).toBeNull()
  })

  it('does not fire on a second slash', () => {
    expect(detectSlash('//')).toBeNull()
    expect(detectSlash('/a/b')).toBeNull()
  })

  it('ignores an empty draft', () => {
    expect(detectSlash('')).toBeNull()
  })
})

describe('skillCommands', () => {
  it('turns skills into insert commands', () => {
    const [cmd] = skillCommands([skill('deploy', { description: 'Ship it', argumentHint: '<env>' })])
    expect(cmd).toMatchObject({
      name: 'deploy',
      description: 'Ship it',
      argumentHint: '<env>',
      action: { kind: 'insert', text: '/deploy ' },
      source: 'claude-code',
    })
  })

  it('drops a skill that collides with a built-in, so /clear keeps its meaning', () => {
    expect(skillCommands([skill('clear'), skill('stop')])).toEqual([])
  })

  it('tolerates a leading slash in the reported name', () => {
    expect(skillCommands([skill('/review')])[0].name).toBe('review')
  })

  it('de-duplicates repeats, case-insensitively', () => {
    expect(skillCommands([skill('Deploy'), skill('deploy')])).toHaveLength(1)
  })

  it('skips an unusable empty name', () => {
    expect(skillCommands([skill('/')])).toEqual([])
  })
})

describe('filterCommands', () => {
  it('returns everything for an empty query', () => {
    expect(filterCommands(BUILT_IN_COMMANDS, '')).toHaveLength(BUILT_IN_COMMANDS.length)
  })

  it('ranks a prefix match above a substring one', () => {
    const cmds = [
      { ...BUILT_IN_COMMANDS[0], name: 'unclear' },
      { ...BUILT_IN_COMMANDS[0], name: 'clear' },
    ]
    expect(filterCommands(cmds, 'cl').map((c) => c.name)).toEqual(['clear', 'unclear'])
  })

  it('is case-insensitive and ignores stray spaces', () => {
    expect(filterCommands(BUILT_IN_COMMANDS, ' PLA ').map((c) => c.name)).toEqual(['plan'])
  })

  it('returns nothing when no command matches', () => {
    expect(filterCommands(BUILT_IN_COMMANDS, 'zzz')).toEqual([])
  })
})

describe('allCommands', () => {
  it('puts built-ins before agent skills', () => {
    const all = allCommands([skill('deploy')])
    expect(all[0].source).toBe('switchboard')
    expect(all[all.length - 1].name).toBe('deploy')
  })

  it('offers the four runtime modes, which is the point on a phone', () => {
    const names = allCommands([]).map((c) => c.name)
    expect(names).toEqual(expect.arrayContaining(['plan', 'sandbox', 'edits', 'full']))
  })
})

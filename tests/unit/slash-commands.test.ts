import { describe, it, expect } from 'vitest'
import {
  detectSlashTrigger,
  filterSlashCommands,
  SLASH_COMMANDS,
} from '../../src/renderer/components/chat/slashCommands'

/**
 * Slash command trigger + registry tests.
 *
 * The trigger is the part most likely to regress silently — someone pastes
 * a path like `src/foo` into the chat and we don't want the menu to pop up.
 * These tests lock down the exact semantics: slash must be the first
 * non-whitespace char of the *current line*.
 */

describe('detectSlashTrigger', () => {
  it('fires when `/` is the first char at caret position', () => {
    const t = detectSlashTrigger('/', 1)
    expect(t).not.toBeNull()
    expect(t!.query).toBe('')
    expect(t!.rangeStart).toBe(0)
    expect(t!.rangeEnd).toBe(1)
  })

  it('captures the query after the slash', () => {
    const t = detectSlashTrigger('/plan', 5)
    expect(t).not.toBeNull()
    expect(t!.query).toBe('plan')
    expect(t!.rangeStart).toBe(0)
    expect(t!.rangeEnd).toBe(5)
  })

  it('returns null when caret is mid-word (e.g. pasting `src/foo`)', () => {
    // `src/foo` — caret after `foo`. Line-prefix is `src/foo`, which does NOT
    // match /^\/(\S*)$/ because it doesn't start with `/`.
    expect(detectSlashTrigger('src/foo', 7)).toBeNull()
  })

  it('returns null for `/` followed by a space (not a command)', () => {
    // Line-prefix `/ ` — the space after `/` disqualifies it from the regex
    // because we require [^\s/]* after the slash.
    expect(detectSlashTrigger('/ plan', 2)).toBeNull()
  })

  it('returns null when the slash is mid-line (after other chars)', () => {
    // `hi /plan` — line-prefix is `hi /plan`, doesn't start with `/`.
    expect(detectSlashTrigger('hi /plan', 8)).toBeNull()
  })

  it('fires on second line when that line starts with `/`', () => {
    // `first line\n/plan` — the current line is `/plan`, so line-prefix is
    // `/plan` and the trigger should fire with query="plan".
    const text = 'first line\n/plan'
    const t = detectSlashTrigger(text, text.length)
    expect(t).not.toBeNull()
    expect(t!.query).toBe('plan')
    expect(t!.rangeStart).toBe(11) // after the newline
  })

  it('captures progressively as the user types', () => {
    expect(detectSlashTrigger('/p', 2)?.query).toBe('p')
    expect(detectSlashTrigger('/pl', 3)?.query).toBe('pl')
    expect(detectSlashTrigger('/pla', 4)?.query).toBe('pla')
    expect(detectSlashTrigger('/plan', 5)?.query).toBe('plan')
  })

  it('clamps out-of-range caret positions safely', () => {
    // Caret beyond text length should not throw
    expect(() => detectSlashTrigger('/plan', 999)).not.toThrow()
    expect(detectSlashTrigger('/plan', 999)?.query).toBe('plan')
    expect(() => detectSlashTrigger('/plan', -5)).not.toThrow()
  })

  it('does NOT fire on paths embedded elsewhere in the text', () => {
    expect(detectSlashTrigger('edit /etc/hosts', 15)).toBeNull()
    expect(detectSlashTrigger('~/Library/foo', 13)).toBeNull()
  })

  it('does NOT fire when a nested slash follows (e.g. `/foo/bar`)', () => {
    // `/foo/bar` looks like a path, not a command. Our regex [^\s/]* forbids
    // subsequent slashes, so this correctly doesn't fire.
    expect(detectSlashTrigger('/foo/bar', 8)).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  it('returns everything for an empty query', () => {
    expect(filterSlashCommands('')).toEqual(SLASH_COMMANDS)
  })

  it('prefix-matches on command name (case-insensitive)', () => {
    const matches = filterSlashCommands('pl')
    expect(matches.map((c) => c.name)).toContain('plan')
    expect(matches.every((c) => c.name.toLowerCase().startsWith('pl'))).toBe(true)
  })

  it('falls back to description substring when no name matches', () => {
    // "execute" appears in the /sandbox description but no command name contains it
    const matches = filterSlashCommands('approve')
    expect(matches.length).toBeGreaterThan(0)
  })

  it('is case-insensitive', () => {
    expect(filterSlashCommands('PLAN').map((c) => c.name)).toContain('plan')
  })

  it('returns empty when nothing matches anywhere', () => {
    expect(filterSlashCommands('xyzzyzzz')).toEqual([])
  })
})

describe('SLASH_COMMANDS registry', () => {
  it('has all expected v1 commands', () => {
    const names = SLASH_COMMANDS.map((c) => c.name)
    for (const expected of ['plan', 'sandbox', 'edits', 'full', 'clear', 'archive', 'image', 'stop', 'help']) {
      expect(names).toContain(expected)
    }
  })

  it('uses unique names', () => {
    const names = SLASH_COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('each command has a description', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.description.length).toBeGreaterThan(0)
    }
  })
})

import { mergeWithAgentSkills, skillsToSlashCommands } from '../../src/renderer/components/chat/slashCommands'
import type { ProviderSkill } from '../../src/shared/types'

describe('skillsToSlashCommands', () => {
  it('maps agent skills to slash commands preserving source', () => {
    const skills: ProviderSkill[] = [
      { name: 'commit', description: 'Make a commit', source: 'claude-code' },
      { name: 'plan', argumentHint: '<file>', source: 'codex' },
    ]
    const cmds = skillsToSlashCommands(skills)
    expect(cmds[0].source).toBe('claude-code')
    expect(cmds[0].description).toBe('Make a commit')
    expect(cmds[1].source).toBe('codex')
    expect(cmds[1].argumentHint).toBe('<file>')
    // Codex skill with no description gets a default
    expect(cmds[1].description.length).toBeGreaterThan(0)
  })
})

describe('mergeWithAgentSkills', () => {
  it('puts built-ins first, then non-colliding agent skills', () => {
    const skills: ProviderSkill[] = [
      { name: 'commit', source: 'claude-code' },
      { name: 'clear', source: 'claude-code' }, // collides with built-in
    ]
    const merged = mergeWithAgentSkills(SLASH_COMMANDS, skills)
    const names = merged.map((c) => c.name)
    // Built-in `clear` wins (only one entry, source switchboard)
    const clearEntries = merged.filter((c) => c.name === 'clear')
    expect(clearEntries).toHaveLength(1)
    expect(clearEntries[0].source).toBeUndefined()
    // Agent's `commit` is appended
    expect(names).toContain('commit')
    const commit = merged.find((c) => c.name === 'commit')!
    expect(commit.source).toBe('claude-code')
    // Built-ins all come before any agent-source command
    const firstAgentIdx = merged.findIndex((c) => c.source !== undefined && c.source !== 'switchboard')
    const lastBuiltinIdx = SLASH_COMMANDS.length - 1
    expect(firstAgentIdx).toBeGreaterThan(lastBuiltinIdx)
  })

  it('returns built-ins unchanged when skills array is empty', () => {
    const merged = mergeWithAgentSkills(SLASH_COMMANDS, [])
    expect(merged).toHaveLength(SLASH_COMMANDS.length)
  })
})

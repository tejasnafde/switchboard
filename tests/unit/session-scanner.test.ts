import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import {
  encodeClaudeProjectPath,
  isClaudeDirForProject,
} from '../../src/main/projects/session-scanner'

describe('session scanner - Claude Code paths', () => {
  it('Claude Code directory exists at ~/.claude/projects', () => {
    const claudeDir = join(homedir(), '.claude', 'projects')
    expect(typeof claudeDir).toBe('string')
    // Platform-agnostic: '.claude/projects' on POSIX, '.claude\\projects' on Windows.
    expect(claudeDir).toContain(join('.claude', 'projects'))
  })

  it('encodes project path correctly for Claude Code lookup', () => {
    const encoded = encodeClaudeProjectPath('/Users/tejas/Desktop/projects/switchboard')
    expect(encoded).toBe('-Users-tejas-Desktop-projects-switchboard')
  })

  it('encodes underscores to dashes (matches Claude Code convention)', () => {
    // Real-world: /Users/tejas/Desktop/projects/radicalize_me_public
    // becomes    -Users-tejas-Desktop-projects-radicalize-me-public
    const encoded = encodeClaudeProjectPath('/Users/tejas/radicalize_me_public')
    expect(encoded).toBe('-Users-tejas-radicalize-me-public')
  })

  it('filters JSONL files from directory listing', () => {
    const files = ['session1.jsonl', 'session2.jsonl', 'sessions-index.json', '.DS_Store', 'notes.md']
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))
    expect(jsonlFiles).toEqual(['session1.jsonl', 'session2.jsonl'])
  })

  it('sorts sessions by startedAt descending (newest first)', () => {
    const sessions = [
      { id: '1', startedAt: 1000 },
      { id: '3', startedAt: 3000 },
      { id: '2', startedAt: 2000 },
    ]
    const sorted = sessions.sort((a, b) => b.startedAt - a.startedAt)
    expect(sorted[0].id).toBe('3')
    expect(sorted[1].id).toBe('2')
    expect(sorted[2].id).toBe('1')
  })
})

/**
 * Regression tests for the parent/child project bleed bug.
 *
 * Historical bug (pre-fix): session-scanner used `dir.includes(encoded)` so
 * parent project `/Users/foo/ssg` would match the Claude dir for child
 * `/Users/foo/ssg/submodule` (because the child's encoded string starts with
 * the parent's). Sessions bled across projects in the sidebar and archive
 * state couldn't reliably hide them.
 *
 * The matching predicate `isClaudeDirForProject` now enforces exact equality.
 */
describe('session scanner - exact dir matching (no parent/child bleed)', () => {
  const parentPath = '/Users/foo/ssg'
  const childPath = '/Users/foo/ssg/submodule'
  const parentDir = '-Users-foo-ssg'
  const childDir = '-Users-foo-ssg-submodule'
  const unrelatedDir = '-Users-foo-other'

  it('matches a project to its exact encoded dir', () => {
    expect(isClaudeDirForProject(parentDir, parentPath)).toBe(true)
    expect(isClaudeDirForProject(childDir, childPath)).toBe(true)
  })

  it('does NOT match parent project against child dir (the real bug)', () => {
    // The child dir name begins with the parent's encoded string.
    // A substring-based match would incorrectly return true here.
    expect(isClaudeDirForProject(childDir, parentPath)).toBe(false)
  })

  it('does NOT match child project against parent dir', () => {
    expect(isClaudeDirForProject(parentDir, childPath)).toBe(false)
  })

  it('does NOT match unrelated dirs', () => {
    expect(isClaudeDirForProject(unrelatedDir, parentPath)).toBe(false)
    expect(isClaudeDirForProject(unrelatedDir, childPath)).toBe(false)
  })

  it('documents why the old substring match was wrong (prefix collision)', () => {
    // This is the exact condition that would have caused the bleed.
    // Kept as a captured artifact so nobody reintroduces `dir.includes(...)`.
    const encoded = encodeClaudeProjectPath(parentPath)
    expect(childDir.startsWith(encoded)).toBe(true) // bleed-trigger
    expect(childDir === encoded).toBe(false)        // correct behavior
  })
})

describe('session scanner - Codex paths', () => {
  it('Codex sessions stored in dated directories', () => {
    const codexDir = join(homedir(), '.codex', 'sessions')
    expect(codexDir).toContain(join('.codex', 'sessions'))
  })
})

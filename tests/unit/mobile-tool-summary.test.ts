/**
 * Tool-call summaries for the mobile feed. Replaces a truncated
 * JSON.stringify of the whole input object.
 */
import { describe, it, expect } from 'vitest'
import { summarizeTool, shortenPath, condense, toolIcon } from '../../apps/mobile/src/lib/toolSummary'

describe('summarizeTool', () => {
  it('shows the command for Bash, not the surrounding JSON', () => {
    expect(summarizeTool('Bash', { command: 'npm run typecheck', description: 'Typecheck' })).toEqual({
      title: 'Terminal',
      detail: 'npm run typecheck',
      mono: true,
    })
  })

  it('joins argv when the provider sends a command array', () => {
    // Codex sends `command: string[]` where Claude sends a string.
    expect(summarizeTool('shell', { command: ['git', 'status', '--short'] }).detail).toBe('git status --short')
  })

  it('shows a short path for file tools', () => {
    expect(summarizeTool('Read', { file_path: '/Users/t/projects/switchboard/src/main/index.ts' })).toEqual({
      title: 'Read',
      detail: '…/main/index.ts',
      mono: true,
    })
    expect(summarizeTool('read_file', { path: '/a/b/c/d.ts' }).detail).toBe('…/c/d.ts')
  })

  it('names the file a patch touches rather than printing the diff', () => {
    const patch = '*** Begin Patch\n*** Update File: src/app/main.ts\n@@\n-a\n+b\n*** End Patch'
    expect(summarizeTool('apply_patch', { patch }).detail).toBe('…/app/main.ts')
  })

  it('counts files when a patch touches several', () => {
    const patch = '*** Update File: a.ts\n*** Add File: b.ts\n*** Delete File: c.ts'
    expect(summarizeTool('apply_patch', { patch })).toMatchObject({ detail: '3 files', mono: false })
  })

  it('shows pattern and scope for search tools', () => {
    expect(summarizeTool('Grep', { pattern: 'TODO', path: '/repo/src/main' }).detail).toBe('TODO in …/src/main')
    expect(summarizeTool('Grep', { pattern: 'TODO' }).detail).toBe('TODO')
  })

  it('shows only the host for fetches, since a full URL wraps', () => {
    expect(summarizeTool('WebFetch', { url: 'https://docs.example.dev/a/b?c=1' })).toMatchObject({
      detail: 'docs.example.dev',
    })
  })

  it('counts todo items', () => {
    expect(summarizeTool('TodoWrite', { todos: [1, 2, 3] }).detail).toBe('3 items')
    expect(summarizeTool('TodoWrite', { todos: [1] }).detail).toBe('1 item')
  })

  it('falls back to a plausible field for an unknown tool', () => {
    expect(summarizeTool('mcp__thing__do', { query: 'find me' })).toMatchObject({
      title: 'mcp__thing__do',
      detail: 'find me',
    })
  })

  it('lists keys rather than dumping JSON when no field is recognisable', () => {
    expect(summarizeTool('Weird', { alpha: 1, beta: 2 }).detail).toBe('alpha, beta')
  })

  it('survives null, string and non-object input', () => {
    expect(summarizeTool('Bash', null).detail).toBe('')
    expect(summarizeTool('Bash', 'raw string').detail).toBe('')
    expect(summarizeTool('Read', undefined).detail).toBe('')
  })

  it('collapses newlines so a heredoc command stays one line', () => {
    const detail = summarizeTool('Bash', { command: 'cat <<EOF\nline one\nline two\nEOF' }).detail
    expect(detail).not.toContain('\n')
    expect(detail).toContain('cat <<EOF line one')
  })
})

describe('helpers', () => {
  it('leaves short paths alone', () => {
    expect(shortenPath('src/index.ts')).toBe('src/index.ts')
    expect(shortenPath('index.ts')).toBe('index.ts')
  })

  it('caps with an ellipsis at the requested length', () => {
    expect(condense('x'.repeat(50), 10)).toHaveLength(10)
    expect(condense('short', 10)).toBe('short')
  })
})

describe('toolIcon', () => {
  it('groups by what the tool does, across providers', () => {
    // Codex/OpenCode spellings must land on the same glyph as Claude's.
    expect(toolIcon('Bash')).toBe(toolIcon('shell'))
    expect(toolIcon('Read')).toBe(toolIcon('read_file'))
    expect(toolIcon('Grep')).toBe(toolIcon('search_files'))
    expect(toolIcon('Edit')).toBe(toolIcon('apply_patch'))
  })

  it('is case-insensitive', () => {
    expect(toolIcon('BASH')).toBe('terminal')
  })

  it('falls back to a generic glyph for an unknown tool', () => {
    expect(toolIcon('mcp__thing__do')).toBe('construct-outline')
    expect(toolIcon('')).toBe('construct-outline')
  })

  it('gives searches and shells different glyphs, so a feed is scannable', () => {
    expect(toolIcon('Grep')).not.toBe(toolIcon('Bash'))
  })
})

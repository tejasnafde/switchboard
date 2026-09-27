import { describe, expect, it } from 'vitest'
import { bbprPullRequestNumbers, toolInputCommand } from '../../src/shared/bbpr-command'

describe('bbprPullRequestNumbers', () => {
  it.each([
    ['bbpr 605', [605]],
    ['bbpr 605 diff', [605]],
    ['  bbpr 605\tcomments', [605]],
    ['cd /repos/ssg-bot-v2 && bbpr 605 diff', [605]],
    ['cd "/repos/my repo" && bbpr 605', [605]],
    ['git fetch; bbpr 605', [605]],
    ['bbpr 605 diff | head -50', [605]],
    ['echo start | bbpr 605', [605]],
    ['false || bbpr 605', [605]],
    ['bbpr 605\nbbpr 606 diff', [605, 606]],
    ['bbpr 605 && bbpr 605 comments', [605]],
    ['~/bin/bbpr 605', [605]],
  ])('reads %j', (command, numbers) => {
    expect(bbprPullRequestNumbers(command)).toEqual(numbers)
  })

  it.each([
    'bbpr',
    'bbpr list',
    'bbpr show 605',
    'bbpr --help 605',
    'bbpr 605abc',
    'bbpr 0',
    'echo bbpr 605',
    'git log | grep 605',
    'cat notes.txt # bbpr 605',
    'echo "a; bbpr 605"',
    "echo 'x && bbpr 605'",
    'mybbpr 605',
    'bbprx 605',
    'npm test -- 605',
  ])('ignores %j', (command) => {
    expect(bbprPullRequestNumbers(command)).toEqual([])
  })
})

describe('toolInputCommand', () => {
  it('reads Claude Bash input, Codex argv, and a bare command', () => {
    expect(toolInputCommand(JSON.stringify({ command: 'bbpr 605', description: 'x' }, null, 2))).toBe('bbpr 605')
    expect(toolInputCommand(JSON.stringify({ command: ['bash', '-lc', 'cd /r && bbpr 605'] }))).toBe('cd /r && bbpr 605')
    expect(toolInputCommand(JSON.stringify({ cmd: 'bbpr 605' }))).toBe('bbpr 605')
    expect(toolInputCommand('bbpr 605 diff')).toBe('bbpr 605 diff')
  })

  it('has no command for a tool without one', () => {
    expect(toolInputCommand(JSON.stringify({ file_path: '/r/a.ts', content: 'bbpr 605' }))).toBeNull()
  })
})

/**
 * Behavior 6: the copyable login / mkdir commands this module formats are
 * pasted into a real POSIX shell, and the directory they embed is free text
 * the user typed into Settings -> Providers.
 *
 * The old quoting wrapped that text in DOUBLE quotes and escaped only
 * `"` `\` and a backtick - which leaves `$` live, so `$(...)`, `${...}` and
 * `$VAR` inside an oauth_dir are evaluated by the shell that runs the command.
 * At best the user gets a CODEX_HOME that is not the directory they logged
 * into (a silent wrong-account run); at worst the pasted command executes
 * whatever the substitution names.
 *
 * These tests do not eyeball the string - they hand the generated assignment
 * to /bin/sh and assert the variable the shell actually ends up with is
 * byte-identical to the directory. The only expansion allowed to survive is
 * the `$HOME` WE generate for a structural leading `~/`, never one that came
 * from user text.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  oauthCreateDirCommand,
  oauthInteractiveLoginCommand,
  oauthLoginCommand,
} from '../../src/shared/provider-auth-format'

/** Value `sh` really assigns, given a `NAME=<quoted>` prefix from the command. */
function shellValueOf(command: string, cliSuffix: string, varName: string): string {
  const assignment = command.slice(0, command.length - cliSuffix.length)
  return execFileSync('/bin/sh', ['-c', `${assignment} sh -c 'printf %s "$${varName}"'`], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: '/fake/home/testuser' },
  })
}

const HOSTILE = [
  '/tmp/oauth $(echo INJECTED)',
  '/tmp/oauth `echo INJECTED`',
  '/tmp/oauth ${HOME}',
  '/tmp/oauth $HOME/x',
  "/tmp/oauth's dir",
  '/tmp/oauth "quoted" dir',
  '/tmp/oauth\\backslash',
]

describe('oauthLoginCommand - POSIX-safe quoting (behavior 6)', () => {
  const created: string[] = []

  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  for (const dir of HOSTILE) {
    it(`passes ${JSON.stringify(dir)} to the shell literally`, () => {
      expect(shellValueOf(oauthLoginCommand('codex', dir), ' codex login', 'CODEX_HOME')).toBe(dir)
      expect(
        shellValueOf(oauthLoginCommand('claude-code', dir), ' claude auth login', 'CLAUDE_CONFIG_DIR'),
      ).toBe(dir)
      expect(
        shellValueOf(oauthInteractiveLoginCommand('codex', dir), ' codex', 'CODEX_HOME'),
      ).toBe(dir)
    })
  }

  it('never lets an oauth_dir substitution run a command', () => {
    const marker = mkdtempSync(join(tmpdir(), 'sb-quote-'))
    created.push(marker)
    const witness = join(marker, 'pwned')
    const dir = `/tmp/x$(touch ${witness})`
    // Running the assignment must not execute the substitution.
    shellValueOf(oauthLoginCommand('codex', dir), ' codex login', 'CODEX_HOME')
    expect(existsSync(witness)).toBe(false)
  })

  it('keeps the structurally generated ~ expansion working', () => {
    // The tilde here is OURS (the `~/.codex` default we pass when an instance
    // has no oauth_dir), so it must still expand to the pasting user's $HOME.
    expect(shellValueOf(oauthLoginCommand('codex', '~/.codex'), ' codex login', 'CODEX_HOME'))
      .toBe('/fake/home/testuser/.codex')
    expect(shellValueOf(oauthLoginCommand('claude-code', '~/.claude-tejas'), ' claude auth login', 'CLAUDE_CONFIG_DIR'))
      .toBe('/fake/home/testuser/.claude-tejas')
  })

  it('expands a structural ~ even when the rest of the path needs quoting', () => {
    expect(shellValueOf(oauthLoginCommand('codex', '~/.codex $(echo INJECTED)'), ' codex login', 'CODEX_HOME'))
      .toBe('/fake/home/testuser/.codex $(echo INJECTED)')
  })
})

describe('oauthCreateDirCommand - POSIX-safe quoting (behavior 6)', () => {
  it('quotes a hostile directory so mkdir receives one literal argument', () => {
    const dir = '/tmp/oauth $(echo INJECTED) dir'
    const cmd = oauthCreateDirCommand(dir)
    const out = execFileSync('/bin/sh', ['-c', cmd.replace(/^mkdir -p /, 'printf %s ')], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: '/fake/home/testuser' },
    })
    expect(out).toBe(dir)
  })

  it('still expands the structural ~ it is given', () => {
    const out = execFileSync('/bin/sh', ['-c', oauthCreateDirCommand('~/.codex-work').replace(/^mkdir -p /, 'printf %s ')], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: '/fake/home/testuser' },
    })
    expect(out).toBe('/fake/home/testuser/.codex-work')
  })
})

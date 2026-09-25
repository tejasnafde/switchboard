/**
 * Get the Claude CLI to refresh an instance's expired OAuth token, so the
 * refresh runs under the CLI's own lock and write-back instead of racing it
 * from Switchboard (see claude-usage.ts).
 *
 * `claude mcp list` makes no model call and still goes through the CLI's
 * refresh-if-expired step: against CLI 2.1.280 (2026-09-25) it rewrote an
 * expired keychain entry, where `claude auth status` left it untouched. It
 * also health-checks the user's MCP servers, so it can take a few seconds.
 * The fallback is one one-word turn on the smallest model, which always
 * refreshes but spends a little quota, so it only runs when the user asks.
 *
 * Child output is discarded, never logged or returned.
 */

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { win32 } from 'path'
import { findClaudeBin } from '../adapters/claude-adapter'
import { createMainLogger } from '../../logger'

const log = createMainLogger('provider:usage-refresh')

const NO_MODEL_TIMEOUT_MS = 30_000
const TURN_TIMEOUT_MS = 60_000

/**
 * execFile cannot start a Windows `.cmd`/`.bat`/`.ps1` shim without a shell,
 * and a shell would re-parse the arguments (the empty `--tools` value among
 * them). npm's shim for Claude Code only forwards to the package's native
 * `bin/claude.exe`, so launch that directly. Null when the shim has no such
 * target, rather than falling back to a shell.
 */
export function claudeLaunchPath(
  bin: string,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform !== 'win32' || !/\.(cmd|bat|ps1)$/i.test(bin)) return bin
  const exe = win32.join(win32.dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  return exists(exe) ? exe : null
}

function runClaude(args: string[], env: Record<string, string>, timeoutMs: number, what: string): Promise<boolean> {
  const found = findClaudeBin()
  const bin = found ? claudeLaunchPath(found) : null
  if (!bin) {
    log.warn(`${what}: ${found ? `cannot launch ${found} without a shell` : 'claude binary not found'}`)
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    // tmpdir, so no project's .mcp.json or CLAUDE.md is involved.
    execFile(bin, args, { env, cwd: tmpdir(), timeout: timeoutMs }, (err) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean }
        log.warn(`${what} failed: ${e.killed ? `timed out after ${timeoutMs}ms` : `exit ${String(e.code)}`}`)
        resolve(false)
        return
      }
      resolve(true)
    })
  })
}

/** No model call, no quota. */
export function refreshClaudeTokenWithoutTurn(env: Record<string, string>): Promise<boolean> {
  return runClaude(['mcp', 'list'], env, NO_MODEL_TIMEOUT_MS, 'claude mcp list')
}

/** One minimal turn: smallest model, one-word prompt, no tools, nothing saved. */
export function refreshClaudeTokenWithTurn(env: Record<string, string>): Promise<boolean> {
  return runClaude(
    ['-p', 'hi', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--strict-mcp-config'],
    env,
    TURN_TIMEOUT_MS,
    'claude -p refresh turn',
  )
}

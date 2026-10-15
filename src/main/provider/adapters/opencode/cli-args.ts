/**
 * The OpenCode command lines Switchboard runs, per generation. Kept apart
 * from `version.ts` so tests that mock the version gate still get real args.
 */
import type { OpencodeGeneration } from './version'

/**
 * `opencode acp`. 1.x takes the folder as `--cwd`; 2.x's `acp` takes no
 * options and rejects unknown ones, and reads the folder from the spawn cwd.
 */
export function opencodeAcpArgs(cwd: string, generation: OpencodeGeneration): string[] {
  return generation === 2 ? ['acp'] : ['acp', '--cwd', cwd]
}

/**
 * `opencode models`. 2.x attaches to a shared background service started
 * with its first caller's env, so an account's API keys may not apply;
 * `--standalone` runs a private server with this spawn's env instead.
 */
export function opencodeModelsArgs(generation: OpencodeGeneration): string[] {
  return generation === 2 ? ['models', '--standalone'] : ['models']
}

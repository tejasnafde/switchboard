/** Real (side-effecting) provisioning deps: a child_process runner + the inputs. */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Machine } from '@shared/machines'
import { appRootDir, appVersion } from '../runtime'
import { provisionRemote, type ProcRunner } from './provisioner'

export const execProc: ProcRunner['exec'] = (command, args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(command, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: err.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (stdin !== undefined) {
      // ssh exiting mid-write raises EPIPE; swallow it here - the 'close'
      // handler above still reports the real exit code + stderr.
      child.stdin.on('error', () => {})
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })

function readServerBundle(): string {
  // Shipped inside the asar via `out/**` (build runs build:server); dev reads it
  // from the repo. appRootDir is the asar root packaged, the repo root in dev.
  const path = join(appRootDir(), 'out/server/index.cjs')
  if (!existsSync(path)) throw new Error('server bundle missing; run `npm run build:server`')
  return readFileSync(path, 'utf-8')
}

function depVersion(name: string): string {
  const pkg = JSON.parse(readFileSync(join(appRootDir(), 'package.json'), 'utf-8'))
  return String(pkg.dependencies?.[name] ?? '').replace(/^[\^~]/, '')
}

/** Bundle the real deps into the ConnectionManager `provision` hook. */
export function makeProvision(log?: (msg: string) => void) {
  return (machine: Machine) =>
    provisionRemote(
      machine,
      { appVersion: appVersion(), betterSqliteVersion: depVersion('better-sqlite3'), bundle: readServerBundle() },
      { exec: execProc },
      log,
    )
}

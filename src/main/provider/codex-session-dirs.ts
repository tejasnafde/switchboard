import { homedir } from 'node:os'
import { join } from 'node:path'
import { listOauthDirsForAgent } from '../db/providerInstances'

export function codexCandidateDirs(): string[] {
  return Array.from(new Set([
    ...listOauthDirsForAgent('codex'),
    join(homedir(), '.codex'),
  ]))
}

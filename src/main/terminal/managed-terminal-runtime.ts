import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { TerminalCreateOptions } from '../../shared/types'
import { createMainLogger } from '../logger'

const log = createMainLogger('terminal:managed-runtime')

export type ManagedTerminalSpec = Pick<
  TerminalCreateOptions,
  'id' | 'cwd' | 'initialCommand' | 'waitFor'
>

export interface ManagedTerminalBackend {
  has(id: string): boolean
  create(options: ManagedTerminalSpec): Promise<void>
}

export interface ManagedTerminalProvisioningResult {
  status: 'succeeded' | 'failed'
  terminalIds: string[]
}

export interface ManagedTerminalCommandLedger {
  /** Atomically claims the right to start this handle's command. */
  claim(terminalId: string): Promise<ManagedTerminalCommandClaim | null>
}

export interface ManagedTerminalCommandClaim {
  /** Release only when terminal creation definitely failed before spawn. */
  release(): Promise<void>
}

class MemoryManagedTerminalCommandLedger implements ManagedTerminalCommandLedger {
  private readonly claimed = new Set<string>()

  async claim(terminalId: string): Promise<ManagedTerminalCommandClaim | null> {
    if (this.claimed.has(terminalId)) return null
    this.claimed.add(terminalId)
    let active = true
    return {
      release: async () => {
        if (!active) return
        active = false
        this.claimed.delete(terminalId)
      },
    }
  }
}

export class FileManagedTerminalCommandLedger implements ManagedTerminalCommandLedger {
  constructor(private readonly directory: () => string) {}

  async claim(terminalId: string): Promise<ManagedTerminalCommandClaim | null> {
    const directory = this.directory()
    mkdirSync(directory, { recursive: true })
    const name = createHash('sha256').update(terminalId).digest('hex')
    const claimPath = join(directory, name)
    try {
      const fd = openSync(claimPath, 'wx')
      closeSync(fd)
      let active = true
      return {
        release: async () => {
          if (!active) return
          active = false
          try {
            unlinkSync(claimPath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
  }
}

/**
 * Owns idempotency for terminals created as part of a backend transaction.
 * The stable id is the handle: a live handle is adopted, while a dead handle
 * may be recreated without replaying its one-shot startup command.
 */
export class ManagedTerminalRuntime {
  private readonly starting = new Map<string, Promise<boolean>>()

  constructor(
    private readonly backend: () => ManagedTerminalBackend | null,
    private readonly commandLedger: ManagedTerminalCommandLedger = new MemoryManagedTerminalCommandLedger(),
  ) {}

  async provision(terminals: ManagedTerminalSpec[]): Promise<ManagedTerminalProvisioningResult> {
    const backend = this.backend()
    if (!backend) return { status: 'failed', terminalIds: [] }

    const terminalIds: string[] = []
    for (const terminal of terminals) {
      if (backend.has(terminal.id)) {
        terminalIds.push(terminal.id)
        continue
      }
      let starting = this.starting.get(terminal.id)
      if (!starting) {
        starting = (async () => {
          let commandClaim: ManagedTerminalCommandClaim | null = null
          try {
            commandClaim = terminal.initialCommand
              ? await this.commandLedger.claim(terminal.id)
              : null
            await backend.create({
              id: terminal.id,
              ...(terminal.cwd ? { cwd: terminal.cwd } : {}),
              ...(commandClaim && terminal.initialCommand
                ? { initialCommand: terminal.initialCommand }
                : {}),
              ...(commandClaim && terminal.initialCommand && terminal.waitFor
                ? { waitFor: terminal.waitFor }
                : {}),
            })
            return true
          } catch (error) {
            if (commandClaim) {
              try {
                await commandClaim.release()
              } catch (releaseError) {
                log.error('failed to release initial-command claim after terminal rejection', {
                  terminalId: terminal.id,
                  error: releaseError,
                })
              }
            }
            log.warn('managed terminal creation rejected', { terminalId: terminal.id, error })
            return false
          }
        })()
        this.starting.set(terminal.id, starting)
        void starting.finally(() => {
          if (this.starting.get(terminal.id) === starting) this.starting.delete(terminal.id)
        })
      }
      if (!await starting) return { status: 'failed', terminalIds }
      terminalIds.push(terminal.id)
    }
    return { status: 'succeeded', terminalIds }
  }
}

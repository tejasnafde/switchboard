/**
 * Files that hold the secrets a user gives an agent (`request_secret`).
 *
 *   <root>/                 0700, Time Machine exclusion, .metadata_never_index
 *   <root>/<dirId>/         0300: the owner opens a known path, `ls` fails
 *   <root>/<dirId>/<NAME>   0600, the value, no trailing newline
 *
 * `dirId` is 128 random bits per root conversation, kept in
 * `agent_secret_dirs`, so it cannot be guessed from a transcript path. The
 * table rows (`db/agent-secrets.ts`) list the names, so nothing here needs to
 * list a chat folder except the sweep, which opens it to 0700 for the read.
 * While a file is live its value is also armed in the redactor
 * (`secret-redactor.ts`): on save, and by the sweep at start, which reads the
 * live files back. Every delete drops it. No encryption at rest: the agent's
 * commands read plaintext, and the short expiry is the control. Logs name row ids only, never a name or a value.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { createMainLogger } from '../logger'
import { resolveRootThreadId } from '../db/conversations'
import { secretRedactor, type SecretRedactor } from './secret-redactor'
import {
  claimSecretDirId,
  deleteSecretDir,
  getAgentSecret,
  getSecretDirId,
  insertAgentSecret,
  listArchivedSecretChats,
  listChatAgentSecrets,
  listLiveAgentSecrets,
  listSecretDirIds,
  markAgentSecretDeleted,
  setAgentSecretExpiry,
  type AgentSecretRow,
} from '../db/agent-secrets'

const log = createMainLogger('secrets:store')

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/
export const SECRET_MAX_BYTES = 16 * 1024
export const SECRET_SWEEP_INTERVAL_MS = 15 * 60_000
const PARTIAL = '.partial'
const DIR_ID_PATTERN = /^[0-9a-f]{32}$/

export interface SavedSecret {
  id: string
  file: string
  expiresAt: number
}

export interface SecretStoreOptions {
  root: string
  now?: () => number
  /** A live file was deleted by its expiry, not by the user or an archive. */
  onExpired?: (row: AgentSecretRow) => void
  /** Exclude the root from backups. Defaults to `tmutil addexclusion` on macOS. */
  excludeFromBackup?: (dir: string) => void
  /** Masks live values in output. Defaults to the backend's one matcher. */
  redactor?: SecretRedactor
}

/** Fs errors carry the path, which names the secret and the chat folder: log the code only. */
export function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.name : 'unknown')
}

function tmutilExclude(dir: string): void {
  if (process.platform !== 'darwin') return
  execFile('tmutil', ['addexclusion', dir], (err) => {
    if (err) log.warn('could not exclude the secrets folder from Time Machine', errCode(err))
  })
}

export class SecretStore {
  private readonly root: string
  private readonly now: () => number
  private readonly onExpired?: (row: AgentSecretRow) => void
  private readonly excludeFromBackup: (dir: string) => void
  private readonly redactor: SecretRedactor
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private sweepTimer: NodeJS.Timeout | null = null
  private rootReady = false

  constructor(opts: SecretStoreOptions) {
    this.root = opts.root
    this.now = opts.now ?? Date.now
    this.onExpired = opts.onExpired
    this.excludeFromBackup = opts.excludeFromBackup ?? tmutilExclude
    this.redactor = opts.redactor ?? secretRedactor
  }

  /** Create the root with its mode, backup exclusion and Spotlight marker, once per process. */
  private ensureRoot(): void {
    if (this.rootReady) return
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
    const marker = join(this.root, '.metadata_never_index')
    if (!existsSync(marker)) writeFileSync(marker, '', { mode: 0o600 })
    this.excludeFromBackup(this.root)
    this.rootReady = true
  }

  /**
   * The chat's folder, made at session start so `SWITCHBOARD_SECRETS_DIR`
   * points at it before any secret exists.
   */
  chatDir(threadId: string): string {
    this.ensureRoot()
    const dirId = claimSecretDirId(threadId, randomBytes(16).toString('hex'), this.now())
    const dir = join(this.root, dirId)
    mkdirSync(dir, { recursive: true, mode: 0o300 })
    chmodSync(dir, 0o300)
    return dir
  }

  /**
   * Write `<NAME>.partial` with `wx` (never follows or replaces a symlink) and
   * fsync it, record the row, then rename over `<NAME>`. A failed write or
   * record deletes the `.partial` file, so the old file and row stay as they
   * were. A new save for the same name replaces the old file.
   */
  save(input: {
    threadId: string
    name: string
    value: Buffer
    cardId: string
    expiresAt: number
    machineId?: string | null
  }): SavedSecret {
    if (!SECRET_NAME_PATTERN.test(input.name)) throw new Error('secret name does not match the rule')
    if (input.value.length === 0 || input.value.length > SECRET_MAX_BYTES) throw new Error('secret size out of range')
    const dir = this.chatDir(input.threadId)
    const file = join(dir, input.name)
    const partial = file + PARTIAL
    const id = `sec_${randomBytes(12).toString('hex')}`
    const replaced = listLiveAgentSecrets(input.threadId).filter((r) => r.name === input.name)
    const fd = openSync(partial, 'wx', 0o600)
    try {
      try {
        writeSync(fd, input.value)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      insertAgentSecret({
        id,
        threadId: input.threadId,
        dirId: getSecretDirId(input.threadId) as string,
        name: input.name,
        machineId: input.machineId ?? null,
        cardId: input.cardId,
        createdAt: this.now(),
        expiresAt: input.expiresAt,
      })
    } catch (err) {
      this.unlinkQuiet(partial)
      throw err
    }
    try {
      renameSync(partial, file)
    } catch (err) {
      markAgentSecretDeleted(id, this.now())
      this.unlinkQuiet(partial)
      throw err
    }
    for (const row of replaced) {
      this.clearTimer(row.id)
      this.redactor.drop(row.id)
    }
    this.redactor.add(resolveRootThreadId(input.threadId), id, input.name, input.value)
    this.arm(id, input.expiresAt)
    return { id, file, expiresAt: input.expiresAt }
  }

  /** Move a live secret's expiry. False when it is gone. */
  extend(id: string, expiresAt: number): boolean {
    if (!setAgentSecretExpiry(id, expiresAt)) return false
    this.arm(id, expiresAt)
    return true
  }

  /** One secret's row, deleted or not. Metadata only. */
  get(id: string): AgentSecretRow | null {
    return getAgentSecret(id)
  }

  /** A chat's rows, deleted ones too, for its saved lines. Metadata only. */
  listChat(threadId: string): AgentSecretRow[] {
    return listChatAgentSecrets(threadId)
  }

  /** Delete one secret now (the user's "Delete now"). False when it was already gone. */
  remove(id: string): boolean {
    const row = getAgentSecret(id)
    if (!row || row.deletedAt !== null) return false
    return this.deleteRow(row)
  }

  /** The chat was archived or deleted: every file, the folder and its dir row go. */
  removeChat(threadId: string): void {
    for (const row of listLiveAgentSecrets(threadId)) this.deleteRow(row)
    this.redactor.dropChat(resolveRootThreadId(threadId))
    const dirId = getSecretDirId(threadId)
    if (!dirId) return
    try {
      this.removeDirTree(join(this.root, dirId))
      deleteSecretDir(threadId)
    } catch (err) {
      log.warn('could not remove a chat secrets folder; the sweep retries', errCode(err))
    }
  }

  /**
   * ponytail: opens every chat folder (two chmods and a readdir each), which is
   * microseconds per chat; track dirty folders if a profile ever holds tens of
   * thousands of them.
   *
   * Delete every archived chat's files and folder (an archive whose own
   * delete failed), every expired file, every folder with no dir row (a crash
   * orphan), every `.partial` file and every file no live row names. A file
   * that has not expired stays: the chat is still there after a restart, and
   * its value is read back into the redactor.
   */
  sweep(): void {
    if (!existsSync(this.root)) return
    this.ensureRoot()
    for (const chat of listArchivedSecretChats()) {
      try {
        this.removeChat(chat)
      } catch (err) {
        log.warn('secrets sweep could not clean an archived chat; the next sweep retries', errCode(err))
      }
    }
    const now = this.now()
    for (const row of listLiveAgentSecrets()) {
      if (row.expiresAt <= now) {
        if (this.deleteRow(row)) this.onExpired?.(row)
        continue
      }
      if (!this.timers.has(row.id)) this.arm(row.id, row.expiresAt)
      if (!this.redactor.has(row.id)) this.rearm(row)
    }
    const keep = new Map<string, Set<string>>()
    for (const row of listLiveAgentSecrets()) {
      const names = keep.get(row.dirId) ?? new Set<string>()
      names.add(row.name)
      keep.set(row.dirId, names)
    }
    const dirs = listSecretDirIds()
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (entry.name === '.metadata_never_index') continue
      const path = join(this.root, entry.name)
      try {
        if (!entry.isDirectory()) {
          // A file or a symlink: unlink it, never chmod through it.
          rmSync(path, { force: true })
          continue
        }
        if (!DIR_ID_PATTERN.test(entry.name) || !dirs.has(entry.name)) {
          this.removeDirTree(path)
          continue
        }
        const names = keep.get(entry.name) ?? new Set<string>()
        chmodSync(path, 0o700)
        try {
          for (const file of readdirSync(path)) if (!names.has(file)) rmSync(join(path, file), { force: true })
        } finally {
          chmodSync(path, 0o300)
        }
      } catch (err) {
        log.warn('secrets sweep could not clean a folder; the next sweep retries', errCode(err))
      }
    }
  }

  /** Sweep now, then every 15 minutes until `stop`. */
  start(): void {
    this.runSweep()
    this.sweepTimer ??= setInterval(() => this.runSweep(), SECRET_SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  /** Quit: a last sweep of expired files, then drop the timers and values. Files that live on stay. */
  stop(): void {
    this.runSweep()
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const [id, t] of this.timers) {
      clearTimeout(t)
      this.redactor.drop(id)
    }
    this.timers.clear()
  }

  /** A live file from before a restart: read its value back so output is masked again. */
  private rearm(row: AgentSecretRow): void {
    let value: Buffer
    try {
      value = readFileSync(join(this.root, row.dirId, row.name))
    } catch (err) {
      log.warn(`could not read secret ${row.id} back for masking`, errCode(err))
      return
    }
    try {
      this.redactor.add(row.rootThreadId, row.id, row.name, value)
    } finally {
      value.fill(0)
    }
  }

  private runSweep(): void {
    try {
      this.sweep()
    } catch (err) {
      log.warn('secrets sweep failed', errCode(err))
    }
  }

  private arm(id: string, expiresAt: number): void {
    this.clearTimer(id)
    // setTimeout overflows above 2^31-1 ms; the 15-minute sweep catches anything later.
    const delay = Math.min(Math.max(0, expiresAt - this.now()), 2 ** 31 - 1)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      const row = getAgentSecret(id)
      if (!row || row.deletedAt !== null) return
      if (row.expiresAt > this.now()) return this.arm(id, row.expiresAt)
      if (this.deleteRow(row)) this.onExpired?.(row)
    }, delay)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
  }

  /**
   * Unlink, then mark the row. The chat folder stays while the chat lives, so
   * `SWITCHBOARD_SECRETS_DIR` keeps pointing at it. False (logged) when the unlink failed.
   */
  private deleteRow(row: AgentSecretRow): boolean {
    this.clearTimer(row.id)
    const dir = join(this.root, row.dirId)
    try {
      rmSync(join(dir, row.name), { force: true })
    } catch (err) {
      log.warn(`could not delete secret ${row.id}; the sweep retries`, errCode(err))
      return false
    }
    markAgentSecretDeleted(row.id, this.now())
    this.redactor.drop(row.id)
    return true
  }

  private removeDirTree(path: string): void {
    try {
      chmodSync(path, 0o700)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    rmSync(path, { recursive: true, force: true })
  }

  private unlinkQuiet(path: string): void {
    try {
      unlinkSync(path)
    } catch (err) {
      log.warn('could not remove a secret file after a failed save; the sweep retries', errCode(err))
    }
  }
}

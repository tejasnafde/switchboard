/**
 * Keeps `<userData>/settings.json` and the settings DB in step. The DB is the
 * source of truth; the file format and its rules are in
 * `shared/settings-file.ts`.
 *
 * File to DB: a save (debounced, since editors write in bursts) is parsed,
 * checked with the same rules as the UI, and applied through the normal write
 * paths. Invalid JSON applies nothing and is never overwritten.
 *
 * DB to file: a settings write made anywhere else rewrites the file, except
 * when its content differs from what Switchboard last wrote or fully applied
 * (a save not applied yet, a parse error, or entries that were refused),
 * which the status reports.
 *
 * Our own writes are recognised by a content hash, kept in the DB so that a
 * file edited while the app was closed is applied at the next launch. The
 * watcher event our own write causes applies nothing. Electron-free, with
 * the DB behind `deps`, for the tests.
 */
import { watch, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TargetChangedError, replaceFile } from './files/replace-file'
import {
  IDLE_SETTINGS_FILE_STATUS,
  SETTINGS_FILE_NAME,
  SETTINGS_SCHEMA_FILE_NAME,
  describeSkipped,
  planSettingsFileApply,
  projectSettingsFile,
  serializeSettingsFile,
  settingsFileSchema,
  type SettingsFileOp,
  type SettingsFileStatus,
  type SettingsSnapshot,
} from '@shared/settings-file'

export interface SettingsFileLog {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

export interface SettingsFileDeps {
  /** The folder the file lives in (userData). */
  dir: string
  readSnapshot: () => SettingsSnapshot
  /** A stored project key as the project list spells it. */
  projectLabel: (projectKey: string) => string
  /** A project folder as the override rows key it. */
  projectKey: (projectPath: string) => string
  /** Run the writes through the normal paths; answers the settings keys that changed. */
  applyOps: (ops: SettingsFileOp[]) => string[]
  onStatus: (status: SettingsFileStatus) => void
  /** Where the hash of the last synced content is kept (a settings row), so a restart can tell an edit from our own write. */
  syncedHash: { load: () => string | null; save: (hash: string) => void }
  log: SettingsFileLog
  debounceMs?: number
}

const contentHash = (content: string): string => createHash('sha256').update(content).digest('hex')

export class SettingsFileSync {
  readonly path: string
  /** Hash of what the file held when Switchboard last wrote it or fully applied it; persisted across restarts. */
  private syncedHash: string | null
  private status: SettingsFileStatus = IDLE_SETTINGS_FILE_STATUS
  private watcher: FSWatcher | null = null
  private fileTimer: ReturnType<typeof setTimeout> | null = null
  private dbTimer: ReturnType<typeof setTimeout> | null = null
  private applying = false
  // Set once the file is opened or found at launch; until then no write creates it.
  private active = false
  // One read-apply or write at a time, so a save and a UI change cannot interleave.
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: SettingsFileDeps) {
    this.path = join(deps.dir, SETTINGS_FILE_NAME)
    this.syncedHash = deps.syncedHash.load()
  }

  getStatus(): SettingsFileStatus {
    return this.status
  }

  /**
   * At launch: pick up a file left by an earlier run. A file that differs
   * from what Switchboard last wrote was edited while the app was closed, so
   * it is applied like a save before any DB change can rewrite it.
   */
  resume(): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.readCurrent()
      if (!current) return
      this.active = true
      this.startWatching()
      if (this.isEdited(current)) await this.applyFile()
      else this.setStatus({ ...IDLE_SETTINGS_FILE_STATUS, path: this.path })
    })
  }

  /**
   * Write the schema and the file from the DB, then watch it. A save not yet
   * applied is applied first; a file that is not valid JSON, or that asked for
   * something it did not get, is left as it is so the edit is not lost.
   */
  open(): Promise<string> {
    return this.enqueue(async () => {
      await mkdir(this.deps.dir, { recursive: true })
      await writeFile(join(this.deps.dir, SETTINGS_SCHEMA_FILE_NAME), `${JSON.stringify(settingsFileSchema(), null, 2)}\n`)
      const current = await this.readCurrent()
      const kept = current !== null && this.isEdited(current) && !(await this.applyFile())
      if (kept) {
        this.deps.log.warn('settings.json left as it is on open: it holds edits that were not fully applied')
      } else {
        const written = await this.writeFromDb(current)
        this.setStatus({ path: this.path, parseError: null, skipped: [], writeSkipped: !written })
      }
      this.active = true
      this.startWatching()
      return this.path
    })
  }

  /** A write to a setting the file holds happened. Our own applies are ignored. */
  onDbChanged(): void {
    if (this.applying || !this.active) return
    if (this.dbTimer) clearTimeout(this.dbTimer)
    this.dbTimer = setTimeout(() => {
      this.dbTimer = null
      void this.enqueue(() => this.writeIfUnedited())
    }, this.deps.debounceMs ?? 150)
  }

  /** The watcher saw the file change. */
  onFileEvent(): void {
    if (this.fileTimer) clearTimeout(this.fileTimer)
    this.fileTimer = setTimeout(() => {
      this.fileTimer = null
      void this.enqueue(async () => { await this.applyFile() })
    }, this.deps.debounceMs ?? 150)
  }

  /** Let pending debounced work run now; for shutdown and the tests. */
  async flush(): Promise<void> {
    if (this.fileTimer) {
      clearTimeout(this.fileTimer)
      this.fileTimer = null
      void this.enqueue(async () => { await this.applyFile() })
    }
    if (this.dbTimer) {
      clearTimeout(this.dbTimer)
      this.dbTimer = null
      void this.enqueue(() => this.writeIfUnedited())
    }
    await this.queue
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.fileTimer) clearTimeout(this.fileTimer)
    if (this.dbTimer) clearTimeout(this.dbTimer)
  }

  /**
   * Parse the file and apply what it asks for. True when the DB now holds
   * everything the file says; only then is the file in sync, so an entry
   * that was refused or a write that failed keeps the file from being
   * rewritten until the user fixes it.
   */
  async applyFile(): Promise<boolean> {
    const current = await this.readCurrent()
    // A deleted file is not an empty one: it resets nothing.
    if (!current) return false
    if (!this.isEdited(current)) return true
    const plan = planSettingsFileApply(current, this.deps.readSnapshot(), { projectKey: this.deps.projectKey })
    if (!plan.ok) {
      this.deps.log.warn(`settings.json not applied: ${plan.error}`)
      this.setStatus({ ...this.status, path: this.path, parseError: plan.error })
      return false
    }
    const skipped = [...plan.skipped]
    this.applying = true
    try {
      const changed = this.deps.applyOps(plan.ops)
      if (changed.length > 0) this.deps.log.info('applied settings.json', changed)
      const failed = plan.ops.length - changed.length
      if (failed > 0) skipped.push({ entry: `${failed} of ${plan.ops.length} writes`, reason: 'could not be saved; the log has the error' })
    } finally {
      this.applying = false
    }
    if (skipped.length > 0) this.deps.log.warn(`settings.json skipped ${describeSkipped(skipped, skipped.length)}`)
    else this.markSynced(current)
    this.setStatus({ path: this.path, parseError: null, skipped, writeSkipped: false })
    return skipped.length === 0
  }

  /** Rewrite the file from the DB unless it holds edits not yet applied. */
  async writeIfUnedited(): Promise<void> {
    const current = await this.readCurrent()
    // Deleted by the user: stays deleted until the next Open.
    if (current === null) return
    if (this.isEdited(current)) {
      this.deps.log.info('settings.json has edits that were not applied; not rewriting it')
      this.setStatus({ ...this.status, writeSkipped: true })
      return
    }
    const writeSkipped = !(await this.writeFromDb(current))
    if (this.status.writeSkipped !== writeSkipped) this.setStatus({ ...this.status, writeSkipped })
  }

  /** Differs, by content, from what Switchboard last wrote or fully applied. mtime is not trusted: it can be coarse or unchanged. */
  private isEdited(content: string): boolean {
    return contentHash(content) !== this.syncedHash
  }

  private markSynced(content: string): void {
    const hash = contentHash(content)
    if (hash === this.syncedHash) return
    this.syncedHash = hash
    try {
      this.deps.syncedHash.save(hash)
    } catch (err) {
      // In memory it still holds, so only a restart would re-apply the file, which changes nothing.
      this.deps.log.warn('saving the settings.json sync marker failed', err)
    }
  }

  /**
   * Replace the file with the DB's projection. `expected` is what the file
   * held when the caller checked it (null: absent); a retry waiting on a
   * Windows lock re-checks it, so an edit saved meanwhile is not overwritten.
   * False when that edit left the file as it is.
   */
  private async writeFromDb(expected: string | null): Promise<boolean> {
    const file = projectSettingsFile(this.deps.readSnapshot(), { projectLabel: this.deps.projectLabel })
    const content = serializeSettingsFile(file)
    try {
      await replaceFile(this.path, content, { log: this.deps.log, stillSafe: () => this.stillHolds(expected) })
    } catch (err) {
      if (!(err instanceof TargetChangedError)) throw err
      this.deps.log.warn('settings.json changed while its rewrite waited for a lock; left as it is')
      return false
    }
    this.markSynced(content)
    return true
  }

  private async stillHolds(expected: string | null): Promise<boolean> {
    try {
      return (await readFile(this.path, 'utf8')) === expected
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return expected === null
      this.deps.log.warn('re-reading settings.json before a retried write failed', err)
      return false
    }
  }

  private async readCurrent(): Promise<string | null> {
    try {
      return await readFile(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log.warn('reading settings.json failed', err)
      return null
    }
  }

  private startWatching(): void {
    if (this.watcher) return
    try {
      // The folder, not the file: editors save by renaming a temp file over it, which ends a file watch.
      this.watcher = watch(this.deps.dir, (_event, name) => {
        if (name === SETTINGS_FILE_NAME) this.onFileEvent()
      })
      this.watcher.on('error', (err) => this.deps.log.warn('settings.json watcher failed', err))
    } catch (err) {
      this.deps.log.warn('could not watch settings.json', err)
    }
  }

  private setStatus(status: SettingsFileStatus): void {
    this.status = status
    this.deps.onStatus(status)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task)
    this.queue = run.then(() => undefined, (err) => this.deps.log.warn('settings.json sync failed', err))
    return run
  }
}

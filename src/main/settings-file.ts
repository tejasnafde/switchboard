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
 * when the file changed on disk since Switchboard last wrote or applied it
 * (edits not applied yet, or a parse error), which the status reports.
 *
 * Our own writes are recognised by content, so the watcher event they cause
 * applies nothing. Electron-free, with the DB behind `deps`, for the tests.
 */
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

/** Why `text` is not a JSON object, or null when it is one. */
function jsonError(text: string): string | null {
  const plan = planSettingsFileApply(text, { settings: {}, projects: {}, keyboard: {} }, { projectKey: (p) => p })
  return plan.ok ? null : plan.error
}

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
  log: SettingsFileLog
  debounceMs?: number
}

/** What the file held when Switchboard last wrote it or applied it. */
interface Synced {
  content: string
  mtimeMs: number
}

export class SettingsFileSync {
  readonly path: string
  private synced: Synced | null = null
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
  }

  getStatus(): SettingsFileStatus {
    return this.status
  }

  /** At launch: pick up a file left by an earlier run, as it is, without applying or rewriting it. */
  async resume(): Promise<void> {
    const current = await this.readCurrent()
    if (!current) return
    this.synced = current
    this.active = true
    this.setStatus({ ...IDLE_SETTINGS_FILE_STATUS, path: this.path })
    this.startWatching()
  }

  /**
   * Write the schema and the file from the DB, then watch it. A file that is
   * not valid JSON is left as it is, so reopening it cannot erase the edit,
   * and a save not yet applied is applied first.
   */
  open(): Promise<string> {
    return this.enqueue(async () => {
      await mkdir(this.deps.dir, { recursive: true })
      await writeFile(join(this.deps.dir, SETTINGS_SCHEMA_FILE_NAME), `${JSON.stringify(settingsFileSchema(), null, 2)}\n`)
      const current = await this.readCurrent()
      const parseError = current ? jsonError(current.content) : null
      if (parseError) {
        this.deps.log.warn(`settings.json left as it is on open: ${parseError}`)
        this.setStatus({ ...this.status, path: this.path, parseError })
      } else {
        const applied = current && this.isEdited(current)
        if (applied) await this.applyFile()
        await this.writeFromDb()
        this.setStatus({ path: this.path, parseError: null, skipped: applied ? this.status.skipped : [], writeSkipped: false })
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
      void this.enqueue(() => this.applyFile())
    }, this.deps.debounceMs ?? 150)
  }

  /** Let pending debounced work run now; for shutdown and the tests. */
  async flush(): Promise<void> {
    if (this.fileTimer) {
      clearTimeout(this.fileTimer)
      this.fileTimer = null
      void this.enqueue(() => this.applyFile())
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

  /** Parse the file and apply what it asks for. */
  async applyFile(): Promise<void> {
    const current = await this.readCurrent()
    // A deleted file is not an empty one: it resets nothing.
    if (!current) return
    if (current.content === this.synced?.content) {
      this.synced = current
      return
    }
    const plan = planSettingsFileApply(current.content, this.deps.readSnapshot(), { projectKey: this.deps.projectKey })
    if (!plan.ok) {
      this.deps.log.warn(`settings.json not applied: ${plan.error}`)
      this.setStatus({ ...this.status, parseError: plan.error })
      return
    }
    if (plan.skipped.length > 0) this.deps.log.warn(`settings.json skipped ${describeSkipped(plan.skipped, plan.skipped.length)}`)
    this.applying = true
    try {
      const changed = this.deps.applyOps(plan.ops)
      if (changed.length > 0) this.deps.log.info('applied settings.json', changed)
    } finally {
      this.applying = false
    }
    this.synced = current
    this.setStatus({ path: this.path, parseError: null, skipped: plan.skipped, writeSkipped: false })
  }

  /** Rewrite the file from the DB unless it holds edits not yet applied. */
  async writeIfUnedited(): Promise<void> {
    const current = await this.readCurrent()
    // Deleted by the user: stays deleted until the next Open.
    if (!current) return
    if (this.isEdited(current)) {
      this.deps.log.info('settings.json has edits that were not applied; not rewriting it')
      this.setStatus({ ...this.status, writeSkipped: true })
      return
    }
    await this.writeFromDb()
    if (this.status.writeSkipped) this.setStatus({ ...this.status, writeSkipped: false })
  }

  /** Changed on disk since Switchboard last wrote or applied it. */
  private isEdited(current: Synced): boolean {
    return !this.synced || (current.content !== this.synced.content && current.mtimeMs > this.synced.mtimeMs)
  }

  private async writeFromDb(): Promise<void> {
    const file = projectSettingsFile(this.deps.readSnapshot(), { projectLabel: this.deps.projectLabel })
    const content = serializeSettingsFile(file)
    // Temp then rename, so an editor or the watcher never reads half a file.
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, content)
    await rename(tmp, this.path)
    const { mtimeMs } = await stat(this.path)
    this.synced = { content, mtimeMs }
  }

  private async readCurrent(): Promise<Synced | null> {
    try {
      const [content, info] = await Promise.all([readFile(this.path, 'utf8'), stat(this.path)])
      return { content, mtimeMs: info.mtimeMs }
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

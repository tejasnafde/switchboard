/**
 * The record of clones in progress on this backend, kept in a file in its
 * data folder so a restart mid-clone can find the half-done folder. An entry
 * is written once the target folder exists and dropped when the clone ends.
 * The entry holds the folder's device and inode, so after a restart only the
 * folder this backend made (or emptied and filled) is removed, never one that
 * took its place.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, parse, resolve } from 'node:path'
import { createMainLogger } from '../logger'

const log = createMainLogger('ipc:project-clone-journal')

export interface CloneJournalEntry {
  path: string
  /** `lstat(path, { bigint: true })` of the folder at the start, as decimal strings. */
  dev: string
  ino: string
  /**
   * The folder's birth time in ns, or '0' where the file system has none. An
   * inode number can be reused (ext4), so a new folder made at the same path
   * after a restart could carry the old one's device and inode.
   */
  birth: string
  /** False when the folder already existed (empty): then only its contents are removed. */
  createdFolder: boolean
  /** False when the path was already a project: then the project row stays. */
  addedProject: boolean
}

export class CloneJournal {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  read(): Promise<CloneJournalEntry[]> {
    return this.serial(() => this.load())
  }

  add(entry: CloneJournalEntry): Promise<void> {
    return this.serial(async () => {
      const entries = (await this.load()).filter((e) => e.path !== entry.path)
      await this.save([...entries, entry])
    })
  }

  remove(path: string): Promise<void> {
    return this.serial(async () => {
      const entries = await this.load()
      const kept = entries.filter((e) => e.path !== path)
      if (kept.length !== entries.length) await this.save(kept)
    })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<CloneJournalEntry[]> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    try {
      const parsed: unknown = JSON.parse(text)
      return Array.isArray(parsed) ? parsed.filter(isEntry) : []
    } catch (err) {
      log.warn('the clone journal is not valid JSON; ignoring it', { file: this.file, err: (err as Error).message })
      return []
    }
  }

  private async save(entries: CloneJournalEntry[]): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(entries), { mode: 0o600 })
    await fs.rename(tmp, this.file)
  }
}

function isEntry(value: unknown): value is CloneJournalEntry {
  const e = value as CloneJournalEntry
  return (
    !!e &&
    typeof e.path === 'string' &&
    typeof e.dev === 'string' &&
    typeof e.ino === 'string' &&
    typeof e.birth === 'string' &&
    typeof e.createdFolder === 'boolean' &&
    typeof e.addedProject === 'boolean'
  )
}

export async function folderIdentity(path: string): Promise<{ dev: string; ino: string; birth: string }> {
  const stat = await fs.lstat(path, { bigint: true })
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), birth: stat.birthtimeNs.toString() }
}

export type PartialCloneOutcome = 'removed' | 'missing' | 'not-ours'

/**
 * Remove what a clone left at `entry.path`, but only when the folder there is
 * still the one the entry names: a real folder (not a link) with the same
 * device, inode and birth time, below the root and not the home folder. A folder that
 * existed before the clone is emptied, not removed.
 */
export async function removePartialClone(entry: CloneJournalEntry): Promise<PartialCloneOutcome> {
  const path = entry.path
  if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root || path === homedir()) {
    log.warn('refusing to remove a journal path', { path })
    return 'not-ours'
  }
  let stat
  try {
    stat = await fs.lstat(path, { bigint: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw err
  }
  if (
    !stat.isDirectory() ||
    stat.dev.toString() !== entry.dev ||
    stat.ino.toString() !== entry.ino ||
    stat.birthtimeNs.toString() !== entry.birth
  ) {
    log.warn('the folder is not the one the clone made; leaving it', { path })
    return 'not-ours'
  }
  if (entry.createdFolder) {
    await fs.rm(path, { recursive: true, force: true })
  } else {
    for (const child of await fs.readdir(path)) {
      await fs.rm(resolve(path, child), { recursive: true, force: true })
    }
  }
  return 'removed'
}

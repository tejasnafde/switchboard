/**
 * Stateful notebook mirror sync for one repo root. Owns the mirror files
 * under .switchboard/notebooks/ and the self-write echo guard; file watching
 * is wired separately (thin chokidar layer) so all sync behavior stays
 * directly unit-testable.
 *
 * Review model matches the rest of Switchboard: mirror edits propagate to the
 * .ipynb immediately (the turn checkpoint protects it) and the diff card
 * reverts, rather than CellIQ's blocking pre-write modal.
 *
 * Echo guard: content-based, not counter-based. CellIQ counted pending
 * self-writes and assumed a 1:1 write-to-event correspondence, so a coalesced
 * or missing watcher event could swallow a genuine agent edit. Here a change
 * event whose content matches what we last wrote is ours; anything else is
 * foreign. Coalesced or duplicate events cannot desync anything.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createMainLogger } from '../logger'
import { generateMirror, mirrorRelPathFor, notebookRelPathFor, parseMirror, validateMirror } from './mirror-format'
import { applyMirror, ensureCellIds, mirrorCellsOf, serializeNotebook, type NotebookDoc } from './notebook-doc'

const log = createMainLogger('notebooks:sync')

export interface EnsureMirrorResult {
  mirrorRelPath: string
  /** Set when ensureMirror found and applied a pending foreign mirror edit. */
  pendingEdit?: MirrorChangeResult
}

export type NotebookChangeResult = { kind: 'unchanged' } | { kind: 'synced'; mirrorRelPath: string }

export type MirrorChangeResult =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; notebookRelPath: string; error: string }
  | { kind: 'applied'; notebookRelPath: string; oldMirror: string; newMirror: string; notebookCreated: boolean }

export class NotebookSync {
  /** Content we last wrote per absolute path - the echo baseline. */
  private readonly lastWritten = new Map<string, string>()
  /** Notebooks this engine materialized from a fresh mirror (abs paths). */
  private readonly materializedNotebooks = new Set<string>()

  constructor(private readonly repoRoot: string) {}

  private abs(relPath: string): string {
    return join(this.repoRoot, relPath)
  }

  /** Atomic temp-then-rename write - a crash or concurrent reader never sees
   *  a half-written notebook (same pattern as files/writing.ts writeFileSafe). */
  private writeTracked(absPath: string, content: string): void {
    this.lastWritten.set(absPath, content)
    mkdirSync(dirname(absPath), { recursive: true })
    const tmp = `${absPath}.sb-tmp-${process.pid}`
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, absPath)
  }

  /** True when the given on-disk content is (or matches) our own last write. */
  private isOwnContent(absPath: string, diskContent: string): boolean {
    return diskContent === this.lastWritten.get(absPath)
  }

  /** True when this engine wrote exactly this notebook content (mirror sync
   *  explains the edit). Used to suppress redundant .ipynb diff cards. */
  explainsNotebookContent(notebookRelPath: string, content: string): boolean {
    return this.isOwnContent(this.abs(notebookRelPath), content)
  }

  /**
   * Read the notebook, assign missing cell ids (persisting the notebook only
   * when ids were added), and ensure its mirror is in sync.
   *
   * An existing mirror whose content differs is NOT clobbered blindly: if the
   * mirror is newer than the notebook it is a pending foreign edit (an agent
   * write whose watcher event was missed, or a previous session's unsynced
   * edit) and is applied through the normal validation path instead. If the
   * notebook is newer, the mirror is stale and regenerating is correct.
   */
  ensureMirror(notebookRelPath: string): EnsureMirrorResult {
    const notebookAbs = this.abs(notebookRelPath)
    const { doc, changed } = ensureCellIds(JSON.parse(readFileSync(notebookAbs, 'utf-8')) as NotebookDoc)
    if (changed) {
      this.writeTracked(notebookAbs, serializeNotebook(doc))
      log.info('assigned cell ids', { notebookRelPath })
    }

    const mirrorRelPath = mirrorRelPathFor(notebookRelPath)
    const mirrorAbs = this.abs(mirrorRelPath)
    const generated = generateMirror(notebookRelPath, mirrorCellsOf(doc))

    if (existsSync(mirrorAbs)) {
      const disk = readFileSync(mirrorAbs, 'utf-8')
      if (disk === generated) {
        // Already in sync - record the baseline without a redundant write
        // (avoids mtime churn and watcher echoes on every attach).
        this.lastWritten.set(mirrorAbs, disk)
        return { mirrorRelPath }
      }
      const mirrorIsNewer = statSync(mirrorAbs).mtimeMs > statSync(notebookAbs).mtimeMs
      if (!this.isOwnContent(mirrorAbs, disk) && mirrorIsNewer) {
        const pendingEdit = this.onMirrorChanged(mirrorRelPath)
        log.info('applied pending mirror edit during ensure', { mirrorRelPath, kind: pendingEdit.kind })
        return { mirrorRelPath, pendingEdit }
      }
    }

    this.writeTracked(mirrorAbs, generated)
    return { mirrorRelPath }
  }

  /** A change event landed on the .ipynb - regenerate its mirror unless the write was ours. */
  onNotebookChanged(notebookRelPath: string): NotebookChangeResult {
    const notebookAbs = this.abs(notebookRelPath)
    if (this.isOwnContent(notebookAbs, readFileSync(notebookAbs, 'utf-8'))) return { kind: 'unchanged' }
    const { mirrorRelPath } = this.ensureMirror(notebookRelPath)
    return { kind: 'synced', mirrorRelPath }
  }

  /** A change event landed on a mirror - validate and propagate to the .ipynb. */
  onMirrorChanged(mirrorRelPath: string): MirrorChangeResult {
    const mirrorAbs = this.abs(mirrorRelPath)
    const content = readFileSync(mirrorAbs, 'utf-8')
    if (this.isOwnContent(mirrorAbs, content)) return { kind: 'unchanged' }

    const notebookRelPath = notebookRelPathFor(mirrorRelPath)
    if (!notebookRelPath) {
      log.warn('mirror change outside the mirror tree', { mirrorRelPath })
      return { kind: 'unchanged' }
    }
    // A mirror without a notebook is an agent authoring a new notebook - it
    // materializes from an empty document. Otherwise re-read the notebook NOW
    // so outputs/execution_count re-attach from live disk state, not a
    // snapshot from when the mirror was created.
    const notebookAbs = this.abs(notebookRelPath)
    const notebookExists = existsSync(notebookAbs)
    const rawDoc: NotebookDoc = notebookExists
      ? (JSON.parse(readFileSync(notebookAbs, 'utf-8')) as NotebookDoc)
      : { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }
    const { doc } = ensureCellIds(rawDoc)
    const originalIds = mirrorCellsOf(doc).map((c) => c.id)

    const error = validateMirror(content, originalIds)
    if (error) {
      log.warn('mirror validation blocked sync', { mirrorRelPath, error })
      return { kind: 'invalid', notebookRelPath, error }
    }

    const updated = applyMirror(doc, parseMirror(content))
    this.writeTracked(notebookAbs, serializeNotebook(updated))
    if (!notebookExists) this.materializedNotebooks.add(notebookAbs)
    const oldMirror = this.lastWritten.get(mirrorAbs) ?? ''
    this.lastWritten.set(mirrorAbs, content)
    log.info('mirror applied to notebook', { mirrorRelPath, notebookRelPath })
    return { kind: 'applied', notebookRelPath, oldMirror, newMirror: content, notebookCreated: !notebookExists }
  }

  /**
   * The mirror file was deleted (diff-card reject of an added notebook).
   * Remove the paired .ipynb ONLY if this engine materialized it and the user
   * has not touched it since - a hand-authored notebook is never deleted.
   */
  onMirrorUnlinked(mirrorRelPath: string): { notebookRelPath: string } | null {
    const notebookRelPath = notebookRelPathFor(mirrorRelPath)
    if (!notebookRelPath) return null
    const notebookAbs = this.abs(notebookRelPath)
    if (!this.materializedNotebooks.has(notebookAbs) || !existsSync(notebookAbs)) return null
    if (!this.isOwnContent(notebookAbs, readFileSync(notebookAbs, 'utf-8'))) return null
    rmSync(notebookAbs)
    this.materializedNotebooks.delete(notebookAbs)
    this.lastWritten.delete(notebookAbs)
    this.lastWritten.delete(this.abs(mirrorRelPath))
    log.info('removed materialized notebook after mirror delete', { notebookRelPath })
    return { notebookRelPath }
  }
}

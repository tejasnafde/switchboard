/**
 * CardModal - create / edit a kanban card.
 *
 * Fields: title, description, tags (comma-separated, normalized on
 * blur), status (column), cost cap (USD, optional), worktree opt-in
 * (create-only) or detach (edit, when one is attached).
 *
 * Esc closes; ⌘Enter submits. We deliberately don't ship a separate
 * "preview" mode - every field is inline-editable and a single Save
 * button commits.
 */

import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useKanbanStore } from '../../stores/kanban-store'
import { downscaleImage } from '../../services/image-downscale'
import { insertSnippetWithNewlineGuards } from '../../services/insert-snippet'
import { buildKanbanCardCreateSubmission } from './kanban-create-intent'
import { describeKanbanWorktreeCreation } from './kanban-worktree-presentation'
import {
  KANBAN_COLUMNS,
  KANBAN_DEFAULT_RUNTIME_MODE,
  type KanbanCard,
  type KanbanStatus,
} from '@shared/kanban'
import type { RuntimeMode } from '@shared/provider-events'
import { confirm } from '../ui/confirm'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { cn } from '../../lib/utils'
import {
  closeButtonClass,
  dangerButtonClass,
  footerClass,
  headerClass,
  modalClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './kanban-modal-classes'
import { matchesShortcut } from '@shared/shortcuts'

const RUNTIME_MODE_OPTIONS: ReadonlyArray<{ value: RuntimeMode; label: string; hint: string }> = [
  { value: 'plan', label: 'Plan', hint: 'Read-only - agent proposes but does not edit' },
  { value: 'sandbox', label: 'Sandbox', hint: 'Edits require approval' },
  { value: 'accept-edits', label: 'Accept edits', hint: 'Auto-approves edits (default)' },
  { value: 'auto', label: 'Auto', hint: 'The agent approves routine actions; OpenCode still asks' },
  { value: 'full-access', label: 'Full access', hint: 'Auto-approves edits and shell commands' },
]

interface ProjectOption {
  path: string
  name: string
}

interface Props {
  mode: 'create' | 'edit'
  /**
   * Default project the card lands in. For `edit`, this is fixed to
   * `card.projectPath`. For `create`, it seeds the picker; the user can
   * still re-target via `availableProjects` when the scope is ambiguous.
   */
  projectPath: string
  /**
   * When provided in `create` mode AND length > 1, renders a dropdown
   * letting the user choose which project the card lands in. Hidden
   * when there's a single unambiguous answer (project filter set, or
   * scope has only one project).
   */
  availableProjects?: ProjectOption[]
  card?: KanbanCard
  onClose: () => void
}

export function CardModal({ mode, projectPath, availableProjects, card, onClose }: Props): React.ReactElement {
  const create = useKanbanStore((s) => s.create)
  const update = useKanbanStore((s) => s.update)
  const remove = useKanbanStore((s) => s.remove)
  const attachWorktree = useKanbanStore((s) => s.attachWorktree)
  const detachWorktree = useKanbanStore((s) => s.detachWorktree)

  const [title, setTitle] = useState(card?.title ?? '')
  const [description, setDescription] = useState(card?.description ?? '')
  const [tagsInput, setTagsInput] = useState((card?.tags ?? []).join(', '))
  const [status, setStatus] = useState<KanbanStatus>(card?.status ?? 'backlog')
  const [costCapInput, setCostCapInput] = useState(
    card?.costCapUsd != null ? String(card.costCapUsd) : ''
  )
  const [withWorktree, setWithWorktree] = useState(false)
  // Initial mode only - once the card has a session, the chat panel's
  // runtime selector is the source of truth, so we render a read-only
  // chip in `edit` mode instead of letting the field drift.
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(
    card?.runtimeMode ?? KANBAN_DEFAULT_RUNTIME_MODE,
  )
  const [submitting, setSubmitting] = useState(false)
  // The ⌘Enter keydown closure captures a stale `submitting`, so a held
  // ⌘Enter fired handleSubmit repeatedly - each call creating a worktree
  // and launching a chat.
  const submittingRef = useRef(false)
  const [worktreeBusy, setWorktreeBusy] = useState<'attach' | 'detach' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Locally-tracked project selection. In `edit` mode the project never
  // changes - moving cards across projects would invalidate worktrees
  // and conversation links, so we lock it. In `create` mode the user
  // can switch when `availableProjects` has > 1 entry.
  const [selectedProjectPath, setSelectedProjectPath] = useState(projectPath)
  const showProjectPicker = mode === 'create' && (availableProjects?.length ?? 0) > 1
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  // Paste/drop image → downscale (≤1920px longest edge) and embed at the caret
  // as `![](data:image/...;base64,…)`.
  const insertImagesAsMarkdown = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    const results = await Promise.all(images.map((f) => downscaleImage(f)))
    const snippet = results.map((r) => `![](${r.dataUrl})`).join('\n')
    // Capture selection synchronously - by the time `setDescription` runs
    // the textarea's selection may have shifted (focus loss, IME, etc.),
    // so we read it once now and reuse it inside the updater closure.
    const ta = descriptionRef.current
    const start = ta?.selectionStart ?? null
    const end = ta?.selectionEnd ?? null
    setDescription((cur) => {
      const s = start ?? cur.length
      const e = end ?? cur.length
      return insertSnippetWithNewlineGuards(cur, s, e, snippet)
    })
  }, [])

  const handleDescriptionPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault()
      void insertImagesAsMarkdown(files)
    }
  }, [insertImagesAsMarkdown])

  const handleDescriptionDrop = useCallback((e: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault()
      void insertImagesAsMarkdown(files)
    }
  }, [insertImagesAsMarkdown])
  const handleDescriptionDragOver = useCallback((e: DragEvent<HTMLTextAreaElement>) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])
  const projectLabel =
    availableProjects?.find((p) => p.path === selectedProjectPath)?.name
    ?? selectedProjectPath.split('/').pop()
    ?? selectedProjectPath

  const handleSubmit = async () => {
    if (submittingRef.current) return
    if (!title.trim()) {
      setError('Title is required')
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean)
      const costCapUsd = costCapInput.trim() === '' ? null : Number(costCapInput)
      if (costCapUsd != null && (Number.isNaN(costCapUsd) || costCapUsd < 0)) {
        setError('Cost cap must be a non-negative number')
        return
      }
      if (mode === 'create') {
        await create(buildKanbanCardCreateSubmission({
          projectPath: selectedProjectPath,
          title: title.trim(),
          description,
          tags,
          status,
          costCapUsd,
          runtimeMode,
          withWorktree,
        }))
      } else if (card) {
        await update(card.id, {
          title: title.trim(),
          description,
          tags,
          status,
          costCapUsd,
        })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (submittingRef.current) return
    if (!card) return
    const removeWt = !!card.worktreePath && await confirm({
      title: 'Also delete the linked git worktree?',
      confirmLabel: 'Delete worktree',
      cancelLabel: 'Keep worktree',
      destructive: true,
    })
    submittingRef.current = true
    setSubmitting(true)
    try {
      await remove(card.id, { removeWorktree: removeWt, force: removeWt })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const handleAttachWorktree = async () => {
    if (!card) return
    setWorktreeBusy('attach')
    setError(null)
    try {
      const updated = await attachWorktree(card.id)
      const presentation = describeKanbanWorktreeCreation(updated?.worktreeCreation)
      if (presentation) setError(presentation.detail)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorktreeBusy(null)
    }
  }

  const handleDetachWorktree = async () => {
    if (!card) return
    if (!(await confirm({
      title: 'Delete this worktree?',
      body: 'Uncommitted files will be lost. The conversation and its history will remain in the project checkout.',
      confirmLabel: 'Delete',
      destructive: true,
    }))) return
    setWorktreeBusy('detach')
    setError(null)
    try {
      await detachWorktree(card.id, { force: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorktreeBusy(null)
    }
  }

  // Escape is the dialog's. Focus stays inside it, so ⌘Enter can live on the
  // content; the confirm dialog holds it back while one is open.
  const onKeyDown = (e: KeyboardEvent) => {
    if (matchesShortcut(e, 'kanban.card-submit')) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        aria-describedby={undefined}
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          titleRef.current?.focus()
        }}
        overlayClassName="z-[1000] bg-[rgba(0,0,0,0.4)]"
        className={modalClass('w-[480px] max-w-[92vw]')}
      >
        <div className={headerClass}>
          <DialogTitle className="text-[13px] font-[600]">{mode === 'create' ? 'New card' : 'Edit card'}</DialogTitle>
          <button onClick={onClose} className={closeButtonClass} aria-label="Close">&times;</button>
        </div>
        <div className="flex flex-col gap-[10px] overflow-auto p-[14px]">
          {/* Project association - visible up front so the user always
              knows where the card lands. Switches to a dropdown when
              the create scope spans multiple projects. */}
          <label className={labelClass}>
            Project
            {showProjectPicker ? (
              <select
                value={selectedProjectPath}
                onChange={(e) => setSelectedProjectPath(e.target.value)}
                className={inputClass}
              >
                {availableProjects!.map((p) => (
                  <option key={p.path} value={p.path}>{p.name}</option>
                ))}
              </select>
            ) : (
              <div className={chipClass} title={selectedProjectPath}>
                {projectLabel}
              </div>
            )}
          </label>

          <label className={labelClass}>
            Title
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              className={inputClass}
            />
          </label>

          <label className={labelClass}>
            Description
            <textarea
              ref={descriptionRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onPaste={handleDescriptionPaste}
              onDrop={handleDescriptionDrop}
              onDragOver={handleDescriptionDragOver}
              placeholder="Context, links, acceptance criteria… (paste images to embed)"
              rows={5}
              className={cn(inputClass, 'resize-y [font-family:inherit]')}
            />
          </label>

          <label className={labelClass}>
            Tags (comma-separated)
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="bug, auth, p0"
              className={inputClass}
            />
          </label>

          <div className="flex gap-[10px]">
            {mode === 'edit' && (
              <label className={cn(labelClass, 'flex-1')}>
                Status
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as KanbanStatus)}
                  className={inputClass}
                >
                  {KANBAN_COLUMNS.map((col) => (
                    <option key={col.id} value={col.id}>{col.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label className={cn(labelClass, 'flex-1')}>
              Cost cap (USD, optional)
              <input
                type="number"
                step="0.01"
                min="0"
                value={costCapInput}
                onChange={(e) => setCostCapInput(e.target.value)}
                placeholder="5.00"
                className={inputClass}
              />
            </label>
          </div>

          {/* Picked at create time only - see `runtimeMode` state comment. */}
          <label className={labelClass}>
            Runtime mode
            {mode === 'create' ? (
              <>
                <select
                  value={runtimeMode}
                  onChange={(e) => setRuntimeMode(e.target.value as RuntimeMode)}
                  className={inputClass}
                >
                  {RUNTIME_MODE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <span className={hintClass}>
                  {RUNTIME_MODE_OPTIONS.find((o) => o.value === runtimeMode)?.hint}
                </span>
              </>
            ) : (
              <div className={chipClass} title="Change the live mode from the chat panel's runtime selector">
                {RUNTIME_MODE_OPTIONS.find((o) => o.value === runtimeMode)?.label ?? runtimeMode}
              </div>
            )}
          </label>

          {mode === 'create' && (
            <label className={cn(labelClass, 'flex-row items-center gap-[6px]')}>
              <input
                type="checkbox"
                checked={withWorktree}
                onChange={(e) => setWithWorktree(e.target.checked)}
              />
              Create isolated git worktree for this card
            </label>
          )}

          {mode === 'edit' && card && (
            <div className="flex items-center gap-[8px] rounded-[4px] bg-[rgba(0,0,0,0.03)] px-[8px] py-[6px] text-[11px]">
              {card.worktreePath ? (
                <>
                  <span>Worktree: <code className="text-[11px] [font-family:monospace] opacity-[0.85]">{card.worktreePath}</code></span>
                  <button
                    onClick={() => { void handleDetachWorktree() }}
                    disabled={worktreeBusy !== null || submitting}
                    className={dangerButtonClass}
                  >{worktreeBusy === 'detach' ? 'Detaching…' : 'Detach'}</button>
                </>
              ) : card.conversationId ? (
                <span className={hintClass}>
                  This card already has a conversation. Continue there; attaching a worktree would replace its execution context.
                </span>
              ) : (
                <button
                  onClick={() => { void handleAttachWorktree() }}
                  disabled={worktreeBusy !== null || submitting}
                  className={secondaryButtonClass}
                >{worktreeBusy === 'attach' ? 'Attaching…' : 'Attach worktree'}</button>
              )}
            </div>
          )}

          {error && <div className="text-[12px] text-[var(--red,#d73a49)]">{error}</div>}
        </div>

        <div className={footerClass}>
          {mode === 'edit' && (
            <button onClick={handleDelete} disabled={submitting || worktreeBusy !== null} className={dangerButtonClass}>Delete</button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} disabled={submitting} className={secondaryButtonClass}>Cancel</button>
          <button onClick={handleSubmit} disabled={submitting || worktreeBusy !== null} className={primaryButtonClass}>
            {mode === 'create' ? 'Create' : 'Save'} {submitting && '…'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const labelClass = 'flex flex-col gap-[4px] text-[11px] opacity-[0.85]'
const inputClass = 'rounded-[4px] border border-[var(--border)] bg-transparent px-[8px] py-[6px] text-[13px] text-inherit'
const chipClass = 'self-start rounded-[4px] border border-[rgba(37,99,235,0.25)] bg-[rgba(37,99,235,0.10)] px-[10px] py-[5px] text-[12px] [font-family:monospace] text-[var(--accent,#2563eb)]'
const hintClass = 'mt-[2px] text-[10px] opacity-[0.65]'

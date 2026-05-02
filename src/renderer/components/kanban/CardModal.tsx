/**
 * CardModal — create / edit a kanban card.
 *
 * Fields: title, description, tags (comma-separated, normalized on
 * blur), status (column), cost cap (USD, optional), worktree opt-in
 * (create-only) or detach (edit, when one is attached).
 *
 * Esc closes; ⌘Enter submits. We deliberately don't ship a separate
 * "preview" mode — every field is inline-editable and a single Save
 * button commits.
 */

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent } from 'react'
import { useKanbanStore } from '../../stores/kanban-store'
import { downscaleImage } from '../../services/imageDownscale'
import { insertSnippetWithNewlineGuards } from '../../services/insertSnippet'
import { launchCardChat } from './cardLaunch'
import { KANBAN_COLUMNS, type KanbanCard, type KanbanStatus } from '@shared/kanban'

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
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Locally-tracked project selection. In `edit` mode the project never
  // changes — moving cards across projects would invalidate worktrees
  // and conversation links, so we lock it. In `create` mode the user
  // can switch when `availableProjects` has > 1 entry.
  const [selectedProjectPath, setSelectedProjectPath] = useState(projectPath)
  const showProjectPicker = mode === 'create' && (availableProjects?.length ?? 0) > 1
  const descriptionRef = useRef<HTMLTextAreaElement>(null)

  // Paste/drop image → downscale (≤1920px longest edge) and embed at the caret
  // as `![](data:image/...;base64,…)`.
  const insertImagesAsMarkdown = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (images.length === 0) return
    const results = await Promise.all(images.map((f) => downscaleImage(f)))
    const snippet = results.map((r) => `![](${r.dataUrl})`).join('\n')
    // Capture selection synchronously — by the time `setDescription` runs
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void handleSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [title, description, tagsInput, status, costCapInput, withWorktree])

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError('Title is required')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean)
      const costCapUsd = costCapInput.trim() === '' ? null : Number(costCapInput)
      if (costCapUsd != null && (Number.isNaN(costCapUsd) || costCapUsd < 0)) {
        setError('Cost cap must be a non-negative number')
        setSubmitting(false)
        return
      }
      if (mode === 'create') {
        const newCard = await create({
          projectPath: selectedProjectPath,
          title: title.trim(),
          description,
          tags,
          costCapUsd,
          withWorktree,
        })
        // Opting into a worktree at create-time signals "I'm starting
        // this work now" — auto-launch the agent in the background and
        // promote the card to in_progress so the user doesn't have to
        // click ▶ separately. Foreground users who just want a row in
        // the backlog leave `withWorktree` off.
        if (newCard && withWorktree) {
          const result = await launchCardChat(newCard, { openChat: false })
          if (!result.reused && newCard.status === 'backlog') {
            void useKanbanStore.getState().move(newCard.id, 'in_progress')
          }
        }
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
      setSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!card) return
    const removeWt = !!card.worktreePath && confirm('Also delete the linked git worktree?')
    setSubmitting(true)
    try {
      await remove(card.id, { removeWorktree: removeWt, force: removeWt })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <span>{mode === 'create' ? 'New card' : 'Edit card'}</span>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>
        <div style={bodyStyle}>
          {/* Project association — visible up front so the user always
              knows where the card lands. Switches to a dropdown when
              the create scope spans multiple projects. */}
          <label style={labelStyle}>
            Project
            {showProjectPicker ? (
              <select
                value={selectedProjectPath}
                onChange={(e) => setSelectedProjectPath(e.target.value)}
                style={inputStyle}
              >
                {availableProjects!.map((p) => (
                  <option key={p.path} value={p.path}>{p.name}</option>
                ))}
              </select>
            ) : (
              <div style={projectChipStyle} title={selectedProjectPath}>
                {projectLabel}
              </div>
            )}
          </label>

          <label style={labelStyle}>
            Title
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              style={inputStyle}
            />
          </label>

          <label style={labelStyle}>
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
              style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </label>

          <label style={labelStyle}>
            Tags (comma-separated)
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="bug, auth, p0"
              style={inputStyle}
            />
          </label>

          <div style={rowStyle}>
            {mode === 'edit' && (
              <label style={{ ...labelStyle, flex: 1 }}>
                Status
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as KanbanStatus)}
                  style={inputStyle}
                >
                  {KANBAN_COLUMNS.map((col) => (
                    <option key={col.id} value={col.id}>{col.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label style={{ ...labelStyle, flex: 1 }}>
              Cost cap (USD, optional)
              <input
                type="number"
                step="0.01"
                min="0"
                value={costCapInput}
                onChange={(e) => setCostCapInput(e.target.value)}
                placeholder="5.00"
                style={inputStyle}
              />
            </label>
          </div>

          {mode === 'create' && (
            <label style={{ ...labelStyle, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={withWorktree}
                onChange={(e) => setWithWorktree(e.target.checked)}
              />
              Create isolated git worktree for this card
            </label>
          )}

          {mode === 'edit' && card && (
            <div style={worktreeRowStyle}>
              {card.worktreePath ? (
                <>
                  <span>Worktree: <code style={codeStyle}>{card.worktreePath}</code></span>
                  <button
                    onClick={async () => {
                      if (!confirm('Detach + delete worktree? Uncommitted work will be lost.')) return
                      try { await detachWorktree(card.id, { force: true }) }
                      catch (err) { setError(err instanceof Error ? err.message : String(err)) }
                    }}
                    style={dangerBtnStyle}
                  >Detach</button>
                </>
              ) : (
                <button
                  onClick={async () => {
                    try { await attachWorktree(card.id) }
                    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
                  }}
                  style={secondaryBtnStyle}
                >Attach worktree</button>
              )}
            </div>
          )}

          {error && <div style={errStyle}>{error}</div>}
        </div>

        <div style={footerStyle}>
          {mode === 'edit' && (
            <button onClick={handleDelete} disabled={submitting} style={dangerBtnStyle}>Delete</button>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={submitting} style={secondaryBtnStyle}>Cancel</button>
          <button onClick={handleSubmit} disabled={submitting} style={primaryBtnStyle}>
            {mode === 'create' ? 'Create' : 'Save'} {submitting && '…'}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlayStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const modalStyle: CSSProperties = {
  width: 480, maxWidth: '92vw', maxHeight: '88vh',
  background: 'var(--bg)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 8,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
}
const headerStyle: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '10px 14px', borderBottom: '1px solid var(--border)', fontWeight: 600,
}
const closeBtnStyle: CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--fg)', cursor: 'pointer', fontSize: 14,
}
const bodyStyle: CSSProperties = { padding: 14, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto' }
const labelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, opacity: 0.85 }
const inputStyle: CSSProperties = {
  fontSize: 13, padding: '6px 8px', background: 'var(--bg-elev1, var(--bg))',
  color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 4,
}
const rowStyle: CSSProperties = { display: 'flex', gap: 10 }
const worktreeRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, fontSize: 11,
  padding: '6px 8px', background: 'var(--bg-elev1, rgba(0,0,0,0.03))', borderRadius: 4,
}
const codeStyle: CSSProperties = { fontFamily: 'monospace', fontSize: 11, opacity: 0.85 }
const projectChipStyle: CSSProperties = {
  fontSize: 12, padding: '5px 10px', borderRadius: 4,
  background: 'rgba(37,99,235,0.10)', color: 'var(--accent, #2563eb)',
  fontFamily: 'monospace', alignSelf: 'flex-start',
  border: '1px solid rgba(37,99,235,0.25)',
}
const errStyle: CSSProperties = { color: 'var(--red, #d73a49)', fontSize: 12 }
const footerStyle: CSSProperties = {
  display: 'flex', gap: 6, padding: 10, borderTop: '1px solid var(--border)',
}
const primaryBtnStyle: CSSProperties = {
  fontSize: 12, padding: '6px 14px', background: 'var(--accent, #2563eb)', color: 'white',
  border: 'none', borderRadius: 4, cursor: 'pointer',
}
const secondaryBtnStyle: CSSProperties = {
  fontSize: 12, padding: '6px 14px', background: 'transparent', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
}
const dangerBtnStyle: CSSProperties = {
  fontSize: 12, padding: '6px 14px', background: 'transparent', color: 'var(--red, #d73a49)',
  border: '1px solid var(--red, #d73a49)', borderRadius: 4, cursor: 'pointer',
}

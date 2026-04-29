import { useState, useCallback, useMemo, useRef, useEffect, type DragEvent } from 'react'
import { ContextWindowMeter, type ContextWindowUsage } from './ContextWindowMeter'
import { useDraftStore } from '../../stores/draft-store'
import {
  modelsForAgent,
  REASONING_EFFORTS,
  agentSupportsReasoningEffort,
  type ReasoningEffort,
} from '@shared/models'
import type { AgentType, ProviderSkill } from '@shared/types'
import { useAgentStore } from '../../stores/agent-store'
import { SlashCommandMenu } from './SlashCommandMenu'
import {
  detectSlashTrigger,
  filterSlashCommands,
  mergeWithAgentSkills,
  SLASH_COMMANDS,
  type SlashCommand,
  type SlashCommandContext,
} from './slashCommands'
import { RichChatTextarea, type RichChatTextareaHandle } from './lexical/RichChatTextarea'
import { serializeBodyWithPills } from '../../services/chatInputBody'

type RuntimeMode = 'plan' | 'sandbox' | 'full-access' | 'accept-edits'

interface ImageAttachment {
  id: string
  file: File
  previewUrl: string
}

interface ChatInputProps {
  sessionId?: string | null
  onSend: (message: string, mode?: string, images?: ImageAttachment[]) => void
  disabled?: boolean
  placeholder?: string
  agentType: AgentType
  onAgentTypeChange: (type: AgentType) => void
  canChangeAgent: boolean
  runtimeMode?: RuntimeMode
  onRuntimeModeChange?: (mode: RuntimeMode) => void
  contextUsage?: ContextWindowUsage
  model?: string
  onModelChange?: (model: string) => void
  /** Current reasoning-effort tier (Codex only). */
  reasoningEffort?: ReasoningEffort
  onReasoningEffortChange?: (effort: ReasoningEffort) => void
  /** True when the agent is currently generating a response */
  isRunning?: boolean
  /** Called when the user clicks the interrupt button while a turn is in progress */
  onInterrupt?: () => void
  /** Clear all messages in the current session (for /clear slash command) */
  onClearMessages?: () => void
  /** Archive the current conversation (for /archive slash command) */
  onArchive?: () => void
  /** Show slash-command help overlay */
  onShowSlashHelp?: () => void
}

const AGENTS: { value: AgentType; label: string; available: boolean }[] = [
  { value: 'claude-code', label: 'Claude Code', available: true },
  { value: 'codex', label: 'Codex', available: true },
  { value: 'opencode', label: 'OpenCode', available: true },
]

const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB

// Module-level constant — referential equality across renders so the
// `pills` selector doesn't fabricate a new array when a session has
// no pills yet. Without this, every render produced a fresh `[]` and
// downstream memos invalidated.
const EMPTY_PILLS: import('../../stores/draft-store').DraftPill[] = []

export function ChatInput({
  sessionId,
  onSend,
  disabled = false,
  placeholder = 'Message the agent...',
  agentType,
  onAgentTypeChange,
  canChangeAgent,
  runtimeMode,
  onRuntimeModeChange,
  contextUsage,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  isRunning = false,
  onInterrupt,
  onClearMessages,
  onArchive,
  onShowSlashHelp,
}: ChatInputProps) {
  // Static fallback list — used for Claude/Codex always, and for OpenCode
  // until the dynamic fetch returns. Prevents the dropdown from being empty
  // on first render while we shell out to `opencode models`.
  const staticModels = modelsForAgent(agentType)
  const [opencodeModels, setOpencodeModels] = useState<typeof staticModels | null>(null)

  // Dynamically fetch the full opencode model list so the dropdown reflects
  // whatever providers the user has configured in ~/.config/opencode.json,
  // plus opencode's own built-in free tier (opencode/* models). Re-fetched
  // when the user switches to the OpenCode agent.
  useEffect(() => {
    if (agentType !== 'opencode') return
    let cancelled = false
    ;(window.api.provider as any)?.listOpencodeModels?.().then((ids: string[]) => {
      if (cancelled || !ids || ids.length === 0) return
      setOpencodeModels(ids.map((id) => ({
        id,
        label: formatOpencodeModelLabel(id),
        tier: inferTierFromId(id),
      })))
    }).catch(() => { /* keep fallback list */ })
    return () => { cancelled = true }
  }, [agentType])

  const models = agentType === 'opencode' && opencodeModels ? opencodeModels : staticModels

  // Per-session draft — reads from store, updates on every keystroke
  const draft = useDraftStore((s) => (sessionId ? s.drafts[sessionId] ?? '' : ''))
  const setDraft = useDraftStore((s) => s.setDraft)
  const clearDraft = useDraftStore((s) => s.clearDraft)
  // CRITICAL: select the raw map and derive `pills` via useMemo with a
  // stable EMPTY_PILLS sentinel. The previous `?? []` selector returned a
  // brand-new array literal on every render whenever the session had no
  // pills, which cascaded into a new `pillsById` object → new RichChatTextarea
  // props → Lexical OnChangePlugin re-registering → infinite update loop.
  const pillsBySession = useDraftStore((s) => s.pillsBySession)
  const pills = useMemo(
    () => (sessionId ? pillsBySession[sessionId] ?? EMPTY_PILLS : EMPTY_PILLS),
    [pillsBySession, sessionId],
  )
  const removePill = useDraftStore((s) => s.removePill)
  const clearPills = useDraftStore((s) => s.clearPills)

  // Local mirror of the body string. Lexical owns the editor state; this
  // is the plain-text-with-pill-tokens representation that flows through
  // draft persistence, slash detection, and Send.
  const [value, setValue] = useState(draft)
  // Live caret offset into `value`. Updated on every editor change so we
  // can re-detect slash triggers without dipping into the editor.
  const [caret, setCaret] = useState<number | null>(null)
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null)
  // Slash command popover state: `null` when closed; trigger info when open
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [slashActiveIdx, setSlashActiveIdx] = useState(0)
  const [agentSkills, setAgentSkills] = useState<ProviderSkill[]>([])

  // Fetch the agent's slash commands/skills (Claude SDK init.commands,
  // Codex skills/list) so the slash menu can surface them alongside our
  // Switchboard built-ins. OpenCode has no skill registry — we just skip
  // the call (preload returns []). Re-run when sessionId or agentType
  // changes so a session swap doesn't show stale skills.
  // Stable fetcher — also called from the slash-trigger path below so the
  // menu refreshes the moment the user opens `/`, not just on session
  // mount. Without this, `system/init` (Claude SDK) hadn't fired yet at
  // mount time and skills would stay empty until the user reloaded.
  const fetchSkills = useCallback(() => {
    if (!sessionId) { setAgentSkills([]); return }
    if (agentType === 'opencode') { setAgentSkills([]); return }
    ;(window.api.provider as any)?.listSkills?.(sessionId).then((skills: ProviderSkill[]) => {
      if (Array.isArray(skills) && skills.length > 0) {
        setAgentSkills(skills)
      }
    }).catch(() => { /* keep current — built-ins still work */ })
  }, [sessionId, agentType])

  useEffect(() => {
    if (!sessionId) { setAgentSkills([]); return }
    if (agentType === 'opencode') { setAgentSkills([]); return }
    let cancelled = false
    // The agent may not have initialized yet; retry a couple of times so
    // the menu populates as soon as `system/init` lands.
    let attempts = 0
    const tryFetch = () => {
      ;(window.api.provider as any)?.listSkills?.(sessionId).then((skills: ProviderSkill[]) => {
        if (cancelled) return
        if (skills && skills.length > 0) {
          setAgentSkills(skills)
        } else if (attempts++ < 4) {
          setTimeout(tryFetch, 500 * (attempts + 1))
        }
      }).catch(() => { /* keep [] — built-ins still work */ })
    }
    tryFetch()
    return () => { cancelled = true }
  }, [sessionId, agentType])

  const mergedCommands = useMemo(
    () => mergeWithAgentSkills(SLASH_COMMANDS, agentSkills),
    [agentSkills],
  )

  const slashRangeRef = useRef<{ start: number; end: number } | null>(null)
  const dragDepthRef = useRef(0)
  const richRef = useRef<RichChatTextareaHandle>(null)
  const filePickerRef = useRef<HTMLInputElement>(null)
  // Track which pill ids we've already inserted into the editor so the
  // sync effect (below) doesn't double-insert when `pills` updates for
  // unrelated reasons (e.g. removePill firing).
  const insertedPillsRef = useRef<Set<string>>(new Set())

  // Sync local `value` whenever the store's draft changes (either because
  // the user switched sessions, OR because an external action — slash
  // command, "forward to" — wrote to the draft). Lexical's HydrationPlugin
  // watches `value` and reconciles the editor when it diverges from the
  // serialized editor state.
  useEffect(() => {
    if (draft !== value) setValue(draft)
  // `value` intentionally excluded — see textarea-era comment.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, draft])

  // Map of pill id → metadata, used by the editor to render chips and by
  // Send to expand `[[pill:id]]` tokens into wire content.
  const pillsById = useMemo(() => {
    const out: Record<string, typeof pills[number]> = {}
    for (const p of pills) out[p.id] = p
    return out
  }, [pills])

  // ⌘L pill insertion: contextBridge.captureSelection() calls
  // addPill(sessionId, pill) and dispatches `sb-pill-added`. We listen
  // and insert the pill at the current caret position via Lexical's
  // INSERT_PILL_COMMAND. Going through a window event keeps contextBridge
  // free of Lexical/React coupling.
  useEffect(() => {
    if (!sessionId) return
    const handler = (ev: Event): void => {
      const e = ev as CustomEvent<{ sessionId: string; pillId: string }>
      if (e.detail.sessionId !== sessionId) return
      if (insertedPillsRef.current.has(e.detail.pillId)) return
      const pill = useDraftStore.getState().pillsBySession[sessionId]?.find((p) => p.id === e.detail.pillId)
      if (!pill) return
      richRef.current?.insertPill(pill)
      insertedPillsRef.current.add(e.detail.pillId)
    }
    window.addEventListener('sb-pill-added', handler)
    return () => window.removeEventListener('sb-pill-added', handler)
  }, [sessionId])

  // Pill ×-button removal: PillNode dispatches `sb-pill-remove` after
  // detaching itself from the editor. We sync by removing the metadata
  // from the draft-store so the chip catalog doesn't accumulate stale
  // entries.
  useEffect(() => {
    if (!sessionId) return
    const handler = (ev: Event): void => {
      const e = ev as CustomEvent<{ id: string }>
      removePill(sessionId, e.detail.id)
      insertedPillsRef.current.delete(e.detail.id)
    }
    window.addEventListener('sb-pill-remove', handler)
    return () => window.removeEventListener('sb-pill-remove', handler)
  }, [sessionId, removePill])



  const addImages = useCallback((files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    const valid = imageFiles.filter((f) => f.size <= MAX_IMAGE_SIZE)

    const newAttachments: ImageAttachment[] = valid.map((file) => ({
      id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }))

    setImages((prev) => [...prev, ...newAttachments])
  }, [])

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const removed = prev.find((img) => img.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return prev.filter((img) => img.id !== id)
    })
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    const hasPills = pills.length > 0
    if ((!trimmed && images.length === 0 && !hasPills) || disabled) return
    // Pills are inline `[[pill:id]]` tokens in `value`. Expand each into
    // its full content (path marker + fenced block, terminal block, or
    // chat-message quote) before handing off. Tokens whose pills were
    // already removed get dropped silently.
    const body = serializeBodyWithPills(trimmed, pillsById)
    onSend(body, undefined, images.length > 0 ? images : undefined)
    setValue('')
    if (sessionId) {
      clearDraft(sessionId)
      if (hasPills) clearPills(sessionId)
    }
    insertedPillsRef.current.clear()
    setImages([])
  }, [value, pills, pillsById, images, disabled, onSend, sessionId, clearDraft, clearPills])

  // ─── Slash command handling ─────────────────────────────────
  const dismissSlash = useCallback(() => {
    setSlashQuery(null)
    slashRangeRef.current = null
  }, [])

  // Editor → host change pipe. RichChatTextarea calls this with the
  // serialized plain-text-with-pill-tokens body whenever Lexical's editor
  // state mutates. We mirror it into local `value`, persist to the draft
  // store (per-session), and re-run slash trigger detection so the menu
  // tracks live typing.
  //
  // Stable identity matters: this callback is a prop on RichChatTextarea,
  // and unstable props would make the editor's plugins re-register every
  // render — that's exactly what caused the original infinite-update loop.
  const handleEditorChange = useCallback((next: string) => {
    setValue(next)
    if (sessionId) setDraft(sessionId, next)
    // Caret may not have been reported yet for this change — fall back to
    // end-of-string for slash detection. The follow-up onCaretChange will
    // correct the trigger range if needed.
    const cur = caret ?? next.length
    const trigger = detectSlashTrigger(next, cur)
    if (trigger) {
      setSlashQuery(trigger.query)
      setSlashActiveIdx(0)
      slashRangeRef.current = { start: trigger.rangeStart, end: trigger.rangeEnd }
      // Refresh agent skills the moment the user opens `/` — handles the
      // case where `system/init` arrives after mount.
      if (agentSkills.length === 0) fetchSkills()
    } else if (slashQuery !== null) {
      dismissSlash()
    }
  }, [sessionId, setDraft, caret, slashQuery, dismissSlash, agentSkills.length, fetchSkills])

  const handleEditorCaret = useCallback((c: number | null) => {
    setCaret(c)
  }, [])

  const runSlashCommand = useCallback((cmd: SlashCommand) => {
    const range = slashRangeRef.current
    if (!range) { dismissSlash(); return }

    const source = cmd.source ?? 'switchboard'

    // Agent-source commands (Claude/Codex skills): don't fire a local
    // action — instead, replace the partial `/que` the user typed with
    // the canonical `/<name> ` and let them fill in any args before
    // hitting Enter. The agent SDK/CLI parses the leading slash from
    // the sent prompt and runs the corresponding handler.
    if (source !== 'switchboard') {
      const inserted = `/${cmd.name} `
      richRef.current?.replaceRange(range.start, range.end, inserted)
      // replaceRange writes through to onChange → setValue + setDraft.
      dismissSlash()
      requestAnimationFrame(() => richRef.current?.focus())
      return
    }

    // Switchboard built-in: strip the /command text and run its action.
    richRef.current?.replaceRange(range.start, range.end, '')
    dismissSlash()

    const ctx: SlashCommandContext = {
      sessionId: sessionId ?? null,
      setRuntimeMode: (m) => onRuntimeModeChange?.(m),
      clearMessages: () => onClearMessages?.(),
      archiveCurrent: () => onArchive?.(),
      showHelp: () => onShowSlashHelp?.(),
      pickImage: () => filePickerRef.current?.click(),
      interrupt: () => onInterrupt?.(),
    }
    cmd.run?.(ctx)

    requestAnimationFrame(() => richRef.current?.focus())
  }, [sessionId, dismissSlash, onRuntimeModeChange, onClearMessages, onArchive, onShowSlashHelp, onInterrupt])

  // Slash menu navigation. Bound at the wrapper-div level so it fires
  // BEFORE Lexical's own Enter-handler (we preventDefault to swallow).
  // Send-on-Enter for the editor-without-slash-menu case is handled by
  // RichChatTextarea's `onEnter` prop instead.
  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (slashQuery === null) return
      const matches = filterSlashCommands(slashQuery, mergedCommands)
      if (matches.length === 0 && e.key !== 'Escape') return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActiveIdx((i) => (i + 1) % Math.max(matches.length, 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActiveIdx((i) => (i - 1 + Math.max(matches.length, 1)) % Math.max(matches.length, 1))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        if (matches.length > 0) runSlashCommand(matches[slashActiveIdx] ?? matches[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        dismissSlash()
      }
    },
    [slashQuery, slashActiveIdx, runSlashCommand, dismissSlash, mergedCommands],
  )

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setIsDragOver(true)
  }, [])

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragDepthRef.current -= 1
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    addImages(files)
    richRef.current?.focus()
  }, [addImages])

  return (
    <div
      style={{
        padding: '8px 12px 10px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        flexShrink: 0,
      }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Image previews */}
      {images.length > 0 && (
        <div style={{
          display: 'flex',
          gap: '6px',
          marginBottom: '6px',
          flexWrap: 'wrap',
        }}>
          {images.map((img) => (
            <div key={img.id} style={{
              position: 'relative',
              width: '56px',
              height: '56px',
              borderRadius: '6px',
              overflow: 'hidden',
              border: '1px solid var(--border)',
            }}>
              <img
                src={img.previewUrl}
                alt="attachment"
                onClick={() => setPreviewImage(img)}
                style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer' }}
              />
              <button
                onClick={() => removeImage(img.id)}
                style={{
                  position: 'absolute',
                  top: '2px',
                  right: '2px',
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  background: 'rgba(0,0,0,0.6)',
                  color: '#fff',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '10px',
                  lineHeight: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Drop overlay */}
      {isDragOver && (
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(var(--accent-rgb, 59, 130, 246), 0.08)',
          border: '2px dashed var(--accent)',
          borderRadius: 'var(--radius)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--accent)',
          fontSize: '13px',
          fontWeight: 500,
          zIndex: 10,
          pointerEvents: 'none',
        }}>
          Drop image to attach
        </div>
      )}

      {/* Hidden file picker for /image slash command */}
      <input
        ref={filePickerRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) addImages(files)
          if (filePickerRef.current) filePickerRef.current.value = ''
          richRef.current?.focus()
        }}
        style={{ display: 'none' }}
      />

      {/* Rich text input — Lexical-backed contenteditable that renders
          pill chips inline at the caret position (Cursor-style). The host
          sees a plain string body with `[[pill:id]]` tokens; pillsById
          maps tokens to chip metadata + serialized content. */}
      <div
        style={{ position: 'relative', display: 'flex', gap: '8px', alignItems: 'flex-end' }}
        onKeyDownCapture={handleEditorKeyDown}
      >
        {/* Slash command popover — positioned above the editor */}
        {slashQuery !== null && (
          <SlashCommandMenu
            query={slashQuery}
            onSelect={runSlashCommand}
            onDismiss={dismissSlash}
            activeIndex={slashActiveIdx}
            onActiveIndexChange={(i) => setSlashActiveIdx(i)}
            commands={mergedCommands}
          />
        )}
        {/* IMPORTANT: this wrapper must NOT use display:flex — Lexical's
            ContentEditable warns that flex parents cause Chrome focusing
            bugs (caret hiding, click-outside selection drift). Use block
            layout and let the inner ContentEditable size itself. */}
        <div
          data-chat-input-textarea
          style={{ display: 'block', position: 'relative', flex: 1, minWidth: 0 }}
          onBlur={() => { setTimeout(() => dismissSlash(), 120) }}
        >
          <RichChatTextarea
            ref={richRef}
            value={value}
            onChange={handleEditorChange}
            onCaretChange={handleEditorCaret}
            onEnter={handleSend}
            onPasteFiles={addImages}
            pillsById={pillsById}
            placeholder={placeholder}
            disabled={disabled}
          />
        </div>
        {isRunning && onInterrupt && (
          <button
            onClick={onInterrupt}
            title="Stop the current turn (\u2318\u232B)"
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--error)',
              background: 'transparent',
              color: 'var(--error)',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 600,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.12s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(248, 81, 73, 0.12)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
            Stop
          </button>
        )}
        <button
          onClick={handleSend}
          disabled={disabled || (!value.trim() && images.length === 0)}
          style={{
            padding: '10px 16px',
            borderRadius: 'var(--radius)',
            border: 'none',
            background: !disabled && (value.trim() || images.length > 0) ? 'var(--accent)' : 'var(--bg-tertiary)',
            color: !disabled && (value.trim() || images.length > 0) ? '#fff' : 'var(--text-muted)',
            cursor: !disabled && (value.trim() || images.length > 0) ? 'pointer' : 'default',
            fontSize: '13px',
            fontWeight: 600,
            flexShrink: 0,
            transition: 'all 0.12s',
          }}
          title={isRunning ? 'Queue a follow-up message (sends after current turn finishes)' : undefined}
        >
          {isRunning ? 'Queue' : 'Send'}
        </button>
      </div>

      {/* Footer bar: agent selector + mode toggle + hints */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginTop: '6px',
          fontSize: '11px',
        }}
      >
        {/* Agent selector */}
        <select
          value={agentType}
          onChange={(e) => onAgentTypeChange(e.target.value as AgentType)}
          disabled={!canChangeAgent}
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            padding: '3px 6px',
            fontSize: '11px',
            cursor: canChangeAgent ? 'pointer' : 'default',
            outline: 'none',
          }}
        >
          {AGENTS.map((a) => (
            <option key={a.value} value={a.value} disabled={!a.available}>
              {a.label}{!a.available ? ' (soon)' : ''}
            </option>
          ))}
        </select>

        {/* Model selector — dropdown of known models + Custom for any string */}
        {onModelChange && (
          <ModelPicker
            value={model ?? ''}
            onChange={onModelChange}
            models={models}
          />
        )}

        {/* Variant chips (OpenCode ACP only) — surfaced when the agent reports
            `availableVariants` for the currently selected model. Clicking a
            chip rewrites the model id to `<base>/<variant>` (or strips the
            variant if "base" is selected). */}
        {agentType === 'opencode' && onModelChange && (
          <VariantChips sessionId={sessionId ?? null} model={model ?? ''} onChange={onModelChange} />
        )}

        {/* Reasoning-effort selector — Codex-only, mirrors the desktop app's
            second dropdown next to the model picker. */}
        {agentSupportsReasoningEffort(agentType) && onReasoningEffortChange && (
          <select
            value={reasoningEffort ?? 'medium'}
            onChange={(e) => onReasoningEffortChange(e.target.value as ReasoningEffort)}
            title="Reasoning effort (Codex)"
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              padding: '3px 6px',
              fontSize: '11px',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            {REASONING_EFFORTS.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        )}

        {/* Runtime mode selector (per-session) */}
        {runtimeMode && onRuntimeModeChange && (
          <select
            value={runtimeMode}
            onChange={(e) => onRuntimeModeChange(e.target.value as RuntimeMode)}
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              padding: '3px 6px',
              fontSize: '11px',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            <option value="sandbox">Sandbox (ask every tool)</option>
            <option value="accept-edits">Accept Edits (auto-approve file changes)</option>
            <option value="full-access">Full Access (skip all prompts)</option>
            <option value="plan">Plan Only (no execution)</option>
          </select>
        )}

        <span style={{ flex: 1 }} />

        {/* Context meter */}
        {contextUsage && (
          <ContextWindowMeter usage={contextUsage} />
        )}

        <span style={{ color: 'var(--text-muted)' }}>
          Enter send · Shift+Enter newline
        </span>
      </div>

      {/* Image lightbox */}
      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          onContextMenu={(e) => {
            e.preventDefault()
            // Copy image to clipboard
            const canvas = document.createElement('canvas')
            const imgEl = document.createElement('img')
            imgEl.src = previewImage.previewUrl
            imgEl.onload = () => {
              canvas.width = imgEl.naturalWidth
              canvas.height = imgEl.naturalHeight
              const ctx = canvas.getContext('2d')
              ctx?.drawImage(imgEl, 0, 0)
              canvas.toBlob((blob) => {
                if (blob) {
                  navigator.clipboard.write([
                    new ClipboardItem({ 'image/png': blob }),
                  ]).catch(() => {})
                }
              }, 'image/png')
            }
            setPreviewImage(null)
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1100,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '80vh' }}>
            <img
              src={previewImage.previewUrl}
              alt="preview"
              style={{
                maxWidth: '90vw',
                maxHeight: '80vh',
                objectFit: 'contain',
                borderRadius: '8px',
                boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
              }}
              onClick={(e) => e.stopPropagation()}
            />
            <div style={{
              position: 'absolute',
              bottom: '-32px',
              left: '50%',
              transform: 'translateX(-50%)',
              color: 'rgba(255,255,255,0.6)',
              fontSize: '11px',
              whiteSpace: 'nowrap',
            }}>
              Click backdrop to close · Right-click to copy
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Model picker with dropdown + custom input ─────────────────

function ModelPicker({
  value,
  onChange,
  models,
}: {
  value: string
  onChange: (model: string) => void
  models: Array<{ id: string; label: string }>
}) {
  const [showCustom, setShowCustom] = useState(false)
  const [customValue, setCustomValue] = useState('')
  const isKnown = !value || models.some((m) => m.id === value)

  // Reset the custom-input branch whenever the model list changes (i.e.
  // the user switched agents). Without this, picking "Custom..." on
  // OpenCode and then flipping to Codex would leave the input box up
  // even though the value was already cleared by setAgentType.
  useEffect(() => {
    setShowCustom(false)
    setCustomValue('')
  }, [models])

  const selectStyle: React.CSSProperties = {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    padding: '3px 6px',
    fontSize: '11px',
    cursor: 'pointer',
    outline: 'none',
    maxWidth: '170px',
  }

  if (showCustom || (!isKnown && value)) {
    return (
      <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
        <input
          value={showCustom ? customValue : value}
          onChange={(e) => {
            setCustomValue(e.target.value)
            onChange(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setShowCustom(false); onChange('') }
            if (e.key === 'Enter') { setShowCustom(false) }
            e.stopPropagation() // don't trigger app shortcuts
          }}
          placeholder="model-id"
          autoFocus
          style={{
            ...selectStyle,
            width: '140px',
            fontFamily: 'var(--font-mono)',
          }}
        />
        <button
          onClick={() => { setShowCustom(false); if (!customValue) onChange('') }}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: '12px',
            padding: '0 2px',
          }}
          title="Back to list"
        >
          x
        </button>
      </div>
    )
  }

  // Group models by their provider prefix (e.g. "google/", "nvidia-nim/")
  // so the OpenCode dropdown — which can return 100+ entries — is browsable.
  // Models without a slash (Claude/Codex static lists) collapse into a
  // single ungrouped section.
  const grouped = groupModelsByProvider(models)

  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === '__custom__') {
          setShowCustom(true)
          setCustomValue('')
        } else {
          onChange(e.target.value)
        }
      }}
      style={selectStyle}
    >
      <option value="">Default</option>
      {grouped.ungrouped.map((m) => (
        <option key={m.id} value={m.id}>{m.label}</option>
      ))}
      {grouped.groups.map(({ provider, models: groupModels }) => (
        <optgroup key={provider} label={provider}>
          {groupModels.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </optgroup>
      ))}
      <option value="__custom__">Custom...</option>
    </select>
  )
}

/**
 * Split a flat model list into provider-prefix groups (for `<optgroup>`).
 * IDs without a `/` go into `ungrouped` (Claude/Codex static lists). Order
 * is stable: groups appear in the order their first member shows up in the
 * input array.
 *
 * Exported for unit tests.
 */
export function groupModelsByProvider<T extends { id: string }>(
  models: T[],
): { ungrouped: T[]; groups: Array<{ provider: string; models: T[] }> } {
  const ungrouped: T[] = []
  const groupMap = new Map<string, T[]>()
  const order: string[] = []
  for (const m of models) {
    const slash = m.id.indexOf('/')
    if (slash === -1) {
      ungrouped.push(m)
      continue
    }
    const provider = m.id.slice(0, slash)
    if (!groupMap.has(provider)) {
      groupMap.set(provider, [])
      order.push(provider)
    }
    groupMap.get(provider)!.push(m)
  }
  return {
    ungrouped,
    groups: order.map((p) => ({ provider: p, models: groupMap.get(p)! })),
  }
}

// ─── Variant chips (OpenCode ACP) ───────────────────────────────

/**
 * Renders a small chip group next to the model picker showing the variants
 * (`low` / `medium` / `high` / `max`, etc.) the agent has advertised for the
 * currently selected model. Hidden when the model has no variants.
 *
 * The base model id is the current `model` prop with any trailing variant
 * stripped — variants are the third path segment for OpenCode-style ids
 * (`provider/model/<variant>`). When the user clicks a chip, we rewrite the
 * model to `<base>/<variant>` and bubble through `onChange`.
 */
function VariantChips({
  sessionId,
  model,
  onChange,
}: {
  sessionId: string | null
  model: string
  onChange: (model: string) => void
}) {
  const session = useAgentStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined,
  )
  const available = session?.availableVariants ?? []
  const current = session?.currentVariant ?? ''
  if (available.length === 0) return null

  const { base } = splitModelVariant(model, available)

  const chip = (label: string, variant: string, active: boolean) => (
    <button
      key={variant || '__base__'}
      onClick={() => onChange(variant ? `${base}/${variant}` : base)}
      style={{
        background: active ? 'var(--accent)' : 'var(--bg-tertiary)',
        color: active ? 'white' : 'var(--text-secondary)',
        border: '1px solid var(--border)',
        borderRadius: '4px',
        padding: '2px 6px',
        fontSize: '10px',
        fontFamily: 'var(--font-mono)',
        cursor: 'pointer',
        outline: 'none',
      }}
      title={`thinking budget: ${label}`}
    >
      {label}
    </button>
  )

  return (
    <span style={{ display: 'inline-flex', gap: '3px', alignItems: 'center' }}>
      {available.map((v) => chip(v || 'base', v, v === current))}
    </span>
  )
}

/**
 * Strip a variant suffix (e.g. `/low` / `/high`) from a model id, given the
 * set of variants the agent advertises. Returns the base id and the
 * detected variant (empty string when the id is already a base model).
 *
 * Exported for unit tests.
 */
export function splitModelVariant(
  id: string,
  variants: string[],
): { base: string; variant: string } {
  for (const v of variants) {
    if (v && id.endsWith(`/${v}`)) {
      return { base: id.slice(0, -v.length - 1), variant: v }
    }
  }
  return { base: id, variant: '' }
}

/**
 * Turn an opencode model ID like `nvidia-nim/z-ai/glm-5.1` into a nice
 * human label like "GLM 5.1 · nvidia-nim". Keeps the full ID visible enough
 * for users to disambiguate, but puts the model name first.
 */
function formatOpencodeModelLabel(id: string): string {
  const parts = id.split('/')
  const provider = parts[0]
  // For 3-part IDs (openai-compat providers like nvidia-nim/org/model),
  // take the last segment as the model name. For 2-part (google/gemini-2.5-pro),
  // the second segment is the name.
  const modelName = parts[parts.length - 1]
  // Prettify: replace dashes/underscores with spaces, title-case-ish
  const pretty = modelName
    .replace(/[-_]/g, ' ')
    .replace(/\b(glm|gpt|llm|ai|r1|v3|k2)\b/gi, (s) => s.toUpperCase())
  // Free-tier callouts
  const isFree = id.startsWith('opencode/') || id.endsWith('-free')
  const badge = isFree
    ? ' · free'
    : provider === 'nvidia-nim'
      ? ' · nvidia'
      : ` · ${provider}`
  return `${pretty}${badge}`
}

function inferTierFromId(id: string): 'fast' | 'balanced' | 'max' {
  const lower = id.toLowerCase()
  if (lower.includes('flash') || lower.includes('mini') || lower.includes('nano') || lower.includes('haiku')) return 'fast'
  if (lower.includes('pro') || lower.includes('opus') || lower.includes('max') || lower.includes('large') || lower.includes('ultra')) return 'max'
  return 'balanced'
}

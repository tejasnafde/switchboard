import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react'
import { ContextWindowMeter, type ContextWindowUsage } from './ContextWindowMeter'
import { useDraftStore } from '../../stores/draft-store'
import {
  modelsForAgent,
  REASONING_EFFORTS,
  agentSupportsReasoningEffort,
  type ReasoningEffort,
} from '@shared/models'
import type { AgentType, ProviderSkill } from '@shared/types'
import { SlashCommandMenu } from './SlashCommandMenu'
import {
  detectSlashTrigger,
  filterSlashCommands,
  mergeWithAgentSkills,
  SLASH_COMMANDS,
  type SlashCommand,
  type SlashCommandContext,
} from './slashCommands'

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

  // Local mirror so textarea stays responsive; kept in sync with store
  const [value, setValue] = useState(draft)
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const filePickerRef = useRef<HTMLInputElement>(null)

  // Sync local `value` whenever the store's draft changes (either because
  // the user switched sessions, OR because an external action — ⌘L context
  // bridge, slash command, "forward to" — wrote to the draft). The local
  // mirror keeps the textarea responsive during typing, but it must re-hydrate
  // from the store on these external writes or the new content stays
  // invisible until the user switches sessions.
  useEffect(() => {
    if (draft !== value) setValue(draft)
  // `value` intentionally excluded: we only sync FROM store TO local when
  // draft changes externally. Including value would cause a loop on typing
  // (draft updates → effect sees draft !== value → setValue → re-render...).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, draft])

  // Auto-resize the textarea on EVERY value change — including external
  // writes (⌘L, slash commands, forward-to). Splitting this from the
  // draft-sync effect above is critical: when draft changes externally,
  // the sync effect schedules setValue(draft) but the textarea DOM still
  // shows the old content during that render, so reading scrollHeight
  // there gives the stale (smaller) height. Running resize after `value`
  // updates means the DOM is already showing the new content.
  useLayoutEffect(() => {
    const t = textareaRef.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = `${Math.min(t.scrollHeight, 200)}px`
  }, [value])



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
    if ((!trimmed && images.length === 0) || disabled) return
    onSend(trimmed, undefined, images.length > 0 ? images : undefined)
    setValue('')
    if (sessionId) clearDraft(sessionId)
    setImages([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [value, images, disabled, onSend, sessionId, clearDraft])

  // ─── Slash command handling ─────────────────────────────────
  const dismissSlash = useCallback(() => {
    setSlashQuery(null)
    slashRangeRef.current = null
  }, [])

  const runSlashCommand = useCallback((cmd: SlashCommand) => {
    const range = slashRangeRef.current
    const ta = textareaRef.current
    if (!ta || !range) { dismissSlash(); return }

    const source = cmd.source ?? 'switchboard'

    // Agent-source commands (Claude/Codex skills): don't fire a local
    // action — instead, replace the partial `/que` the user typed with
    // the canonical `/<name> ` and let them fill in any args before
    // hitting Enter. The agent SDK/CLI parses the leading slash from the
    // sent prompt and runs the corresponding handler.
    if (source !== 'switchboard') {
      const inserted = `/${cmd.name} `
      const next = value.slice(0, range.start) + inserted + value.slice(range.end)
      setValue(next)
      if (sessionId) setDraft(sessionId, next)
      dismissSlash()
      const caret = range.start + inserted.length
      requestAnimationFrame(() => {
        if (ta) { ta.focus(); ta.setSelectionRange(caret, caret) }
      })
      return
    }

    // Switchboard built-in: strip the /command text and run its action.
    const next = value.slice(0, range.start) + value.slice(range.end)
    setValue(next)
    if (sessionId) setDraft(sessionId, next)
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

    // Restore focus + caret to where /cmd used to start
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus()
        ta.setSelectionRange(range.start, range.start)
      }
    })
  }, [value, sessionId, setDraft, dismissSlash, onRuntimeModeChange, onClearMessages, onArchive, onShowSlashHelp, onInterrupt])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Slash menu intercepts ↑/↓/Enter/Escape/Tab when open
      if (slashQuery !== null) {
        const matches = filterSlashCommands(slashQuery, mergedCommands)
        if (matches.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSlashActiveIdx((i) => (i + 1) % matches.length)
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSlashActiveIdx((i) => (i - 1 + matches.length) % matches.length)
            return
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            runSlashCommand(matches[slashActiveIdx] ?? matches[0])
            return
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          dismissSlash()
          return
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend, slashQuery, slashActiveIdx, runSlashCommand, dismissSlash, mergedCommands]
  )

  const handleInput = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
  }, [])

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length === 0) return
    const imageFiles = files.filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    e.preventDefault()
    addImages(imageFiles)
  }, [addImages])

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
    textareaRef.current?.focus()
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
          textareaRef.current?.focus()
        }}
        style={{ display: 'none' }}
      />

      {/* Text input */}
      <div style={{ position: 'relative', display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
        {/* Slash command popover — positioned above the textarea */}
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
        <textarea
          ref={textareaRef}
          data-chat-input-textarea
          value={value}
          onChange={(e) => {
            const v = e.target.value
            const caret = e.target.selectionStart ?? v.length
            setValue(v)
            if (sessionId) setDraft(sessionId, v)
            // Detect slash trigger at caret. Commit caret position so
            // runSlashCommand knows where to splice the `/cmd` out.
            const trigger = detectSlashTrigger(v, caret)
            if (trigger) {
              slashRangeRef.current = { start: trigger.rangeStart, end: trigger.rangeEnd }
              // First-open of this slash session — kick a fresh fetch so
              // any commands the SDK announced AFTER our initial mount
              // (system/init lands post-sendTurn) show up immediately.
              if (slashQuery === null) fetchSkills()
              setSlashQuery(trigger.query)
              setSlashActiveIdx(0)
            } else if (slashQuery !== null) {
              dismissSlash()
            }
          }}
          onBlur={() => {
            // Small delay so onMouseDown on the menu item wins over blur
            setTimeout(() => dismissSlash(), 120)
          }}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onPaste={handlePaste}
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          style={{
            flex: 1,
            resize: 'none',
            padding: '10px 12px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            fontSize: '13px',
            fontFamily: 'var(--font-sans)',
            lineHeight: 1.5,
            outline: 'none',
            maxHeight: '200px',
          }}
        />
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
      {models.map((m) => (
        <option key={m.id} value={m.id}>{m.label}</option>
      ))}
      <option value="__custom__">Custom...</option>
    </select>
  )
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

import { USER_MESSAGE_IMAGE_TYPES } from '@shared/provider-events'
import { useState, useCallback, useMemo, useRef, useEffect, type DragEvent } from 'react'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('chat:input')
import { ContextWindowMeter, type ContextWindowUsage } from './ContextWindowMeter'
import {
  discardDetachedDraftPayload,
  draftPayloadEquals,
  useDraftStore,
  type DraftPayload,
  type ImageAttachment,
} from '../../stores/draft-store'
import { coversFor, reconcileSelectedModel } from '@shared/model-reconcile'
import { followUpDelivery, sendAction, waitsForIdle, type TurnDelivery } from '@shared/turn-delivery'
import { followOffNotice, followSuggestionView, type FollowSuggestionMode } from '@shared/follow-suggestions'
import { useLayoutStore } from '../../stores/layout-store'
import { ArrowUpIcon, StopSquareIcon } from './chat-icons'
import {
  modelsForAgent,
  REASONING_EFFORTS,
  agentSupportsReasoningEffort,
  type ModelOption,
  type ReasoningEffort,
} from '@shared/models'
import { defaultInstanceId, type AgentType, type ProviderSkill } from '@shared/types'
import { useAgentStore } from '../../stores/agent-store'
import { describeRelocationOutcome } from '../../services/execution-root-relocation'
import type { RelocationReason } from '@shared/execution-root-relocation'
import { UnifiedProviderPicker } from './UnifiedProviderPicker'
import { useSkillStore } from '../../stores/skill-store'
import { useSpendBlockStore } from '../../stores/spend-block-store'
import { describeSpendBlock, findSpendBlock } from '@shared/spend-block'
import { SlashCommandMenu } from './SlashCommandMenu'
import { resolvePickerKeydown } from './picker-keydown'
import { VariantChips } from './model-variants'
import {
  detectSlashTrigger,
  filterSlashCommands,
  mergeWithAgentSkills,
  commandInsertion,
  SLASH_COMMANDS,
  type SlashCommand,
  type SlashCommandContext,
} from './slash-commands'
import { detectAtTrigger, filterAtMatches } from './at-mention'
import { detectSendToTrigger, pinSendToTarget, SEND_TO_EMPTY_MESSAGE, sendToPickAfterSend, sendToPickerItems, sendToPickInsertion } from './send-to-command'
import { fuzzyScore } from '../../services/fuzzy-score'
import { AtMentionMenu } from './AtMentionMenu'
import { DraftWorkspaceChips } from './DraftWorkspaceChips'
import { BranchPickerTrigger } from './BranchPicker'
import { RICH_TEXTAREA_MIN_HEIGHT, RichChatTextarea, type RichChatTextareaHandle } from './lexical/RichChatTextarea'
import { serializeBodyWithPills } from '../../services/chat-input-body'
import {
  desktopComposerRecoveryAction,
  desktopComposerFingerprint,
  desktopPreparedTurns,
  desktopTurnAttempts,
} from '../../services/desktop-turn-submission'
import { onUserTurnAccepted } from '../../services/session-events'
import { registerComposer } from '../../services/composer-registry'
import type { RuntimeMode } from '@shared/provider-events'
import { Button } from '../ui/button'
import { confirm } from '../ui/confirm'


export type ChatSendResult =
  | { accepted: true }
  | {
      accepted: false
      error: string
      delivery?: 'rejected' | 'ambiguous'
      recoveryOrigin?: string
    }

interface ComposerRecovery {
  sessionId: string
  origin?: string
  fingerprint: string
  payload: DraftPayload
  error: string
  ambiguous: boolean
  restored: boolean
  collisionPayload?: DraftPayload
  collisionFingerprint?: string
  collisionOrigin?: string
  /** The user closed the banner. The recovery itself still guards the next send. */
  dismissed?: boolean
}

export function shouldFetchProviderSkills(agentType: AgentType): boolean {
  return agentType !== 'terminal'
}

export function shouldFetchLiveModels(
  agentType: AgentType,
  sessionId: string | null | undefined,
  sessionIsActive: boolean,
): boolean {
  if (!sessionId || agentType === 'terminal') return false
  // OpenCode's catalog belongs to the binary, so the backend can answer from
  // another open OpenCode session before this one has started.
  return sessionIsActive || agentType === 'opencode'
}

interface ChatInputProps {
  sessionId?: string | null
  onSend: (
    message: string,
    mode?: string,
    images?: ImageAttachment[],
    extras?: {
      origin?: string
      confirmedRecoveryOrigin?: string
      displayBody?: string
      pillsMeta?: Record<string, { label: string; kind: 'file' | 'terminal' | 'chat-message' }>
    },
  ) => Promise<ChatSendResult>
  disabled?: boolean
  placeholder?: string
  agentType: AgentType
  onAgentTypeChange: (type: AgentType) => void
  canChangeAgent: boolean
  /** Selected provider-instance id. Falls back to default in main. */
  instanceId?: string
  onInstanceChange?: (instanceId: string | undefined) => void
  runtimeMode?: RuntimeMode
  onRuntimeModeChange?: (mode: RuntimeMode) => void
  contextUsage?: ContextWindowUsage
  model?: string
  onModelChange?: (model: string) => void
  /** Model the backend resolved to, when the user pinned nothing. */
  resolvedModel?: string
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

const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB

/** The text-link buttons in the drift chip and its "off" line. */
const driftLinkStyle = {
  cursor: 'pointer',
  border: 'none',
  background: 'transparent',
  color: 'var(--accent, #4a7dff)',
  padding: 0,
  fontSize: 11,
} as const

// Stop/Send sit inside the input box at its bottom-right, inset so they are
// centred on a one-line draft and stay pinned to the corner as it grows.
// The size is Button's `icon-round` (size-7), which is rem-based.
const COMPOSER_ACTION_SIZE = '1.75rem'
const COMPOSER_ACTION_INSET = `calc((${RICH_TEXTAREA_MIN_HEIGHT}px - ${COMPOSER_ACTION_SIZE}) / 2)`
const COMPOSER_ACTION_GAP = 6
const COMPOSER_TEXT_GAP = 8

function composerActionsInset(showStop: boolean): string {
  const buttons = showStop ? 2 : 1
  const gaps = (buttons - 1) * COMPOSER_ACTION_GAP + COMPOSER_TEXT_GAP
  return `calc(${COMPOSER_ACTION_INSET} + ${buttons} * ${COMPOSER_ACTION_SIZE} + ${gaps}px)`
}

// Module-level constant - referential equality across renders so the
// `pills` selector doesn't fabricate a new array when a session has
// no pills yet. Without this, every render produced a fresh `[]` and
// downstream memos invalidated.
const EMPTY_PILLS: import('../../stores/draft-store').DraftPill[] = []
const EMPTY_IMAGES: import('../../stores/draft-store').ImageAttachment[] = []

// Short labels only: a native select is as wide as its longest option, and
// the long text pushed the footer onto a second row. The detail is a tooltip.
const RUNTIME_MODE_OPTIONS: Array<{ value: RuntimeMode; label: string; detail: string }> = [
  { value: 'sandbox', label: 'Supervised', detail: 'Ask before commands and file changes' },
  { value: 'accept-edits', label: 'Auto-accept edits', detail: 'Ask before other actions' },
  { value: 'auto', label: 'Auto', detail: 'The agent approves routine actions. OpenCode still asks.' },
  { value: 'full-access', label: 'Full access', detail: 'No prompts' },
  { value: 'plan', label: 'Plan', detail: 'No execution' },
]

export function ChatInput({
  sessionId,
  onSend,
  disabled = false,
  placeholder = 'Message the agent...',
  agentType,
  onAgentTypeChange,
  canChangeAgent,
  instanceId,
  onInstanceChange,
  runtimeMode,
  onRuntimeModeChange,
  contextUsage,
  model,
  onModelChange,
  resolvedModel,
  reasoningEffort,
  onReasoningEffortChange,
  isRunning = false,
  onInterrupt,
  onClearMessages,
  onArchive,
  onShowSlashHelp,
}: ChatInputProps) {
  // Static fallback list - used until a dynamic fetch returns (OpenCode
  // shells out to `opencode models`; Claude asks the live SDK query).
  // Prevents the dropdown from being empty on first render.
  const staticModels = modelsForAgent(agentType)
  const [dynamicModels, setDynamicModels] = useState<typeof staticModels | null>(null)
  // Set once this chat's own session answered; the pre-session catalog never overwrites it.
  const liveListRef = useRef(false)

  // Claude model availability is per account, so the cache key includes the
  // instance - instance A's list must not hydrate instance B's picker.
  const modelsCacheKey = `models.dynamic.${agentType}${instanceId ? `.${instanceId}` : ''}`

  const persistDynamicModels = useCallback((models: ModelOption[]) => {
    setDynamicModels(models)
    void window.api.settings?.set?.(modelsCacheKey, JSON.stringify(models))
  }, [modelsCacheKey])

  // Stale-while-revalidate: hydrate the last-known dynamic list from the
  // settings cache instantly; live fetches overwrite it when they land.
  useEffect(() => {
    let cancelled = false
    setDynamicModels(null)
    ;window.api.settings?.get?.(modelsCacheKey).then((raw: string | null) => {
      if (cancelled || !raw) return
      try {
        const parsed = JSON.parse(raw) as ModelOption[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          // prev ?? parsed: never clobber a live fetch that beat the cache read.
          setDynamicModels((prev) => prev ?? parsed)
        }
      } catch (err) {
        log.warn('corrupt dynamic-model cache, awaiting live fetch', { key: modelsCacheKey, err })
      }
    }).catch((err) => {
      log.debug('no model cache yet for settings key', { key: modelsCacheKey, err })
    })

    // Then the instance's live catalog without waiting for a session, so a
    // model launched after this release shows up in a new chat. A running
    // session's own list, once it lands, stays authoritative.
    liveListRef.current = false
    if (agentType !== 'terminal') {
      window.api.provider.listCatalog?.({ threadId: sessionId ?? undefined, agentType, instanceId })
        .then((catalog) => {
          if (cancelled || liveListRef.current || !catalog?.length) return
          persistDynamicModels(catalog)
        })
        .catch((err: unknown) => log.warn('catalog probe failed, keeping cached list', err))
    }

    return () => { cancelled = true }
  }, [agentType, sessionId, instanceId, persistDynamicModels])

  // Provider catalogs only exist after startup, so fetch when the first turn
  // activates the session.
  const sessionIsActive = useAgentStore((s) => {
    const st = s.sessions.find((x) => x.id === sessionId)?.status
    return st === 'running' || st === 'thinking'
  })
  useEffect(() => {
    if (!sessionId || !shouldFetchLiveModels(agentType, sessionId, sessionIsActive)) return
    let cancelled = false
    let attempts = 0
    const tryFetch = () => {
      ;window.api.provider.listModels?.(sessionId).then((models) => {
        if (cancelled) return
        if (models && models.length > 0) {
          liveListRef.current = true
          persistDynamicModels(models)
        } else if (attempts++ < 4) {
          setTimeout(tryFetch, 500 * (attempts + 1))
        }
      }).catch((err) => {
        log.debug(`listModels failed for ${sessionId} - keeping fallback list`, err)
      })
    }
    tryFetch()
    return () => { cancelled = true }
  }, [agentType, sessionId, sessionIsActive, persistDynamicModels])

  const models = dynamicModels && dynamicModels.length > 0 ? dynamicModels : staticModels
  // Checked against the live (or last cached live) catalog only: the static
  // list is not evidence that a model was retired.
  const pickUnavailable = Boolean(model)
    && Boolean(dynamicModels?.length)
    && !reconcileSelectedModel(model, { models: dynamicModels ?? [] }, coversFor(agentType))

  // Per-session draft - reads from store, updates on every keystroke
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
  // Per session, exactly like drafts and pills - the previous component-local
  // useState survived a conversation switch (nothing remounts ChatInput), so a
  // pasted image followed the user into every chat they opened and was sent
  // from whichever one they hit Send in.
  const imagesBySession = useDraftStore((s) => s.imagesBySession)
  const images = useMemo(
    () => (sessionId ? imagesBySession[sessionId] ?? EMPTY_IMAGES : EMPTY_IMAGES),
    [imagesBySession, sessionId],
  )
  const addImagesToSession = useDraftStore((s) => s.addImages)
  const removeImageFromSession = useDraftStore((s) => s.removeImage)
  const clearImages = useDraftStore((s) => s.clearImages)
  const removePill = useDraftStore((s) => s.removePill)
  const clearPills = useDraftStore((s) => s.clearPills)

  // Local mirror of the body string. Lexical owns the editor state; this
  // is the plain-text-with-pill-tokens representation that flows through
  // draft persistence, slash detection, and Send.
  const [value, setValue] = useState(draft)
  const [sendError, setSendError] = useState<string | null>(null)
  const [recoveries, setRecoveries] = useState<Record<string, ComposerRecovery>>({})
  const recoveriesRef = useRef<Record<string, ComposerRecovery>>({})
  const updateRecoveries = useCallback((
    updater: (current: Record<string, ComposerRecovery>) => Record<string, ComposerRecovery>,
  ) => {
    const next = updater(recoveriesRef.current)
    recoveriesRef.current = next
    setRecoveries(next)
  }, [])
  const recovery = sessionId ? recoveries[sessionId] ?? null : null
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const submissionRef = useRef(0)
  const acceptedOriginsRef = useRef(new Set<string>())
  const pendingOriginsRef = useRef(new Set<string>())
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  // Live caret offset into `value`. Updated on every editor change so we
  // can re-detect slash triggers without dipping into the editor.
  const [caret, setCaret] = useState<number | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null)

  // Slash command popover state: `null` when closed; trigger info when open
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [slashActiveIdx, setSlashActiveIdx] = useState(0)
  const [agentSkills, setAgentSkills] = useState<ProviderSkill[]>([])
  const skillsScope = `${sessionId ?? ''}\u0000${agentType}\u0000${instanceId ?? ''}`
  const skillsScopeRef = useRef(skillsScope)
  skillsScopeRef.current = skillsScope
  const skillsRequestRef = useRef(0)
  // @-mention popover state. Parallel to the slash-popover; at most one
  // is open at a time (different trigger chars on the same token).
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [atActiveIdx, setAtActiveIdx] = useState(0)
  // `/send-to` target picker: the command needs an exact chat title, so
  // offer the open ones rather than making the user recall one.
  const [sendToQuery, setSendToQuery] = useState<string | null>(null)
  const [sendToActiveIdx, setSendToActiveIdx] = useState(0)
  const sendToRangeRef = useRef<{ start: number; end: number } | null>(null)
  const sendToPickRef = useRef<{ sessionId: string; id: string; title: string } | null>(null)
  const [atFiles, setAtFiles] = useState<string[]>([])
  const [atLoading, setAtLoading] = useState(false)
  // Read on demand, not subscribed: `sessions` changes identity on every
  // streamed token, so subscribing would re-render the composer per token.
  const sendToItems = useMemo(() => {
    if (sendToQuery === null || !sessionId) return []
    return sendToPickerItems(useAgentStore.getState().sessions, sessionId)
      .filter((i) => sendToQuery === '' || fuzzyScore(sendToQuery, i.label) !== null)
  }, [sendToQuery, sessionId])
  const sendToMatches = useMemo(() => sendToItems.map((i) => i.label), [sendToItems])

  // Single fuzzy scan per keystroke, shared by the keyboard handler and the
  // menu. Previously the keydown handler re-ran filterAtMatches (a full-list
  // fuzzyScore pass, 10k+ files) unmemoized on every keydown, on top of the
  // menu's own memoized copy.
  const atMatches = useMemo(
    () => (atQuery !== null ? filterAtMatches(atQuery, atFiles) : []),
    [atQuery, atFiles],
  )
  const atRangeRef = useRef<{ start: number; end: number } | null>(null)
  // Per-instance file-list cache, mirroring QuickOpenModal's per-mount ref.
  // Dies with ChatInput, so a closed-and-reopened chat picks up tree changes
  // - and we never accumulate entries across visited projects.
  const atFilesCacheRef = useRef<{ repoRoot: string; files: string[] } | null>(null)

  // Fetch the agent's slash commands/skills (Claude SDK init.commands,
  // Codex skills/list, OpenCode ACP available_commands_update) so the
  // slash menu can surface them alongside our Switchboard built-ins.
  // Re-run when sessionId or agentType changes so a session swap doesn't
  // show stale skills.
  // Stable fetcher - also called from the slash-trigger path below so the
  // menu refreshes the moment the user opens `/`, not just on session
  // mount. Without this, `system/init` (Claude SDK) hadn't fired yet at
  // mount time and skills would stay empty until the user reloaded.
  const fetchSkills = useCallback(() => {
    if (!sessionId) { setAgentSkills([]); return }
    if (!shouldFetchProviderSkills(agentType)) { setAgentSkills([]); return }
    const request = ++skillsRequestRef.current
    const requestScope = skillsScope
    setAgentSkills([])
    ;window.api.provider.listSkills?.(sessionId).then((skills: ProviderSkill[]) => {
      if (request !== skillsRequestRef.current || requestScope !== skillsScopeRef.current) return
      if (Array.isArray(skills) && skills.length > 0) {
        setAgentSkills(skills)
      }
    }).catch((err) => {
      log.debug(`listSkills failed for ${sessionId} - keeping current list, built-ins still work`, err)
    })
  }, [sessionId, agentType, instanceId, skillsScope])

  useEffect(() => {
    if (!sessionId) { setAgentSkills([]); return }
    if (!shouldFetchProviderSkills(agentType)) { setAgentSkills([]); return }
    const request = ++skillsRequestRef.current
    const requestScope = skillsScope
    setAgentSkills([])
    let cancelled = false
    // The agent may not have initialized yet; retry a couple of times so
    // the menu populates as soon as `system/init` lands.
    let attempts = 0
    const tryFetch = () => {
      ;window.api.provider.listSkills?.(sessionId).then((skills: ProviderSkill[]) => {
        if (cancelled || request !== skillsRequestRef.current || requestScope !== skillsScopeRef.current) return
        if (skills && skills.length > 0) {
          setAgentSkills(skills)
        } else if (attempts++ < 4) {
          setTimeout(tryFetch, 500 * (attempts + 1))
        }
      }).catch((err) => {
        log.debug(`listSkills retry failed for ${sessionId} - keeping [], built-ins still work`, err)
      })
    }
    tryFetch()
    return () => { cancelled = true }
  }, [sessionId, agentType, instanceId, skillsScope])

  const mergedCommands = useMemo(
    () => mergeWithAgentSkills(SLASH_COMMANDS, agentSkills),
    [agentSkills],
  )

  // Publish the merged skill-name set so MessageBubble can validate
  // leading `/<cmd>` chips against a real registry instead of rendering
  // the chip for any slash-shaped token (which would let typos like
  // `/halp` masquerade as recognized skills in sent bubbles).
  const setSkillNames = useSkillStore((s) => s.setSkillNames)
  useEffect(() => {
    if (!sessionId) return
    setSkillNames(sessionId, mergedCommands.map((c) => c.name))
  }, [sessionId, mergedCommands, setSkillNames])

  // Resolve the instance id the way the backend does: it records the RESOLVED
  // id, so looking up a bare `undefined` never matched. Not memoized because
  // `Date.now()` is not a reactive dep and a memo kept the banner up past expiry.
  const spendBlocks = useSpendBlockStore((s) => s.blocks)
  const spendBlock = findSpendBlock(
    spendBlocks,
    instanceId ?? defaultInstanceId(agentType),
    model || resolvedModel || null,
    Date.now(),
  )

  const slashRangeRef = useRef<{ start: number; end: number } | null>(null)
  const dragDepthRef = useRef(0)
  const richRef = useRef<RichChatTextareaHandle>(null)
  useEffect(() => {
    if (!sessionId) return
    return registerComposer(sessionId, {
      focus: () => richRef.current?.focus(),
    })
  }, [sessionId])
  const filePickerRef = useRef<HTMLInputElement>(null)
  // Track which pill ids we've already inserted into the editor so the
  // sync effect (below) doesn't double-insert when `pills` updates for
  // unrelated reasons (e.g. removePill firing).
  const insertedPillsRef = useRef<Set<string>>(new Set())

  // Sync local `value` whenever the store's draft changes (either because
  // the user switched sessions, OR because an external action - slash
  // command, "forward to" - wrote to the draft). Lexical's HydrationPlugin
  // watches `value` and reconciles the editor when it diverges from the
  // serialized editor state.
  useEffect(() => {
    if (draft !== value) setValue(draft)
  // `value` intentionally excluded - see textarea-era comment.
  }, [sessionId, draft])

  useEffect(() => {
    submissionRef.current += 1
    submittingRef.current = false
    setIsSubmitting(false)
    setSendError(null)
  }, [sessionId])

  // Map of pill id → metadata, used by the editor to render chips and by
  // Send to expand `[[pill:id]]` tokens into wire content.
  const pillsById = useMemo(() => {
    const out: Record<string, typeof pills[number]> = {}
    for (const p of pills) out[p.id] = p
    return out
  }, [pills])

  const composerFingerprint = useMemo(() => desktopComposerFingerprint({
    value,
    runtimeMode,
    pills: pills.map((pill) => ({
      id: pill.id,
      kind: pill.kind,
      label: pill.label,
      content: pill.content,
    })),
    images: images.map((image) => ({
      id: image.id,
      name: image.file.name,
      size: image.file.size,
      type: image.file.type,
      lastModified: image.file.lastModified,
    })),
  }), [value, runtimeMode, pills, images])
  const recoveryAction = recovery
    ? desktopComposerRecoveryAction(
        recovery.fingerprint,
        composerFingerprint,
        recovery.ambiguous,
        recovery.restored,
      )
    : 'send'
  const composerErrorColor = recovery?.ambiguous ? 'var(--warning)' : 'var(--error)'
  const followUpDefault = useLayoutStore((s) => s.followUpDefault)
  const showStop = isRunning && !!onInterrupt
  const sendButton = isSubmitting
    ? { label: 'Sending', tooltip: 'Sending…' }
    : recoveryAction === 'retry-safe'
      ? { label: 'Retry safely', tooltip: 'Retry safely (Enter)' }
      : recoveryAction === 'retry'
        ? { label: 'Retry', tooltip: 'Retry (Enter)' }
        : sendAction(agentType, isRunning, followUpDefault)
  const canRestore = Boolean(recovery && (!recovery.restored || recovery.collisionPayload))
  // `sendError` clears on the next edit. A recovery outlives edits, so its
  // error shows only while it still offers Restore: once the failed text is
  // back in the composer, editing it makes the error stale.
  const bannerError = sendError ?? (canRestore && !recovery?.dismissed ? recovery?.error ?? null : null)
  const dismissBanner = useCallback(() => {
    setSendError(null)
    if (sessionId && recoveriesRef.current[sessionId]) {
      updateRecoveries((current) => ({ ...current, [sessionId]: { ...current[sessionId], dismissed: true } }))
    }
  }, [sessionId, updateRecoveries])

  useEffect(() => onUserTurnAccepted((acceptedSessionId, origin) => {
    if (pendingOriginsRef.current.has(origin)) acceptedOriginsRef.current.add(origin)
    const acceptedRecovery = recoveriesRef.current[acceptedSessionId]
    if (acceptedRecovery?.origin === origin) {
      desktopTurnAttempts.accept(acceptedSessionId, origin)
      desktopPreparedTurns.accept(acceptedSessionId, origin)
      const draftStore = useDraftStore.getState()
      const storedPills = draftStore.pillsBySession[acceptedSessionId] ?? EMPTY_PILLS
      const storedImages = draftStore.imagesBySession[acceptedSessionId] ?? EMPTY_IMAGES
      const storedPayload: DraftPayload = {
        text: draftStore.drafts[acceptedSessionId] ?? '',
        pills: storedPills,
        images: storedImages,
      }
      if (acceptedRecovery.collisionPayload) {
        discardDetachedDraftPayload(acceptedRecovery.payload, [
          acceptedRecovery.collisionPayload,
          storedPayload,
        ])
        const collisionPayload = acceptedRecovery.collisionPayload
        const restored = draftStore.restoreDraftPayloadIfEmpty(acceptedSessionId, collisionPayload)
        updateRecoveries((current) => ({
          ...current,
          [acceptedSessionId]: {
            sessionId: acceptedSessionId,
            origin: acceptedRecovery.collisionOrigin,
            fingerprint: acceptedRecovery.collisionFingerprint
              ?? desktopComposerFingerprint(collisionPayload),
            payload: collisionPayload,
            error: 'The earlier delivery was accepted. This newer message was not sent.',
            ambiguous: false,
            restored,
          },
        }))
        if (acceptedSessionId === sessionId) {
          if (restored) setValue(collisionPayload.text)
          setSendError('The earlier delivery was accepted. This newer message was not sent.')
        }
        return
      }
      const restoredPayloadIsUnchanged = acceptedRecovery.restored && draftPayloadEquals({
        text: storedPayload.text,
        pills: storedPayload.pills,
        images: storedPayload.images,
      }, acceptedRecovery.payload)
      if (restoredPayloadIsUnchanged) {
        const detached = draftStore.detachDraftPayload(acceptedSessionId)
        discardDetachedDraftPayload(detached ?? acceptedRecovery.payload)
        if (acceptedSessionId === sessionId) {
          setValue('')
          insertedPillsRef.current.clear()
        }
      } else if (!acceptedRecovery.restored) {
        discardDetachedDraftPayload(acceptedRecovery.payload)
      }
      updateRecoveries((current) => {
        const next = { ...current }
        delete next[acceptedSessionId]
        return next
      })
      if (acceptedSessionId === sessionId) setSendError(null)
      return
    }
    if (!sessionId || acceptedSessionId !== sessionId) return
    if (!desktopTurnAttempts.matches(sessionId, composerFingerprint, origin)) return
    desktopTurnAttempts.accept(sessionId, origin)
    desktopPreparedTurns.accept(sessionId, origin)
    clearDraft(sessionId)
    clearPills(sessionId)
    clearImages(sessionId)
    setValue('')
    setSendError(null)
    insertedPillsRef.current.clear()
  }), [sessionId, composerFingerprint, clearDraft, clearPills, clearImages, updateRecoveries])

  useEffect(() => () => {
    for (const pendingRecovery of Object.values(recoveriesRef.current)) {
      if (!pendingRecovery.restored) {
        discardDetachedDraftPayload(
          pendingRecovery.payload,
          pendingRecovery.collisionPayload ? [pendingRecovery.collisionPayload] : [],
        )
      }
      if (pendingRecovery.collisionPayload) {
        discardDetachedDraftPayload(pendingRecovery.collisionPayload)
      }
    }
    recoveriesRef.current = {}
  }, [])

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



  const addImages = useCallback(
    (files: File[]) => {
      if (!sessionId) return
      setSendError(null)
      const imageFiles = files.filter((f) => f.type.startsWith('image/'))
      const valid = imageFiles.filter((f) => f.size <= MAX_IMAGE_SIZE)

      addImagesToSession(
        sessionId,
        valid.map((file) => ({
          id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      )
    },
    [sessionId, addImagesToSession],
  )

  const removeImage = useCallback(
    (id: string) => {
      setSendError(null)
      if (sessionId) removeImageFromSession(sessionId, id)
    },
    [sessionId, removeImageFromSession],
  )

  const handleSend = useCallback(async (delivery: TurnDelivery = 'steer') => {
    const trimmed = value.trim()
    const hasPills = pills.length > 0
    if ((!trimmed && images.length === 0 && !hasPills) || disabled || submittingRef.current) return
    const submittedSessionId = sessionId
    const submission = ++submissionRef.current
    const priorRecovery = recovery?.sessionId === submittedSessionId ? recovery : null
    const action = priorRecovery
      ? desktopComposerRecoveryAction(
          priorRecovery.fingerprint,
          composerFingerprint,
          priorRecovery.ambiguous,
          priorRecovery.restored,
        )
      : 'send'
    if (action === 'send-with-warning' && !(await confirm({
      title: 'The previous delivery could not be confirmed and may already have arrived.',
      body: 'Send this edited message as a new turn?',
      confirmLabel: 'Send',
    }))) return
    if (action === 'send-with-discard-warning' && !(await confirm({
      title: 'A failed message is still available to restore.',
      body: 'Send this newer draft and discard the failed message?',
      confirmLabel: 'Send',
      destructive: true,
    }))) return
    // The dialog is modal, but a global shortcut can still switch chats under it.
    if (sessionIdRef.current !== submittedSessionId) return
    const origin = (action === 'retry' || action === 'retry-safe') && priorRecovery?.origin
      ? priorRecovery.origin
      : submittedSessionId
        ? desktopTurnAttempts.originFor(submittedSessionId, composerFingerprint)
        : undefined
    // Pills are inline `[[pill:id]]` tokens in `value`. Expand each into
    // its full content (path marker + fenced block, terminal block, or
    // chat-message quote) before handing off. Tokens whose pills were
    // already removed get dropped silently.
    const pick = sendToPickRef.current?.sessionId === submittedSessionId ? sendToPickRef.current : null
    const body = pinSendToTarget(serializeBodyWithPills(trimmed, pillsById), pick)
    const pillsMeta: Record<string, { label: string; kind: 'file' | 'terminal' | 'chat-message' }> = {}
    for (const p of pills) {
      if (trimmed.includes(`[[pill:${p.id}]]`)) {
        pillsMeta[p.id] = { label: p.label, kind: p.kind }
      }
    }
    const submittedPayload: DraftPayload = submittedSessionId
      ? useDraftStore.getState().detachDraftPayload(submittedSessionId) ?? {
          text: value,
          pills: [...pills],
          images: [...images],
        }
      : { text: value, pills: [...pills], images: [...images] }
    setValue('')
    insertedPillsRef.current.clear()
    submittingRef.current = true
    setIsSubmitting(true)
    setSendError(null)
    if (origin) pendingOriginsRef.current.add(origin)
    let result: ChatSendResult
    try {
      result = await onSend(
        body,
        // ChatPanel holds a queued message until the running turn ends.
        waitsForIdle(agentType, isRunning, delivery) ? 'queue' : undefined,
        images.length > 0 ? images : undefined,
        {
          origin,
          ...(action === 'send-with-warning' && priorRecovery?.origin
            ? { confirmedRecoveryOrigin: priorRecovery.origin }
            : {}),
          ...(hasPills ? { displayBody: trimmed, pillsMeta } : {}),
        },
      )
    } catch (error) {
      result = { accepted: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (submission === submissionRef.current) {
        submittingRef.current = false
        setIsSubmitting(false)
      }
    }
    if (!result.accepted && origin && acceptedOriginsRef.current.delete(origin)) {
      result = { accepted: true }
    }
    sendToPickRef.current = sendToPickAfterSend(sendToPickRef.current, pick, result.accepted)
    if (origin) {
      pendingOriginsRef.current.delete(origin)
      acceptedOriginsRef.current.delete(origin)
    }
    if (!result.accepted) {
      const restored = submittedSessionId
        ? useDraftStore.getState().restoreDraftPayloadIfEmpty(submittedSessionId, submittedPayload)
        : false
      if (submittedSessionId) {
        const preservePriorRecovery = Boolean(
          priorRecovery?.origin
          && result.recoveryOrigin === priorRecovery.origin
          && recoveriesRef.current[submittedSessionId]?.origin === priorRecovery.origin,
        )
        if (preservePriorRecovery && priorRecovery) {
          if (!restored && priorRecovery.collisionPayload) {
            discardDetachedDraftPayload(priorRecovery.collisionPayload, [submittedPayload])
          }
          updateRecoveries((current) => ({
            ...current,
            [submittedSessionId]: {
              ...priorRecovery,
              error: result.error,
              dismissed: false,
              ...(!restored ? {
                collisionPayload: submittedPayload,
                collisionFingerprint: composerFingerprint,
                collisionOrigin: origin,
              } : {}),
            },
          }))
        } else {
          if (priorRecovery && !priorRecovery.restored
            && priorRecovery.fingerprint !== composerFingerprint) {
            discardDetachedDraftPayload(priorRecovery.payload, [submittedPayload])
          }
          if (priorRecovery?.collisionPayload) {
            discardDetachedDraftPayload(priorRecovery.collisionPayload, [submittedPayload])
          }
          updateRecoveries((current) => ({
            ...current,
            [submittedSessionId]: {
              sessionId: submittedSessionId,
              origin,
              fingerprint: composerFingerprint,
              payload: submittedPayload,
              error: result.error,
              ambiguous: result.delivery === 'ambiguous',
              restored,
            },
          }))
        }
      }
      if (sessionIdRef.current === submittedSessionId && submission === submissionRef.current) {
        if (restored) setValue(submittedPayload.text)
        setSendError(result.error)
      }
      return
    }
    if (submittedSessionId) {
      if (origin) desktopTurnAttempts.accept(submittedSessionId, origin)
      if (priorRecovery && !priorRecovery.restored
        && priorRecovery.fingerprint !== composerFingerprint) {
        discardDetachedDraftPayload(priorRecovery.payload, [submittedPayload])
      }
      if (priorRecovery?.collisionPayload) {
        discardDetachedDraftPayload(priorRecovery.collisionPayload, [submittedPayload])
      }
      discardDetachedDraftPayload(submittedPayload)
    }
    if (submittedSessionId) {
      updateRecoveries((current) => {
        if (!current[submittedSessionId]) return current
        const next = { ...current }
        delete next[submittedSessionId]
        return next
      })
    }
    if (sessionIdRef.current !== submittedSessionId || submission !== submissionRef.current) return
    insertedPillsRef.current.clear()
  }, [value, pills, pillsById, images, disabled, onSend, sessionId, composerFingerprint, recovery, updateRecoveries, agentType, isRunning])

  const restoreRecovery = useCallback(async () => {
    if (!sessionId || !recovery || (recovery.restored && !recovery.collisionPayload)) return
    const draftStore = useDraftStore.getState()
    const hasNewerDraft = Boolean(
      draftStore.drafts[sessionId]
      || draftStore.pillsBySession[sessionId]?.length
      || draftStore.imagesBySession[sessionId]?.length,
    )
    if (hasNewerDraft && !(await confirm({ title: 'Replace the current draft with the failed message?', confirmLabel: 'Replace', destructive: true }))) return
    // A global shortcut can switch chats while the dialog is open.
    if (sessionIdRef.current !== sessionId) return
    const payload = recovery.collisionPayload ?? recovery.payload
    draftStore.replaceDraftPayload(sessionId, payload)
    setValue(payload.text)
    insertedPillsRef.current.clear()
    setSendError(recovery.error)
    updateRecoveries((current) => ({
      ...current,
      [sessionId]: recovery.collisionPayload
        ? {
            ...recovery,
            collisionPayload: undefined,
            collisionFingerprint: undefined,
            collisionOrigin: undefined,
          }
        : { ...recovery, restored: true },
    }))
    richRef.current?.focus()
  }, [recovery, sessionId, updateRecoveries])

  // ─── Slash command handling ─────────────────────────────────
  const dismissSlash = useCallback(() => {
    setSlashQuery(null)
    slashRangeRef.current = null
  }, [])

  // ─── @-mention handling ─────────────────────────────────────
  const dismissAt = useCallback(() => {
    setAtQuery(null)
    atRangeRef.current = null
  }, [])

  // Resolve the agent's real cwd (worktree over parent checkout) - scopes the
  // at-menu file listing AND the BranchPicker, so a worktree session's branch
  // switch can't flip HEAD in the shared parent repo.
  const sessionsForRepo = useAgentStore((s) => s.sessions)
  // Held in a ref so the memoized orphan-heal callback can reach it without
  // depending on the whole relocation closure.
  const swapWorktreePointerRef = useRef<
    ((cwd: string, branch: string, reason?: RelocationReason, successNotice?: string, noticeId?: string) => void) | null
  >(null)

  /**
   * The ONE relocation entry point: the drift Follow button and the branch
   * picker both come through here.
   *
   * This used to write the pointer and the store directly, which is why
   * Follow moved the branch chip and left the agent running in the old
   * directory. It is now a request to the backend that OWNS the path, and the
   * store is updated only from what that backend actually committed.
   */
  const swapWorktreePointer = (
    newCwd: string,
    branch: string,
    reason: RelocationReason = 'branch-picker',
    successNotice?: string,
    noticeId?: string,
  ) => {
    if (!sessionId) return
    const session = useAgentStore.getState().sessions.find((x) => x.id === sessionId)
    const request = {
      threadId: session?.conversationId ?? sessionId,
      expectedRevision: session?.executionRootRevision ?? 0,
      targetPath: newCwd,
      targetBranch: branch,
      machineId: session?.machineId ?? 'local',
      reason,
    }
    void window.api.provider
      .relocateExecutionRoot(request)
      .then((result) => {
        const view = describeRelocationOutcome(result)
        if (view.applyRoot) useAgentStore.getState().applyExecutionRoot(sessionId, view.applyRoot)
        // Our revision was wrong and the refusal carried the right one.
        // Adopting it is what lets a retry succeed instead of failing
        // identically forever against the same stale number.
        if (view.syncRevision !== null) {
          useAgentStore.getState().syncExecutionRootRevision(sessionId, view.syncRevision)
        }
        if (view.clearSuggestion && !view.applyRoot) {
          useAgentStore.getState().setDriftSuggestion(sessionId, null)
        }
        const notice = view.applyRoot ? successNotice ?? view.notice : view.notice
        if (!notice) return
        useAgentStore.getState().appendMessage(sessionId, {
          // A caller-supplied id is deterministic, so `appendMessage`'s dedupe
          // absorbs a repeated heal instead of stacking identical notices.
          id: noticeId ?? `wt_relocate_${Date.now()}`,
          role: 'system',
          content: notice,
          timestamp: Date.now(),
        })
      })
      .catch((err: unknown) => log.warn('relocate execution root failed:', err))
  }

  swapWorktreePointerRef.current = swapWorktreePointer

  swapWorktreePointerRef.current = swapWorktreePointer

  const draftOptions = useAgentStore((st) => st.sessions.find((x) => x.id === sessionId)?.draft)
  const { repoRoot, driftSuggestion, orphanedPath, orphanedBranch } = useMemo(() => {
    const s = sessionsForRepo.find((sess) => sess.id === sessionId)
    return {
      repoRoot: s?.worktreePath ?? s?.projectPath ?? null,
      driftSuggestion: s?.driftSuggestion ?? null,
      // Only a WORKTREE pointer can be healed by falling back to the clone;
      // a missing projectPath has nowhere to fall back to. Strings, not an
      // object: this feeds `onCwdMissing`, and a fresh object per store commit
      // re-ran BranchPicker's effect - a git spawn per frame while streaming.
      orphanedPath: s?.worktreePath ?? null,
      orphanedBranch: s?.worktreeBranch ?? null,
    }
  }, [sessionsForRepo, sessionId])

  // The session's worktree was deleted out from under it (agents clean up
  // after merges): reset the pointer to the main clone so the chip, IDE
  // pane, terminals, and diff review all recover, and say so in the chat.
  /** Orphaned paths a heal has already been started for, so the repeat calls
   *  this gets (two panes on one session, two mount effects in dev) fire one
   *  relocation rather than one per call. */
  const healingRef = useRef<Set<string>>(new Set())

  /**
   * The recorded worktree is gone. Move back to the parent checkout.
   *
   * This used to write the store and the legacy DB setter directly, which
   * reintroduced the exact bug this feature exists to fix: a provider left
   * running inside the DELETED directory while the chip said otherwise. It
   * also skipped the revision bump, so a relocation already in flight could
   * commit over a pointer that had changed without the revision moving.
   */
  const healOrphanedWorktree = useCallback(() => {
    if (!sessionId || !orphanedPath) return
    if (healingRef.current.has(orphanedPath)) return
    healingRef.current.add(orphanedPath)
    const projectPath = useAgentStore.getState().sessions.find((x) => x.id === sessionId)?.projectPath
    if (!projectPath) {
      log.warn('cannot heal an orphaned worktree without a project path', orphanedPath)
      return
    }
    // The branch is advisory here; the backend resolves the real one from git.
    swapWorktreePointerRef.current?.(
      projectPath,
      '',
      'orphan-heal',
      `Worktree ${orphanedBranch ?? orphanedPath} no longer exists - switched back to the main checkout.`,
      `wt_orphan_${orphanedPath}`,
    )
    log.info('healing orphaned worktree pointer', orphanedPath)
  }, [sessionId, orphanedPath, orphanedBranch])

  const followDrift = () => {
    if (driftSuggestion) swapWorktreePointer(driftSuggestion.worktreePath, driftSuggestion.branch, 'drift-follow')
  }

  const driftView = driftSuggestion
    ? followSuggestionView(driftSuggestion.followSuggestions ?? 'auto', driftSuggestion.workedWorktrees ?? 0)
    : null

  /** "Not in this chat" / "Turn back on": saved with the conversation on its backend. */
  const setFollowSuggestions = (mode: FollowSuggestionMode) => {
    if (!sessionId) return
    useAgentStore.getState().setFollowNoticeDismissed(sessionId, false)
    if (driftSuggestion) {
      useAgentStore.getState().setDriftSuggestion(sessionId, { ...driftSuggestion, followSuggestions: mode })
    }
    window.api.app.setConversationFollowSuggestions(sessionId, mode).catch((err: unknown) => {
      log.warn('could not save the Follow suggestion setting', err)
    })
  }

  /**
   * The chip's x only closes this suggestion; the "off" notice's x is saved, so
   * it stays closed. A failed save still closes it here: an older backend has no
   * such channel, and a notice that cannot be closed is worse than one that
   * comes back.
   */
  const dismissDrift = () => {
    if (!sessionId) return
    useAgentStore.getState().setDriftSuggestion(sessionId, null)
    if (driftView?.kind !== 'off') return
    useAgentStore.getState().setFollowNoticeDismissed(sessionId, true)
    window.api.app.dismissConversationFollowNotice(sessionId).then(
      ({ ok }) => { if (!ok) log.warn('no conversation row to save the dismissed Follow notice on', sessionId) },
      (err: unknown) => log.warn('could not save the dismissed Follow notice', err),
    )
  }

  // Lazy-load the file list the first time the user opens `@`. Cached on
  // a per-mount ref so reopening this chat refreshes the listing.
  const ensureAtFiles = useCallback(async () => {
    if (!repoRoot) return
    const cached = atFilesCacheRef.current
    if (cached && cached.repoRoot === repoRoot) {
      setAtFiles(cached.files)
      return
    }
    setAtLoading(true)
    try {
      const res = await window.api?.files?.listAll?.(repoRoot)
      const list = res?.files ?? []
      atFilesCacheRef.current = { repoRoot, files: list }
      setAtFiles(list)
    } finally {
      setAtLoading(false)
    }
  }, [repoRoot])

  /** Commit a picked chat title as the `/send-to` target, colon included. */
  const runSendToPick = useCallback((label: string) => {
    const range = sendToRangeRef.current
    const picked = sendToItems.find((i) => i.label === label)
    setSendToQuery(null)
    if (!range || !picked) return
    // Two chats can share a title, so a title that would not resolve back to
    // this exact chat goes in as `#<id>` instead.
    const target = sendToPickInsertion(picked.id, useAgentStore.getState().sessions, sessionId ?? '')
    if (sessionId) sendToPickRef.current = { sessionId, id: picked.id, title: target }
    richRef.current?.replaceRange(range.start, range.end, `${target}: `)
    requestAnimationFrame(() => richRef.current?.focus())
  }, [sendToItems, sessionId])

  const runAtMention = useCallback((path: string) => {
    const range = atRangeRef.current
    if (!range || !sessionId) { dismissAt(); return }

    // Strip the `@query` text - the chip carries the path now, and the
    // serialized message body will expand `[[pill:id]]` into `@<path>` on
    // Send (see DraftPill.content below).
    richRef.current?.replaceRange(range.start, range.end, '')
    dismissAt()

    const fileName = path.split('/').pop() ?? path
    const pillId = `at_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    useDraftStore.getState().addPill(sessionId, {
      id: pillId,
      kind: 'file',
      label: fileName,
      // Send-time content is just the `@<path>` marker - Claude SDK
      // resolves it natively; Codex / OpenCode treat it as a relative
      // path they can Read on demand.
      content: `@${path}`,
    })
    window.dispatchEvent(new CustomEvent('sb-pill-added', { detail: { sessionId, pillId } }))
    requestAnimationFrame(() => richRef.current?.focus())
  }, [sessionId, dismissAt])

  // Editor → host change pipe. RichChatTextarea calls this with the
  // serialized plain-text-with-pill-tokens body whenever Lexical's editor
  // state mutates. We mirror it into local `value`, persist to the draft
  // store (per-session), and re-run slash trigger detection so the menu
  // tracks live typing.
  //
  // Stable identity matters: this callback is a prop on RichChatTextarea,
  // and unstable props would make the editor's plugins re-register every
  // render - that's exactly what caused the original infinite-update loop.
  const handleEditorChange = useCallback((next: string, caretNow: number | null = null) => {
    setSendError(null)
    setValue(next)
    if (sessionId) setDraft(sessionId, next)
    // Prefer the caret reported WITH this change: the `caret` state is one
    // Lexical update behind here, so after a click into an empty composer it
    // still reads 0 and a lone `/` never opened the menu. Fall back to
    // end-of-string when the editor could not resolve a selection.
    const cur = caretNow ?? caret ?? next.length
    const trigger = detectSlashTrigger(next, cur)
    if (trigger) {
      setSlashQuery(trigger.query)
      setSlashActiveIdx(0)
      slashRangeRef.current = { start: trigger.rangeStart, end: trigger.rangeEnd }
      // Refresh agent skills the moment the user opens `/` - handles the
      // case where `system/init` arrives after mount.
      if (agentSkills.length === 0) fetchSkills()
    } else if (slashQuery !== null) {
      dismissSlash()
    }

    // @-mention detection - independent of slash; the two triggers can't
    // both fire on the same token.
    const atTrigger = detectAtTrigger(next, cur)
    if (atTrigger) {
      // Only reset when query text changes - arrow key caret moves leave
      // query identical and must not overwrite handleEditorKeyDown's bump.
      if (atTrigger.query !== atQuery) {
        setAtQuery(atTrigger.query)
        setAtActiveIdx(0)
      }
      atRangeRef.current = { start: atTrigger.rangeStart, end: atTrigger.rangeEnd }
      // Kick off file listing on first open. ensureAtFiles is a no-op if
      // the cache is already warm.
      void ensureAtFiles()
    } else if (atQuery !== null) {
      dismissAt()
    }

    const sendToTrigger = detectSendToTrigger(next, cur ?? next.length)
    if (sendToTrigger) {
      if (sendToTrigger.query !== sendToQuery) {
        setSendToQuery(sendToTrigger.query)
        setSendToActiveIdx(0)
      }
      sendToRangeRef.current = { start: sendToTrigger.start, end: sendToTrigger.end }
    } else if (sendToQuery !== null) {
      setSendToQuery(null)
    }
  }, [sessionId, setDraft, caret, slashQuery, dismissSlash, agentSkills.length, fetchSkills, atQuery, dismissAt, ensureAtFiles, sendToQuery])

  const handleEditorCaret = useCallback((c: number | null) => {
    setCaret(c)
  }, [])

  const runSlashCommand = useCallback((cmd: SlashCommand) => {
    const range = slashRangeRef.current
    if (!range) { dismissSlash(); return }

    const source = cmd.source ?? 'switchboard'

    // Agent-source commands (Claude/Codex skills): don't fire a local
    // action - instead, replace the partial `/que` the user typed with
    // the canonical `/<name> ` and let them fill in any args before
    // hitting Enter. The agent SDK/CLI parses the leading slash from
    // the sent prompt and runs the corresponding handler.
    if (source !== 'switchboard' || cmd.takesArgs) {
      const inserted = commandInsertion(cmd)
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
      // An open @-mention picker claims or passes every key before the slash menu is consulted.
      const slashMatches = slashQuery === null || atQuery !== null ? null : filterSlashCommands(slashQuery, mergedCommands)
      const action = resolvePickerKeydown(e, {
        sendToMatches: sendToQuery === null ? null : sendToMatches.length,
        atMatches: atQuery === null ? null : atMatches.length,
        slashMatches: slashMatches?.length ?? null,
      })
      if (!action) return
      e.preventDefault()
      if ('stopPropagation' in action) e.stopPropagation()
      if (action.menu === 'send-to') {
        if (action.op === 'move') {
          const delta = action.delta
          setSendToActiveIdx((i) => (i + delta + sendToMatches.length) % sendToMatches.length)
        } else if (action.op === 'pick') {
          runSendToPick(sendToMatches[sendToActiveIdx] ?? sendToMatches[0])
        } else {
          setSendToQuery(null)
        }
      } else if (action.menu === 'at') {
        if (action.op === 'next') setAtActiveIdx((i) => i + 1)
        else if (action.op === 'prev') setAtActiveIdx((i) => Math.max(0, i - 1))
        else if (action.op === 'dismiss') dismissAt()
        else {
          const pick = atMatches[atActiveIdx] ?? atMatches[0]
          if (pick) runAtMention(pick)
        }
      } else {
        const matches = slashMatches ?? []
        const count = Math.max(matches.length, 1)
        if (action.op === 'next') setSlashActiveIdx((i) => (i + 1) % count)
        else if (action.op === 'prev') setSlashActiveIdx((i) => (i - 1 + count) % count)
        else if (action.op === 'dismiss') dismissSlash()
        else if (matches.length > 0) runSlashCommand(matches[slashActiveIdx] ?? matches[0])
      }
    },
    [slashQuery, slashActiveIdx, runSlashCommand, dismissSlash, mergedCommands, atQuery, atMatches, atActiveIdx, dismissAt, runAtMention, sendToQuery, sendToMatches, sendToActiveIdx, runSendToPick],
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
      className="chat-composer"
      data-runtime-mode={runtimeMode}
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

      {bannerError && (
        <div
          data-composer-send-error
          data-composer-recovery={recovery ? '' : undefined}
          role="alert"
          style={{
            position: 'relative',
            marginBottom: '6px',
            padding: '7px 9px',
            border: `1px solid color-mix(in srgb, ${composerErrorColor} 45%, transparent)`,
            borderRadius: '6px',
            background: `color-mix(in srgb, ${composerErrorColor} 10%, transparent)`,
            color: composerErrorColor,
            fontSize: '12px',
            lineHeight: 1.4,
          }}
        >
          <button
            type="button"
            className="composer-banner-dismiss"
            aria-label="Dismiss"
            onClick={dismissBanner}
          >
            x
          </button>
          <div style={{ paddingRight: '18px' }}>{bannerError}</div>
          {canRestore && (
            <button
              type="button"
              className="composer-recovery-action"
              onClick={restoreRecovery}
            >
              Restore
            </button>
          )}
          {bannerError === SEND_TO_EMPTY_MESSAGE && (
            <button
              type="button"
              className="composer-recovery-action"
              onClick={() => {
                richRef.current?.replaceRange(value.length, value.length, '')
                richRef.current?.focus()
              }}
            >
              Write the message
            </button>
          )}
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
        accept={USER_MESSAGE_IMAGE_TYPES.join(',')}
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) addImages(files)
          if (filePickerRef.current) filePickerRef.current.value = ''
          richRef.current?.focus()
        }}
        style={{ display: 'none' }}
      />

      {/* Before the send: a retired pick would otherwise fall back silently. */}
      {pickUnavailable && (
        <div
          data-model-unavailable-warning
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
            margin: '0 0 6px',
            padding: '7px 9px',
            fontSize: '11px',
            lineHeight: 1.45,
            color: 'var(--text-secondary)',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--warning)',
            borderRadius: 'var(--radius)',
          }}
        >
          <span aria-hidden style={{ color: 'var(--warning)', fontWeight: 600 }}>!</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            {model} is not available on this account any more. Your next message uses the default model, or pick another one.
          </span>
          {onModelChange && (
            <button
              type="button"
              onClick={() => onModelChange('')}
              style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '11px', whiteSpace: 'nowrap' }}
            >
              Use default
            </button>
          )}
        </div>
      )}

      {/* Shown before the send: the plan windows read normal in this case. */}
      {spendBlock && (
        <div
          data-spend-block-warning
          style={{
            display: 'flex',
            gap: '8px',
            alignItems: 'flex-start',
            margin: '0 0 6px',
            padding: '7px 9px',
            fontSize: '11px',
            lineHeight: 1.45,
            color: 'var(--text-secondary)',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--warning)',
            borderRadius: 'var(--radius)',
          }}
        >
          <span aria-hidden style={{ color: 'var(--warning)', fontWeight: 600 }}>!</span>
          <span style={{ flex: 1, minWidth: 0 }}>{describeSpendBlock(spendBlock)}</span>
        </div>
      )}

      {/* Rich text input - Lexical-backed contenteditable that renders
          pill chips inline at the caret position (Cursor-style). The host
          sees a plain string body with `[[pill:id]]` tokens; pillsById
          maps tokens to chip metadata + serialized content. */}
      <div
        style={{ position: 'relative', display: 'flex' }}
        onKeyDownCapture={handleEditorKeyDown}
      >
        {/* Slash command popover - positioned above the editor */}
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
        {/* `/send-to` target picker - reuses the at-mention menu below. */}
        {sendToQuery !== null && sendToMatches.length > 0 && (
          <AtMentionMenu
            query={sendToQuery}
            heading="Chats"
            matches={sendToMatches}
            onSelect={runSendToPick}
            onDismiss={() => setSendToQuery(null)}
            activeIndex={sendToActiveIdx}
            onActiveIndexChange={setSendToActiveIdx}
          />
        )}
        {/* @-mention popover - same anchor; never simultaneously open. */}
        {atQuery !== null && (
          <AtMentionMenu
            query={atQuery}
            matches={atMatches}
            loading={atLoading}
            onSelect={runAtMention}
            onDismiss={dismissAt}
            activeIndex={atActiveIdx}
            onActiveIndexChange={(i) => setAtActiveIdx(i)}
          />
        )}
        {/* IMPORTANT: this wrapper must NOT use display:flex - Lexical's
            ContentEditable warns that flex parents cause Chrome focusing
            bugs (caret hiding, click-outside selection drift). Use block
            layout and let the inner ContentEditable size itself. */}
        <div
          data-chat-input-textarea
          style={{ display: 'block', position: 'relative', flex: 1, minWidth: 0 }}
          onBlur={() => { setTimeout(() => { dismissSlash(); dismissAt() }, 120) }}
        >
          <RichChatTextarea
            ref={richRef}
            value={value}
            onChange={handleEditorChange}
            onCaretChange={handleEditorCaret}
            onEnter={({ altKey }) => { void handleSend(followUpDelivery(followUpDefault, altKey)) }}
            onPasteFiles={addImages}
            pillsById={pillsById}
            placeholder={placeholder}
            disabled={disabled}
            trailingInset={composerActionsInset(showStop)}
          />
          <div
            data-composer-actions
            style={{
              position: 'absolute',
              right: COMPOSER_ACTION_INSET,
              bottom: COMPOSER_ACTION_INSET,
              display: 'flex',
              gap: COMPOSER_ACTION_GAP,
            }}
          >
            {showStop && (
              <Button
                variant="destructive-outline"
                size="icon-round"
                onClick={onInterrupt}
                aria-label="Stop"
                title="Stop the current turn (⌘⌫)"
              >
                <StopSquareIcon />
              </Button>
            )}
            <Button
              size="icon-round"
              onClick={() => { void handleSend(followUpDefault) }}
              disabled={disabled || isSubmitting || (!value.trim() && images.length === 0 && pills.length === 0)}
              aria-label={sendButton.label}
              title={sendButton.tooltip}
            >
              <ArrowUpIcon />
            </Button>
          </div>
        </div>
      </div>

      {/* Footer bar: agent selector + mode toggle + hints. Wraps instead of
          overflowing on a narrow pane; the policy drops the hint and shortens
          the mode labels first. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '8px',
          rowGap: '4px',
          marginTop: '6px',
          fontSize: '11px',
        }}
      >
        {/* Unified provider/instance/model picker - single drop-up popover
            consolidating what used to be three separate footer controls. */}
        {onModelChange && onInstanceChange && (
          <UnifiedProviderPicker
            agentType={agentType}
            onAgentTypeChange={onAgentTypeChange}
            canChangeAgent={canChangeAgent}
            instanceId={instanceId}
            onInstanceChange={onInstanceChange}
            model={model ?? ''}
            onModelChange={onModelChange}
            dynamicModels={dynamicModels}
            resolvedModel={resolvedModel}
          />
        )}

        {/* Variant chips (OpenCode ACP only) - surfaced when the agent reports
            `availableVariants` for the currently selected model. Clicking a
            chip rewrites the model id to `<base>/<variant>` (or strips the
            variant if "base" is selected). */}
        {agentType === 'opencode' && onModelChange && (
          <VariantChips sessionId={sessionId ?? null} model={model ?? ''} onChange={onModelChange} />
        )}

        {/* Reasoning-effort selector - Codex-only, mirrors the desktop app's
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

        {driftSuggestion && driftView && driftView.kind !== 'hidden' && (
          <span
            data-drift-banner
            data-drift-view={driftView.kind}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
              whiteSpace: 'nowrap',
              maxWidth: '100%',
              fontSize: 11,
              color: driftView.kind === 'off' ? 'var(--text-muted)' : 'var(--text-secondary)',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '3px 8px',
            }}
          >
            {driftView.kind === 'chip' ? (
              <>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  Agent is working in <strong>{driftSuggestion.branch}</strong>
                </span>
                <button
                  type="button"
                  onClick={followDrift}
                  style={{ cursor: 'pointer', border: 'none', background: 'var(--accent, #4a7dff)', color: '#fff', borderRadius: 3, padding: '2px 8px', fontSize: 11 }}
                >
                  Follow
                </button>
                <button
                  type="button"
                  title="Stop suggesting a branch to follow in this chat"
                  onClick={() => setFollowSuggestions('muted')}
                  style={driftLinkStyle}
                >
                  Not in this chat
                </button>
              </>
            ) : (
              <>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{followOffNotice(driftView)}</span>
                <button type="button" onClick={() => setFollowSuggestions('on')} style={driftLinkStyle}>
                  Turn back on
                </button>
              </>
            )}
            <button
              type="button"
              title="Dismiss"
              aria-label="Dismiss"
              onClick={dismissDrift}
              style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12 }}
            >
              ×
            </button>
          </span>
        )}

        {/* Per-thread branch picker. On `swap-cwd` (picked branch already
            has a worktree elsewhere) we update the store + persist to the
            conversations row; the running adapter keeps its old cwd until
            session restart, then picks up the new pointer. */}
        {draftOptions && sessionId ? (
          <DraftWorkspaceChips sessionId={sessionId} cwd={repoRoot} draft={draftOptions} />
        ) : (
          <BranchPickerTrigger
            cwd={repoRoot}
            followSessionId={sessionId ?? undefined}
            onTurnFollowBackOn={() => setFollowSuggestions('on')}
            onSwapWorktree={swapWorktreePointer}
            onCwdMissing={healOrphanedWorktree}
          />
        )}

        {/* Runtime mode selector (per-session) */}
        {runtimeMode && onRuntimeModeChange && (
          <select
            className="runtime-mode-select"
            data-runtime-mode={runtimeMode}
            title={RUNTIME_MODE_OPTIONS.find((m) => m.value === runtimeMode)?.detail}
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
            {RUNTIME_MODE_OPTIONS.map((m) => (
              <option key={m.value} value={m.value} title={m.detail}>{m.label}</option>
            ))}
          </select>
        )}

        {/* Context meter (24px), last so it sits centred under the Send button,
            and marginLeft auto keeps it right-aligned when a narrow footer
            wraps it onto a row of its own. flexShrink 0: this is the one
            footer item that must never be squeezed under the pane edge. */}
        {contextUsage && (
          <span
            style={{
              flexShrink: 0,
              display: 'inline-flex',
              marginLeft: 'auto',
              marginRight: `calc(${COMPOSER_ACTION_INSET} + (${COMPOSER_ACTION_SIZE} - 24px) / 2)`,
            }}
          >
            <ContextWindowMeter usage={contextUsage} />
          </span>
        )}
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
                  ]).catch((err) => {
                    log.warn('failed to copy preview image to clipboard', err)
                  })
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

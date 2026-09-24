/**
 * One chat thread: inverted feed over the chat store's FeedItems, a status
 * header (dot + context meter + cost), and a pinned composer with a runtime
 * mode picker. History seeds from LOAD_SESSION_BY_ID; live events arrive via
 * the connection's onEvent -> useChatStore.ingest wiring.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { useHeaderHeight } from '@react-navigation/elements'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { ProviderKind, RuntimeMode } from '@shared/provider-events'
import { shouldOfferCompaction } from '@shared/compaction-offer'
import { canSteer, type QueuedTurnSummary } from '@shared/turn-delivery'
import { providerKindFor, type ProviderInstance, type ProviderSkill } from '@shared/types'
import type { ChatMessage } from '@shared/types'
import type { ForkConversationRequest, ForkLineageMetadata } from '@shared/conversation-fork'
import type { ModelOption } from '@shared/models'
import { formatTokens, contextPercent } from '@shared/format'
import { echoMessageId } from '@shared/provider-events'
import { VIEWING_RENEW_MS } from '@shared/push-policy'
import { generateTitle } from '@shared/auto-title'
import { createLogger } from '@shared/logger'
import type { RootStackParamList } from '../../App'
import { colors } from '../theme'
import { getClient, onAppForeground, useConnectionsStore } from '../stores/connections'
import { useChatStore, threadKey, emptyThread, type FeedItem } from '../stores/chat'
import { missingPendingFeedItems } from '../lib/pendingRequestRecovery'
import {
  completeRejectedEdit,
  drain,
  enqueue,
  openRejectedForEdit,
  queuedFor,
  useOutboxStore,
  abandonAmbiguous,
} from '../stores/outbox'
import { usePrefsStore } from '../stores/prefs'
import { usePushStore } from '../stores/push'
import { ModePicker } from '../components/ModePicker'
import { ProfilePicker } from '../components/ProfilePicker'
import { SlashMenu } from '../components/SlashMenu'
import { allCommands, detectSlash, filterCommands, type SlashCommand } from '../lib/slash'
import { profilesFor } from '../lib/profiles'
import { rotateWithinAgent } from '../lib/profileRotation'
import { buildTurn } from '../lib/turnSubmit'
import { resolvedAmbiguousBubbleAction } from '../lib/outboxModel'
import { keyboardAvoidance } from '../lib/keyboardAvoidance'
import { historyToItems } from '../lib/threadHistory'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ThreadHeaderStatus } from '../components/ThreadHeaderStatus'
import { VoiceNoteBar } from '../components/MicButton'
import { SendMicButton } from '../components/SendMicButton'
import { SyntheticRow } from '../components/SyntheticRow'
import { useDictation, type VoiceNote } from '../hooks/useDictation'
import { useEdgeSwipeBack } from '../hooks/useEdgeSwipeBack'
import { AttachButton, AttachmentStrip, type Attachment } from '../components/ImageAttachments'
import { outboxPresentation, recoverRejectedDraft } from '../lib/outboxModel'
import { forgetMobileForkRequest, mobileForkRequest } from '../lib/conversationFork'
import { ApprovalItem, FileEditItem, HeldTurnBar, PlanItem, QuestionItem, TextItem, ToolItem } from './ThreadFeedItems'
import { styles } from './ThreadScreen.styles'
import { heldTurnActions, heldTurnFor, queueToggle } from '../lib/heldTurns'

/** How much of a long thread to pull on open. The feed says when it is a window. */
const HISTORY_WINDOW = 250

const log = createLogger('screen:thread')

type Props = NativeStackScreenProps<RootStackParamList, 'Thread'>

const IMPLEMENT_MESSAGE = 'Implement the plan you proposed.'

/** KeyboardAvoidingView cannot take an Animated.Value in its style unwrapped. */
const AnimatedKeyboardAvoidingView = Animated.createAnimatedComponent(KeyboardAvoidingView)

export default function ThreadScreen({ route, navigation }: Props) {
  const { connectionId, threadId, projectPath, worktreePath, isNew } = route.params
  const key = threadKey(connectionId, threadId)
  const thread = useChatStore((s) => s.threads[key]) ?? emptyThread()
  const backendLabel =
    useConnectionsStore((s) => s.configs.find((c) => c.id === connectionId)?.label) ?? 'backend'

  // Real header height: the keyboard offset must clear it, and hardcoding 96
  // was wrong on Android where it was 0.
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  const [draft, setDraft] = useState('')
  // True when the next send should do the opposite of the device's follow-up
  // default (steer instead of queue, or queue instead of steer).
  const [flipNext, setFlipNext] = useState(false)
  const followUpDefault = usePrefsStore((s) => s.followUpDefault)
  const toggle = queueToggle(followUpDefault, flipNext)
  // The focus-effect cleanup closes over its first render, so it reads the
  // latest text from a ref rather than a stale `draft`.
  const draftRef = useRef('')
  draftRef.current = draft
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const composerRef = useRef<TextInput>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState('')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  /** Full-screen preview of a sent image, since a 180pt thumbnail hides detail. */
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [skills, setSkills] = useState<ProviderSkill[]>([])
  const swipeBack = useEdgeSwipeBack(useCallback(() => navigation.goBack(), [navigation]))
  // Which provider drives this thread. Only OpenCode needs the client-side
  // queue below; Claude queues in its adapter and Codex steers into the turn.
  const [provider, setProvider] = useState<ProviderKind>('claude')
  const [instances, setInstances] = useState<ProviderInstance[]>([])
  const [instanceId, setInstanceId] = useState<string | undefined>(undefined)
  const [profilePickerOpen, setProfilePickerOpen] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [forkMetadata, setForkMetadata] = useState<ForkLineageMetadata | null>(null)
  const forkMessagesRef = useRef(new Map<string, ChatMessage>())

  // The accessory subscribes to the store itself, so this runs once per thread.
  useEffect(() => {
    navigation.setOptions({
      headerRight: () => <ThreadHeaderStatus threadKey={key} onPress={() => setStatusOpen((v) => !v)} />,
    })
  }, [navigation, key])

  // useFocusEffect (not useEffect) so activeKey tracks push/pop: pushing
  // another screen on top blurs this one and re-focusing restores it.
  useFocusEffect(
    useCallback(() => {
      useChatStore.getState().setActive(key)
      usePushStore.getState().reportViewing(connectionId, threadId)
      // The claim is a lease on the backend, so it has to be renewed while the
      // screen stays open. Without this a thread left open for a few minutes
      // starts pushing notifications about itself.
      const report = (): void => usePushStore.getState().reportViewing(connectionId, threadId)
      const renew = setInterval(report, VIEWING_RENEW_MS)
      // The interval does not run while the app is suspended, so a long
      // background leaves the lease expired and the user gets notified about
      // the thread already on their screen.
      const unsubForeground = onAppForeground(report)
      // Read state is the backend's, so the Mac's badge clears from here too.
      getClient(connectionId)
        ?.markRead(threadId)
        .catch((err) => log.warn('markRead failed', err))
      return () => {
        clearInterval(renew)
        unsubForeground()
        useChatStore.getState().setActive(null)
        usePushStore.getState().reportViewing(connectionId, null)
        // On the way out, not per keystroke - persist writes to AsyncStorage.
        usePrefsStore.getState().rememberDraft(key, draftRef.current)
      }
    }, [key, connectionId, threadId]),
  )

  const reportError = useCallback(
    (err: unknown) => {
      useChatStore.getState().ingest(connectionId, {
        type: 'error',
        threadId,
        message: err instanceof Error ? err.message : String(err),
      })
    },
    [connectionId, threadId],
  )

  // Seed history + attach a live provider session for existing threads. New
  // threads were already started by NewSessionScreen (startSession is
  // idempotent server-side, this just avoids a redundant round-trip). The ref
  // guards double-run within one mount; a fresh mount re-attaches harmlessly.
  const startedKeyRef = useRef<string | null>(null)
  // A re-seed request has to defeat the once-per-mount guard, or a feed that
  // lost events while the phone was away stays holed until the app restarts.
  const staleGeneration = useChatStore((s) => s.staleGeneration)
  const mountGenerationRef = useRef(staleGeneration)
  // True once this backend has reported that it could not replay what we
  // missed, so the cached feed was dropped.
  const invalidated = staleGeneration !== mountGenerationRef.current
  useEffect(() => {
    startedKeyRef.current = null
  }, [staleGeneration])
  useEffect(() => {
    // `isNew` skips the seed because NewSessionScreen already started the
    // session, but it is a route param that never changes. Honouring it after
    // an invalidation left a phone-started thread wiped and never refilled,
    // for the life of the process, including across navigating away and back.
    // A cached feed counts as unseeded: it is a snapshot from a previous run
    // and everything the backend did since is missing from it.
    const stale = invalidated || thread.cached === true
    if ((isNew && !stale) || startedKeyRef.current === key) return
    startedKeyRef.current = key
    const client = getClient(connectionId)
    if (!client) {
      startedKeyRef.current = null
      return
    }
    void (async () => {
      let provider: ProviderKind = 'claude'
      let loadedMeta: Awaited<ReturnType<typeof client.loadSessionById>>['meta'] = null
      try {
        const loaded = await client.loadSessionById(threadId, HISTORY_WINDOW)
        loadedMeta = loaded.meta
        setForkMetadata(loaded.meta?.forkMetadata ?? null)
        forkMessagesRef.current = new Map(loaded.messages.flatMap((message) => {
          if (message.role === 'user' || (message.role === 'assistant' && message.content.trim())) {
            return [[`h-${message.id}`, message] as const]
          }
          return []
        }))
        provider = providerKindFor(loaded.meta?.agentType)
        setProvider(provider)
        const store = useChatStore.getState()
        const current = store.threads[key]
        const replaceable = (current?.items.length ?? 0) === 0 || current?.cached === true
        if (replaceable && loaded.messages.length > 0) {
          const seeded = historyToItems(loaded.messages)
          // A thread silently starting mid-conversation reads as lost history.
          if (loaded.truncated && loaded.total) {
            seeded.unshift({
              kind: 'notice',
              id: 'history-window',
              text: `Showing the last ${loaded.messages.length} of ${loaded.total} messages`,
            })
          }
          // Anything still queued is newer than this history and invisible to
          // it, so it has to survive the replace.
          const pending = queuedFor(connectionId, threadId).map((m) => echoMessageId(m.messageId))
          store.seedItems(key, seeded, pending)
        }
      } catch (err) {
        reportError(err)
      }
      try {
        // Mirrors the desktop resume path: the conversation id doubles as the
        // resumeSessionId so the Claude adapter can --resume the JSONL chain.
        // Failure rejects (no { ok } envelope) and routes to the error feed.
        await client.startSession({
          threadId,
          provider,
          // `worktreePath ?? projectPath`, same as the desktop. Without it the
          // phone started worktree-backed chats in the parent repo, and
          // whichever client started first fixed the cwd for both - so the
          // agent edited the wrong tree.
          cwd: loadedMeta?.worktreePath ?? worktreePath ?? loadedMeta?.projectPath ?? projectPath,
          ...(loadedMeta?.forkMetadata?.resumeMode === 'transcript-handoff'
            ? {}
            : { resumeSessionId: threadId }),
          runtimeMode: loadedMeta?.runtimeMode ?? undefined,
          model: loadedMeta?.model ?? undefined,
          instanceId: loadedMeta?.providerInstanceId ?? undefined,
        })
      } catch (err) {
        startedKeyRef.current = null
        reportError(err)
        return
      }
      // Recover any approval/question/plan card a resume gap or a reload
      // dropped - this effect re-runs on both (staleGeneration), so it also
      // covers an ordinary reconnect. Older backends have no handler for the
      // channel, hence the capability gate.
      if (client.supportsCapability('pending_requests_v1') === true) {
        try {
          const pending = await client.getPendingRequests(threadId)
          if (pending.length) {
            const items = useChatStore.getState().threads[key]?.items ?? []
            for (const event of missingPendingFeedItems(pending, items)) {
              useChatStore.getState().ingestNow(connectionId, event)
            }
          }
        } catch (err) {
          reportError(err)
        }
      }
      // Same for messages the backend still holds: re-list them, so the
      // Queued rows survive a reload or a resume gap.
      if (client.supportsCapability('turn_queue_controls_v1') === true) {
        try {
          // A live event that lands while the backend answers makes the answer
          // stale; ask again rather than undo it.
          const revisionOf = () => useChatStore.getState().threads[key]?.heldRevision ?? 0
          for (let attempt = 0; attempt < 3; attempt++) {
            const revision = revisionOf()
            const held = await client.listQueuedTurns(threadId)
            if (revisionOf() !== revision) continue
            useChatStore.getState().setHeldTurns(key, held)
            break
          }
        } catch (err) {
          reportError(err)
        }
      }
    })()
  }, [connectionId, threadId, projectPath, key, isNew, reportError, staleGeneration, invalidated, thread.cached])

  // Restore the user's last choices, pushing the mode to the backend too so the
  // adapter and the chip agree.
  const restoredKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (restoredKeyRef.current === key) return
    const saved = usePrefsStore.getState().threads[key]
    const mode = saved?.mode ?? (isNew ? usePrefsStore.getState().defaultMode : undefined)
    if (mode === undefined && saved?.model === undefined && !saved?.draft) {
      restoredKeyRef.current = key
      return
    }
    const client = getClient(connectionId)
    if (!client) return // Retry on a later render, once the client exists.
    restoredKeyRef.current = key
    if (mode !== undefined) {
      useChatStore.getState().setRuntimeMode(key, mode)
      client.setRuntimeMode(threadId, mode).catch((err) => log.warn('restore mode failed', err))
    }
    if (saved?.model !== undefined) {
      // Local only. Pushing a remembered model on OPEN would retarget a session
      // the desktop is driving - harmless while the Claude adapter ignored
      // setModel, a silent mid-conversation model change now that it does not.
      // The backend reports the live model on `context_window`.
      setModel(saved.model)
    }
    if (saved?.draft) setDraft(saved.draft)
  }, [connectionId, threadId, key, isNew])

  useEffect(() => {
    const client = getClient(connectionId)
    if (!client) return
    let cancelled = false
    client
      .listInstances()
      .then((rows) => {
        if (!cancelled) setInstances(rows)
      })
      .catch((err) => log.warn('listInstances failed - hiding the profile chip', err))
    return () => {
      cancelled = true
    }
  }, [connectionId])

  /** Rotate providers, or transactionally rotate credentials within one provider. */
  const rotateProfile = useCallback(
    (nextProvider: ProviderKind, nextInstanceId?: string) => {
      const client = getClient(connectionId)
      if (!client) {
        reportError(new Error('Backend not connected.'))
        return
      }
      setProfilePickerOpen(false)
      setRotating(true)
      void (async () => {
        try {
          if (nextProvider === provider && nextInstanceId) {
            const rotation = await rotateWithinAgent(threadId, instanceId, nextInstanceId, {
              switchInstance: (id, input) => client.switchInstance(id, input),
              setConversationProviderInstanceId: (id, inst) =>
                client.setConversationProviderInstanceId(id, inst),
              confirmStartFresh: (message) =>
                new Promise<boolean>((resolve) => {
                  Alert.alert(
                    'Profile histories differ',
                    `${message}\n\nThe current profile is still active. You can stay there or start the selected profile fresh with the visible conversation carried into your next turn.`,
                    [
                      { text: 'Stay here', style: 'cancel', onPress: () => resolve(false) },
                      { text: 'Start fresh', onPress: () => resolve(true) },
                    ],
                    { cancelable: false },
                  )
                }),
            })
            if (!rotation.applied) return
          } else {
            await client.stopSession(threadId)
            await client.startSession({
              threadId,
              provider: nextProvider,
              cwd: worktreePath ?? projectPath,
              resumeSessionId: threadId,
              instanceId: nextInstanceId,
            })
          }
          setProvider(nextProvider)
          setInstanceId(nextInstanceId)
        } catch (err) {
          reportError(err)
        } finally {
          setRotating(false)
        }
      })()
    },
    [connectionId, threadId, projectPath, worktreePath, provider, instanceId, reportError],
  )

  useEffect(() => {
    if (skills.length > 0) return
    const client = getClient(connectionId)
    if (!client) return
    let cancelled = false
    client
      .listSkills(threadId)
      .then((rows) => {
        if (!cancelled && rows && rows.length > 0) setSkills(rows)
      })
      .catch((err) => log.warn('listSkills failed - built-ins only', err))
    return () => {
      cancelled = true
    }
  }, [connectionId, threadId, thread.status, skills.length])

  // Live model list for this thread. It stays empty until the adapter can
  // answer (Claude's SDK query only exists once a turn has begun, so the fetch
  // is re-run on every status change until a list lands) and an empty list
  // means "this provider has no model picker" - the chip stays hidden.
  useEffect(() => {
    if (models.length > 0) return
    const client = getClient(connectionId)
    if (!client) return
    let cancelled = false
    client
      .listModels(threadId)
      .then((rows) => {
        if (cancelled || !rows || rows.length === 0) return
        setModels(rows)
      })
      .catch((err) => log.warn('listModels failed - hiding the model chip', err))
    return () => {
      cancelled = true
    }
  }, [connectionId, threadId, thread.status, models.length])

  // FlatList passes its own getItem/getItemCount after {...restProps}, so a
  // zero-copy accessor would be ignored and the feed would render oldest-first.
  // Reversing a copy is cheap; the memoized rows are what actually mattered.
  const reversedItems = useMemo(() => [...thread.items].reverse(), [thread.items])
  const itemCount = reversedItems.length

  const setMode = (mode: RuntimeMode) => {
    useChatStore.getState().setRuntimeMode(key, mode)
    usePrefsStore.getState().rememberMode(key, mode)
    getClient(connectionId)?.setRuntimeMode(threadId, mode).catch(reportError)
  }

  // Optimistic like setMode: the chip updates now, a rejection lands in the feed.
  const chooseModel = (id: string) => {
    setModelPickerOpen(false)
    setModel(id)
    usePrefsStore.getState().rememberModel(key, id)
    getClient(connectionId)?.setModel(threadId, id).catch(reportError)
  }

  const modelLabel = models.find((m) => m.id === model)?.label ?? 'Default'

  /**
   * Messages still waiting to reach the backend, for this thread.
   *
   * Includes both the offline case and follow-ups typed during an OpenCode
   * turn: its adapter is one-prompt-per-turn and drops a mid-turn send
   * silently, while Claude queues in its SDK and Codex steers into the live
   * turn. That distinction now lives in the outbox rather than in a second
   * queue here.
   */
  const allQueuedMessages = useOutboxStore((outbox) => outbox.messages)
  const queuedMessages = useMemo(
    () => allQueuedMessages.filter(
      (message) => message.connectionId === connectionId && message.threadId === threadId,
    ),
    [allQueuedMessages, connectionId, threadId],
  )
  const queuedByBubbleId = useMemo(
    () => new Map(queuedMessages.map((message) => [echoMessageId(message.messageId), message])),
    [queuedMessages],
  )
  const waitingCount = queuedMessages.filter((message) => !message.blockedReason).length

  // A turn ending is the most likely moment a waiting message becomes
  // deliverable, so nudge the queue rather than waiting out its backoff.
  useEffect(() => {
    if (thread.status === 'idle') void drain()
  }, [thread.status])

  // `textOverride` is for one-tap actions like the Compact banner: it sends
  // that text alone and leaves the user's draft and attachments untouched.
  const send = (textOverride?: string) => {
    const text = (textOverride ?? draft).trim()
    // An image with no caption is a legitimate turn.
    if (!text && attachments.length === 0) return
    const images = textOverride ? [] : attachments.map((a) => ({ url: a.url, mimeType: a.mimeType }))
    // An override (Compact) is its own turn; it must not complete a pending edit.
    const editingId = textOverride ? undefined : useOutboxStore.getState().editingId
    const editingMessage = editingId
      ? queuedMessages.find((message) => message.messageId === editingId)
      : undefined
    if (!textOverride) {
      setDraft('')
      setVoiceNote(null)
      setAttachments([])
      usePrefsStore.getState().rememberDraft(key, '')
    }

    // Every send goes through the outbox, including one made while connected.
    // A backend check here would only cover the cases we can SEE are broken,
    // and the expensive ones are the ambiguous ones: a socket that still reads
    // as open, a reconnect in flight, a turn already running.
    const titleCandidate = editingMessage?.titleCandidate ?? (
      isNew && thread.items.filter((item) => item.kind === 'user').length === 0 && text
        ? generateTitle(text)
        : undefined
    )
    const turn = buildTurn({
      connectionId,
      threadId,
      text,
      images,
      runtimeMode: thread.runtimeMode,
      titleCandidate,
      whenIdle: toggle.queues && !textOverride,
    })
    setFlipNext(false)
    // Title from the first message, as the desktop does. `isNew` matters: an
    // existing chat whose items were emptied by /clear, or one whose history
    // has not loaded yet, also has no user items - titling those would
    // overwrite a title the user already has.
    useChatStore.getState().addUserMessage(key, text, images.map((i) => i.url), turn.bubbleId)
    enqueue(turn.queued)
      .then(async () => {
        if (!editingId) return
        await completeRejectedEdit(editingId)
        useChatStore.getState().removeUserMessage(key, echoMessageId(editingId))
      })
      .catch((err: unknown) => {
        // The durable write failed, so the message is out of the queue again.
        // Take the optimistic bubble back down and give the user what they typed,
        // rather than leaving a bubble that reads as sent and never will be.
        useChatStore.getState().removeUserMessage(key, turn.bubbleId)
        setDraft((current) => (current ? current : text))
        setAttachments(attachments)
        reportError(err)
      })
  }

  const addAttachments = useCallback((added: Attachment[]) => {
    setAttachments((prev) => [...prev, ...added])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const stop = () => {
    getClient(connectionId)?.interrupt(threadId).catch(reportError)
  }

  const implementPlan = useCallback(() => {
    const client = getClient(connectionId)
    if (!client) {
      reportError(new Error('Backend not connected.'))
      return
    }
    // Same flow as the desktop PlanCard: drop to sandbox, then send the
    // implement follow-up.
    useChatStore.getState().setRuntimeMode(key, 'sandbox')
    client.setRuntimeMode(threadId, 'sandbox').catch(reportError)
    // Through the outbox like every other send, or it is lost off-socket.
    const turn = buildTurn({
      connectionId,
      threadId,
      text: IMPLEMENT_MESSAGE,
      runtimeMode: 'sandbox',
    })
    useChatStore.getState().addUserMessage(key, IMPLEMENT_MESSAGE, undefined, turn.bubbleId)
    enqueue(turn.queued).catch((err: unknown) => {
      useChatStore.getState().removeUserMessage(key, turn.bubbleId)
      reportError(err)
    })
  }, [connectionId, threadId, key, reportError])

  const decideApproval = useCallback(
    (requestId: string, decision: 'approve' | 'deny') => {
      getClient(connectionId)?.respondToRequest(threadId, requestId, decision).catch(reportError)
      useChatStore.getState().markApprovalResolved(key, requestId, decision)
    },
    [connectionId, threadId, key, reportError],
  )

  const submitAnswers = useCallback(
    (requestId: string, answers: string[][]) => {
      getClient(connectionId)?.answerQuestion(threadId, requestId, answers).catch(reportError)
      useChatStore.getState().markQuestionAnswered(key, requestId, answers)
    },
    [connectionId, threadId, key, reportError],
  )

  const focusComposer = useCallback(() => composerRef.current?.focus(), [])

  const editRejected = useCallback((messageId: string) => {
    const rejected = openRejectedForEdit(messageId)
    if (!rejected) return
    const recovered = recoverRejectedDraft(rejected)
    if (!recovered) return
    setDraft(recovered.text)
    setAttachments(recovered.images)
    usePrefsStore.getState().rememberDraft(key, recovered.text)
    composerRef.current?.focus()
  }, [key])

  const resolveAmbiguous = useCallback((messageId: string) => {
    Alert.alert(
      'Delivery unconfirmed',
      'The agent may already have received this message. Continue without resending it to unblock later messages?',
      [
        { text: 'Keep retrying', style: 'cancel' },
        {
          text: 'Continue without resending',
          style: 'destructive',
          onPress: () => void abandonAmbiguous(messageId)
            .then(({ message, status }) => {
              if (resolvedAmbiguousBubbleAction(status) === 'remove') {
                useChatStore.getState().removeUserMessage(key, echoMessageId(message.messageId))
              }
              useChatStore.getState().ingest(connectionId, {
                type: 'error',
                threadId,
                message: status === 'completed'
                  ? 'Message delivery was confirmed; it was not sent again.'
                  : 'Unconfirmed message was not resent. Delivery may already have occurred.',
              })
            })
            .catch(reportError),
        },
      ],
    )
  }, [connectionId, key, reportError, threadId])

  const forkFromMessage = useCallback((message: ChatMessage) => {
    const client = getClient(connectionId)
    if (!client) return
    const execute = async (withWorktree: boolean): Promise<void> => {
      let request = await mobileForkRequest({
        connectionId,
        sourceConversationId: threadId,
        message,
        withWorktree,
      })
      let outcome = await client.getConversationFork({
        requestId: request.requestId,
        sourceConversationId: threadId,
      })
      if (outcome?.kind !== 'completed') outcome = await client.forkConversation(request)
      if (outcome.kind === 'confirmation-required') {
        const dirtySource = outcome.dirtySource
        const accepted = await new Promise<boolean>((resolve) => Alert.alert(
          'Uncommitted changes will not be copied',
          `The new worktree starts from ${dirtySource.headSha.slice(0, 8)}. ${dirtySource.omittedChangeSummary}`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Continue from HEAD', onPress: () => resolve(true) },
          ],
          { cancelable: false },
        ))
        if (!accepted) return
        request = {
          ...request,
          checkout: {
            kind: 'new-worktree',
            basePolicy: 'source-head',
            dirtySourceConfirmed: {
              headSha: dirtySource.headSha,
              statusDigest: dirtySource.statusDigest,
            },
          },
        }
        outcome = await client.forkConversation(request)
      }
      if (outcome.kind === 'confirmation-required') {
        throw new Error('The source changed after confirmation. Review the changes and try again.')
      }
      if (outcome.kind === 'failed') throw new Error(outcome.error.message)
      const fork = outcome.result.conversation
      await forgetMobileForkRequest({
        connectionId,
        sourceConversationId: threadId,
        messageId: message.id,
        withWorktree,
      }).catch((error) => log.warn('could not clear completed fork retry intent', error))
      navigation.push('Thread', {
        connectionId,
        threadId: fork.id,
        title: fork.title,
        projectPath: fork.projectPath,
        worktreePath: fork.worktreePath,
        worktreeBranch: fork.worktreeBranch ?? undefined,
        worktreeId: fork.worktreeId ?? undefined,
      })
    }
    Alert.alert('Fork conversation', 'Choose how to branch from this message.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Fork conversation here', onPress: () => void execute(false).catch(reportError) },
      { text: 'Fork into a new worktree from current HEAD', onPress: () => void execute(true).catch(reportError) },
    ])
  }, [connectionId, navigation, reportError, threadId])

  // Held messages only come from a backend that can act on them, but the
  // controls check too, rather than offer buttons whose channel is missing.
  const canControlQueue = getClient(connectionId)?.supportsCapability('turn_queue_controls_v1') === true

  const actOnHeld = useCallback(async (held: QueuedTurnSummary, action: 'promote' | 'cancel') => {
    const client = getClient(connectionId)
    if (!client) return
    try {
      const result = action === 'promote'
        ? await client.promoteQueuedTurn(threadId, held.messageId)
        : await client.cancelQueuedTurn(threadId, held.messageId)
      if (!result.ok) {
        reportError(new Error(result.message))
        return
      }
      // The bubble goes on the backend's turn.dequeued; the text comes back here.
      if (action === 'cancel') setDraft((current) => (current ? `${current}\n\n${result.turn.text}` : result.turn.text))
    } catch (err) {
      reportError(err)
    }
  }, [connectionId, threadId, reportError])

  const renderItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      switch (item.kind) {
        case 'user':
          const queued = queuedByBubbleId.get(item.id)
          const delivery = queued ? outboxPresentation(queued) : null
          const held = canControlQueue ? heldTurnFor(thread.heldTurns, item.id) : undefined
          return (
            <View style={styles.userRow}>
              <Pressable
                disabled={delivery?.state !== 'failed' && delivery?.state !== 'ambiguous'}
                onPress={() => {
                  if (!queued || !delivery) return
                  if (delivery.state === 'failed') editRejected(queued.messageId)
                  if (delivery.state === 'ambiguous') resolveAmbiguous(queued.messageId)
                }}
                onLongPress={() => {
                  const message = forkMessagesRef.current.get(item.id)
                  if (message) forkFromMessage(message)
                }}
                style={[styles.userBubble, held && styles.heldBubble]}
              >
                {item.images?.map((url, i) => (
                  <Pressable key={`${item.id}-img-${i}`} onPress={() => setLightbox(url)}>
                    <Image source={{ uri: url }} style={styles.sentImage} resizeMode="cover" />
                  </Pressable>
                ))}
                {/* An image with no caption is a valid message, so the label is
                    conditional rather than a placeholder like "[1 image]". */}
                {item.text.length > 0 && <Text style={styles.userText}>{item.text}</Text>}
                {delivery && (
                  <Text style={[
                    styles.deliveryText,
                    delivery.state === 'failed' && styles.deliveryFailed,
                  ]}>
                    {delivery.label}{delivery.state === 'failed'
                      ? ' - tap to edit'
                      : delivery.state === 'ambiguous' ? ' - tap to resolve' : ''}
                  </Text>
                )}
                {held && (
                  <HeldTurnBar
                    actions={heldTurnActions(thread.provider ?? provider)}
                    onPromote={() => void actOnHeld(held, 'promote')}
                    onCancel={() => void actOnHeld(held, 'cancel')}
                  />
                )}
              </Pressable>
            </View>
          )
        case 'text':
          return (
            <TextItem
              item={item}
              onLongPress={forkMessagesRef.current.has(item.id)
                ? () => forkFromMessage(forkMessagesRef.current.get(item.id)!)
                : undefined}
            />
          )
        case 'tool':
          return <ToolItem item={item} />
        case 'denial':
          return (
            <View style={styles.denialPill}>
              <Text style={styles.denialText}>
                Blocked: {item.toolName} - {item.reason}
              </Text>
            </View>
          )
        case 'approval':
          return <ApprovalItem item={item} onDecide={decideApproval} />
        case 'question':
          return <QuestionItem item={item} onSubmit={submitAnswers} />
        case 'plan':
          return <PlanItem item={item} onImplement={implementPlan} onIterate={focusComposer} />
        case 'fileEdit':
          return <FileEditItem item={item} backendLabel={backendLabel} />
        case 'notice':
          return (
            <View style={styles.noticeRow}>
              <Text style={styles.noticeText}>{item.text}</Text>
            </View>
          )
        case 'synthetic':
          return <SyntheticRow part={item.part} />
        case 'error':
          return <Text style={styles.errorText}>{item.message}</Text>
      }
    },
    [
      decideApproval,
      submitAnswers,
      implementPlan,
      focusComposer,
      backendLabel,
      setLightbox,
      queuedByBubbleId,
      editRejected,
      resolveAmbiguous,
      forkFromMessage,
      canControlQueue,
      thread.heldTurns,
      thread.provider,
      provider,
      actOnHeld,
    ],
  )

  // Null hides the chip: a backend with no configured profiles has nothing to
  // switch between, and an empty chip would just be a dead control.
  // The backend's own view, from session.provider, so a rotation performed on
  // the desktop relabels this chip live instead of going stale until reopen.
  const effectiveProvider = thread.provider ?? provider
  const effectiveInstanceId = thread.instanceId ?? instanceId
  const currentProfiles = profilesFor(instances, effectiveProvider)
  const profileLabel =
    currentProfiles.length === 0
      ? null
      : (thread.instanceName ??
          (currentProfiles.find((i) => i.id === effectiveInstanceId) ?? currentProfiles[0]).displayName)

  const slashQuery = detectSlash(draft)
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : filterCommands(allCommands(skills), slashQuery)),
    [slashQuery, skills],
  )

  const runSlash = useCallback(
    (cmd: SlashCommand) => {
      const action = cmd.action
      // Built-ins consume the typed slash; a skill replaces it with the invocation
      // so the user can add arguments before sending.
      setDraft(action.kind === 'insert' ? action.text : '')
      switch (action.kind) {
        case 'mode':
          setMode(action.mode)
          break
        case 'clear':
          // Local only: the backend transcript is the record of truth, so this
          // clears what this phone shows, not the conversation.
          useChatStore.getState().seedItems(key, [])
          break
        case 'stop':
          stop()
          break
        case 'attach':
        case 'insert':
          composerRef.current?.focus()
          break
      }
    },
    [key, setMode, stop],
  )

  const isRunning = thread.status === 'running'
  const canSend = draft.trim().length > 0 || attachments.length > 0
  // Vocabulary bias comes from the tree the agent works in, so a worktree
  // session biases on the worktree's files.
  const dictation = useDictation({
    draft,
    onDraft: setDraft,
    onNote: setVoiceNote,
    refine: { connectionId, projectPath: worktreePath ?? projectPath },
  })

  const contextShare = thread.usedTokens != null ? contextPercent(thread.usedTokens, thread.maxTokens) : null
  const contextPct = contextShare == null ? null : contextShare / 100
  const [compactionDismissed, setCompactionDismissed] = useState(false)
  // Same 60s tick as the desktop pane: nothing else re-renders an idle thread.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  // Seeded history has no lastTurnAt yet, so the last user bubble's time stands in.
  const lastUserAt = useMemo(() => {
    for (let i = thread.items.length - 1; i >= 0; i--) {
      const item = thread.items[i]
      if (item.kind === 'user') return item.at
    }
    return undefined
  }, [thread.items])
  const offerCompaction = !compactionDismissed && shouldOfferCompaction({
    provider: effectiveProvider,
    usedTokens: thread.usedTokens,
    lastMessageAt: thread.lastTurnAt ?? lastUserAt,
    busy: isRunning,
    now,
  })

  return (
    <AnimatedKeyboardAvoidingView
      {...swipeBack.panHandlers}
      style={[styles.screen, { transform: [{ translateX: swipeBack.translateX }] }]}
      {...keyboardAvoidance(Platform.OS, headerHeight)}
    >
      {/* Expanded detail, shown only when the header accessory is tapped. */}
      {statusOpen && (
        <View style={styles.statusBar}>
          <Text style={styles.statusText}>{thread.status}</Text>
          {contextPct != null && thread.usedTokens != null && thread.maxTokens != null && (
            <View style={styles.contextWrap}>
              <View style={styles.contextTrack}>
                <View style={[styles.contextFill, { width: `${Math.round(contextPct * 100)}%` }]} />
              </View>
              <Text style={styles.contextText}>
                {formatTokens(thread.usedTokens)} / {formatTokens(thread.maxTokens)}
              </Text>
            </View>
          )}
          {thread.costUsd != null && <Text style={styles.costText}>${thread.costUsd.toFixed(2)}</Text>}
        </View>
      )}

      {offerCompaction && thread.usedTokens != null && (
        <View style={[styles.forkBanner, styles.compactBanner]} accessibilityRole="summary" testID="compaction-offer-banner">
          <Text style={[styles.forkBannerText, styles.compactBannerText]} numberOfLines={1}>
            Resume with less context · {formatTokens(thread.usedTokens)} tokens from earlier
          </Text>
          <Pressable onPress={() => send('/compact')} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.compactAction}>Compact</Text>
          </Pressable>
          <Pressable onPress={() => setCompactionDismissed(true)} accessibilityRole="button" accessibilityLabel="Keep full history" hitSlop={8}>
            <Text style={styles.forkBannerText}>×</Text>
          </Pressable>
        </View>
      )}

      {forkMetadata && (
        <View style={styles.forkBanner} accessibilityRole="summary">
          <Text style={styles.forkBannerText} numberOfLines={2}>
            Forked from {forkMetadata.parentTitle} · {forkMetadata.anchor.preview} ·{' '}
            {forkMetadata.resumeMode === 'native' ? 'native resume' : 'transcript handoff'}
            {forkMetadata.git ? ` · ${forkMetadata.git.branch} from ${forkMetadata.git.baseSha.slice(0, 8)}` : ''}
          </Text>
        </View>
      )}

      {/* Outside the list: ListEmptyComponent gets no counter-transform from an
          inverted FlatList, so anything placed there renders mirrored. */}
      {itemCount === 0 ? (
        <View style={styles.emptyWrap}>
          {!isNew && <ActivityIndicator size="small" color={colors.textDim} />}
          <Text style={styles.emptyText}>
            {isNew ? 'Session started. Say something below.' : 'Loading conversation'}
          </Text>
        </View>
      ) : (
        <FlatList
          inverted
          data={reversedItems}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={styles.feedContent}
          // Long threads: keep far fewer rows realised and recycle aggressively.
          windowSize={9}
          maxToRenderPerBatch={8}
          initialNumToRender={12}
          removeClippedSubviews
        />
      )}

      {/* Model picker. Hidden entirely when the provider reports no models, so
          Claude-only setups do not get a chip that cannot do anything. */}
      <Modal
        visible={modelPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setModelPickerOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setModelPickerOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Model</Text>
            <ScrollView>
              {models.map((m) => {
                const active = m.id === model
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => chooseModel(m.id)}
                    style={({ pressed }) => [styles.modelRow, pressed && styles.pressed]}
                  >
                    <Text style={[styles.modelRowText, active && styles.modelRowTextActive]}>
                      {m.label}
                    </Text>
                    {active && <Text style={styles.modelRowMark}>current</Text>}
                  </Pressable>
                )
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <ProfilePicker
        visible={profilePickerOpen}
        instances={instances}
        provider={effectiveProvider}
        instanceId={effectiveInstanceId ?? undefined}
        busy={rotating}
        onPick={rotateProfile}
        onClose={() => setProfilePickerOpen(false)}
      />

      <Modal visible={lightbox !== null} transparent animationType="fade" onRequestClose={() => setLightbox(null)}>
        <Pressable style={styles.lightbox} onPress={() => setLightbox(null)}>
          {lightbox !== null && (
            <Image source={{ uri: lightbox }} style={styles.lightboxImage} resizeMode="contain" />
          )}
        </Pressable>
      </Modal>

      {/* Composer */}
      {/* The inset, not a constant: under edge-to-edge the gesture bar overlays
          the app, and it is a different height on every device. Floored so the
          composer keeps its breathing room on a phone that reports none. */}
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {/* Dropdowns left, actions right. The left group scrolls if the labels
            overflow; the right group never does, so the mic, attach and Stop
            are always where the thumb expects them. */}
        <View style={styles.controlsRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            style={styles.controlsScroller}
            contentContainerStyle={styles.controlsContent}
          >
            <ModePicker value={thread.runtimeMode} onChange={setMode} />
            {models.length > 0 && (
              <Pressable
                onPress={() => setModelPickerOpen(true)}
                style={({ pressed }) => [styles.modelChip, pressed && styles.pressed]}
              >
                <Text style={styles.modelChipText} numberOfLines={1}>
                  {modelLabel}
                </Text>
              </Pressable>
            )}
            {profileLabel !== null && (
              <Pressable
                onPress={() => setProfilePickerOpen(true)}
                disabled={rotating}
                style={({ pressed }) => [styles.modelChip, (pressed || rotating) && styles.pressed]}
              >
                <Text style={styles.modelChipText} numberOfLines={1}>
                  {rotating ? 'Switching…' : profileLabel}
                </Text>
              </Pressable>
            )}
          </ScrollView>
        </View>
        {voiceNote && <VoiceNoteBar note={voiceNote} />}
        {dictation.refining && <Text style={styles.queuedNote}>Refining transcript…</Text>}
        {waitingCount > 0 && (
          <Text style={styles.queuedNote}>
            {waitingCount} {waitingCount === 1 ? 'message' : 'messages'} awaiting confirmation
          </Text>
        )}
        {slashQuery !== null && <SlashMenu commands={slashMatches} onPick={runSlash} />}
        <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
        {isRunning && canSteer(thread.provider ?? provider) && (
          <Pressable
            onPress={() => setFlipNext((v) => !v)}
            accessibilityRole="switch"
            accessibilityState={{ checked: flipNext }}
            accessibilityLabel={toggle.accessibilityLabel}
            testID="queue-next-toggle"
            style={[styles.queueChip, toggle.queues && styles.queueChipOn]}
            hitSlop={6}
          >
            <Text style={[styles.queueChipText, toggle.queues && styles.queueChipTextOn]}>
              {toggle.label}
            </Text>
          </Pressable>
        )}
        <View style={styles.inputSurface}>
          <TextInput
            ref={composerRef}
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={isRunning ? (canSteer(thread.provider ?? provider) && !toggle.queues ? 'Steer the agent…' : 'Queue a follow-up…') : 'Message the agent…'}
            placeholderTextColor={colors.textFaint}
            multiline
          />
          {/* Attach lives inside the bubble, left of the primary button. */}
          <AttachButton existing={attachments} onAdd={addAttachments} />
          <SendMicButton
            canSend={canSend}
            isRunning={isRunning}
            dictation={dictation}
            onSend={() => send()}
            onStopTurn={stop}
          />
        </View>
      </View>
    </AnimatedKeyboardAvoidingView>
  )
}

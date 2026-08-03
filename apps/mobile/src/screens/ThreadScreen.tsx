/**
 * One chat thread: inverted feed over the chat store's FeedItems, a status
 * header (dot + context meter + cost), and a pinned composer with a runtime
 * mode picker. History seeds from LOAD_SESSION_BY_ID; live events arrive via
 * the connection's onEvent -> useChatStore.ingest wiring.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Image,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from '@react-navigation/native'
import { useHeaderHeight } from '@react-navigation/elements'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { ProviderKind, Question, RuntimeMode } from '@shared/provider-events'
import type { ProviderInstance, ProviderSkill } from '@shared/types'
import type { ChatMessage } from '@shared/types'
import type { ModelOption } from '@shared/models'
import { fmtDuration, formatTokens } from '@shared/format'
import { echoMessageId } from '@shared/provider-events'
import { VIEWING_RENEW_MS } from '@shared/push-policy'
import { generateTitle } from '@shared/auto-title'
import { createLogger } from '@shared/logger'
import type { RootStackParamList } from '../../App'
import { colors, radius, space, type } from '../theme'
import { Markdown } from '../components/Markdown'
import { summarizeTool, toolIcon } from '../lib/toolSummary'
import { getClient, onAppForeground, useConnectionsStore } from '../stores/connections'
import { useChatStore, threadKey, emptyThread, type FeedItem } from '../stores/chat'
import { drain, enqueue, useOutboxStore } from '../stores/outbox'
import { usePrefsStore } from '../stores/prefs'
import { usePushStore } from '../stores/push'
import { ModePicker } from '../components/ModePicker'
import { ProfilePicker } from '../components/ProfilePicker'
import { SlashMenu } from '../components/SlashMenu'
import { allCommands, detectSlash, filterCommands, type SlashCommand } from '../lib/slash'
import { profilesFor } from '../lib/profiles'
import { ThreadHeaderStatus } from '../components/ThreadHeaderStatus'
import { VoiceNoteBar } from '../components/MicButton'
import { SendMicButton } from '../components/SendMicButton'
import { useDictation, type VoiceNote } from '../hooks/useDictation'
import { useEdgeSwipeBack } from '../hooks/useEdgeSwipeBack'
import { AttachButton, AttachmentStrip, type Attachment } from '../components/ImageAttachments'

/** How much of a long thread to pull on open. The feed says when it is a window. */
const HISTORY_WINDOW = 250

const log = createLogger('screen:thread')

type Props = NativeStackScreenProps<RootStackParamList, 'Thread'>

/** Origin for a turn we send. The optimistic bubble uses echoMessageId(origin),
 *  so the broadcast collapses onto it instead of rendering a second copy. */
function ownTurn(): string {
  return `m${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const IMPLEMENT_MESSAGE = 'Implement the plan you proposed.'

/** KeyboardAvoidingView cannot take an Animated.Value in its style unwrapped. */
const AnimatedKeyboardAvoidingView = Animated.createAnimatedComponent(KeyboardAvoidingView)

function providerFromAgentType(agentType: string | undefined): ProviderKind {
  if (agentType === 'codex') return 'codex'
  if (agentType === 'opencode') return 'opencode'
  return 'claude'
}

/** Map loaded ChatMessages into FeedItems (user text, assistant text, tools). */
function historyToItems(messages: ChatMessage[]): FeedItem[] {
  const items: FeedItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const urls = (m.images ?? []).map((img) => img.url).filter(Boolean)
      // A message can be images with no caption, so an empty body still counts.
      if (m.content.trim() || urls.length > 0) {
        items.push({
          kind: 'user',
          id: `h-${m.id}`,
          text: m.content,
          at: m.timestamp,
          images: urls.length > 0 ? urls : undefined,
        })
      }
      continue
    }
    // Assistant and system messages render as done assistant text.
    if (m.content.trim()) {
      items.push({ kind: 'text', id: `h-${m.id}`, text: m.content, stream: 'assistant', done: true })
    }
    for (const tc of m.toolCalls ?? []) {
      items.push({
        kind: 'tool',
        id: `h-${m.id}-t-${tc.id}`,
        toolName: tc.name,
        input: tc.input,
        output: tc.output,
        state: 'done',
      })
    }
  }
  return items
}

export default function ThreadScreen({ route, navigation }: Props) {
  const { connectionId, threadId, projectPath, isNew } = route.params
  const key = threadKey(connectionId, threadId)
  const thread = useChatStore((s) => s.threads[key]) ?? emptyThread()
  const backendLabel =
    useConnectionsStore((s) => s.configs.find((c) => c.id === connectionId)?.label) ?? 'backend'

  // Real header height: the keyboard offset must clear it, and hardcoding 96
  // was wrong on Android where it was 0.
  const headerHeight = useHeaderHeight()
  const [draft, setDraft] = useState('')
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
      try {
        const loaded = await client.loadSessionById(threadId, HISTORY_WINDOW)
        provider = providerFromAgentType(loaded.meta?.agentType)
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
          store.seedItems(key, seeded)
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
          cwd: projectPath,
          resumeSessionId: threadId,
        })
      } catch (err) {
        startedKeyRef.current = null
        reportError(err)
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
      setModel(saved.model)
      client.setModel(threadId, saved.model).catch((err) => log.warn('restore model failed', err))
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

  /**
   * Rotate the agent or the OAuth profile on this live thread.
   *
   * startSession is idempotent server-side, so re-invoking it on a running
   * thread returns the existing session and changes nothing. The session has to
   * be stopped first for the registry to resolve the new credentials.
   */
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
          await client.stopSession(threadId)
          await client.startSession({
            threadId,
            provider: nextProvider,
            cwd: projectPath,
            resumeSessionId: threadId,
            instanceId: nextInstanceId,
          })
          setProvider(nextProvider)
          setInstanceId(nextInstanceId)
        } catch (err) {
          reportError(err)
        } finally {
          setRotating(false)
        }
      })()
    },
    [connectionId, threadId, projectPath, reportError],
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
  const queuedCount = useOutboxStore(
    (o) => o.messages.filter((m) => m.connectionId === connectionId && m.threadId === threadId).length,
  )

  // A turn ending is the most likely moment a waiting message becomes
  // deliverable, so nudge the queue rather than waiting out its backoff.
  useEffect(() => {
    if (thread.status === 'idle') void drain()
  }, [thread.status])

  const send = () => {
    const text = draft.trim()
    // An image with no caption is a legitimate turn.
    if (!text && attachments.length === 0) return
    const images = attachments.map((a) => ({ url: a.url, mimeType: a.mimeType }))
    setDraft('')
    setVoiceNote(null)
    setAttachments([])
    usePrefsStore.getState().rememberDraft(key, '')

    // Every send goes through the outbox, including one made while connected.
    // A backend check here would only cover the cases we can SEE are broken,
    // and the expensive ones are the ambiguous ones: a socket that still reads
    // as open, a reconnect in flight, a turn already running.
    const messageId = ownTurn()
    // Title from the first message, as the desktop does. `isNew` matters: an
    // existing chat whose items were emptied by /clear, or one whose history
    // has not loaded yet, also has no user items - titling those would
    // overwrite a title the user already has.
    if (isNew && thread.items.filter((i) => i.kind === 'user').length === 0 && text) {
      const title = generateTitle(text)
      getClient(connectionId)
        ?.renameConversation(threadId, title)
        .catch((err: unknown) => log.warn('could not set the chat title', err))
    }
    useChatStore.getState().addUserMessage(key, text, images.map((i) => i.url), echoMessageId(messageId))
    enqueue({
      connectionId,
      threadId,
      messageId,
      text,
      images: images.length > 0 ? images : undefined,
      runtimeMode: thread.runtimeMode,
      createdAt: Date.now(),
      attempts: 0,
    }).catch((err: unknown) => {
      // The durable write failed, so the message is out of the queue again.
      // Take the optimistic bubble back down and give the user what they typed,
      // rather than leaving a bubble that reads as sent and never will be.
      useChatStore.getState().removeUserMessage(key, echoMessageId(messageId))
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
    useChatStore.getState().addUserMessage(key, IMPLEMENT_MESSAGE)
    // Through the outbox like every other send, or it is lost off-socket.
    const messageId = ownTurn()
    useChatStore.getState().addUserMessage(key, IMPLEMENT_MESSAGE, undefined, echoMessageId(messageId))
    enqueue({
      connectionId,
      threadId,
      messageId,
      text: IMPLEMENT_MESSAGE,
      runtimeMode: 'sandbox',
      createdAt: Date.now(),
      attempts: 0,
    }).catch((err: unknown) => {
      useChatStore.getState().removeUserMessage(key, echoMessageId(messageId))
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

  const renderItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      switch (item.kind) {
        case 'user':
          return (
            <View style={styles.userRow}>
              <View style={styles.userBubble}>
                {item.images?.map((url, i) => (
                  <Pressable key={`${item.id}-img-${i}`} onPress={() => setLightbox(url)}>
                    <Image source={{ uri: url }} style={styles.sentImage} resizeMode="cover" />
                  </Pressable>
                ))}
                {/* An image with no caption is a valid message, so the label is
                    conditional rather than a placeholder like "[1 image]". */}
                {item.text.length > 0 && <Text style={styles.userText}>{item.text}</Text>}
              </View>
            </View>
          )
        case 'text':
          return <TextItem item={item} />
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
        case 'error':
          return <Text style={styles.errorText}>{item.message}</Text>
      }
    },
    [decideApproval, submitAnswers, implementPlan, focusComposer, backendLabel, setLightbox],
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
  const dictation = useDictation({ draft, onDraft: setDraft, onNote: setVoiceNote })

  const contextPct =
    thread.usedTokens != null && thread.maxTokens ? Math.min(1, thread.usedTokens / thread.maxTokens) : null

  return (
    <AnimatedKeyboardAvoidingView
      {...swipeBack.panHandlers}
      style={[styles.screen, { transform: [{ translateX: swipeBack.translateX }] }]}
      // Edge-to-edge is unconditional in SDK 57, and under it the window is not
      // resized for the keyboard, so `undefined` left the composer covered.
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
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
      <View style={styles.composer}>
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
        {queuedCount > 0 && (
          <Text style={styles.queuedNote}>
            {queuedCount} {queuedCount === 1 ? 'message' : 'messages'} waiting to send
          </Text>
        )}
        {slashQuery !== null && <SlashMenu commands={slashMatches} onPick={runSlash} />}
        <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
        <View style={styles.inputSurface}>
          <TextInput
            ref={composerRef}
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={isRunning ? 'Queue a follow-up…' : 'Message the agent…'}
            placeholderTextColor={colors.textFaint}
            multiline
          />
          {/* Attach lives inside the bubble, left of the primary button. */}
          <AttachButton count={attachments.length} existing={attachments} onAdd={addAttachments} />
          <SendMicButton
            canSend={canSend}
            isRunning={isRunning}
            dictation={dictation}
            onSend={send}
            onStopTurn={stop}
          />
        </View>
      </View>
    </AnimatedKeyboardAvoidingView>
  )
}

// ─── Item renderers ────────────────────────────────────────────

export const TextItem = memo(function TextItem({ item }: { item: Extract<FeedItem, { kind: 'text' }> }) {
  const [expanded, setExpanded] = useState(false)

  if (item.stream === 'reasoning') {
    return (
      <View style={styles.itemBlock}>
        <Text style={styles.reasoningText} numberOfLines={expanded ? undefined : 3}>
          {item.text}
        </Text>
        <Pressable onPress={() => setExpanded((v) => !v)}>
          <Text style={styles.toggleText}>{expanded ? 'Show less' : 'Show more'}</Text>
        </Pressable>
      </View>
    )
  }

  if (item.stream === 'plan') {
    return (
      <View style={[styles.itemBlock, styles.planStreamBox]}>
        <Markdown text={item.text} />
      </View>
    )
  }

  return (
    <View style={styles.itemBlock}>
      <Markdown text={item.text} />
      {item.done && item.durationMs != null && (
        <Text style={styles.durationText}>Worked for {fmtDuration(item.durationMs)}</Text>
      )}
    </View>
  )
})

export const ToolItem = memo(function ToolItem({ item }: { item: Extract<FeedItem, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(() => summarizeTool(item.toolName, item.input), [item.toolName, item.input])
  const icon = useMemo(() => toolIcon(item.toolName), [item.toolName])
  const output = item.output ?? ''
  const hasOutput = item.state === 'done' && output.length > 0
  const lineCount = hasOutput ? output.split('\n').length : 0

  // Collapsed to a single quiet line: a turn can hold dozens of these, and the
  // output only matters when the user asks for it.
  return (
    <View style={styles.itemBlock}>
      <Pressable
        onPress={() => hasOutput && setExpanded((v) => !v)}
        style={({ pressed }) => [styles.toolRow, pressed && hasOutput && styles.pressed]}
        accessibilityRole={hasOutput ? 'button' : undefined}
        accessibilityLabel={`${summary.title} ${summary.detail}`}
      >
        {item.state === 'running' ? (
          <ActivityIndicator size="small" color={colors.accent} style={styles.toolIcon} />
        ) : (
          <Ionicons name={icon as never} size={14} color={colors.textFaint} style={styles.toolIcon} />
        )}
        <Text style={styles.toolTitle}>{summary.title}</Text>
        {summary.detail.length > 0 && (
          <Text
            style={[styles.toolDetail, summary.mono ? styles.toolDetailMono : null]}
            numberOfLines={1}
            ellipsizeMode={summary.mono ? 'head' : 'tail'}
          >
            {summary.detail}
          </Text>
        )}
        {hasOutput && (
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={13}
            color={colors.textFaint}
          />
        )}
      </Pressable>

      {expanded && hasOutput && (
        <View style={styles.toolOutputBox}>
          {/* Horizontal scroll, not wrapping: tool output is machine-formatted
              and wrapped columns are unreadable. */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text style={styles.toolOutputText}>{output}</Text>
          </ScrollView>
          <Text style={styles.toolMeta}>{lineCount} {lineCount === 1 ? 'line' : 'lines'}</Text>
        </View>
      )}
    </View>
  )
})

const ApprovalItem = memo(function ApprovalItem({
  item,
  onDecide,
}: {
  item: Extract<FeedItem, { kind: 'approval' }>
  onDecide: (requestId: string, decision: 'approve' | 'deny') => void
}) {
  const pending = item.state === 'pending'
  return (
    <View style={[styles.itemBlock, styles.approvalCard, !pending && styles.cardResolved]}>
      <Text style={styles.approvalTitle}>
        {pending ? 'Approval needed' : item.state === 'approve' ? 'Approved' : 'Denied'}
      </Text>
      <Text style={styles.toolName}>{item.toolName}</Text>
      <Text style={styles.toolOutput} numberOfLines={6}>
        {item.detail}
      </Text>
      {pending && (
        <View style={styles.buttonRow}>
          <Pressable style={[styles.actionButton, styles.approveButton]} onPress={() => onDecide(item.requestId, 'approve')}>
            <Text style={styles.actionLabel}>Approve</Text>
          </Pressable>
          <Pressable style={[styles.actionButton, styles.denyButton]} onPress={() => onDecide(item.requestId, 'deny')}>
            <Text style={styles.actionLabel}>Deny</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
})

const QuestionItem = memo(function QuestionItem({
  item,
  onSubmit,
}: {
  item: Extract<FeedItem, { kind: 'question' }>
  onSubmit: (requestId: string, answers: string[][]) => void
}) {
  const answered = item.answers != null
  // One selection array per question - submitted together as string[][],
  // matching the desktop QuestionCard wire shape.
  const [selections, setSelections] = useState<string[][]>(
    () => item.answers ?? item.questions.map(() => []),
  )

  const toggle = (qIdx: number, q: Question, label: string) => {
    if (answered) return
    setSelections((prev) =>
      prev.map((picks, i) => {
        if (i !== qIdx) return picks
        if (q.multiSelect) {
          return picks.includes(label) ? picks.filter((l) => l !== label) : [...picks, label]
        }
        return [label]
      }),
    )
  }

  const shown = item.answers ?? selections
  const canSubmit = !answered && selections.every((picks) => picks.length > 0)

  return (
    <View style={[styles.itemBlock, styles.questionCard]}>
      <Text style={styles.questionHeader}>{answered ? 'Answered' : 'Question'}</Text>
      {item.questions.map((q, qIdx) => (
        <View key={q.id} style={styles.questionBlock}>
          {q.header ? <Text style={styles.questionSubHeader}>{q.header}</Text> : null}
          <Text style={styles.questionText}>{q.question}</Text>
          {q.multiSelect && !answered && <Text style={styles.questionHint}>Select one or more.</Text>}
          {q.options.map((opt, i) => {
            const selected = (shown[qIdx] ?? []).includes(opt.label)
            return (
              <Pressable
                key={`${q.id}:${opt.label}`}
                disabled={answered}
                onPress={() => toggle(qIdx, q, opt.label)}
                style={[
                  styles.optionRow,
                  selected && styles.optionRowSelected,
                  answered && !selected && styles.optionRowDimmed,
                ]}
              >
                <View style={[styles.optionNum, selected && styles.optionNumSelected]}>
                  <Text style={[styles.optionNumText, selected && styles.optionNumTextSelected]}>{i + 1}</Text>
                </View>
                <View style={styles.optionBody}>
                  <Text style={styles.optionLabel}>{opt.label}</Text>
                  {opt.description && opt.description !== opt.label ? (
                    <Text style={styles.optionDesc}>{opt.description}</Text>
                  ) : null}
                </View>
                {selected && <Text style={styles.optionCheck}>{'[x]'}</Text>}
              </Pressable>
            )
          })}
        </View>
      ))}
      {!answered && (
        <Pressable
          style={[styles.actionButton, styles.submitButton, !canSubmit && styles.submitDisabled]}
          disabled={!canSubmit}
          onPress={() => onSubmit(item.requestId, selections)}
        >
          <Text style={styles.actionLabel}>Submit</Text>
        </Pressable>
      )}
    </View>
  )
})

const PlanItem = memo(function PlanItem({
  item,
  onImplement,
  onIterate,
}: {
  item: Extract<FeedItem, { kind: 'plan' }>
  onImplement: () => void
  onIterate: () => void
}) {
  return (
    <View style={[styles.itemBlock, styles.planCard]}>
      <Text style={styles.planHeader}>Proposed Plan</Text>
      <Markdown text={item.markdown} />
      <View style={styles.buttonRow}>
        <Pressable style={[styles.actionButton, styles.implementButton]} onPress={onImplement}>
          <Text style={styles.actionLabel}>Implement Plan</Text>
        </Pressable>
        <Pressable style={[styles.actionButton, styles.iterateButton]} onPress={onIterate}>
          <Text style={styles.iterateLabel}>Iterate</Text>
        </Pressable>
      </View>
    </View>
  )
})

const FileEditItem = memo(function FileEditItem({
  item,
  backendLabel,
}: {
  item: Extract<FeedItem, { kind: 'fileEdit' }>
  backendLabel: string
}) {
  const oldLines = item.oldContent ? item.oldContent.split('\n').length : 0
  const newLines = item.newContent ? item.newContent.split('\n').length : 0
  const added = item.changeKind === 'delete' ? 0 : item.changeKind === 'add' ? newLines : Math.max(0, newLines - oldLines)
  const removed = item.changeKind === 'add' ? 0 : item.changeKind === 'delete' ? oldLines : Math.max(0, oldLines - newLines)

  return (
    <View style={[styles.itemBlock, styles.fileEditCard]}>
      <Text style={styles.fileEditTitle}>
        {item.changeKind} {item.relPath}
      </Text>
      <View style={styles.fileEditMetaRow}>
        <Text style={styles.addedText}>+{added}</Text>
        <Text style={styles.removedText}>-{removed}</Text>
        <Text style={styles.fileEditApplied}>applied on {backendLabel}</Text>
      </View>
    </View>
  )
})

// ─── Styles ────────────────────────────────────────────────────

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace'

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    backgroundColor: colors.bg,
  },
  statusText: {
    color: colors.textDim,
    fontSize: 12,
    textTransform: 'capitalize',
  },
  contextWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  contextTrack: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
  },
  contextFill: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  contextText: {
    color: colors.textFaint,
    fontSize: 11,
    fontFamily: mono,
  },
  costText: {
    color: colors.textDim,
    fontSize: 11,
    fontFamily: mono,
  },
  feedContent: {
    paddingVertical: 10,
    flexGrow: 1,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    // No counter-flip here. This block renders OUTSIDE the inverted list, so
    // nothing flips it; the scaleY:-1 that used to cancel the list's transform
    // became the thing turning it upside down once it moved out.
  },
  emptyText: {
    color: colors.textFaint,
    fontSize: 13,
    marginTop: space.sm,
  },
  itemBlock: {
    marginHorizontal: space.lg,
    marginVertical: space.sm,
  },
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginHorizontal: space.lg,
    marginTop: space.lg,
    marginBottom: space.xs,
  },
  // The old bubble was near-black navy on near-black: technically present,
  // practically invisible. A lighter raised surface plus a left accent edge
  // reads as "you said this" without shouting.
  userBubble: {
    maxWidth: '82%',
    backgroundColor: colors.surfaceRaised,
    borderLeftWidth: 2,
    borderLeftColor: colors.accent,
    borderTopRightRadius: radius.md,
    borderBottomRightRadius: radius.md,
    borderTopLeftRadius: 3,
    borderBottomLeftRadius: 3,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  lightbox: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  lightboxImage: { width: '100%', height: '80%' },
  sentImage: {
    width: 180,
    height: 180,
    borderRadius: radius.sm,
    marginBottom: space.xs,
    backgroundColor: colors.surfaceRaised,
  },
  userText: {
    ...type.bodySm,
    color: colors.text,
  },
  // Prose is the hero: it gets the widest measure and the most contrast, while
  // tool cards below deliberately recede.
  assistantText: {
    ...type.body,
    color: colors.text,
  },
  durationText: {
    marginTop: space.xs,
    ...type.monoSm,
    color: colors.textFaint,
  },
  reasoningText: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 19,
    fontStyle: 'italic',
  },
  toggleText: {
    marginTop: 4,
    color: colors.accent,
    fontSize: 12,
  },
  planStreamBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    backgroundColor: colors.surface,
  },
  monoText: {
    color: colors.text,
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: mono,
  },
  toolCard: {
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    gap: 3,
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toolName: {
    ...type.monoSm,
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  toolInput: {
    ...type.monoSm,
    color: colors.textFaint,
  },
  toolOutput: {
    color: colors.textDim,
    fontSize: 11.5,
    lineHeight: 16,
    fontFamily: mono,
  },
  noticeRow: { alignItems: 'center', paddingVertical: space.md },
  noticeText: { color: colors.textDim, ...type.monoSm },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 5,
  },
  toolIcon: { width: 16, alignItems: 'center' },
  toolTitle: { color: colors.textDim, ...type.bodySm },
  toolDetail: { color: colors.textFaint, ...type.bodySm, flexShrink: 1 },
  toolDetailMono: { ...type.monoSm },
  toolOutputBox: {
    marginTop: space.xs,
    marginLeft: 24,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toolOutputText: { color: colors.textDim, ...type.monoSm },
  toolMeta: { color: colors.textFaint, ...type.monoSm, marginTop: space.xs },
  toolInputProse: { color: colors.textDim, ...type.bodySm },
  queuedNote: { color: colors.textDim, ...type.monoSm, marginBottom: space.sm },
  denialPill: {
    alignSelf: 'flex-start',
    marginHorizontal: 14,
    marginVertical: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: 'rgba(229, 84, 74, 0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(229, 84, 74, 0.5)',
  },
  denialText: {
    color: colors.red,
    fontSize: 12,
  },
  approvalCard: {
    backgroundColor: 'rgba(229, 165, 58, 0.06)',
    borderWidth: 1,
    borderColor: colors.amber,
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  cardResolved: {
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  approvalTitle: {
    color: colors.amber,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  actionButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  approveButton: {
    backgroundColor: colors.green,
  },
  denyButton: {
    backgroundColor: colors.red,
  },
  actionLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  questionCard: {
    backgroundColor: 'rgba(229, 165, 58, 0.04)',
    borderWidth: 1,
    borderColor: colors.amber,
    borderRadius: 8,
    padding: 10,
    gap: 8,
  },
  questionHeader: {
    color: colors.amber,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  questionBlock: {
    gap: 4,
  },
  questionSubHeader: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  questionText: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  questionHint: {
    color: colors.textFaint,
    fontSize: 11,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  optionRowSelected: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(79, 142, 247, 0.1)',
  },
  optionRowDimmed: {
    opacity: 0.4,
  },
  optionNum: {
    width: 22,
    height: 22,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
  },
  optionNumSelected: {
    backgroundColor: 'rgba(79, 142, 247, 0.25)',
  },
  optionNumText: {
    color: colors.textDim,
    fontSize: 12,
    fontFamily: mono,
  },
  optionNumTextSelected: {
    color: colors.accent,
  },
  optionBody: {
    flex: 1,
    gap: 1,
  },
  optionLabel: {
    color: colors.text,
    fontSize: 13.5,
    fontWeight: '500',
  },
  optionDesc: {
    color: colors.textDim,
    fontSize: 12,
  },
  optionCheck: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  submitButton: {
    backgroundColor: colors.accent,
    marginTop: 2,
  },
  submitDisabled: {
    opacity: 0.4,
  },
  planCard: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 8,
    padding: 10,
    gap: 8,
    backgroundColor: 'rgba(79, 142, 247, 0.05)',
  },
  planHeader: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  implementButton: {
    backgroundColor: colors.accent,
  },
  iterateButton: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  iterateLabel: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '600',
  },
  fileEditCard: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  fileEditTitle: {
    color: colors.text,
    fontSize: 13,
    fontFamily: mono,
  },
  fileEditMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  addedText: {
    color: colors.green,
    fontSize: 12,
    fontFamily: mono,
  },
  removedText: {
    color: colors.red,
    fontSize: 12,
    fontFamily: mono,
  },
  fileEditApplied: {
    color: colors.textFaint,
    fontSize: 11,
  },
  errorText: {
    marginHorizontal: 14,
    marginVertical: 4,
    color: colors.red,
    fontSize: 13,
  },
  pressed: {
    opacity: 0.6,
  },
  modelChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    maxWidth: 140,
  },
  modelChipText: {
    color: colors.textDim,
    fontSize: 12,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 8,
    maxHeight: '70%',
  },
  modalTitle: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 10,
    paddingBottom: 8,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  modelRowText: {
    color: colors.text,
    fontSize: 15,
    flex: 1,
  },
  modelRowTextActive: {
    color: colors.accent,
    fontWeight: '600',
  },
  modelRowMark: {
    color: colors.textFaint,
    fontSize: 11,
    marginLeft: 10,
  },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 24 : 12,
    gap: 8,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  controlsScroller: {
    flex: 1,
    minHeight: 40,
  },
  controlsContent: {
    gap: space.sm,
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  controlsActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  // Owns the border and fill so the send button can nest flush inside it: the
  // small right padding is what makes the circle sit against the edge.
  inputSurface: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 18,
    paddingRight: 5,
    paddingVertical: 5,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 160,
    paddingHorizontal: 4,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 15,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  sendButtonDisabled: {
    backgroundColor: colors.surfaceRaised,
    opacity: 0.55,
  },
  stopButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.red,
  },
})

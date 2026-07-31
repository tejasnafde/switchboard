/**
 * One chat thread: inverted feed over the chat store's FeedItems, a status
 * header (dot + context meter + cost), and a pinned composer with a runtime
 * mode picker. History seeds from LOAD_SESSION_BY_ID; live events arrive via
 * the connection's onEvent -> useChatStore.ingest wiring.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
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
import { useFocusEffect } from '@react-navigation/native'
import { useHeaderHeight } from '@react-navigation/elements'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { ProviderKind, Question, RuntimeMode } from '@shared/provider-events'
import type { ChatMessage } from '@shared/types'
import type { ModelOption } from '@shared/models'
import { fmtDuration, formatTokens } from '@shared/format'
import { createLogger } from '@shared/logger'
import type { RootStackParamList } from '../../App'
import { colors, radius, space, type } from '../theme'
import { Markdown } from '../components/Markdown'
import { summarizeTool } from '../lib/toolSummary'
import { getClient, useConnectionsStore } from '../stores/connections'
import { useChatStore, threadKey, emptyThread, type FeedItem } from '../stores/chat'
import { ModePicker } from '../components/ModePicker'
import { ThreadHeaderStatus } from '../components/ThreadHeaderStatus'
import { MicButton, VoiceNoteBar, type VoiceNote } from '../components/MicButton'
import { AttachButton, AttachmentStrip, type Attachment } from '../components/ImageAttachments'

/**
 * How much of a long thread to pull on open. Enough that scrolling back feels
 * normal, small enough that a 2800-message thread paints promptly over a phone
 * connection. The backend reports the true total and the feed says so.
 */
const HISTORY_WINDOW = 250

const log = createLogger('screen:thread')

type Props = NativeStackScreenProps<RootStackParamList, 'Thread'>

const IMPLEMENT_MESSAGE = 'Implement the plan you proposed.'

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
      if (m.content.trim()) items.push({ kind: 'user', id: `h-${m.id}`, text: m.content, at: m.timestamp })
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
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const composerRef = useRef<TextInput>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState('')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)

  // Status lives in the header, not in a row of its own. The accessory
  // subscribes to the store directly, so this runs once per thread rather than
  // once per streamed token.
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
      return () => useChatStore.getState().setActive(null)
    }, [key]),
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
  useEffect(() => {
    if (isNew || startedKeyRef.current === key) return
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
        const store = useChatStore.getState()
        if ((store.threads[key]?.items.length ?? 0) === 0 && loaded.messages.length > 0) {
          const seeded = historyToItems(loaded.messages)
          // Say what is being withheld. A long thread silently starting
          // mid-conversation reads as lost history.
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
  }, [connectionId, threadId, projectPath, key, isNew, reportError])

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

  // FlatList passes its OWN getItem/getItemCount after {...restProps}, so a
  // zero-copy accessor is impossible here - it would be silently ignored and the
  // feed would render oldest-first inside an inverted list. Reversing a copy is
  // the supported route; the cost that actually mattered was re-rendering every
  // row per token, which the memoized rows below fix.
  const reversedItems = useMemo(() => [...thread.items].reverse(), [thread.items])
  const itemCount = reversedItems.length

  const setMode = (mode: RuntimeMode) => {
    useChatStore.getState().setRuntimeMode(key, mode)
    getClient(connectionId)?.setRuntimeMode(threadId, mode).catch(reportError)
  }

  // Optimistic like setMode: the chip updates now, a rejection lands in the feed.
  const chooseModel = (id: string) => {
    setModelPickerOpen(false)
    setModel(id)
    getClient(connectionId)?.setModel(threadId, id).catch(reportError)
  }

  const modelLabel = models.find((m) => m.id === model)?.label ?? 'Default'

  const send = () => {
    const text = draft.trim()
    // An image with no caption is a legitimate turn - "what is wrong with this
    // screenshot" is most of the reason to attach one from a phone.
    if (!text && attachments.length === 0) return
    const client = getClient(connectionId)
    if (!client) {
      reportError(new Error('Backend not connected.'))
      return
    }
    const images = attachments.map((a) => ({ url: a.url, mimeType: a.mimeType }))
    setDraft('')
    setVoiceNote(null)
    setAttachments([])
    useChatStore.getState().addUserMessage(
      key,
      text || `[${images.length} ${images.length === 1 ? 'image' : 'images'}]`,
    )
    client
      .sendTurn(threadId, text, thread.runtimeMode, images.length > 0 ? images : undefined)
      .catch(reportError)
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
    client.sendTurn(threadId, IMPLEMENT_MESSAGE, 'sandbox').catch(reportError)
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
                <Text style={styles.userText}>{item.text}</Text>
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
    [decideApproval, submitAnswers, implementPlan, focusComposer, backendLabel],
  )

  const canSend = draft.trim().length > 0 || attachments.length > 0

  const contextPct =
    thread.usedTokens != null && thread.maxTokens ? Math.min(1, thread.usedTokens / thread.maxTokens) : null

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      // Android needs a real behaviour too. Edge-to-edge is unconditional in
      // SDK 57, and under it the window is no longer resized for the keyboard,
      // so `undefined` left the composer covered. Offset accounts for the header.
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

      {/* Rendered OUTSIDE the list on purpose. An inverted FlatList applies a
          flip to the container and cancels it per cell, but ListEmptyComponent
          gets no counter-transform, so anything placed there renders mirrored. */}
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

      {/* Composer */}
      <View style={styles.composer}>
        <View style={styles.composerControls}>
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
        </View>
        {voiceNote && <VoiceNoteBar note={voiceNote} />}
        <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
        <View style={styles.inputRow}>
          <TextInput
            ref={composerRef}
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Message the agent…"
            placeholderTextColor={colors.textFaint}
            multiline
          />
          <AttachButton count={attachments.length} existing={attachments} onAdd={addAttachments} />
          <MicButton draft={draft} onDraft={setDraft} onNote={setVoiceNote} />
          {thread.status === 'running' ? (
            <Pressable style={[styles.sendButton, styles.stopButton]} onPress={stop}>
              <Text style={styles.sendLabel}>Stop</Text>
            </Pressable>
          ) : (
            <Pressable
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              onPress={send}
              disabled={!canSend}
            >
              <Text style={styles.sendLabel}>Send</Text>
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

// ─── Item renderers ────────────────────────────────────────────

const TextItem = memo(function TextItem({ item }: { item: Extract<FeedItem, { kind: 'text' }> }) {
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

const ToolItem = memo(function ToolItem({ item }: { item: Extract<FeedItem, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(() => summarizeTool(item.toolName, item.input), [item.toolName, item.input])
  const outputLines = (item.output ?? '').split('\n')
  const shown = expanded ? outputLines : outputLines.slice(0, 6)
  const hiddenCount = outputLines.length - 6

  return (
    <View style={[styles.itemBlock, styles.toolCard]}>
      <View style={styles.toolHeader}>
        <Text style={styles.toolName}>{summary.title}</Text>
        {item.state === 'running' && <ActivityIndicator size="small" color={colors.accent} />}
      </View>
      {summary.detail.length > 0 && (
        <Text style={summary.mono ? styles.toolInput : styles.toolInputProse} numberOfLines={2}>
          {summary.detail}
        </Text>
      )}
      {item.state === 'done' && item.output != null && item.output.length > 0 && (
        <>
          <Text style={styles.toolOutput}>{shown.join('\n')}</Text>
          {hiddenCount > 0 && (
            <Pressable onPress={() => setExpanded((v) => !v)}>
              <Text style={styles.toggleText}>
                {expanded ? 'Show less' : `Show ${hiddenCount} more lines`}
              </Text>
            </Pressable>
          )}
        </>
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
          style={[styles.actionButton, styles.submitButton, !canSubmit && styles.sendButtonDisabled]}
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
    // The list is inverted, so un-flip the empty state.
    transform: [{ scaleY: -1 }],
  },
  emptyText: {
    color: colors.textFaint,
    fontSize: 13,
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
  toolInputProse: { color: colors.textDim, ...type.bodySm },
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
  composerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 15,
  },
  sendButton: {
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: colors.accent,
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  stopButton: {
    backgroundColor: colors.red,
  },
  sendLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
})

import { memo, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { Question } from '@shared/provider-events'
import { fmtDuration } from '@shared/format'
import { stripDigest } from '@shared/agent-digest'
import { summarizeTool, toolIcon } from '@shared/tool-summary'
import { colors } from '../theme'
import { Markdown } from '../components/Markdown'
import type { FeedItem } from '../stores/chat'
import { styles } from './thread-screen.styles'
import type { HeldTurnActions } from '../lib/held-turns'
import { fileEditCounts, type FileGroupRow } from '../lib/file-groups'
import { approvalActions, offersQuiet, quietLabel, quietly } from '../lib/approval-actions'
import { hostWriteTitle, type HostWriteResponse } from '@shared/agent-host-writes'
import { PR_HOST_LABEL } from '@shared/pull-requests'
import { peerUndeliveredHeading } from '@shared/peer-links'
import { peerUndeliveredReasonText } from '@shared/system-markers'

// ─── Item renderers ────────────────────────────────────────────

export const TextItem = memo(function TextItem({
  item,
  onLongPress,
}: {
  item: Extract<FeedItem, { kind: 'text' }>
  onLongPress?: () => void
}) {
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
    <Pressable style={styles.itemBlock} onLongPress={onLongPress} disabled={!onLongPress}>
      {/* <agent_digest> status tags drive the thread-list preview, not the
          transcript - stripped here the same way the desktop MessageBubble
          strips them. See @shared/agent-digest. streaming: !item.done, so a
          finished message that merely quotes the tag literally is not
          chopped off - only a message still streaming in hides a trailing
          partial/unclosed tag. */}
      <Markdown text={stripDigest(item.text, { streaming: !item.done })} />
      {item.done && item.durationMs != null && (
        <Text style={styles.durationText}>Worked for {fmtDuration(item.durationMs)}</Text>
      )}
    </Pressable>
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

export const ApprovalItem = memo(function ApprovalItem({
  item,
  backendTakesPhoneApproval,
  backendAsyncApproval = false,
  onDecide,
}: {
  item: Extract<FeedItem, { kind: 'approval' }>
  backendTakesPhoneApproval: boolean
  backendAsyncApproval?: boolean
  onDecide: (requestId: string, decision: 'approve' | 'deny', response?: HostWriteResponse) => void
}) {
  const pending = item.state === 'pending'
  const card = item.hostWrite
  const actions = useMemo(() => approvalActions(item, backendTakesPhoneApproval), [item, backendTakesPhoneApproval])
  const [expanded, setExpanded] = useState(false)
  const quietOffered = offersQuiet(item, backendAsyncApproval)
  const [quiet, setQuiet] = useState(false)
  // A long draft starts collapsed, and nothing is approved until it has been opened.
  const hidden = actions.kind === 'host-write' && actions.preview.long && !expanded
  return (
    <View style={[styles.itemBlock, styles.approvalCard, !pending && styles.cardResolved]}>
      <Text style={styles.approvalTitle}>
        {pending ? 'Approval needed' : item.state === 'approve' ? 'Approved' : 'Denied'}
      </Text>
      {card
        ? (
          <>
            <Text style={styles.hostWriteTitle}>{hostWriteTitle(card)}</Text>
            <Text style={styles.toolName}>{[PR_HOST_LABEL[card.host], card.prLabel, card.location].filter(Boolean).join(' · ')}</Text>
          </>
        )
        : <Text style={styles.toolName}>{item.toolName}</Text>}
      {actions.kind === 'host-write'
        ? (
          <>
            <View style={hidden && styles.hostWritePreviewCollapsed} testID="host-write-preview">
              {actions.preview.sections.map((section, i) => (
                <View key={i} style={styles.hostWriteSection}>
                  <Text style={styles.toolName}>{section.label}</Text>
                  <Text style={styles.hostWriteText} selectable>{section.text}</Text>
                </View>
              ))}
            </View>
            {actions.preview.long && (
              <Pressable onPress={() => setExpanded((v) => !v)} accessibilityState={{ expanded }}>
                <Text style={styles.toggleText}>{expanded ? 'Show less' : 'Show the full draft'}</Text>
              </Pressable>
            )}
          </>
        )
        : (
          <Text style={styles.toolOutput} numberOfLines={card ? 24 : 6}>
            {item.detail}
          </Text>
        )}
      {pending && actions.kind === 'deny-only' && <Text style={styles.toolOutput}>Approve this on the desktop. You can deny it here.</Text>}
      {pending && actions.kind === 'host-write' && (
        <Text style={styles.toolOutput}>{hidden ? 'Show the full draft to approve it.' : 'Posts as shown. Edit on the desktop.'}</Text>
      )}
      {pending && actions.kind === 'host-write' && actions.buttons.map((b) => b.problem && (
        <Text key={b.id} style={styles.toolOutput}>{b.label}: {b.problem}</Text>
      ))}
      {pending && quietOffered && (
        <Pressable
          testID="approval-quiet"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: quiet }}
          onPress={() => setQuiet((v) => !v)}
        >
          <Text style={styles.toggleText}>{quiet ? '☑' : '☐'} Don't wake the agent</Text>
        </Pressable>
      )}
      {pending && (
        <View style={styles.buttonRowWrap}>
          {actions.kind === 'plain' && (
            <Pressable style={[styles.actionButton, styles.approveButton]} onPress={() => onDecide(item.requestId, 'approve', quietly(undefined, quiet))}>
              <Text style={styles.actionLabel}>{quietLabel('Approve', 'approve', quiet)}</Text>
            </Pressable>
          )}
          {actions.kind === 'host-write' && actions.buttons.map((b) => (
            <Pressable
              key={b.id}
              disabled={hidden || b.problem !== null}
              accessibilityState={{ disabled: hidden || b.problem !== null }}
              style={[styles.actionButton, b.primary ? styles.approveButton : styles.secondaryButton, (hidden || b.problem !== null) && styles.buttonDisabled]}
              onPress={() => onDecide(item.requestId, 'approve', quietly(b.response, quiet))}
            >
              <Text style={styles.actionLabel}>{quietLabel(b.label, 'approve', quiet)}</Text>
            </Pressable>
          ))}
          <Pressable style={[styles.actionButton, styles.denyButton]} onPress={() => onDecide(item.requestId, 'deny', quietly(undefined, quiet))}>
            <Text style={styles.actionLabel}>{quietLabel('Deny', 'deny', quiet)}</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
})

export const QuestionItem = memo(function QuestionItem({
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
                accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: selected, disabled: answered }}
                testID={`question-option-${qIdx}-${i}`}
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

export const PlanItem = memo(function PlanItem({
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

export const FileEditItem = memo(function FileEditItem({
  item,
  backendLabel,
}: {
  item: Extract<FeedItem, { kind: 'fileEdit' }>
  backendLabel: string
}) {
  const { added, removed } = fileEditCounts(item)

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

/** One turn's changed files, folded; a tap shows or hides that turn's file rows. */
export const FileGroupItem = memo(function FileGroupItem({
  row,
  onToggle,
}: {
  row: FileGroupRow
  onToggle: (id: string) => void
}) {
  return (
    <Pressable
      onPress={() => onToggle(row.id)}
      accessibilityRole="button"
      accessibilityState={{ expanded: row.expanded }}
      testID="file-group"
      style={[styles.itemBlock, styles.fileEditCard]}
    >
      <Text style={styles.fileEditTitle}>{row.label}</Text>
      <View style={styles.fileEditMetaRow}>
        <Text style={styles.addedText}>+{row.added}</Text>
        <Text style={styles.removedText}>-{row.removed}</Text>
        <Text style={styles.fileEditApplied}>{row.expanded ? 'Hide' : 'Show'}</Text>
      </View>
    </Pressable>
  )
})

/**
 * The foot of a user bubble the backend holds until the running turn ends:
 * a Queued chip, Send now (steer it in) and Cancel (text back to the composer).
 */
/** Past this the message starts clamped, with Show more. */
const UNDELIVERED_CLAMP_LINES = 4

/**
 * A message a session link refused. Send delivers it as the user's own send
 * (which renews the link); the backend then marks the row sent on every client.
 */
export function PeerUndeliveredItem({
  item,
  sending,
  error,
  onSend,
}: {
  item: Extract<FeedItem, { kind: 'undelivered' }>
  sending: boolean
  error?: string
  onSend: () => void
}) {
  const { row } = item
  const [expanded, setExpanded] = useState(false)
  const long = row.text.length > 200 || row.text.split('\n').length > UNDELIVERED_CLAMP_LINES
  return (
    <View style={styles.undeliveredCard} testID="peer-undelivered-row">
      <Text style={styles.undeliveredTitle}>
        {row.sent ? peerUndeliveredHeading(row) : `Not delivered to ${row.toLabel}`}
      </Text>
      {!row.sent && <Text style={styles.undeliveredReason}>{peerUndeliveredReasonText(row)}</Text>}
      <Text style={styles.undeliveredText} numberOfLines={long && !expanded ? UNDELIVERED_CLAMP_LINES : undefined} selectable>
        {row.text}
      </Text>
      {long && (
        <Pressable onPress={() => setExpanded((v) => !v)} accessibilityRole="button">
          <Text style={styles.toggleText}>{expanded ? 'Show less' : 'Show more'}</Text>
        </Pressable>
      )}
      {error !== undefined && <Text style={[styles.undeliveredReason, styles.deliveryFailed]} accessibilityLiveRegion="polite">{error}</Text>}
      {!row.sent && (
        <View style={styles.buttonRow}>
          <Pressable
            onPress={onSend}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel={`Send to ${row.toLabel}`}
            accessibilityState={{ disabled: sending }}
            testID="peer-undelivered-send"
            style={[styles.actionButton, styles.secondaryButton, sending && styles.buttonDisabled]}
          >
            <Text style={styles.undeliveredSendText}>{sending ? 'Sending…' : 'Send'}</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

export function HeldTurnBar({
  actions,
  error,
  onPromote,
  onCancel,
}: {
  actions: HeldTurnActions
  /** Why the last Send now / Cancel was refused, shown in place of the hint. */
  error?: string
  onPromote: () => void
  onCancel: () => void
}) {
  return (
    <View style={styles.heldBar}>
      <View style={styles.heldChip}>
        <Ionicons name="time-outline" size={11} color={colors.textDim} />
        <Text style={styles.heldChipText}>Queued</Text>
      </View>
      <Text
        style={[styles.heldHint, error !== undefined && styles.deliveryFailed]}
        numberOfLines={2}
        accessibilityLiveRegion="polite"
      >
        {error ?? actions.hint}
      </Text>
      <Pressable
        onPress={onPromote}
        disabled={!actions.canPromote}
        accessibilityRole="button"
        accessibilityLabel="Send now"
        accessibilityState={{ disabled: !actions.canPromote }}
        testID="held-send-now"
        hitSlop={8}
        style={[styles.heldAction, !actions.canPromote && styles.heldActionDisabled]}
      >
        <Ionicons name="arrow-up" size={15} color={colors.textDim} />
      </Pressable>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        testID="held-cancel"
        hitSlop={8}
        style={styles.heldAction}
      >
        <Ionicons name="close" size={15} color={colors.textDim} />
      </Pressable>
    </View>
  )
}

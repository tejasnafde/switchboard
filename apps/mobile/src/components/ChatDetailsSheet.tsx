/**
 * The chat Details sheet (`details_sheet_v1`): the machine, branch, linked
 * pull request and working-tree changes of the chat, then the account's
 * weekly and 5-hour limits beside the chat's context use. The reads run each
 * time the sheet opens; the rows are built in lib/chat-details.ts.
 */
import React, { useEffect, useState, type ReactNode } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { createLogger } from '@shared/logger'
import type { BranchRead, DiffRead } from '@shared/chat-details'
import type { PrLink } from '@shared/pull-request-links'
import type { ProviderUsage } from '@shared/provider-usage'
import type { LeftTone } from '@shared/usage-left'
import {
  barAccessibilityLabel,
  branchValue,
  changesValue,
  prValue,
  usageBars,
  type DetailsValue,
  type UsageBar,
} from '../lib/chat-details'
import { getClient } from '../stores/connections'
import { reviewsEntry, useReviewsStore } from '../stores/reviews'
import { chat, colors, radius, space, type } from '../theme'

const log = createLogger('chat:details')

export function ChatDetailsButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Chat details"
      testID="chat-details-button"
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Ionicons name="information-circle-outline" size={22} color={colors.textDim} />
    </Pressable>
  )
}

/** No folder, or a read that threw: the row shows None. */
const UNREAD = { ok: false, error: 'not read' } as const

interface Reads {
  branch: BranchRead | undefined
  diff: DiffRead | undefined
  usage: ProviderUsage | undefined
  usageReading: boolean
}

function useDetailsReads(connectionId: string, open: boolean, cwd: string | null, instanceId: string): Reads {
  const [branch, setBranch] = useState<BranchRead>()
  const [diff, setDiff] = useState<DiffRead>()
  const [usage, setUsage] = useState<ProviderUsage>()
  const [usageReading, setUsageReading] = useState(false)
  useEffect(() => {
    if (!open) return
    const client = getClient(connectionId)
    let live = true
    setBranch(cwd && client ? undefined : UNREAD)
    setDiff(cwd && client ? undefined : UNREAD)
    setUsage(undefined)
    if (!client) return
    if (cwd) {
      client
        .currentBranch(cwd)
        .then((read) => live && setBranch(read))
        .catch((err) => {
          log.warn('reading the branch failed', err)
          if (live) setBranch(UNREAD)
        })
      client
        .diffStat(cwd)
        .then((read) => live && setDiff(read))
        .catch((err) => {
          log.warn('reading the diff stat failed', err)
          if (live) setDiff(UNREAD)
        })
    }
    setUsageReading(true)
    client
      .instanceUsage(instanceId)
      .then((read) => live && setUsage(read))
      .catch((err) => log.warn('reading usage limits failed', err))
      .finally(() => live && setUsageReading(false))
    void useReviewsStore.getState().refresh(connectionId, 'focus')
    return () => {
      live = false
    }
  }, [open, connectionId, cwd, instanceId])
  return { branch, diff, usage, usageReading }
}

const LEFT_COLOUR: Record<LeftTone, string> = { neutral: colors.textDim, warning: colors.amber, error: colors.red }

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.row} accessible>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.value}>{children}</View>
    </View>
  )
}

function Value({ value }: { value: DetailsValue }) {
  return (
    <Text style={[styles.primary, value.muted && styles.muted]} numberOfLines={1}>
      {value.text}
    </Text>
  )
}

function Bar({ bar }: { bar: UsageBar }) {
  return (
    <View
      style={styles.bar}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={barAccessibilityLabel(bar)}
      accessibilityValue={bar.used === null ? undefined : { min: 0, max: 100, now: bar.used }}
    >
      <View style={styles.barHead}>
        <Text style={styles.primary}>{bar.label}</Text>
        {bar.left === null ? (
          <Text style={[styles.primary, styles.muted]}>{bar.pending ? '…' : 'Unavailable'}</Text>
        ) : (
          <Text style={[styles.left, { color: LEFT_COLOUR[bar.tone] }]}>{`${bar.left}% left`}</Text>
        )}
      </View>
      <View style={styles.track}>
        {bar.used !== null && (
          <View style={[styles.fill, { width: `${bar.used}%`, backgroundColor: LEFT_COLOUR[bar.tone] }]} />
        )}
      </View>
    </View>
  )
}

export function ChatDetailsSheet({
  visible,
  onClose,
  connectionId,
  machine,
  cwd,
  instanceId,
  links,
  contextUsed,
}: {
  visible: boolean
  onClose: () => void
  connectionId: string
  /** The machine the phone is connected to: the connection's name. */
  machine: string
  /** The agent's working folder: the worktree, else the project. */
  cwd: string | null
  /** The provider account whose limits the bars show. */
  instanceId: string
  links: PrLink[]
  /** The chat's context use, 0..100; null when the agent has not reported it. */
  contextUsed: number | null
}) {
  const reads = useDetailsReads(connectionId, visible, cwd, instanceId)
  const list = useReviewsStore((s) => reviewsEntry(s, connectionId).data)
  const pr = prValue(links, list)
  const changes = changesValue(reads.diff)
  const bars = usageBars(reads.usage, reads.usageReading, contextUsed)

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close chat details">
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="chat-details-sheet">
          <View style={styles.handle} />
          <Text style={styles.heading} accessibilityRole="header">
            Details
          </Text>
          <Row label="Machine">
            <Value value={{ text: machine }} />
          </Row>
          <Row label="Branch">
            <Value value={branchValue(reads.branch)} />
          </Row>
          <Row label="PR">
            {pr ? (
              <>
                <Text style={styles.primary} numberOfLines={1}>
                  {pr.title}
                </Text>
                <Text style={styles.secondary} numberOfLines={1}>
                  {pr.detail.map((part, i) => (
                    <Text key={i} style={part.bad && styles.bad}>
                      {i > 0 ? ' · ' : ''}
                      {part.text}
                    </Text>
                  ))}
                </Text>
              </>
            ) : (
              <Value value={{ text: 'None', muted: true }} />
            )}
          </Row>
          <Row label="Changes">
            {'text' in changes ? (
              <Value value={changes} />
            ) : (
              <View style={styles.changes}>
                <Text style={[styles.primary, styles.added]}>{`+${changes.added}`}</Text>
                <Text style={[styles.primary, styles.bad]}>{`-${changes.removed}`}</Text>
              </View>
            )}
          </Row>
          <View style={styles.divider} />
          {bars.map((bar) => (
            <Bar key={bar.label} bar={bar} />
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  button: { minHeight: chat.target, minWidth: chat.target, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surfaceRaised,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: space.sm,
    paddingBottom: space.xl,
  },
  handle: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textFaint,
    marginTop: space.sm,
    marginBottom: 18,
  },
  heading: { color: colors.text, ...type.heading, paddingHorizontal: space.xl, paddingBottom: space.md },
  row: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.xl, paddingVertical: space.sm },
  label: { width: 72, color: colors.textDim, ...type.meta },
  value: { flex: 1, minWidth: 0 },
  primary: { color: colors.text, fontSize: 15, lineHeight: 20 },
  secondary: { color: colors.textDim, ...type.meta },
  muted: { color: colors.textDim },
  bad: { color: colors.red },
  added: { color: colors.green },
  changes: { flexDirection: 'row', gap: space.sm },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: space.sm, marginHorizontal: space.xl },
  bar: { paddingHorizontal: space.xl, paddingVertical: space.sm },
  barHead: { flexDirection: 'row', justifyContent: 'space-between' },
  left: { fontSize: 15, lineHeight: 20, fontVariant: ['tabular-nums'] },
  track: { marginTop: 6, height: 4, borderRadius: radius.sm, backgroundColor: colors.wash, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.sm },
})

import { memo, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { subagentStatusParts, type SubagentDisplayItem, type SubagentStep } from '@shared/subagent-steps'
import { backgroundTaskLabel, syntheticPartTone, type SyntheticTone } from '@shared/synthetic-message'
import { chat, colors, radius, space, type } from '../theme'
import { Markdown } from '../components/Markdown'
import type { SubagentRow } from '../lib/subagent-rows'
import { ToolItem } from './ThreadFeedItems'

const TONE_COLOR: Record<SyntheticTone, string> = {
  ok: colors.green,
  error: colors.red,
  warn: colors.amber,
  muted: colors.textFaint,
}

function StatusIcon({ status }: { status: SubagentRow['view']['status'] }) {
  if (status === 'running') return <ActivityIndicator size="small" color={colors.accent} testID="subagent-running" />
  if (status === 'done')
    return <Ionicons name="checkmark-circle-outline" size={20} color={colors.green} testID="subagent-done" />
  return <Ionicons name="alert-circle-outline" size={20} color={colors.red} testID="subagent-failed" />
}

function Fold({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <View>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.fold}
      >
        <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={11} color={colors.textFaint} />
        <Text style={styles.foldText}>{label}</Text>
      </Pressable>
      {open && <View style={styles.foldBody}>{children}</View>}
    </View>
  )
}

/**
 * One Agent/Task call: collapsed to a row with its status, expanded to its
 * steps (middle runs and consecutive notices folded) and its report.
 */
export const SubagentItem = memo(function SubagentItem({ row }: { row: SubagentRow }) {
  const [open, setOpen] = useState(false)
  const { view } = row
  const status = subagentStatusParts(view)
  const statusText = [status.detail, ...status.meta].filter(Boolean).join(' · ')

  const renderStep = (step: SubagentStep, failed = false) => {
    if (step.kind === 'notice') {
      return (
        <View key={step.key} style={styles.notice}>
          <View style={[styles.dot, { backgroundColor: TONE_COLOR[syntheticPartTone(step.part)] }]} />
          <Text style={styles.noticeText} numberOfLines={1}>
            {backgroundTaskLabel(step.part.summary)}
          </Text>
        </View>
      )
    }
    if (step.kind === 'text') {
      return (
        <Text key={step.key} style={styles.stepText}>
          {step.text}
        </Text>
      )
    }
    const item = row.stepRows.get(step.key)
    if (item?.kind !== 'tool') return null
    return (
      <View key={step.key}>
        <ToolItem item={item} />
        {failed && step.output ? (
          <Text style={styles.failedOutput} selectable>
            {step.output}
          </Text>
        ) : null}
      </View>
    )
  }

  const renderItem = (item: SubagentDisplayItem) => {
    if (item.kind === 'step') return renderStep(item.step, item.failed)
    return (
      <Fold key={item.key} label={item.label}>
        {item.steps.map((step) => renderStep(step))}
      </Fold>
    )
  }

  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Agent ${view.description}, ${status.lead}${statusText ? `, ${statusText}` : ''}`}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <View style={styles.statusIcon}>
          <StatusIcon status={view.status} />
        </View>
        <View style={styles.lines}>
          <Text style={styles.titleLine} numberOfLines={1}>
            <Text style={styles.agent}>Agent</Text> {view.description}
            {view.model ? <Text style={styles.model}> · {view.model}</Text> : null}
          </Text>
          <Text style={[styles.status, view.status === 'failed' && styles.failed]} numberOfLines={1}>
            {status.lead}
            {statusText ? ` · ${statusText}` : ''}
          </Text>
        </View>
        <View style={styles.chevron}>
          <Ionicons name="chevron-down" size={18} color={colors.textDim} style={open && styles.flipped} />
        </View>
      </Pressable>
      {open && (
        <View style={styles.body}>
          <View style={styles.guide}>
            {view.items.map(renderItem)}
            {view.status === 'done' && view.result ? (
              <View style={styles.result}>
                <Text style={styles.resultLabel}>Result</Text>
                <Markdown text={view.result} />
              </View>
            ) : null}
          </View>
        </View>
      )}
    </View>
  )
})

const styles = StyleSheet.create({
  card: {
    marginHorizontal: chat.margin,
    marginTop: chat.turnGap,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56, borderRadius: radius.sm },
  pressed: { backgroundColor: colors.wash },
  statusIcon: { width: 20, alignItems: 'center' },
  lines: { flex: 1, minWidth: 0 },
  titleLine: { color: colors.text, fontSize: 15, lineHeight: 20 },
  agent: { fontWeight: '600' },
  model: { color: colors.textDim },
  status: { color: colors.textDim, ...type.meta },
  chevron: { width: chat.target, height: chat.target, alignItems: 'center', justifyContent: 'center' },
  flipped: { transform: [{ rotate: '180deg' }] },
  failed: { color: colors.red },
  body: {
    paddingLeft: space.xs,
    paddingVertical: space.xs,
  },
  guide: { marginLeft: 7, paddingLeft: 9, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
  fold: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 5 },
  foldText: { color: colors.textDim, ...type.bodySm },
  foldBody: { marginLeft: space.md },
  notice: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 3 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  noticeText: { flex: 1, color: colors.textDim, ...type.bodySm },
  stepText: { color: colors.textDim, ...type.bodySm, paddingVertical: 3 },
  failedOutput: {
    color: colors.textDim,
    ...type.monoSm,
    marginLeft: 24,
    marginBottom: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderLeftWidth: 2,
    borderLeftColor: colors.red,
    backgroundColor: colors.surfaceRaised,
  },
  result: { marginTop: space.sm, padding: space.md, borderRadius: radius.sm, backgroundColor: colors.bg },
  resultLabel: { color: colors.textFaint, ...type.meta, marginBottom: space.xs },
})

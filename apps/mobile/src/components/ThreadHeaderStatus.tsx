/**
 * Session status as a header accessory: state dot, context use, spend. Reads the
 * chat store directly so a streamed token re-renders this alone, not the header.
 */
import React, { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { contextPercent, formatCostUsd, formatTokens } from '@shared/format'
import { colors, space, statusColor, type } from '../theme'
import { emptyThread, useChatStore } from '../stores/chat'

export const ThreadHeaderStatus = memo(function ThreadHeaderStatus({
  threadKey: key,
  onPress,
}: {
  threadKey: string
  onPress?: () => void
}) {
  const thread = useChatStore((s) => s.threads[key]) ?? emptyThread()
  const percent = thread.usedTokens != null ? contextPercent(thread.usedTokens, thread.maxTokens) : null
  const pct = percent == null ? null : Math.round(percent)

  return (
    <Pressable
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        [
          `status ${thread.status}`,
          pct != null ? `context ${pct} percent` : null,
          thread.usedTokens != null && thread.maxTokens != null
            ? `${formatTokens(thread.usedTokens)} of ${formatTokens(thread.maxTokens)} tokens`
            : null,
          thread.costUsd != null ? `cost ${formatCostUsd(thread.costUsd).slice(1)} dollars` : null,
        ]
          .filter(Boolean)
          .join(', ')
      }
    >
      <View style={[styles.dot, { backgroundColor: statusColor[thread.status] ?? colors.textFaint }]} />
      {pct != null && <Text style={styles.value}>{pct}%</Text>}
      {thread.costUsd != null && thread.costUsd > 0 && (
        <Text style={styles.value}>{formatCostUsd(thread.costUsd)}</Text>
      )}
    </Pressable>
  )
})

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: space.sm },
  dot: { width: 7, height: 7, borderRadius: 4 },
  value: { color: colors.textDim, ...type.monoSm },
})

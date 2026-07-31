/**
 * Session status as a header accessory: state dot, context use, spend.
 *
 * This used to be a full-width bar under the navigation header, which spent a
 * whole row of a phone screen on three short values. It subscribes to the chat
 * store itself so streaming updates re-render this component alone - putting it
 * in `headerRight` via setOptions on every token would rebuild the header.
 */
import React, { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { formatTokens } from '@shared/format'
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
  const pct =
    thread.usedTokens != null && thread.maxTokens
      ? Math.min(100, Math.round((thread.usedTokens / thread.maxTokens) * 100))
      : null

  return (
    <Pressable
      style={styles.row}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        // Spoken form, since the visual form is three abbreviations.
        [
          `status ${thread.status}`,
          pct != null ? `context ${pct} percent` : null,
          thread.usedTokens != null && thread.maxTokens != null
            ? `${formatTokens(thread.usedTokens)} of ${formatTokens(thread.maxTokens)} tokens`
            : null,
          thread.costUsd != null ? `cost ${thread.costUsd.toFixed(2)} dollars` : null,
        ]
          .filter(Boolean)
          .join(', ')
      }
    >
      <View style={[styles.dot, { backgroundColor: statusColor[thread.status] ?? colors.textFaint }]} />
      {pct != null && <Text style={styles.value}>{pct}%</Text>}
      {thread.costUsd != null && thread.costUsd > 0 && (
        <Text style={styles.value}>${thread.costUsd.toFixed(2)}</Text>
      )}
    </Pressable>
  )
})

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: space.sm },
  dot: { width: 7, height: 7, borderRadius: 4 },
  value: { color: colors.textDim, ...type.monoSm },
})

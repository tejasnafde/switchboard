/**
 * The chat header's title block: the chat title over "SSG · Working". A tap
 * shows or hides the usage line under the header. Reads the chat store
 * directly so a streamed token re-renders this alone, not the header.
 */
import React, { memo } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { chat, colors, fonts, type } from '../theme'
import { emptyThread, useChatStore } from '../stores/chat'
import { threadSubtitle } from '../lib/thread-chrome'

export const ThreadHeaderTitle = memo(function ThreadHeaderTitle({
  threadKey: key,
  title,
  provider,
  usageOpen,
  onPress,
}: {
  threadKey: string
  title: string
  /** The screen's provider, for a thread whose session has not reported one yet. */
  provider?: string
  usageOpen: boolean
  onPress: () => void
}) {
  const thread = useChatStore((s) => s.threads[key]) ?? emptyThread()
  const subtitle = threadSubtitle({
    status: thread.status,
    cached: thread.cached,
    instanceName: thread.instanceName,
    provider: thread.provider ?? provider,
  })
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${subtitle}`}
      accessibilityHint={usageOpen ? 'Hides usage' : 'Shows usage'}
      testID="thread-title"
      style={styles.wrap}
    >
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.subtitle} numberOfLines={1}>
        {subtitle}
      </Text>
    </Pressable>
  )
})

const styles = StyleSheet.create({
  wrap: { minHeight: chat.target, justifyContent: 'center', maxWidth: 220 },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: 18, lineHeight: 23 },
  subtitle: { color: colors.textDim, ...type.meta },
})

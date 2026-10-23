import { memo } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { TodoStatus } from '@shared/provider-events'
import { colors, radius, space, type } from '../theme'
import type { FeedItem } from '../stores/chat'
import { eventRowCopy } from '../lib/event-rows'

export type EventFeedItem = Extract<FeedItem, { kind: 'retry' | 'drift' | 'spendBlocked' | 'peer' | 'todo' }>

const TINT: Record<EventFeedItem['kind'], string> = {
  retry: colors.amber,
  drift: colors.amber,
  spendBlocked: colors.red,
  peer: colors.accent,
  todo: colors.accent,
}

const TODO_ICON: Record<TodoStatus, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  completed: { name: 'checkmark-circle', color: colors.green },
  in_progress: { name: 'radio-button-on', color: colors.accent },
  pending: { name: 'ellipse-outline', color: colors.textFaint },
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** Read-only rows for retries, worktree drift, spend blocks, peer messages and the agent's checklist. */
export const EventRowItem = memo(function EventRowItem({ item }: { item: EventFeedItem }) {
  const tint = TINT[item.kind]
  if (item.kind === 'todo') {
    return (
      <View style={styles.card} testID="todo-row">
        <Text style={[styles.title, { color: tint }]}>Todo</Text>
        {item.items.map((todo, i) => {
          const icon = TODO_ICON[todo.status]
          return (
            <View key={`${i}-${todo.text}`} style={styles.todoLine}>
              <Ionicons name={icon.name} size={13} color={icon.color} />
              <Text style={[styles.body, todo.status === 'completed' && styles.done]}>{todo.text}</Text>
            </View>
          )
        })}
      </View>
    )
  }
  const copy = eventRowCopy(item, formatTime)
  return (
    <View style={styles.card} testID={`${item.kind}-row`}>
      <View style={styles.titleLine}>
        {item.kind === 'retry' && item.active && <ActivityIndicator size="small" color={tint} />}
        <Text style={[styles.title, { color: tint }]}>{copy.title}</Text>
      </View>
      {copy.lines.map((line, i) => (
        <Text key={`${i}-${line}`} style={styles.body} selectable>
          {line}
        </Text>
      ))}
      {copy.meta ? <Text style={styles.meta}>{copy.meta}</Text> : null}
    </View>
  )
})

const styles = StyleSheet.create({
  card: {
    marginHorizontal: space.lg,
    marginVertical: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 2,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...type.bodySm, fontWeight: '600' },
  body: { flexShrink: 1, color: colors.text, ...type.bodySm },
  done: { color: colors.textDim, textDecorationLine: 'line-through' },
  meta: { color: colors.textDim, ...type.monoSm },
  todoLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
})
